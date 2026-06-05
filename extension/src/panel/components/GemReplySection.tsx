import { useEffect, useMemo, useState } from 'react';
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
import { formatNewCustomer, formatUpdate } from '@/lib/gem-prompt';
import {
  parseBudgetValue,
  parseGemResponse,
  type ParsedClientRecord,
} from '@/lib/gem-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { recordFill } from '@/lib/ai-reply-attribution';
import { logContactEvent } from '@/lib/events-log';
import type { CustomerStage } from '@/lib/database.types';
import { logAiReply, markAiReplyFilled } from '@/lib/ai-reply-log';
import { sanitizeReplyForCustomer, wasReplyDirty } from '@/lib/reply-sanitize';
import { ReplyCard } from './ReplyCard';
import { GemTemplatesModal } from './GemTemplatesModal';
import { GeneratedAtBadge } from './GeneratedAtBadge';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type GemTemplateRow = Database['public']['Tables']['gem_templates']['Row'];
type GemConversationRow =
  Database['public']['Tables']['gem_conversations']['Row'];
type VehicleInterestRow =
  Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  orgId: string;
  contact: ContactRow;
  /** 如果不在当前 WhatsApp 聊天窗口，传手机号让我们 jumpToChat */
  needsJump?: boolean;
}

/** 'dom' = 实时 WA 聊天；'db' = 导入的历史；
 *  'guidance' = 完全没历史，仅按销售指令冷启动生成（新客户首条开场白） */
type MessageSource = 'dom' | 'db' | 'guidance';

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'sending'; foreground: boolean; source: MessageSource; count: number }
  | { kind: 'waiting' }
  | {
      kind: 'done';
      text: string;
      chatUrl: string;
      model: string | null;
      source: MessageSource;
      count: number;
      /** ai_reply_logs row id — fillReply 用它把 was_filled 翻成 true */
      logId: string | null;
      /** 自动由 usePersistedReplyStatus 注入（done 状态写 chrome.storage 时盖戳） */
      generatedAt?: number;
    }
  | { kind: 'error'; message: string };

