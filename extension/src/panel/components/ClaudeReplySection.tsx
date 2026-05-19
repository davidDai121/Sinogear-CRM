import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  waitForChatMessages,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { loadMessages } from '@/lib/message-sync';
import {
  buildFirstMessage,
  buildFollowUpMessage,
  DEFAULT_STYLE_ANCHORS,
  detectObjection,
  type ClaudeMode,
  type StyleAnchor,
} from '@/lib/claude-prompt';

/** anchor 唯一性 key — reply 前 60 字符（足够区分但短到可序列化） */
const anchorKey = (a: StyleAnchor): string => a.reply.slice(0, 60);
import {
  parseBudgetValue,
  parseClaudeResponse,
  type ParsedClientRecord,
} from '@/lib/claude-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { logContactEvent } from '@/lib/events-log';
import type { CustomerStage } from '@/lib/database.types';
import { logAiReply, markAiReplyFilled } from '@/lib/ai-reply-log';
import { sanitizeReplyForCustomer, wasReplyDirty } from '@/lib/reply-sanitize';
import { ReplyCard } from './ReplyCard';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type ClaudeConvRow = Database['public']['Tables']['claude_conversations']['Row'];
type VehicleInterestRow =
  Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  orgId: string;
  contact: ContactRow;
  needsJump?: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'sending'; foreground: boolean; mode: ClaudeMode; source: 'dom' | 'db'; count: number }
  | {
      kind: 'done';
      mode: ClaudeMode;
      text: string;
      chatUrl: string;
      source: 'dom' | 'db';
      count: number;
      /** ai_reply_logs row id — fillReply 用它把 was_filled 翻成 true */
      logId: string | null;
    }
  | { kind: 'error'; message: string };

const MODE_LABELS: Record<ClaudeMode, string> = {
  reply: '💬 写回复',
  discuss: '🗣️ 讨论客户',
  analyze: '🔍 深度分析',
  variants: '🎭 3 个变体',
  quote: '📋 起报价',
};

const MODE_HINTS: Record<ClaudeMode, string> = {
  reply: '给客户的回复 + 翻译 + 策略 + 客户档案',
  discuss: '不出回复，跟 Claude 一起分析这个客户、讨论怎么应对',
  analyze: '不出回复，输出痛点 / 决策驱动 / 异议 / 预测下一步',
  variants: '一次出 3 个不同语气的回复，挑一个用',
  quote: '起草结构化报价 + 配套客户回复',
};

