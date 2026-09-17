import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, CustomerStage } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { parseBudgetValue, type ParsedClientRecord } from '@/lib/claude-parser';
import { logContactEvent } from '@/lib/events-log';
type ContactRow = Database['public']['Tables']['contacts']['Row'];

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
  if (record.name && !contact.name?.trim()) {
    patch.name = record.name;
  }
  return patch;
}

export function ClientRecordCard({
  record,
  contact,
  source = 'gpt',
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
