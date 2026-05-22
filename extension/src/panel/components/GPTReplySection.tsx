import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  waitForChatMessages,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { loadMessages, mergeDomWithDbMessages, syncMessages } from '@/lib/message-sync';
import {
  buildFirstMessage,
  buildFollowUpMessage,
  buildDiscussionMessage,
} from '@/lib/gpt-prompt';
import { parseClaudeResponse } from '@/lib/claude-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { recordFill } from '@/lib/ai-reply-attribution';
import { logAiReply, markAiReplyFilled } from '@/lib/ai-reply-log';
import { sanitizeReplyForCustomer, wasReplyDirty } from '@/lib/reply-sanitize';
import { ReplyCard } from './ReplyCard';
import { ClientRecordCard } from './ClaudeReplySection';
import { GPTTemplatesModal } from './GPTTemplatesModal';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type GptConvRow = Database['public']['Tables']['gpt_conversations']['Row'];
type GptTemplateRow = Database['public']['Tables']['gpt_templates']['Row'];
type VehicleInterestRow =
  Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  orgId: string;
  contact: ContactRow;
  needsJump?: boolean;
}

type Mode = 'reply' | 'discuss';

/** 'dom' = 实时 WA 聊天；'db' = 导入的历史；
 *  'guidance' = 完全没历史，仅按销售指令冷启动生成（新客户首条开场白） */
type MessageSource = 'dom' | 'db' | 'guidance';

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | {
      kind: 'sending';
      foreground: boolean;
      mode: Mode;
      source: MessageSource;
      count: number;
    }
  | {
      kind: 'done';
      mode: Mode;
      text: string;
      chatUrl: string;
      source: MessageSource;
      count: number;
      logId: string | null;
    }
  | { kind: 'error'; message: string };

/**
 * GPT 回复 — 走 chatgpt.com 网页端自动化。
 *
 * 跟 Gem 一样的模板架构（per-user）：
 *   - 用户在 chatgpt.com/gpts 自建 Custom GPT，URL 录入 gpt_templates 表
 *   - 每个 (contact, template) 的对话 URL 缓存到 gpt_conversations，下次续聊
 *   - per-user RLS：每个销售只看到自己 ChatGPT 账号下的 Custom GPT
 *   - 没有模板时不让生成（必须先建一个，URL 可填默认 https://chatgpt.com/?model=gpt-5-thinking）
 *
 * 两条主流程：
 *   - generate(): 给客户写下一条回复（三段 Client Record / WhatsApp Reply / Translation & Strategy）
 *   - sendDiscussion(): 跟 GPT 商量这客户怎么办（自由中文回答，不走三段格式）
 */
