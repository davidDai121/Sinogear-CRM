import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersistedReplyStatus } from '@/panel/hooks/usePersistedReplyStatus';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { jumpToChat, verifyHeaderMatches, type RequireMatch } from '@/lib/jump-to-chat';
import {
  waitForChatMessages,
  maybeLogReadFailure,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { loadMessages, mergeDomWithDbMessages, syncMessages } from '@/lib/message-sync';
import {
  buildFirstMessage,
  buildFollowUpMessage,
  type ClaudeMode,
} from '@/lib/claude-prompt';
import {
  parseBudgetValue,
  parseClaudeResponse,
  type ParsedClientRecord,
} from '@/lib/claude-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { recordFill } from '@/lib/ai-reply-attribution';
import { logContactEvent } from '@/lib/events-log';
import type { CustomerStage } from '@/lib/database.types';
import { logAiReply, markAiReplyFilled } from '@/lib/ai-reply-log';
import { sanitizeReplyForCustomer, wasReplyDirty } from '@/lib/reply-sanitize';
import { ReplyCard } from './ReplyCard';
import { GeneratedAtBadge } from './GeneratedAtBadge';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type ClaudeConvRow = Database['public']['Tables']['claude_conversations']['Row'];
type VehicleInterestRow =
  Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  orgId: string;
  contact: ContactRow;
  needsJump?: boolean;
}

/** 'dom' = 实时 WA 聊天；'db' = 导入的历史；
 *  'guidance' = 完全没历史，仅按销售指令冷启动生成（新客户首条开场白） */
