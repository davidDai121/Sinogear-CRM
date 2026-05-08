import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  readChatMessages,
  waitForChatMessages,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { loadMessages } from '@/lib/message-sync';
import { formatNewCustomer, formatUpdate } from '@/lib/gem-prompt';
import {
  parseBudgetValue,
  parseGemResponse,
  type ParsedClientRecord,
} from '@/lib/gem-parser';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { logContactEvent } from '@/lib/events-log';
import type { CustomerStage } from '@/lib/database.types';
import { GemTemplatesModal } from './GemTemplatesModal';

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
  | { kind: 'sending'; foreground: boolean; source: 'dom' | 'db'; count: number }
  | { kind: 'waiting' }
  | {
      kind: 'done';
      text: string;
      chatUrl: string;
      model: string | null;
      source: 'dom' | 'db';
      count: number;
    }
  | { kind: 'error'; message: string };

export function GemReplySection({ orgId, contact, needsJump }: Props) {
  const [templates, setTemplates] = useState<GemTemplateRow[]>([]);
  const [conversations, setConversations] = useState<GemConversationRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [foreground, setForeground] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
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

    setStatus({ kind: 'reading' });
    try {
      // 1. Read chat messages — DOM 优先；DOM 空时 fallback 到 messages 表（导入的历史）
      let messages: ChatMessage[] = [];
      let messageSource: 'dom' | 'db' = 'dom';
      if (needsJump && contact.phone) {
        const ok = await jumpToChat(contact.phone.replace(/^\+/, ''));
        if (!ok) throw new Error('未能跳转到该客户聊天');
        messages = await waitForChatMessages(5000, 30, 1);
      } else {
        messages = readChatMessages(30);
      }
      if (messages.length === 0) {
        // DOM 没消息（手机端聊天 / WA Web 还没加载），用导入的历史
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
        }));
        messageSource = 'db';
      }

      // 2. Load vehicle interests for richer context (only on new conversation)
      let vehicleInterests: VehicleInterestRow[] = [];
      if (!existingConv) {
        const { data } = await supabase
          .from('vehicle_interests')
          .select('*')
          .eq('contact_id', contact.id);
        vehicleInterests = data ?? [];
      }

      // 3. Build prompt + url
      const url = existingConv?.gem_chat_url ?? template.gem_url;
      const basePrompt = existingConv
        ? formatUpdate(contact.phone, messages.slice(-5))
        : formatNewCustomer({
            contact,
            vehicleInterests,
            messages,
          });
      // 销售自定义指令（来自 textarea）— 高优先级，覆盖默认风格
      const guidance = followup.trim();
      const prompt = guidance
        ? `[Sales Guidance — TOP PRIORITY]\n${guidance}\n\nThe guidance above OVERRIDES default style. Apply it strictly to the [WhatsApp Reply].\n\n${basePrompt}`
        : basePrompt;

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

      setStatus({
        kind: 'done',
        text: response.responseText,
        chatUrl: newChatUrl,
        model: response.modelSelected ?? null,
        source: messageSource,
        count: messages.length,
      });
      setFollowup('');
    } catch (err) {
      const msg = stringifyError(err);
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
      if (needsJump && contact.phone) {
        const ok = await jumpToChat(contact.phone.replace(/^\+/, ''));
        if (!ok) {
          alert('未能跳转到该客户聊天，请先手动打开聊天再点填入');
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      const ok = fillWhatsAppCompose(text);
      if (!ok) {
        alert('找不到 WhatsApp 输入框，请确认聊天已打开');
      }
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
              正在{status.foreground ? '前台' : '后台'}打开 Gemini 并发送 prompt…
            </div>
          )}

          {status.kind === 'error' && (
            <div className="sgc-error">{status.message}</div>
          )}

          {status.kind === 'done' && parsed && (
            <>
              {status.model && (
                <div className="sgc-gem-progress">
                  ✅ 用模型：{status.model}
                  {status.source === 'db' && (
                    <> · 📜 基于导入的历史（{status.count} 条）</>
                  )}
                </div>
              )}

              {parsed.reply && (
                <div className="sgc-gem-card sgc-gem-card-reply">
                  <div className="sgc-gem-card-label">
                    💬 给客户的回复
                  </div>
                  <div className="sgc-gem-card-body">{parsed.reply}</div>
                  <div className="sgc-gem-result-actions">
                    <button
                      type="button"
                      className="sgc-btn-primary"
                      onClick={() => fillReply(parsed.reply!)}
                      title="把这段回复填入下方 WhatsApp 输入框（不自动发送）"
                    >
                      💬 填入聊天框
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-secondary"
                      onClick={() => copyToClipboard(parsed.reply!)}
                    >
                      📋 复制
                    </button>
                  </div>
                </div>
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