export function ClaudeReplySection({ orgId, contact, needsJump }: Props) {
  const [mode, setMode] = useState<ClaudeMode>('reply');
  const [existingConv, setExistingConv] = useState<ClaudeConvRow | null>(null);
  const [foreground, setForeground] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [guidance, setGuidance] = useState('');
  const [guidanceLoaded, setGuidanceLoaded] = useState(false);
  const [discuss, setDiscuss] = useState('');
  const [styleAnchors, setStyleAnchors] = useState<StyleAnchor[]>([]);
  // 用户 disable 掉的 anchor key 集合，按 orgId 持久化到 chrome.storage
  const [anchorDisabled, setAnchorDisabled] = useState<Record<string, boolean>>({});

  // default + dynamic 合并，去重（同一段 reply 不重复）
  const combinedAnchors = useMemo<StyleAnchor[]>(() => {
    const seen = new Set<string>();
    const all: StyleAnchor[] = [];
    for (const a of [...DEFAULT_STYLE_ANCHORS, ...styleAnchors]) {
      const k = anchorKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(a);
    }
    return all;
  }, [styleAnchors]);

  // 实际传给 Claude 的 anchors = combined 减去用户 disable 的，上限 8 段
  const enabledAnchors = useMemo<StyleAnchor[]>(
    () => combinedAnchors.filter((a) => !anchorDisabled[anchorKey(a)]).slice(0, 8),
    [combinedAnchors, anchorDisabled],
  );

  // ── 前台开关偏好 ──
  useEffect(() => {
    void chrome.storage.local.get('claudeForeground').then((s) => {
      setForeground(Boolean(s.claudeForeground));
    });
  }, []);

  // ── 销售指令草稿（per-contact） ──
  const guidanceKey = `claudeGuidance:${contact.id}`;
  useEffect(() => {
    setGuidanceLoaded(false);
    void chrome.storage.local.get(guidanceKey).then((s) => {
      const saved =
        typeof s[guidanceKey] === 'string' ? (s[guidanceKey] as string) : '';
      setGuidance(saved);
      setGuidanceLoaded(true);
    });
  }, [guidanceKey]);

  useEffect(() => {
    if (!guidanceLoaded) return;
    if (guidance) {
      void chrome.storage.local.set({ [guidanceKey]: guidance });
    } else {
      void chrome.storage.local.remove(guidanceKey);
    }
  }, [guidance, guidanceLoaded, guidanceKey]);

  // ── 续聊：读 claude_conversations ──
  const refreshExistingConv = async () => {
    const { data } = await supabase
      .from('claude_conversations')
      .select('*')
      .eq('contact_id', contact.id)
      .maybeSingle();
    setExistingConv(data ?? null);
  };

  useEffect(() => {
    void refreshExistingConv();
    setStatus({ kind: 'idle' });
    setDiscuss('');
  }, [contact.id]);

  // ── 风格锚点：从 messages 表拉销售自己过往成功客户的 outbound 片段 ──
  // 一次性按 org 加载（跨 contact 复用），用 chrome.storage 缓存 1 天
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `claudeStyleAnchors:${orgId}`;
    const oneDayMs = 24 * 60 * 60 * 1000;
    void (async () => {
      // 先读缓存
      const cached = await chrome.storage.local.get(cacheKey);
      const entry = cached[cacheKey] as
        | { ts: number; anchors: StyleAnchor[] }
        | undefined;
      if (entry && Date.now() - entry.ts < oneDayMs && entry.anchors?.length) {
        if (!cancelled) setStyleAnchors(entry.anchors);
        return;
      }
      // 失效或没有 → 拉取
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, country, language, customer_stage')
        .eq('org_id', orgId)
        .in('customer_stage', ['quoted', 'won']);
      if (!contacts || contacts.length === 0) return;
      const contactById = new Map(contacts.map((c) => [c.id, c]));
      const ids = contacts.map((c) => c.id);
      const { data: msgs } = await supabase
        .from('messages')
        .select('contact_id, text, sent_at')
        .in('contact_id', ids)
        .eq('direction', 'outbound')
        .order('sent_at', { ascending: false })
        .limit(60);
      if (!msgs) return;
      // 筛：长度 50-400，去附件占位
      const goodMsgs = msgs.filter((m) => {
        const t = (m.text ?? '').trim();
        if (t.length < 50 || t.length > 400) return false;
        if (/^\[图片|^IMG-|^VID-|\(文件附件\)/i.test(t)) return false;
        return true;
      });
      // 随机挑 8 个，多样化
      shuffleInPlace(goodMsgs);
      const picked = goodMsgs.slice(0, 8).map((m): StyleAnchor => {
        const c = contactById.get(m.contact_id);
        const ctxParts: string[] = [];
        if (c?.country) ctxParts.push(c.country);
        if (c?.language) ctxParts.push(c.language);
        if (c?.customer_stage) ctxParts.push(c.customer_stage);
        return {
          context: ctxParts.length ? ctxParts.join(' · ') : 'past customer',
          reply: m.text ?? '',
        };
      });
      if (cancelled) return;
      setStyleAnchors(picked);
      void chrome.storage.local.set({
        [cacheKey]: { ts: Date.now(), anchors: picked },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // 读 anchorDisabled 持久化
  useEffect(() => {
    const key = `claudeAnchorDisabled:${orgId}`;
    void chrome.storage.local.get(key).then((res) => {
      const v = res[key];
      if (v && typeof v === 'object') setAnchorDisabled(v as Record<string, boolean>);
    });
  }, [orgId]);

  const toggleAnchor = (anchor: StyleAnchor) => {
    const k = anchorKey(anchor);
    setAnchorDisabled((prev) => {
      const next = { ...prev };
      if (next[k]) delete next[k];
      else next[k] = true;
      void chrome.storage.local.set({ [`claudeAnchorDisabled:${orgId}`]: next });
      return next;
    });
  };

  const toggleForeground = (next: boolean) => {
    setForeground(next);
    void chrome.storage.local.set({ claudeForeground: next });
  };

  // ── 主流程：generate / discuss ──

  const generate = async (chosenMode: ClaudeMode = mode) => {
    setStatus({ kind: 'reading' });
    const startedAt = Date.now();
    let promptForLog = '';
    let messageSourceForLog: 'dom' | 'db' = 'dom';
    let messageCountForLog = 0;
    const guidanceForLog = guidance.trim();
    try {
      // 1. 读消息：DOM 优先；空时走 messages 表
      let messages: ChatMessage[] = [];
      let messageSource: 'dom' | 'db' = 'dom';
      if (needsJump) {
        const query = contact.phone
          ? contact.phone.replace(/^\+/, '')
          : contact.name?.trim() || contact.wa_name?.trim() || '';
        if (query) {
          const ok = await jumpToChat(query);
          if (ok) {
            messages = await waitForChatMessages(5000, 30, 1);
          }
        } else {
          messages = await waitForChatMessages(5000, 30, 1);
        }
      } else {
        // 即使不需要 jump 也走轮询版——WA Web 冷启动后 div#main 出现 ≈ 6s，
        // bubble 渲染 ≈ 10s+；单发 readChatMessages 会一发就空，错误地
        // 走 DB fallback，DB 又没数据时误报"没可读消息"
        messages = await waitForChatMessages(5000, 30, 1);
      }
      if (messages.length === 0) {
        const rows = await loadMessages(contact.id, 50);
        if (rows.length === 0) {
          throw new Error(
            '当前聊天没有可读消息，且数据库里也没历史记录。请先打开 WhatsApp 聊天加载消息，或在「客户」tab 用「📥 导入手机聊天」导入 .txt 历史。',
          );
        }
        messages = rows.map((r) => ({
          id: r.wa_message_id,
          fromMe: r.direction === 'outbound',
          text: r.text,
          timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
          sender: null,
        }));
        messageSource = 'db';
      }

      // 2. 群聊成员名单（如果是群）
      let groupMemberNames: string[] | undefined;
      const isGroup = !!contact.group_jid;
      if (isGroup && contact.group_jid && !existingConv) {
        try {
          const { readWhatsAppData } = await import('@/lib/whatsapp-idb');
          const wa = await readWhatsAppData();
          const chat = wa.chats.find((c) => c.id === contact.group_jid);
          if (chat) {
            const contactByJid = new Map(wa.contacts.map((c) => [c.id, c]));
            groupMemberNames = chat.participants.map((jid) => {
              const c = contactByJid.get(jid);
              return (
                (c?.name ?? '').trim() ||
                (c?.shortName ?? '').trim() ||
                (c?.pushname ?? '').trim() ||
                jid.split('@')[0]
              );
            });
          }
        } catch {
          // 拿不到成员不致命
        }
      }

      // 3. 车型兴趣（仅新对话）
      let vehicleInterests: VehicleInterestRow[] = [];
      if (!existingConv) {
        const { data } = await supabase
          .from('vehicle_interests')
          .select('*')
          .eq('contact_id', contact.id);
        vehicleInterests = data ?? [];
      }

      // 4. 卡点雷达
      const detectedObjection = detectObjection(messages);

      // 5. 构造 prompt + URL
      const url = existingConv?.chat_url ?? 'https://claude.ai/new';
      const prompt = existingConv
        ? buildFollowUpMessage({
            mode: chosenMode,
            newMessages: messages.slice(-10),
            isGroup,
            salesGuidance: guidance.trim() || undefined,
            detectedObjection,
          })
        : buildFirstMessage(
            {
              contact,
              vehicleInterests,
              messages,
              groupMemberNames,
              styleAnchors: enabledAnchors,
              detectedObjection,
              salesGuidance: guidance.trim() || undefined,
            },
            chosenMode,
          );
      promptForLog = prompt;
      messageSourceForLog = messageSource;
      messageCountForLog = messages.length;

      // 6. 发到 Claude
      setStatus({
        kind: 'sending',
        foreground,
        mode: chosenMode,
        source: messageSource,
        count: messages.length,
      });
      const response = await chrome.runtime.sendMessage({
        type: 'CLAUDE_RUN',
        url,
        prompt,
        active: foreground,
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Claude 调用失败');
      }

      // 7. 写回 claude_conversations
      const newChatUrl: string = response.chatUrl;
      if (existingConv) {
        await supabase
          .from('claude_conversations')
          .update({
            chat_url: newChatUrl,
            last_used_at: new Date().toISOString(),
          })
          .eq('contact_id', contact.id);
      } else {
        await supabase.from('claude_conversations').insert({
          contact_id: contact.id,
          chat_url: newChatUrl,
        });
      }
      await refreshExistingConv();

      // 写 log（不阻塞 UI；失败只 console.warn）
      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'claude',
        mode: chosenMode,
        prompt,
        response: response.responseText,
        guidance: guidanceForLog || null,
        messageSource,
        messageCount: messages.length,
        chatUrl: newChatUrl,
        durationMs: Date.now() - startedAt,
      });

      setStatus({
        kind: 'done',
        mode: chosenMode,
        text: response.responseText,
        chatUrl: newChatUrl,
        source: messageSource,
        count: messages.length,
        logId,
      });
      setGuidance('');
    } catch (err) {
      const msg = stringifyError(err);
      // 错误也记 log — 方便回看为啥跪了（auth required / rate limit / DOM 漂移等）
      void logAiReply({
        orgId,
        contactId: contact.id,
        source: 'claude',
        mode: chosenMode,
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        guidance: guidanceForLog || null,
        messageSource: messageSourceForLog,
        messageCount: messageCountForLog,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      if (msg.includes('CLAUDE_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message:
            '需要先登录 Claude。请打开 https://claude.ai 登录后再试（同一个 Chrome profile 即可）。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  const sendDiscussion = async () => {
    const q = discuss.trim();
    if (!q) return;
    setStatus({ kind: 'reading' });
    const startedAt = Date.now();
    let promptForLog = '';
    let sourceForLog: 'dom' | 'db' = 'dom';
    let countForLog = 0;
    try {
      const url = existingConv?.chat_url ?? 'https://claude.ai/new';
      // 没历史 → 第一次连同上下文一起发；有历史 → 只发问题
      let prompt: string;
      let source: 'dom' | 'db' = 'dom';
      let count = 0;
      if (!existingConv) {
        // 复用 generate 的消息加载逻辑（精简版）——同样走轮询版
        let messages: ChatMessage[] = await waitForChatMessages(5000, 30, 1);
        if (messages.length === 0) {
          const rows = await loadMessages(contact.id, 50);
          messages = rows.map((r) => ({
            id: r.wa_message_id,
            fromMe: r.direction === 'outbound',
            text: r.text,
            timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
            sender: null,
          }));
          source = 'db';
        }
        count = messages.length;
        if (count === 0) {
          throw new Error('没有可读对话历史。先打开 WhatsApp 聊天或导入 .txt');
        }
        let vehicleInterests: VehicleInterestRow[] = [];
        const { data } = await supabase
          .from('vehicle_interests')
          .select('*')
          .eq('contact_id', contact.id);
        vehicleInterests = data ?? [];

        // First message in discuss mode + 用户的问题作为 [Sales Guidance]
        prompt = buildFirstMessage(
          {
            contact,
            vehicleInterests,
            messages,
            styleAnchors: enabledAnchors,
            salesGuidance: q,
          },
          'discuss',
        );
      } else {
        prompt = buildFollowUpMessage({
          mode: 'discuss',
          userQuestion: q,
        });
      }
      promptForLog = prompt;
      sourceForLog = source;
      countForLog = count;
      setStatus({
        kind: 'sending',
        foreground,
        mode: 'discuss',
        source,
        count,
      });
      const response = await chrome.runtime.sendMessage({
        type: 'CLAUDE_RUN',
        url,
        prompt,
        active: foreground,
      });
      if (!response?.ok) throw new Error(response?.error ?? 'Claude 调用失败');

      const newChatUrl: string = response.chatUrl;
      if (existingConv) {
        await supabase
          .from('claude_conversations')
          .update({
            chat_url: newChatUrl,
            last_used_at: new Date().toISOString(),
          })
          .eq('contact_id', contact.id);
      } else {
        await supabase.from('claude_conversations').insert({
          contact_id: contact.id,
          chat_url: newChatUrl,
        });
      }
      await refreshExistingConv();

      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'claude',
        mode: 'discuss',
        prompt,
        response: response.responseText,
        guidance: q,
        messageSource: source,
        messageCount: count,
        chatUrl: newChatUrl,
        durationMs: Date.now() - startedAt,
      });

      setStatus({
        kind: 'done',
        mode: 'discuss',
        text: response.responseText,
        chatUrl: newChatUrl,
        source,
        count,
        logId,
      });
      setDiscuss('');
    } catch (err) {
      const msg = stringifyError(err);
      void logAiReply({
        orgId,
        contactId: contact.id,
        source: 'claude',
        mode: 'discuss',
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        guidance: q,
        messageSource: sourceForLog,
        messageCount: countForLog,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      if (msg.includes('CLAUDE_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message: '需要先登录 Claude。打开 https://claude.ai 登录后再试。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  const reset = async () => {
    if (!existingConv) return;
    if (!confirm('清除此客户在 Claude 上的对话？下次将开新对话。')) return;
    await supabase
      .from('claude_conversations')
      .delete()
      .eq('contact_id', contact.id);
    await refreshExistingConv();
    setStatus({ kind: 'idle' });
    setDiscuss('');
  };

  const parsed = useMemo(
    () =>
      status.kind === 'done' ? parseClaudeResponse(status.text) : null,
    [status],
  );

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const fillReply = async (text: string) => {
    try {
      // P0 安全：剥掉 LLM 可能夹进 reply 的内部段落（[Strategy] / Note: 等）
      // 防止把 Claude 的"思考"当作客户消息发出去
      const wasDirty = wasReplyDirty(text);
      const cleanText = sanitizeReplyForCustomer(text);
      if (!cleanText) {
        alert('回复为空（可能 Claude 没生成有效的 [WhatsApp Reply] 段）');
        return;
      }
      if (wasDirty) {
        const ok = confirm(
          'Claude 的回复里夹了内部段落（[Strategy] / 备注 之类），已自动剥掉。确认要把净化后的版本发给客户？',
        );
        if (!ok) return;
      }
      if (needsJump) {
        const query = contact.phone
          ? contact.phone.replace(/^\+/, '')
          : contact.name?.trim() || contact.wa_name?.trim() || '';
        if (query) {
          const ok = await jumpToChat(query, { allowDeepLink: true });
          if (!ok) {
            alert('未能跳转到该聊天，请先手动打开后再点填入');
            return;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      const ok = fillWhatsAppCompose(cleanText);
      if (!ok) {
        alert('找不到 WhatsApp 输入框，请确认聊天已打开');
        return;
      }
      // 填入成功 → 标 log 为 was_filled（用户认可了这条回复）
      if (status.kind === 'done' && status.logId) {
        void markAiReplyFilled(status.logId);
      }
    } catch (err) {
      alert(stringifyError(err));
    }
  };

  const busy = status.kind === 'reading' || status.kind === 'sending';

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">
          ✨ Claude AI 回复{' '}
          <span className="sgc-muted" style={{ fontSize: 11, fontWeight: 400 }}>
            · Opus 4.7
          </span>
        </div>
      </div>

      <div className="sgc-gem-section">
        <div className="sgc-gem-controls">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ClaudeMode)}
            disabled={busy}
            title={MODE_HINTS[mode]}
            style={{ minWidth: 130 }}
          >
            {(Object.keys(MODE_LABELS) as ClaudeMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <label
            className="sgc-checkbox-row"
            style={{ marginBottom: 0, fontSize: 12 }}
            title="开启后会切换到 Claude 标签页，便于调试"
          >
            <input
              type="checkbox"
              checked={foreground}
              onChange={(e) => toggleForeground(e.target.checked)}
            />
            <span>前台</span>
          </label>
          <button
            type="button"
            className="sgc-btn-primary"
            onClick={() => generate()}
            disabled={busy}
          >
            {busy
              ? status.kind === 'reading'
                ? '读取聊天…'
                : '✨ Claude 处理中…'
              : existingConv
                ? '续聊生成'
                : '生成'}
          </button>
        </div>

        <div className="sgc-muted" style={{ fontSize: 11, marginTop: 4 }}>
          {MODE_HINTS[mode]}
        </div>

        {/* 销售自定义指令 — 控制下一次"生成"按钮的输出 */}
        <div className="sgc-gem-guidance" style={{ marginTop: 12 }}>
          <div className="sgc-section-title" style={{ fontSize: 12, marginBottom: 4 }}>
            🎯 控制 Claude 怎么写回复
          </div>
          <textarea
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!busy) void generate();
              }
            }}
            placeholder="想让 Claude 怎么回？(可选 · Cmd/Ctrl+Enter 直接生成)
例：用法语回 / 客气一点 / 强调 1 万定金锁车 / 直接报 35k USD / 别问太多问题"
            rows={3}
            disabled={busy}
          />
        </div>

        {/* 风格锚点：用户可勾选哪些样本被 Claude 看到，前 8 段被实际注入 */}
        {combinedAnchors.length > 0 && !existingConv && (
          <details className="sgc-muted" style={{ fontSize: 11, marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>
              📚 风格锚点 · 已启用 {enabledAnchors.length}/{combinedAnchors.length}（前 8 个被注入 Claude，点击调整）
            </summary>
            <ul style={{ marginTop: 6, paddingLeft: 0, listStyle: 'none' }}>
              {combinedAnchors.map((a) => {
                const k = anchorKey(a);
                const disabled = !!anchorDisabled[k];
                const enabledIdx = enabledAnchors.indexOf(a);
                const willBeInjected = enabledIdx >= 0 && enabledIdx < 8;
                return (
                  <li
                    key={k}
                    style={{
                      marginBottom: 6,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      opacity: disabled ? 0.4 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!disabled}
                      onChange={() => toggleAnchor(a)}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: '#667781' }}>
                        <code>{a.context.slice(0, 100)}{a.context.length > 100 ? '…' : ''}</code>
                        {willBeInjected && (
                          <span style={{ marginLeft: 6, color: '#00a884' }}>✓ 注入</span>
                        )}
                        {!disabled && !willBeInjected && (
                          <span style={{ marginLeft: 6, color: '#aaa' }}>(超 8 段上限,不注入)</span>
                        )}
                      </div>
                      <div style={{ fontStyle: 'italic', marginTop: 2 }}>
                        "{a.reply.slice(0, 120)}{a.reply.length > 120 ? '…' : ''}"
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        {/* 续聊状态 */}
        {existingConv && (
          <div className="sgc-gem-progress">
            已有对话 · 最近使用{' '}
            {new Date(existingConv.last_used_at).toLocaleString()}
            <a
              className="sgc-btn-link"
              href={existingConv.chat_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 8 }}
              title="在新标签页打开此客户在 Claude 上的对话"
            >
              🔗 打开 Claude
            </a>
            <button
              type="button"
              className="sgc-btn-link sgc-btn-danger-link"
              onClick={reset}
              style={{ marginLeft: 8 }}
            >
              清除并新建
            </button>
          </div>
        )}

        {status.kind === 'sending' && (
          <div className="sgc-gem-progress">
            {status.source === 'db' && (
              <>📜 用导入的历史记录（{status.count} 条）·{' '}</>
            )}
            正在{status.foreground ? '前台' : '后台'}打开 Claude 并发送（
            {MODE_LABELS[status.mode]}）…
          </div>
        )}

        {status.kind === 'error' && (
          <div className="sgc-error">{status.message}</div>
        )}

        {status.kind === 'done' && parsed && (
          <ResultView
            mode={status.mode}
            parsed={parsed}
            source={status.source}
            count={status.count}
            chatUrl={status.chatUrl}
            contact={contact}
            onFillReply={fillReply}
            onCopy={copyToClipboard}
          />
        )}

        {/* 讨论框：永远显示。无 existingConv 时第一条会带客户上下文 + 你的问题; 有 existingConv 时直接续聊 Claude */}
        <div className="sgc-gem-guidance" style={{ marginTop: 14 }}>
          <div className="sgc-section-title" style={{ fontSize: 12, marginBottom: 4 }}>
            💬 跟 Claude 讨论这个客户
            {!existingConv && (
              <span className="sgc-muted" style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}>
                （首次发送会带上客户聊天历史）
              </span>
            )}
          </div>
          <textarea
            value={discuss}
            onChange={(e) => setDiscuss(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!busy && discuss.trim()) void sendDiscussion();
              }
            }}
            placeholder={
              existingConv
                ? '例：他这句话什么意思 / 如果对方嫌贵怎么办 / 再用更紧迫的语气写一版 / 这个客户值不值得继续追'
                : '例：先帮我分析这客户 / 这单值不值得追 / 怎么破他的"再考虑考虑" / 用这个 SKU 怎么开场'
            }
            rows={2}
            disabled={busy}
          />
          <div className="sgc-gem-result-actions">
            <button
              type="button"
              className="sgc-btn-secondary"
              onClick={() => sendDiscussion()}
              disabled={busy || !discuss.trim()}
            >
              {busy ? '处理中…' : '💬 发送讨论（Cmd/Ctrl+Enter）'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Result rendering（按 mode 分发） ──

interface ResultViewProps {
  mode: ClaudeMode;
  parsed: ReturnType<typeof parseClaudeResponse>;
  source: 'dom' | 'db';
  count: number;
  chatUrl: string;
  contact: ContactRow;
  onFillReply: (text: string) => void;
  onCopy: (text: string) => void;
}

function ResultView({
  mode,
  parsed,
  source,
  count,
  chatUrl,
  contact,
  onFillReply,
  onCopy,
}: ResultViewProps) {
  return (
    <>
      {source === 'db' && (
        <div className="sgc-gem-progress">
          ✅ 基于导入的历史记录（{count} 条）
        </div>
      )}

      {/* Need from Sales Rep — 最显眼，红 banner，AI 缺信息时显示 */}
      {parsed.needFromSalesRep && (
        <div
          className="sgc-gem-card"
          style={{
            background: '#fef2f2',
            borderColor: '#fca5a5',
            borderWidth: 2,
            padding: '10px 12px',
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: '#b91c1c',
              fontWeight: 700,
              marginBottom: 4,
            }}
          >
            ⚠️ Claude 等你确认 — 客户回复是占位，等你给信息后重新生成
          </div>
          <div
            className="sgc-gem-card-body"
            style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}
          >
            {parsed.needFromSalesRep}
          </div>
        </div>
      )}

      {/* Quick Summary — 几乎所有 mode 都有 */}
      {parsed.quickSummary && (
        <div
          className="sgc-gem-card"
          style={{
            background: '#f0fdf4',
            borderColor: '#86efac',
            padding: '8px 12px',
          }}
        >
          <div style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>
            📌 {parsed.quickSummary}
          </div>
        </div>
      )}

      {/* Customer Read — 写回复 / 变体 / 报价 都有，放在 reply 之前给销售先看 */}
      {parsed.customerRead && mode !== 'analyze' && mode !== 'discuss' && (
        <div
          className="sgc-gem-card"
          style={{
            background: '#fff7ed',
            borderColor: '#fed7aa',
          }}
        >
          <div className="sgc-gem-card-label">
            🧠 客户心思 · 写回复前先看这个
          </div>
          <div
            className="sgc-gem-card-body"
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {parsed.customerRead}
          </div>
        </div>
      )}

      {/* Reply mode */}
      {mode === 'reply' && parsed.reply && (
        <ReplyCard
          label="💬 给客户的回复"
          reply={parsed.reply}
          existingTranslation={parsed.translation}
          onFillReply={onFillReply}
          onCopy={onCopy}
        />
      )}

      {/* Variants mode */}
      {mode === 'variants' && parsed.variants.length > 0 && (
        <>
          {parsed.variants.map((v, i) => (
            <ReplyCard
              key={i}
              label={`🎭 变体 ${i + 1} · ${v.tone}`}
              reply={v.reply}
              existingTranslation={null}
              extraNote={v.whenToUse ? `💡 何时用：${v.whenToUse}` : undefined}
              onFillReply={onFillReply}
              onCopy={onCopy}
            />
          ))}
        </>
      )}

      {/* Quote mode */}
      {mode === 'quote' && parsed.quoteDraft && (
        <div
          className="sgc-gem-card"
          style={{ background: '#fefce8', borderColor: '#fde047' }}
        >
          <div className="sgc-gem-card-label">📋 报价草稿</div>
          <div
            className="sgc-gem-card-body"
            style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
          >
            {parsed.quoteDraft}
          </div>
          <div className="sgc-gem-result-actions">
            <button
              type="button"
              className="sgc-btn-secondary"
              onClick={() => onCopy(parsed.quoteDraft!)}
            >
              📋 复制报价
            </button>
          </div>
        </div>
      )}
      {mode === 'quote' && parsed.reply && (
        <ReplyCard
          label="💬 配套客户回复"
          reply={parsed.reply}
          existingTranslation={parsed.translation}
          onFillReply={onFillReply}
          onCopy={onCopy}
        />
      )}
      {/* Analyze mode — 5 张卡 */}
      {mode === 'analyze' && (
        <>
          {parsed.painPoints && (
            <AnalysisCard label="😣 痛点" body={parsed.painPoints} />
          )}
          {parsed.decisionDrivers && (
            <AnalysisCard label="🎯 决策驱动" body={parsed.decisionDrivers} />
          )}
          {parsed.likelyObjections && (
            <AnalysisCard label="🛑 可能异议" body={parsed.likelyObjections} />
          )}
          {parsed.predictedNextAction && (
            <AnalysisCard
              label="🔮 预测下一步"
              body={parsed.predictedNextAction}
            />
          )}
          {parsed.suggestedMove && (
            <AnalysisCard
              label="✅ 建议行动"
              body={parsed.suggestedMove}
              highlight
            />
          )}
        </>
      )}

      {/* Discuss mode — 自由文本 */}
      {mode === 'discuss' && (
        <div className="sgc-gem-card">
          <div className="sgc-gem-card-label">🗣️ Claude 的看法</div>
          <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
            {parsed.raw}
          </div>
          <div className="sgc-gem-result-actions">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => onCopy(parsed.raw)}
            >
              📋 复制
            </button>
          </div>
        </div>
      )}

      {/* Translation 卡（reply / variants / quote 共用） */}
      {parsed.translation && (mode === 'reply' || mode === 'variants' || mode === 'quote') && (
        <div className="sgc-gem-card sgc-gem-card-translation">
          <div className="sgc-gem-card-label">🌏 中文翻译</div>
          <div className="sgc-gem-card-body">{parsed.translation}</div>
          <div className="sgc-gem-result-actions">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => onCopy(parsed.translation!)}
            >
              📋 复制
            </button>
          </div>
        </div>
      )}

      {/* Strategy 卡（除 analyze 之外都有） */}
      {parsed.strategy && mode !== 'analyze' && (
        <div
          className="sgc-gem-card"
          style={{ background: '#f0f9ff', borderColor: '#bae6fd' }}
        >
          <div className="sgc-gem-card-label">💡 销售策略</div>
          <div className="sgc-gem-card-body">{parsed.strategy}</div>
        </div>
      )}

      {/* Followup Queue — reply / variants / quote 模式有 */}
      {parsed.followups.length > 0 &&
        (mode === 'reply' || mode === 'variants' || mode === 'quote') && (
          <FollowupQueueCard
            items={parsed.followups}
            onFillReply={onFillReply}
            onCopy={onCopy}
          />
        )}

      {/* Client Record（reply mode 才显示） */}
      {mode === 'reply' && parsed.clientRecord && (
        <ClientRecordCard record={parsed.clientRecord} contact={contact} />
      )}

      <details className="sgc-gem-raw-toggle">
        <summary>查看完整原始响应</summary>
        <div className="sgc-gem-result">{parsed.raw}</div>
      </details>

      <div className="sgc-gem-result-actions">
        <a
          className="sgc-btn-link"
          href={chatUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          在 Claude 打开此对话
        </a>
      </div>
    </>
  );
}

/**
 * Followup Queue 卡 — 列出 Claude 给的 2-4 条续聊话题
 * 每条独立 "📋 复制" 按钮 + "💬 直接填入" 按钮
 * boss 看时机自己决定何时发
 */
function FollowupQueueCard({
  items,
  onFillReply,
  onCopy,
}: {
  items: import('@/lib/claude-parser').ParsedFollowupItem[];
  onFillReply: (text: string) => void;
  onCopy: (text: string) => void;
}) {
  return (
    <div
      className="sgc-gem-card"
      style={{ background: '#fefce8', borderColor: '#fde68a' }}
    >
      <div className="sgc-gem-card-label">
        📋 续聊话题队列（{items.length} 条）
        <span
          className="sgc-muted"
          style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}
        >
          按时机自己决定何时发，每条独立复制
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              border: '1px solid #fcd34d',
              borderRadius: 6,
              padding: '8px 10px',
              background: '#fffbeb',
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: '#92400e',
                marginBottom: 2,
              }}
            >
              #{i + 1} · {item.topic}
              {item.whenToSend && (
                <span
                  className="sgc-muted"
                  style={{ fontWeight: 400, marginLeft: 6 }}
                >
                  · ⏱ {item.whenToSend}
                </span>
              )}
            </div>
            <div
              className="sgc-gem-card-body"
              style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginBottom: 6 }}
            >
              {item.draft}
            </div>
            <div className="sgc-gem-result-actions">
              <button
                type="button"
                className="sgc-btn-primary"
                onClick={() => onFillReply(item.draft)}
                style={{ fontSize: 11, padding: '3px 8px' }}
              >
                💬 填入聊天框
              </button>
              <button
                type="button"
                className="sgc-btn-secondary"
                onClick={() => onCopy(item.draft)}
                style={{ fontSize: 11, padding: '3px 8px' }}
              >
                📋 复制
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalysisCard({
  label,
  body,
  highlight,
}: {
  label: string;
  body: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="sgc-gem-card"
      style={
        highlight
          ? { background: '#fef3c7', borderColor: '#fbbf24' }
          : undefined
      }
    >
      <div className="sgc-gem-card-label">{label}</div>
      <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
        {body}
      </div>
    </div>
  );
}

// ── ClientRecord 应用（跟 GemReplySection 一样） ──

const RECORD_LABELS: Array<[keyof ParsedClientRecord, string]> = [
  ['country', '国家'],
  ['language', '语言'],
  ['budget', '预算'],
  ['interestedModel', '感兴趣车型'],
  ['destinationPort', '目的港'],
  ['condition', '车况'],
  ['steering', '舵向'],
  ['customerStage', '阶段'],
];

const STAGE_MAP: Record<string, CustomerStage> = {
  new: 'new',
  new_lead: 'new',
  lead: 'new',
  qualifying: 'qualifying',
  inquiring: 'qualifying',
  inquiry: 'qualifying',
  negotiating: 'negotiating',
  negotiation: 'negotiating',
  stalled: 'stalled',
  cold: 'stalled',
  quoted: 'quoted',
  quote: 'quoted',
  won: 'won',
  closed: 'won',
  closed_won: 'won',
  lost: 'lost',
  closed_lost: 'lost',
};

function mapStage(raw: string): CustomerStage | null {
  return STAGE_MAP[raw.toLowerCase().trim().replace(/\s+/g, '_')] ?? null;
}

interface ContactPatch {
  country?: string;
  language?: string;
  destination_port?: string;
  budget_usd?: number;
  customer_stage?: CustomerStage;
  name?: string;
}

function buildContactPatch(
  record: ParsedClientRecord,
  contact: ContactRow,
): ContactPatch {
  const patch: ContactPatch = {};
  if (record.country && record.country !== contact.country) {
    patch.country = record.country;
  }
  if (record.language && record.language !== contact.language) {
    patch.language = record.language;
  }
  if (
    record.destinationPort &&
    record.destinationPort !== contact.destination_port
  ) {
    patch.destination_port = record.destinationPort;
  }
  if (record.budget) {
    const num = parseBudgetValue(record.budget);
    if (num != null && num !== contact.budget_usd) {
      patch.budget_usd = num;
    }
  }
  if (record.customerStage) {
    const stage = mapStage(record.customerStage);
    if (stage && stage !== contact.customer_stage) {
      patch.customer_stage = stage;
    }
  }
  if (record.name && !contact.name?.trim()) {
    patch.name = record.name;
  }
  return patch;
}

function ClientRecordCard({
  record,
  contact,
}: {
  record: ParsedClientRecord;
  contact: ContactRow;
}) {
  const [existingTags, setExistingTags] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<{ fields: number; tags: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase
      .from('contact_tags')
      .select('tag')
      .eq('contact_id', contact.id)
      .then(({ data }) => {
        setExistingTags((data ?? []).map((r) => r.tag));
      });
  }, [contact.id]);

  const patch = useMemo(
    () => buildContactPatch(record, contact),
    [record, contact],
  );

  const tagsToAdd = useMemo(
    () => (record.tags ?? []).filter((t) => t && !existingTags.includes(t)),
    [record.tags, existingTags],
  );

  const fieldCount = Object.keys(patch).length;
  const tagCount = tagsToAdd.length;
  const total = fieldCount + tagCount;

  const rows = RECORD_LABELS.filter(([key]) => {
    const v = record[key];
    return typeof v === 'string' && v.length > 0;
  });
  if (!rows.length && !record.tags?.length) return null;

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      if (fieldCount > 0) {
        const { error: upErr } = await supabase
          .from('contacts')
          .update(patch)
          .eq('id', contact.id);
        if (upErr) throw new Error(upErr.message);
      }
      if (tagCount > 0) {
        const rows = tagsToAdd.map((tag) => ({
          contact_id: contact.id,
          tag,
        }));
        const { error: tagErr } = await supabase
          .from('contact_tags')
          .upsert(rows, {
            onConflict: 'contact_id,tag',
            ignoreDuplicates: true,
          });
        if (tagErr) throw new Error(tagErr.message);
      }
      void logContactEvent(contact.id, 'ai_extracted', {
        source: 'claude',
        fields: Object.keys(patch),
        tags: tagsToAdd,
      });
      setExistingTags((prev) => [...prev, ...tagsToAdd]);
      setDone({ fields: fieldCount, tags: tagCount });
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setApplying(false);
    }
  };

  const hasTags = record.tags && record.tags.length > 0;

  return (
    <details className="sgc-gem-card sgc-gem-card-record" open>
      <summary className="sgc-gem-card-label">👤 Claude 识别的客户档案</summary>
      <div className="sgc-gem-card-body">
        <ul className="sgc-record-list">
          {rows.map(([key, label]) => {
            const isPatching = key in patch;
            return (
              <li key={key}>
                <span className="sgc-record-key">{label}：</span>
                <span>{record[key] as string}</span>
                {isPatching && (
                  <span className="sgc-record-diff">· 将更新</span>
                )}
              </li>
            );
          })}
          {hasTags && (
            <li>
              <span className="sgc-record-key">标签：</span>
              <span>{record.tags!.join('、')}</span>
              {tagCount > 0 && (
                <span className="sgc-record-diff">· 新增 {tagCount} 个</span>
              )}
            </li>
          )}
        </ul>

        <div className="sgc-gem-result-actions">
          {done ? (
            <span className="sgc-muted">
              ✅ 已应用 {done.fields} 项字段 + {done.tags} 个标签
            </span>
          ) : total === 0 ? (
            <span className="sgc-muted">客户资料已是最新</span>
          ) : (
            <button
              type="button"
              className="sgc-btn-secondary"
              onClick={apply}
              disabled={applying}
            >
              {applying ? '应用中…' : `应用 ${total} 项到客户资料`}
            </button>
          )}
        </div>

        {error && <div className="sgc-error">{error}</div>}
      </div>
    </details>
  );
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