type MessageSource = 'dom' | 'db' | 'guidance';

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'sending'; foreground: boolean; mode: ClaudeMode; source: MessageSource; count: number }
  | {
      kind: 'done';
      mode: ClaudeMode;
      text: string;
      chatUrl: string;
      source: MessageSource;
      count: number;
      /** ai_reply_logs row id — fillReply 用它把 was_filled 翻成 true */
      logId: string | null;
      /** 自动由 usePersistedReplyStatus 注入（done 状态写 chrome.storage 时盖戳） */
      generatedAt?: number;
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
  const [status, setStatus] = usePersistedReplyStatus<Status>('claude', contact.id, { kind: 'idle' });
  const [guidance, setGuidance] = useState('');
  const [guidanceLoaded, setGuidanceLoaded] = useState(false);
  const [discuss, setDiscuss] = useState('');

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
    // status 由 usePersistedReplyStatus 接管：切 contact 时它会自动恢复上次 done card（如有）
    setDiscuss('');
  }, [contact.id]);

  const toggleForeground = (next: boolean) => {
    setForeground(next);
    void chrome.storage.local.set({ claudeForeground: next });
  };

  // ── 主流程：generate / discuss ──

  const generate = async (chosenMode: ClaudeMode = mode) => {
    setStatus({ kind: 'reading' });
    const startedAt = Date.now();
    let promptForLog = '';
    let messageSourceForLog: MessageSource = 'dom';
    let messageCountForLog = 0;
    const guidanceForLog = guidance.trim();
    try {
      // 1. 读消息：DOM 优先；空时走 messages 表；完全没历史时若有 guidance 则冷启动
      //
      // DOM 路径下也强制走 mergeDomWithDbMessages —— WA Web 渲染消息从下往上慢慢
      // 出现，销售刚发完图就点 Generate 时 DOM 可能只有最新 1 条 bubble。
      // waitForChatMessages 已改成稳态判定（count 不增长才返回），但 DB 兜底仍然
      // 关键：DB 里有上次 useMessageSync 持久化的老消息，DOM 当下渲染不出来的能补回来。
      // 同时 fire-and-forget syncMessages 把本次 DOM 写进 DB，下次 Generate 即使
      // DOM 全丢（虚拟滚动）也能从 DB 完整恢复。
      const loadAiMessages = async (): Promise<{
        messages: ChatMessage[];
        source: MessageSource;
      }> => {
        // 严格身份校验 —— 必传，防止 jumpToChat 跳错 chat 后 DOM 读到的是别人的消息
        // 被 syncMessages 写错位到当前 contact，污染 messages 表
        const requireMatch: RequireMatch = {
          phone: contact.phone,
          name: contact.name,
          waName: contact.wa_name,
        };
        let dom: ChatMessage[] = [];
        if (needsJump) {
          const query = contact.phone
            ? contact.phone.replace(/^\+/, '')
            : contact.name?.trim() || contact.wa_name?.trim() || '';
          if (query) {
            const ok = await jumpToChat(query, { requireMatch });
            if (ok) dom = await waitForChatMessages(5000, 30, 1);
          } else {
            dom = await waitForChatMessages(5000, 30, 1);
          }
        } else {
          // 即使不需要 jump 也走轮询版——WA Web 冷启动后 div#main 出现 ≈ 6s，
          // bubble 渲染 ≈ 10s+
          // needsJump=false 也 verify 一遍防 React state 跟 WA chat 之间的 race
          if (verifyHeaderMatches(requireMatch)) {
            dom = await waitForChatMessages(5000, 30, 1);
          }
        }
        // 写 DB 前最后一次 sanity check（防 race：generate 期间用户切走 WA chat）
        if (dom.length > 0 && !verifyHeaderMatches(requireMatch)) {
          console.warn(
            '[ClaudeReplySection] DOM 不再是目标客户（用户切了 WA chat？），放弃 DOM 消息走 DB',
            { contactId: contact.id, phone: contact.phone },
          );
          dom = [];
        }
        if (dom.length > 0) {
          void syncMessages(contact.id, dom);
          const merged = await mergeDomWithDbMessages(dom, contact.id, 50);
          return { messages: merged, source: 'dom' };
        }
        const rows = await loadMessages(contact.id, 50);
        if (rows.length === 0) {
          if (guidance.trim()) return { messages: [], source: 'guidance' };
          maybeLogReadFailure('ClaudeReplySection.generate cold-start');
          throw new Error(
            '当前聊天没有可读消息，且数据库里也没历史记录。请先打开 WhatsApp 聊天加载消息，「客户」tab 用「📥 导入手机聊天」导入 .txt 历史，或在下方"销售指令"里写明意图来冷启动。',
          );
        }
        return {
          messages: rows.map((r) => ({
            id: r.wa_message_id,
            fromMe: r.direction === 'outbound',
            text: r.text,
            timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
            sender: null,
          })),
          source: 'db',
        };
      };
      const { messages, source: messageSource } = await loadAiMessages();

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

      // 3. 车型兴趣 —— 续聊也拉（buildFollowUpMessage 现在带精简客户档案 + 车型兴趣，
      // 让 Claude thread 长后也不会忘客户 anchor）
      const { data: viData } = await supabase
        .from('vehicle_interests')
        .select('*')
        .eq('contact_id', contact.id);
      const vehicleInterests: VehicleInterestRow[] = viData ?? [];

      // 4. 构造 prompt + URL
      const url = existingConv?.chat_url ?? 'https://claude.ai/new';
      const prompt = existingConv
        ? buildFollowUpMessage({
            mode: chosenMode,
            newMessages: messages.slice(-50),
            isGroup,
            salesGuidance: guidance.trim() || undefined,
            contact,
            vehicleInterests,
          })
        : buildFirstMessage(
            {
              contact,
              vehicleInterests,
              messages,
              groupMemberNames,
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
    let sourceForLog: MessageSource = 'dom';
    let countForLog = 0;
    try {
      const url = existingConv?.chat_url ?? 'https://claude.ai/new';
      // 没历史 → 第一次连同上下文一起发；有历史 → 只发问题
      let prompt: string;
      let source: MessageSource = 'dom';
      let count = 0;
      // 公共消息加载 —— 跟 generate 一样：DOM 稳态 + 持久化 + DB merge，DOM 空时纯 DB，
      // 都空且 discuss 已提了问题 → guidance（不报错，讨论模式允许）
      const loadDiscussMessages = async (): Promise<{
        messages: ChatMessage[];
        source: MessageSource;
      }> => {
        // 严格校验：discuss 路径之前完全没校验，DOM 抓到啥写到啥
        const requireMatch: RequireMatch = {
          phone: contact.phone,
          name: contact.name,
          waName: contact.wa_name,
        };
        let dom: ChatMessage[] = [];
        if (verifyHeaderMatches(requireMatch)) {
          dom = await waitForChatMessages(5000, 30, 1);
        }
        // 写 DB 前再 verify 一次防 race
        if (dom.length > 0 && !verifyHeaderMatches(requireMatch)) {
          console.warn('[ClaudeReplySection discuss] DOM 不再是目标客户，放弃');
          dom = [];
        }
        if (dom.length > 0) {
          void syncMessages(contact.id, dom);
          const merged = await mergeDomWithDbMessages(dom, contact.id, 50);
          return { messages: merged, source: 'dom' };
        }
        const rows = await loadMessages(contact.id, 50);
        if (rows.length === 0) {
          // 讨论模式：用户已经主动提了问题，无历史也允许（Claude 可基于客户档案回答）
          return { messages: [], source: 'guidance' };
        }
        return {
          messages: rows.map((r) => ({
            id: r.wa_message_id,
            fromMe: r.direction === 'outbound',
            text: r.text,
            timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
            sender: null,
          })),
          source: 'db',
        };
      };

      if (!existingConv) {
        const loaded = await loadDiscussMessages();
        source = loaded.source;
        count = loaded.messages.length;
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
            messages: loaded.messages,
            salesGuidance: q,
          },
          'discuss',
        );
      } else {
        // 续聊讨论也要重发最近 50 条 — Claude 那边 chat thread 看到的只是
        // 上一次 generate 时的历史快照，之后客户陆续发的新消息（最新预算 /
        // 改车型 / 发图）没人喂给它，必须在本次 prompt 里补上。
        // 同时带精简客户档案，防 thread 长后 Claude 忘客户 anchor。
        const loaded = await loadDiscussMessages();
        source = loaded.source;
        count = loaded.messages.length;
        const { data: viData } = await supabase
          .from('vehicle_interests')
          .select('*')
          .eq('contact_id', contact.id);
        prompt = buildFollowUpMessage({
          mode: 'discuss',
          newMessages: loaded.messages.slice(-50),
          isGroup: !!contact.group_jid,
          userQuestion: q,
          contact,
          vehicleInterests: viData ?? [],
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
      const logId = status.kind === 'done' ? status.logId : null;
      if (logId) {
        void markAiReplyFilled(logId);
      }
      // 归因 attribution：记下这次填入，syncMessages 写出站消息时匹配文本来标 ai_source
      void recordFill({ contactId: contact.id, source: 'claude', text: cleanText, logId });
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
            {status.source === 'guidance' && (
              <>📝 仅按销售指令冷启动 ·{' '}</>
            )}
            正在{status.foreground ? '前台' : '后台'}打开 Claude 并发送（
            {MODE_LABELS[status.mode]}）…
          </div>
        )}

        {status.kind === 'error' && (
          <div className="sgc-error">{status.message}</div>
        )}

        {status.kind === 'done' && (
          <GeneratedAtBadge generatedAt={status.generatedAt} />
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
  source: MessageSource;
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
      {source === 'guidance' && (
        <div className="sgc-gem-progress">
          📝 仅按销售指令冷启动生成（无聊天历史）
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

export function ClientRecordCard({
  record,
  contact,
  source = 'claude',
}: {
  record: ParsedClientRecord;
  contact: ContactRow;
  /** 来源标签，写入 ai_extracted 事件的 payload，方便回看是哪个 AI 抽的 */
  source?: 'claude' | 'gpt' | 'gem';
}) {
  const [existingTags, setExistingTags] = useState<string[]>([]);
  const [existingTagsLoaded, setExistingTagsLoaded] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<{ fields: number; tags: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // 自动 apply 锁：每个 (contact_id + record 文本指纹) 只触发一次，
  // 切换客户 / 重新生成回复后才会再 auto-apply
  const autoAppliedKey = useRef<string | null>(null);

  useEffect(() => {
    setExistingTagsLoaded(false);
    void supabase
      .from('contact_tags')
      .select('tag')
      .eq('contact_id', contact.id)
      .then(({ data }) => {
        setExistingTags((data ?? []).map((r) => r.tag));
        setExistingTagsLoaded(true);
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

  const apply = useCallback(async () => {
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
        source,
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
  }, [contact.id, patch, tagsToAdd, fieldCount, tagCount, source]);

  // 自动保存：tags 加载完成 + 有要写的字段/标签 + 还没自动应用过这条 record
  // → 静默写入 DB。指纹 = contact.id|record JSON，保证切客户 / 重新生成时
  // 重新触发一次（同一 record 不重复写）
  useEffect(() => {
    if (!existingTagsLoaded || total === 0 || applying || done) return;
    const fingerprint = `${contact.id}|${JSON.stringify(record)}`;
    if (autoAppliedKey.current === fingerprint) return;
    autoAppliedKey.current = fingerprint;
    void apply();
  }, [existingTagsLoaded, total, applying, done, contact.id, record, apply]);

  if (!rows.length && !record.tags?.length) return null;

  const hasTags = record.tags && record.tags.length > 0;

  return (
    <details className="sgc-gem-card sgc-gem-card-record" open>
      <summary className="sgc-gem-card-label">👤 AI 识别的客户档案</summary>
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
          {applying ? (
            <span className="sgc-muted">💾 自动保存中…</span>
          ) : done ? (
            <span className="sgc-muted">
              ✅ 已自动保存 {done.fields} 项字段
              {done.tags > 0 ? ` + ${done.tags} 个标签` : ''}
            </span>
          ) : total === 0 ? (
            <span className="sgc-muted">客户资料已是最新</span>
          ) : null}
        </div>

        {error && (
          <div className="sgc-error">
            自动保存失败：{error}
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => {
                autoAppliedKey.current = null;
                void apply();
              }}
              style={{ marginLeft: 8 }}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