export function GemReplySection({ orgId, contact, needsJump }: Props) {
  const [templates, setTemplates] = useState<GemTemplateRow[]>([]);
  const [conversations, setConversations] = useState<GemConversationRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [foreground, setForeground] = useState(false);
  const [status, setStatus] = usePersistedReplyStatus<Status>('gem', contact.id, { kind: 'idle' });
  const [showTemplates, setShowTemplates] = useState(false);
  const [followup, setFollowup] = useState('');
  const [followupLoaded, setFollowupLoaded] = useState(false);

  // Load foreground preference
  useEffect(() => {
    void chrome.storage.local.get('gemForeground').then((s) => {
      setForeground(Boolean(s.gemForeground));
    });
  }, []);

  // 每个客户独立存草稿；切 tab / 失败 / 切客户回来都能拿回输入
  const guidanceKey = `gemGuidance:${contact.id}`;
  useEffect(() => {
    setFollowupLoaded(false);
    void chrome.storage.local.get(guidanceKey).then((s) => {
      const saved = typeof s[guidanceKey] === 'string' ? (s[guidanceKey] as string) : '';
      setFollowup(saved);
      setFollowupLoaded(true);
    });
  }, [guidanceKey]);

  useEffect(() => {
    if (!followupLoaded) return;
    if (followup) {
      void chrome.storage.local.set({ [guidanceKey]: followup });
    } else {
      void chrome.storage.local.remove(guidanceKey);
    }
  }, [followup, followupLoaded, guidanceKey]);

  const refreshTemplates = async () => {
    const { data } = await supabase
      .from('gem_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    setTemplates(data ?? []);
  };

  const refreshConversations = async () => {
    const { data } = await supabase
      .from('gem_conversations')
      .select('*')
      .eq('contact_id', contact.id);
    setConversations(data ?? []);
  };

  useEffect(() => {
    void refreshTemplates();
  }, [orgId]);

  useEffect(() => {
    void refreshConversations();
  }, [contact.id]);

  // Auto-select default template (or first) when templates load
  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      const def = templates.find((t) => t.is_default) ?? templates[0];
      setSelectedTemplateId(def.id);
    }
  }, [templates, selectedTemplateId]);

  const existingConv = useMemo(
    () =>
      conversations.find((c) => c.template_id === selectedTemplateId) ?? null,
    [conversations, selectedTemplateId],
  );

  const toggleForeground = (next: boolean) => {
    setForeground(next);
    void chrome.storage.local.set({ gemForeground: next });
  };

  const generate = async () => {
    if (!selectedTemplateId) return;
    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) return;

    const isGroup = !!contact.group_jid;

    setStatus({ kind: 'reading' });
    const startedAt = Date.now();
    let promptForLog = '';
    let messageSourceForLog: MessageSource = 'dom';
    let messageCountForLog = 0;
    const guidanceForLog = followup.trim();
    const modeForLog = existingConv ? 'gem_followup' : 'gem_first';
    try {
      // 1. Read chat messages — DOM 优先 + DB merge + 持久化；DOM 空时 fallback 到
      // messages 表（导入的历史）
      //
      // DOM 路径必须 merge DB：WA Web 渲染从下往上慢慢出现，刚发完图就点 Generate
      // DOM 可能只有最新 1 条 bubble。waitForChatMessages 改稳态判定后好了很多，
      // 但 DB 兜底仍然关键。同时 fire-and-forget syncMessages 把本次 DOM 持久化，
      // 下次 Generate 即使 DOM 全丢（虚拟滚动）也能从 DB 完整恢复。
      //
      // jumpToChat 不开启 deep-link fallback——若开启会触发 reload，中断当前 generate()。
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
          // 个人按手机号跳，群按群名跳（jumpToChat 会按搜索匹配上）
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
          // needsJump=false 也 verify 一遍防 React state 跟 WA chat 之间的 race
          if (verifyHeaderMatches(requireMatch)) {
            dom = await waitForChatMessages(5000, 30, 1);
          }
        }
        // 写 DB 前最后一次 sanity check（防 race：generate 期间用户切走 WA chat）
        if (dom.length > 0 && !verifyHeaderMatches(requireMatch)) {
          console.warn(
            '[GemReplySection] DOM 不再是目标客户（用户切了 WA chat？），放弃 DOM 消息走 DB',
            { contactId: contact.id, phone: contact.phone },
          );
          dom = [];
        }
        if (dom.length > 0) {
          void syncMessages(contact.id, dom);
          const merged = await mergeDomWithDbMessages(dom, contact.id, 50);
          return { messages: merged, source: 'dom' };
        }
        // DOM 没消息（手机端聊天 / WA Web 还没加载），用导入的历史
        const rows = await loadMessages(contact.id, 50);
        if (rows.length === 0) {
          // 冷启动：完全没历史，但用户在销售指令里写了意图 → 按指令冷开
          if (followup.trim()) return { messages: [], source: 'guidance' };
          maybeLogReadFailure('GemReplySection.generate cold-start');
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
            // DB 加载的历史消息没存 sender；群聊从 messages 表 fallback 时拿不到，
            // 但 Gem prompt 里仍能正常按 fromMe 区分销售/客户
            sender: null,
          })),
          source: 'db',
        };
      };
      const { messages, source: messageSource } = await loadAiMessages();

      // 2. Load vehicle interests for richer context —— 续聊也拉（formatUpdate 现在带
      // 精简客户档案 + 车型兴趣，让 Gem 对话长后也不会忘客户 anchor）
      const { data: viData } = await supabase
        .from('vehicle_interests')
        .select('*')
        .eq('contact_id', contact.id);
      const vehicleInterests: VehicleInterestRow[] = viData ?? [];

      // 2.5. 群聊：从 IDB 拉成员名单给 Gem 用
      let groupMemberNames: string[] | undefined;
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

      // 3. Build prompt + url
      const url = existingConv?.gem_chat_url ?? template.gem_url;
      const updateLabel = isGroup
        ? contact.name?.trim() || contact.wa_name?.trim() || null
        : contact.phone;
      const basePrompt = existingConv
        ? formatUpdate(updateLabel, messages.slice(-50), isGroup, contact, vehicleInterests)
        : formatNewCustomer({
            contact,
            vehicleInterests,
            messages,
            groupMemberNames,
          });
      // 销售自定义指令（来自 textarea）— 高优先级，覆盖默认风格
      const guidance = followup.trim();
      const prompt = guidance
        ? `[Sales Guidance — TOP PRIORITY]\n${guidance}\n\nThe guidance above OVERRIDES default style. Apply it strictly to the [WhatsApp Reply].\n\n${basePrompt}`
        : basePrompt;
      promptForLog = prompt;
      messageSourceForLog = messageSource;
      messageCountForLog = messages.length;

      // 4. Run Gem
      setStatus({
        kind: 'sending',
        foreground,
        source: messageSource,
        count: messages.length,
      });
      const response = await chrome.runtime.sendMessage({
        type: 'GEM_RUN',
        url,
        prompt,
        active: foreground,
        preferModel: ['Pro', '专业', '高级', 'Advanced'],
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Gem 调用失败');
      }

      // 5. Persist gem_conversations
      const newChatUrl: string = response.chatUrl;
      if (existingConv) {
        await supabase
          .from('gem_conversations')
          .update({
            gem_chat_url: newChatUrl,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', existingConv.id);
      } else {
        await supabase.from('gem_conversations').insert({
          contact_id: contact.id,
          template_id: selectedTemplateId,
          gem_chat_url: newChatUrl,
        });
      }
      await refreshConversations();

      const logId = await logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gem',
        mode: modeForLog,
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
        text: response.responseText,
        chatUrl: newChatUrl,
        model: response.modelSelected ?? null,
        source: messageSource,
        count: messages.length,
        logId,
      });
      setFollowup('');
    } catch (err) {
      const msg = stringifyError(err);
      void logAiReply({
        orgId,
        contactId: contact.id,
        source: 'gem',
        mode: modeForLog,
        prompt: promptForLog || '(prompt 未构造完成就出错了)',
        guidance: guidanceForLog || null,
        messageSource: messageSourceForLog,
        messageCount: messageCountForLog,
        durationMs: Date.now() - startedAt,
        error: msg,
      });
      if (msg.includes('GEMINI_AUTH_REQUIRED')) {
        setStatus({
          kind: 'error',
          message:
            '需要先登录 Google 账号。请打开 https://gemini.google.com 登录后再试。',
        });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  const reset = async () => {
    if (!existingConv) return;
    if (!confirm('清除此客户与该模板的 Gem 对话历史？下次将开新对话。')) return;
    await supabase
      .from('gem_conversations')
      .delete()
      .eq('id', existingConv.id);
    await refreshConversations();
    setStatus({ kind: 'idle' });
    setFollowup('');
  };

  const parsed = useMemo(
    () => (status.kind === 'done' ? parseGemResponse(status.text) : null),
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
      // P0 安全：剥掉 LLM 可能夹进 reply 的内部段落（[Translation] / Note: 等）
      const wasDirty = wasReplyDirty(text);
      const cleanText = sanitizeReplyForCustomer(text);
      if (!cleanText) {
        alert('回复为空（Gem 没生成有效的 [WhatsApp Reply] 段）');
        return;
      }
      if (wasDirty) {
        const okConfirm = confirm(
          'Gem 的回复里夹了内部段落（[Translation] / 备注 之类），已自动剥掉。确认要把净化后的版本发给客户？',
        );
        if (!okConfirm) return;
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
      void recordFill({ contactId: contact.id, source: 'gem', text: cleanText, logId });
    } catch (err) {
      alert(stringifyError(err));
    }
  };

  const busy =
    status.kind === 'reading' ||
    status.kind === 'sending' ||
    status.kind === 'waiting';

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">🤖 Gem AI 回复</div>
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
          还没有 Gem 模板。
          <button
            className="sgc-btn-link"
            type="button"
            onClick={() => setShowTemplates(true)}
          >
            添加模板
          </button>
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
              title="开启后会切换到 Gemini 标签页，便于调试"
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
              onClick={generate}
              disabled={busy || !selectedTemplateId}
            >
              {busy
                ? status.kind === 'reading'
                  ? '读取聊天…'
                  : '🤖 Gem 处理中…'
                : existingConv
                  ? '续聊生成'
                  : '生成回复'}
            </button>
          </div>

          {/* 销售自定义指令（永远展示）— 写了就高优先级注入到 prompt 顶部 */}
          <div className="sgc-gem-guidance">
            <textarea
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (!busy && selectedTemplateId) void generate();
                }
              }}
              placeholder="想让 Gem 怎么回？(可选 · Cmd/Ctrl+Enter 直接生成)