export function GPTReplySection({ orgId, contact, needsJump }: Props) {
  const [templates, setTemplates] = useState<GptTemplateRow[]>([]);
  const [conversations, setConversations] = useState<GptConvRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [foreground, setForeground] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [guidance, setGuidance] = useState('');
  const [guidanceLoaded, setGuidanceLoaded] = useState(false);
  const [discuss, setDiscuss] = useState('');

  // ── 前台开关 ──
  useEffect(() => {
    void chrome.storage.local.get('gptForeground').then((s) => {
      setForeground(Boolean(s.gptForeground));
    });
  }, []);

  // ── 模板 + 对话拉取 ──
  const refreshTemplates = async () => {
    const { data } = await supabase
      .from('gpt_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    setTemplates(data ?? []);
  };

  const refreshConversations = async () => {
    const { data } = await supabase
      .from('gpt_conversations')
      .select('*')
      .eq('contact_id', contact.id);
    setConversations(data ?? []);
  };

  useEffect(() => {
    void refreshTemplates();
  }, [orgId]);

  useEffect(() => {
    void refreshConversations();
    setStatus({ kind: 'idle' });
    setDiscuss('');
  }, [contact.id]);

  // ── 一次性迁移：把老的 chrome.storage.local['gptCustomUrl'] 转成第一个模板 ──
  // 0026 之前用户把 Custom GPT URL 存在 chrome.storage 里。改 DB 模板后，
  // 第一次打开看到自己有老 URL 但没模板 → 自动建一个名叫"我的 Custom GPT"的模板，
  // 然后清掉 chrome.storage 那条。一台机器一次。
  useEffect(() => {
    if (templates.length > 0) return; // 已经有模板就不动
    let cancelled = false;
    void chrome.storage.local.get('gptCustomUrl').then(async (s) => {
      const legacy =
        typeof s.gptCustomUrl === 'string' ? s.gptCustomUrl.trim() : '';
      if (!legacy || cancelled) return;
      // 建模板（created_by 由 trigger 自动填 auth.uid()）
      const { error } = await supabase.from('gpt_templates').insert({
        org_id: orgId,
        name: '我的 Custom GPT',
        gpt_url: legacy,
        description: '从旧 chrome.storage 自动迁移',
        is_default: true,
      });
      if (error) {
        console.warn('[gpt-template-migrate]', error.message);
        return;
      }
      await chrome.storage.local.remove('gptCustomUrl');
      if (!cancelled) await refreshTemplates();
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, templates.length]);

  // 自动选默认（or 第一个）模板
  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      const def = templates.find((t) => t.is_default) ?? templates[0];
      setSelectedTemplateId(def.id);
    }
  }, [templates, selectedTemplateId]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  const existingConv = useMemo(
    () =>
      conversations.find((c) => c.template_id === selectedTemplateId) ?? null,
    [conversations, selectedTemplateId],
  );

  // ── 销售指令（per-contact 持久化） ──
  const guidanceKey = `gptGuidance:${contact.id}`;
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

  const toggleForeground = (next: boolean) => {
    setForeground(next);
    void chrome.storage.local.set({ gptForeground: next });
  };

  // ── 公共：读 messages（DOM 优先，DB merge 补齐，最后 fallback 纯 DB） ──
  //
  // 关键：DOM 路径下也强制 merge DB —— 因为 WA Web 渲染消息从下往上慢慢出现，
  // 销售刚发完图就点 Generate 时 DOM 可能只有最新 1 条 bubble，DB 必须兜底
  // 把老消息加回来（waitForChatMessages 改稳态判定后好了很多，但仍可能漏）。
  // 同时 fire-and-forget syncMessages 让本次 DOM 持久化到 DB，下次 Generate
  // 即使 DOM 全丢（虚拟滚动）也能从 DB 完整恢复。
  const loadChatMessages = async (): Promise<{
    messages: ChatMessage[];
    source: MessageSource;
  }> => {
    let messages: ChatMessage[] = [];
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
      messages = await waitForChatMessages(5000, 30, 1);
    }
    if (messages.length > 0) {
      // DOM 路径：持久化 + merge
      void syncMessages(contact.id, messages);
      const merged = await mergeDomWithDbMessages(messages, contact.id, 50);
      return { messages: merged, source: 'dom' };
    }
    // DOM 空 → 纯 DB
    const rows = await loadMessages(contact.id, 50);
    if (rows.length === 0) {
      // 冷启动：完全没历史，但用户在销售指令里写了意图 → 按指令冷开。
      // 用于新客户首条开场白（如 FB lead 注册没说话就要主动推车）。
      if (guidance.trim()) {
        return { messages: [], source: 'guidance' };
      }
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

  const loadGroupMemberNames = async (): Promise<string[] | undefined> => {
    if (!contact.group_jid || existingConv) return undefined;
    try {
      const { readWhatsAppData } = await import('@/lib/whatsapp-idb');
      const wa = await readWhatsAppData();
      const chat = wa.chats.find((c) => c.id === contact.group_jid);
      if (!chat) return undefined;
      const contactByJid = new Map(wa.contacts.map((c) => [c.id, c]));
      return chat.participants.map((jid) => {
        const c = contactByJid.get(jid);
        return (
          (c?.name ?? '').trim() ||
          (c?.shortName ?? '').trim() ||
          (c?.pushname ?? '').trim() ||
          jid.split('@')[0]
        );
      });
    } catch {
      return undefined;
    }
  };

  // ── 主流程 1：写客户回复 ──

  const generate = async () => {
    if (!selectedTemplate) {
      setStatus({
        kind: 'error',
        message: '请先选择一个 Custom GPT 模板，或点"管理模板"添加。',
      });
      return;
    }
    setStatus({ kind: 'reading' });
    const startedAt = Date.now();
    let promptForLog = '';
    let messageSourceForLog: MessageSource = 'dom';
    let messageCountForLog = 0;
    const guidanceForLog = guidance.trim();
    // useCustomGpt 总是 true：模板化后所有调用都走用户自建的 Custom GPT URL，
    // 链接里的 instructions 已含 Miles 角色，不再重发 ROLE_PROMPT
    const useCustomGpt = true;
    try {
      const { messages, source: messageSource } = await loadChatMessages();
      // loadChatMessages 已经处理了 DOM merge + 持久化（避免 prompt 只有 1 条最新消息的 bug）
      const isGroup = !!contact.group_jid;
      const groupMemberNames = isGroup ? await loadGroupMemberNames() : undefined;

      let vehicleInterests: VehicleInterestRow[] = [];
      if (!existingConv) {
        const { data } = await supabase
          .from('vehicle_interests')
          .select('*')
          .eq('contact_id', contact.id);
        vehicleInterests = data ?? [];
      }

      const url = existingConv?.chat_url ?? selectedTemplate.gpt_url;
      const prompt = existingConv
        ? buildFollowUpMessage({
            newMessages: messages.slice(-50),
            isGroup,
            salesGuidance: guidance.trim() || undefined,
          })
        : buildFirstMessage({
            contact,
            vehicleInterests,
            messages,
            groupMemberNames,
            salesGuidance: guidance.trim() || undefined,
            useCustomGpt,
          });
      promptForLog = prompt;
      messageSourceForLog = messageSource;
      messageCountForLog = messages.length;

      setStatus({
        kind: 'sending',
        foreground,
        mode: 'reply',
        source: messageSource,
        count: messages.length,
      });
      const response = await chrome.runtime.sendMessage({
        type: 'GPT_RUN',
        url,
        prompt,
        active: foreground,
        // Custom GPT 里已设了模型；默认 URL 也带了 ?model=gpt-5-thinking query param。
        // ensureThinking 是 DOM 点击切换的保险路径，默认不开（避免误点）。
        ensureThinking: false,
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? 'GPT 调用失败');
      }

      const newChatUrl: string = response.chatUrl;
      if (existingConv) {
        await supabase
          .from('gpt_conversations')
          .update({
            chat_url: newChatUrl,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', existingConv.id);
      } else {
        await supabase.from('gpt_conversations').insert({
          contact_id: contact.id,
          template_id: selectedTemplate.id,
          chat_url: newChatUrl,
        });
      }
      await refreshConversations();

      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: existingConv ? 'gpt_followup' : 'gpt_first',
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
        mode: 'reply',
        text: response.responseText,
        chatUrl: newChatUrl,
        source: messageSource,
        count: messages.length,
        logId,
      });
      setGuidance('');
    } catch (err) {
      const msg = stringifyError(err);
      void logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: existingConv ? 'gpt_followup' : 'gpt_first',
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        guidance: guidanceForLog || null,
        messageSource: messageSourceForLog,
        messageCount: messageCountForLog,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      if (msg.includes('GPT_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message:
            '需要先登录 ChatGPT。请打开 https://chatgpt.com 登录后再试（同一个 Chrome profile 即可）。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  // ── 主流程 2：跟 GPT 讨论这客户 ──

  const sendDiscussion = async () => {
    const q = discuss.trim();
    if (!q) return;
    if (!selectedTemplate) {
      setStatus({
        kind: 'error',
        message: '请先选择一个 Custom GPT 模板，或点"管理模板"添加。',
      });
      return;
    }
    setStatus({ kind: 'reading' });
    const startedAt = Date.now();
    let promptForLog = '';
    let sourceForLog: MessageSource = 'dom';
    let countForLog = 0;
    const useCustomGpt = true;
    try {
      const url = existingConv?.chat_url ?? selectedTemplate.gpt_url;
      let prompt: string;
      let source: MessageSource = 'dom';
      let count = 0;
      if (!existingConv) {
        // 第一次讨论 — 带客户上下文 + 历史
        const loaded = await loadChatMessages();
        source = loaded.source;
        count = loaded.messages.length;
        const isGroup = !!contact.group_jid;
        const groupMemberNames = isGroup ? await loadGroupMemberNames() : undefined;
        const { data } = await supabase
          .from('vehicle_interests')
          .select('*')
          .eq('contact_id', contact.id);
        const vehicleInterests = data ?? [];

        prompt = buildDiscussionMessage({
          ctx: {
            contact,
            vehicleInterests,
            messages: loaded.messages,
            groupMemberNames,
            useCustomGpt,
          },
          question: q,
        });
      } else {
        // 续聊讨论也要补发最近 50 条 — GPT 那边 chat thread 看到的只是
        // 上一次 generate 时的历史快照，之后客户陆续发的新消息（最新预算 /
        // 改车型 / 发图）没人喂给它，必须在本次 prompt 里补上。
        const loaded = await loadChatMessages();
        source = loaded.source;
        count = loaded.messages.length;
        prompt = buildDiscussionMessage({
          newMessages: loaded.messages.slice(-50),
          isGroup: !!contact.group_jid,
          question: q,
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
        type: 'GPT_RUN',
        url,
        prompt,
        active: foreground,
        ensureThinking: false,
      });
      if (!response?.ok) throw new Error(response?.error ?? 'GPT 调用失败');

      const newChatUrl: string = response.chatUrl;
      if (existingConv) {
        await supabase
          .from('gpt_conversations')
          .update({
            chat_url: newChatUrl,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', existingConv.id);
      } else {
        await supabase.from('gpt_conversations').insert({
          contact_id: contact.id,
          template_id: selectedTemplate.id,
          chat_url: newChatUrl,
        });
      }
      await refreshConversations();

      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gpt',
        mode: 'gpt_discuss',
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
        source: 'gpt',
        mode: 'gpt_discuss',
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        guidance: q,
        messageSource: sourceForLog,
        messageCount: countForLog,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      if (msg.includes('GPT_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message: '需要先登录 ChatGPT。打开 https://chatgpt.com 登录后再试。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  const reset = async () => {
    if (!existingConv) return;
    if (!confirm('清除此客户在此 Custom GPT 上的对话？下次将开新对话。')) return;
    await supabase
      .from('gpt_conversations')
      .delete()
      .eq('id', existingConv.id);
    await refreshConversations();
    setStatus({ kind: 'idle' });
    setDiscuss('');
  };

  const parsed = useMemo(
    () =>
      status.kind === 'done' && status.mode === 'reply'
        ? parseClaudeResponse(status.text)
        : null,
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
      const wasDirty = wasReplyDirty(text);
      const cleanText = sanitizeReplyForCustomer(text);
      if (!cleanText) {
        alert('回复为空（GPT 没生成有效的 [WhatsApp Reply] 段）');
        return;
      }
      if (wasDirty) {
        const ok = confirm(
          'GPT 的回复里夹了内部段落（[Strategy] / 备注 之类），已自动剥掉。确认要把净化后的版本发给客户？',
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
      const logId = status.kind === 'done' ? status.logId : null;
      if (logId) {
        void markAiReplyFilled(logId);
      }
      // 归因 attribution：记下这次填入，syncMessages 写出站消息时匹配文本来标 ai_source
      void recordFill({ contactId: contact.id, source: 'gpt', text: cleanText, logId });
    } catch (err) {
      alert(stringifyError(err));
    }
  };

  const busy = status.kind === 'reading' || status.kind === 'sending';

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">
          🧠 GPT AI 回复{' '}
          {selectedTemplate && (
            <span
              className="sgc-muted"
              style={{ fontSize: 11, fontWeight: 400 }}
            >
              · {selectedTemplate.name}
            </span>
          )}
        </div>
        <div className="sgc-section-actions">
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => setShowTemplates(true)}
          >
            管理模板
          </button>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="sgc-empty">
          还没有 Custom GPT 模板。
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => setShowTemplates(true)}
          >
            添加模板
          </button>
          <div
            className="sgc-muted"
            style={{ fontSize: 11, marginTop: 6 }}
          >
            可填 chatgpt.com/g/g-xxx 自建 GPT URL，或填默认{' '}
            <code>https://chatgpt.com/?model=gpt-5-thinking</code> 直接用 Thinking 模型
          </div>
        </div>
      ) : (
        <div className="sgc-gem-section">
          <div className="sgc-gem-controls">
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              disabled={busy}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_default ? ' · 默认' : ''}
                </option>
              ))}
            </select>
            <label
              className="sgc-checkbox-row"
              style={{ marginBottom: 0, fontSize: 12 }}
              title="开启后会切到 ChatGPT 标签页便于调试"
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
              disabled={busy || !selectedTemplateId}
            >
              {busy
                ? status.kind === 'reading'
                  ? '读取聊天…'
                  : status.kind === 'sending' && status.mode === 'reply'
                    ? '🧠 GPT 思考中…'
                    : '处理中…'
                : existingConv
                  ? '续聊生成'
                  : '生成'}
            </button>
          </div>

          {/* 销售指令（per-contact 持久化） */}
          <div className="sgc-gem-guidance" style={{ marginTop: 12 }}>
            <div
              className="sgc-section-title"
              style={{ fontSize: 12, marginBottom: 4 }}
            >
              🎯 想让 GPT 怎么回？（可选）
            </div>
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (!busy && selectedTemplateId) void generate();
                }
              }}
              placeholder="可选 · Cmd/Ctrl+Enter 直接生成
例：用法语回 / 客气一点 / 强调 1 万定金锁车 / 直接报 35k USD / 别问太多问题"
              rows={3}
              disabled={busy}
            />
          </div>

          {/* 续聊状态 */}
          {existingConv && (
            <div className="sgc-gem-progress">
              已有对话 · 最近使用 {new Date(existingConv.last_used_at).toLocaleString()}
              <a
                className="sgc-btn-link"
                href={existingConv.chat_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: 8 }}
                title="在新标签页打开此客户在 ChatGPT 上的对话"
              >
                🔗 打开 ChatGPT
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
              正在{status.foreground ? '前台' : '后台'}打开 ChatGPT 并
              {status.mode === 'discuss' ? '发送讨论' : '生成回复'}…
            </div>
          )}

          {status.kind === 'error' && (
            <div className="sgc-error">{status.message}</div>
          )}

          {status.kind === 'done' && status.mode === 'reply' && parsed && (
            <ResultView
              parsed={parsed}
              source={status.source}
              count={status.count}
              chatUrl={status.chatUrl}
              contact={contact}
              onFillReply={fillReply}
              onCopy={copyToClipboard}
            />
          )}

          {status.kind === 'done' && status.mode === 'discuss' && (
            <DiscussionResultView
              text={status.text}
              chatUrl={status.chatUrl}
              onCopy={copyToClipboard}
            />
          )}

          {/* 讨论框（永远显示在底部） */}
          <div className="sgc-gem-guidance" style={{ marginTop: 14 }}>
            <div
              className="sgc-section-title"
              style={{ fontSize: 12, marginBottom: 4 }}
            >
              💬 跟 GPT 讨论这客户
              {!existingConv && (
                <span
                  className="sgc-muted"
                  style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}
                >
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
                  ? '例：他这句话什么意思 / 如果对方嫌贵怎么办 / 这个客户值不值得继续追'
                  : '例：先帮我分析这客户 / 这单值不值得追 / 怎么破他的"再考虑考虑"'
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
      )}

      {showTemplates && (
        <GPTTemplatesModal
          orgId={orgId}
          onClose={async () => {
            setShowTemplates(false);
            await refreshTemplates();
          }}
        />
      )}
    </section>
  );
}

// ── ResultView（reply 模式：三段解析） ──

interface ResultViewProps {
  parsed: ReturnType<typeof parseClaudeResponse>;
  source: MessageSource;
  count: number;
  chatUrl: string;
  contact: ContactRow;
  onFillReply: (text: string) => void;
  onCopy: (text: string) => void;
}

function ResultView({
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

      {parsed.reply && (
        <ReplyCard
          label="💬 给客户的回复"
          reply={parsed.reply}
          existingTranslation={parsed.translation}
          onFillReply={onFillReply}
          onCopy={onCopy}
        />
      )}

      {parsed.strategy && (
        <div
          className="sgc-gem-card"
          style={{ background: '#f0f9ff', borderColor: '#bae6fd' }}
        >
          <div className="sgc-gem-card-label">💡 销售策略</div>
          <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
            {parsed.strategy}
          </div>
        </div>
      )}

      {parsed.clientRecord && (
        <ClientRecordCard
          record={parsed.clientRecord}
          contact={contact}
          source="gpt"
        />
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
          在 ChatGPT 打开此对话
        </a>
      </div>
    </>
  );
}

// ── DiscussionResultView（discuss 模式：自由中文文本） ──

function DiscussionResultView({
  text,
  chatUrl,
  onCopy,
}: {
  text: string;
  chatUrl: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div
      className="sgc-gem-card"
      style={{ background: '#fff7ed', borderColor: '#fed7aa' }}
    >
      <div className="sgc-gem-card-label">🧠 GPT 的分析</div>
      <div className="sgc-gem-card-body" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </div>
      <div className="sgc-gem-result-actions">
        <button
          type="button"
          className="sgc-btn-secondary"
          onClick={() => onCopy(text)}
        >
          📋 复制
        </button>
        <a
          className="sgc-btn-link"
          href={chatUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          在 ChatGPT 继续
        </a>
      </div>
    </div>
  );
}
