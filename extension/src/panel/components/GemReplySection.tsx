import { useEffect, useMemo, useState } from 'react';
import { usePersistedReplyStatus } from '@/panel/hooks/usePersistedReplyStatus';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  loadChatContext,
  loadGroupMemberNames,
  type MessageSource,
} from '@/lib/chat-context';
import { formatNewCustomer, formatUpdate } from '@/lib/gem-prompt';
import {
  parseBudgetValue,
  parseGemResponse,
  type ParsedClientRecord,
} from '@/lib/gem-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { recordFill } from '@/lib/ai-reply-attribution';
import { setReplyProgress, clearReplyProgress } from '@/lib/reply-progress';
import { useReplyProgress } from '../hooks/useReplyProgress';
import { logContactEvent } from '@/lib/events-log';
import type { CustomerStage } from '@/lib/database.types';
import { logAiReply, markAiReplyFilled } from '@/lib/ai-reply-log';
import { sanitizeReplyForCustomer, wasReplyDirty } from '@/lib/reply-sanitize';
import { ReplyCard } from './ReplyCard';
import { GemTemplatesModal } from './GemTemplatesModal';
import { GeneratedAtBadge } from './GeneratedAtBadge';
import {
  GEM_MODELS,
  DEFAULT_GEM_MODEL,
  GEM_MODEL_STORAGE_KEY,
  getGemModelPreset,
} from '@/lib/gem-models';

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
  const [gemModel, setGemModel] = useState<string>(DEFAULT_GEM_MODEL);
  const [status, setStatus] = usePersistedReplyStatus<Status>('gem', contact.id, { kind: 'idle' });
  const [showTemplates, setShowTemplates] = useState(false);
  const [followup, setFollowup] = useState('');
  const [followupLoaded, setFollowupLoaded] = useState(false);

  // Load foreground + model preference（全局，不按 contact 隔离）
  useEffect(() => {
    void chrome.storage.local
      .get(['gemForeground', GEM_MODEL_STORAGE_KEY])
      .then((s) => {
        setForeground(Boolean(s.gemForeground));
        if (typeof s[GEM_MODEL_STORAGE_KEY] === 'string') {
          setGemModel(s[GEM_MODEL_STORAGE_KEY] as string);
        }
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

  const changeModel = (next: string) => {
    setGemModel(next);
    void chrome.storage.local.set({ [GEM_MODEL_STORAGE_KEY]: next });
  };

  const generate = async () => {
    if (!selectedTemplateId) return;
    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) return;

    const isGroup = !!contact.group_jid;

    setStatus({ kind: 'reading' });
    // 左栏那一行立刻显示「⏳ 生成中」——切走客户也还在，见 reply-progress
    void setReplyProgress(contact.id, 'generating', 'gem');
    const startedAt = Date.now();
    let promptForLog = '';
    let messageSourceForLog: MessageSource = 'dom';
    let messageCountForLog = 0;
    const guidanceForLog = followup.trim();
    const modeForLog = existingConv ? 'gem_followup' : 'gem_first';
    try {
      // 1. Read chat messages — DOM 优先 + DB merge + 持久化；DOM 空时 fallback 到
      // messages 表（导入的历史）。共享实现见 lib/chat-context.ts。
      const { messages, source: messageSource } = await loadChatContext(
        contact,
        {
          needsJump: Boolean(needsJump),
          logTag: 'GemReplySection.generate',
          guidance: followup,
        },
      );

      // 2. Load vehicle interests for richer context —— 续聊也拉（formatUpdate 现在带
      // 精简客户档案 + 车型兴趣，让 Gem 对话长后也不会忘客户 anchor）
      const { data: viData } = await supabase
        .from('vehicle_interests')
        .select('*')
        .eq('contact_id', contact.id);
      const vehicleInterests: VehicleInterestRow[] = viData ?? [];

      // 2.5. 群聊：从 IDB 拉成员名单给 Gem 用
      const groupMemberNames =
        isGroup && !existingConv
          ? await loadGroupMemberNames(contact.group_jid)
          : undefined;

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
      const modelPreset = getGemModelPreset(gemModel);
      const response = await chrome.runtime.sendMessage({
        type: 'GEM_RUN',
        url,
        prompt,
        active: foreground,
        preferModel: modelPreset.prefer,
        avoidModel: modelPreset.avoid,
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

      void setReplyProgress(contact.id, 'ready', 'gem');

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
        void clearReplyProgress(contact.id);
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

  const replyProgress = useReplyProgress();
  const busy =
    status.kind === 'reading' ||
    status.kind === 'sending' ||
    status.kind === 'waiting';
  /**
   * 后台还在跑同一个客户的生成。
   *
   * usePersistedReplyStatus 只持久化 done，reading/sending 是 transient ——
   * 所以切走客户再切回来，本地 status 是 idle，生成按钮又可点了，而 SW 那边
   * 其实还在跑（结果会写进旧 contact 的 storage key，不会丢）。不拦的话销售
   * 一并发就容易对同一个人点两次，白烧一次 40-50 秒。
   * reply-progress 是跨组件、跨 mount 的，正好补这个洞。
   */
  const bgPhase = replyProgress[contact.id]?.phase;
  const backgroundBusy = bgPhase === 'generating' && !busy;


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
              disabled={busy || backgroundBusy}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_default ? ' · 默认' : ''}
                </option>
              ))}
            </select>
            <select
              value={gemModel}
              onChange={(e) => changeModel(e.target.value)}
              disabled={busy || backgroundBusy}
              title="Gemini 模型：Flash 快、Pro 最强但慢、Flash-Lite 最快"
            >
              {GEM_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
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
              disabled={busy || backgroundBusy || !selectedTemplateId}
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
              disabled={busy || backgroundBusy}
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
      {backgroundBusy && (
        <div className="sgc-gem-progress">
          ⏳ 这个客户的回复正在后台生成 —— 可以先去处理别的客户，好了左栏那一行会变成「📝 待填入」
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
  // ⛔ AI 不许标成交——只有客户发来水单、人工确认后才是 won（2026-08-19 定）。
  // AI 说的 won/closed/closed_won 一律降级成「已报价」，让人自己判断。
  won: 'quoted',
  closed: 'quoted',
  closed_won: 'quoted',
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