例：用法语回 / 客气一点 / 强调 1 万定金锁车 / 直接报 35k USD / 别问太多问题"
              rows={3}
              disabled={busy}
            />
          </div>

          {existingConv && (
            <div className="sgc-gem-progress">
              已有对话 · 最近使用{' '}
              {new Date(existingConv.last_used_at).toLocaleString()}
              <a
                className="sgc-btn-link"
                href={existingConv.gem_chat_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: 8 }}
                title="在新标签页打开此客户在 Gemini 上的对话"
              >
                🔗 打开 Gemini
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
              正在{status.foreground ? '前台' : '后台'}打开 Gemini 并发送 prompt…
            </div>
          )}

          {status.kind === 'error' && (
            <div className="sgc-error">{status.message}</div>
          )}

          {status.kind === 'done' && (
            <GeneratedAtBadge generatedAt={status.generatedAt} />
          )}

          {status.kind === 'done' && parsed && (
            <>
              {status.model && (
                <div className="sgc-gem-progress">
                  ✅ 用模型：{status.model}
                  {status.source === 'db' && (
                    <> · 📜 基于导入的历史（{status.count} 条）</>
                  )}
                  {status.source === 'guidance' && (
                    <> · 📝 仅按销售指令冷启动（无聊天历史）</>
                  )}
                </div>
              )}

              {parsed.reply && (
                <ReplyCard
                  label="💬 给客户的回复"
                  reply={parsed.reply}
                  existingTranslation={parsed.translation}
                  onFillReply={fillReply}
                  onCopy={copyToClipboard}
                />
              )}

              {parsed.translation && (
                <div className="sgc-gem-card sgc-gem-card-translation">
                  <div className="sgc-gem-card-label">🌏 中文翻译/策略</div>
                  <div className="sgc-gem-card-body">{parsed.translation}</div>
                  <div className="sgc-gem-result-actions">
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={() => copyToClipboard(parsed.translation!)}
                    >
                      📋 复制
                    </button>
                  </div>
                </div>
              )}

              {parsed.clientRecord && (
                <ClientRecordCard
                  record={parsed.clientRecord}
                  contact={contact}
                />
              )}

              {!parsed.reply && !parsed.translation && (
                <div className="sgc-gem-result">{status.text}</div>
              )}

              <details className="sgc-gem-raw-toggle">
                <summary>查看完整原始响应</summary>
                <div className="sgc-gem-result">{status.text}</div>
              </details>

              <div className="sgc-gem-result-actions">
                <a
                  className="sgc-btn-link"
                  href={status.chatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  在 Gemini 打开此对话
                </a>
              </div>

            </>
          )}
        </div>
      )}

      {showTemplates && (
        <GemTemplatesModal
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
  // Name: 只在 contact.name 为空时设置（不覆盖已手动填的）
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
    () =>
      (record.tags ?? []).filter(
        (t) => t && !existingTags.includes(t),
      ),
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
        source: 'gem',
        fields: Object.keys(patch),
        tags: tagsToAdd,
      });
      // 把已应用的标签合并到 existingTags，让按钮立即变灰
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
      <summary className="sgc-gem-card-label">
        👤 Gem 识别的客户档案
      </summary>
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
                <span className="sgc-record-diff">
                  · 新增 {tagCount} 个
                </span>
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
