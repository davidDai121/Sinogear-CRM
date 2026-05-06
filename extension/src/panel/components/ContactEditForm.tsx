import { useEffect, useState } from 'react';
import type {
  Database,
  CustomerStage,
  CustomerQuality,
} from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

const STAGES: { value: CustomerStage; label: string }[] = [
  { value: 'new', label: '新客户' },
  { value: 'qualifying', label: '资质确认' },
  { value: 'negotiating', label: '跟进中' },
  { value: 'stalled', label: '待跟进' },
  { value: 'quoted', label: '已报价' },
  { value: 'won', label: '成交' },
  { value: 'lost', label: '流失' },
];

const QUALITIES: { value: CustomerQuality; label: string }[] = [
  { value: 'big', label: '⭐⭐⭐ 大客户' },
  { value: 'potential', label: '⭐⭐ 有潜力' },
  { value: 'normal', label: '⭐ 普通' },
  { value: 'spam', label: '🗑 垃圾' },
];

export interface ContactEditFormProps {
  contact: ContactRow;
  onSave: (patch: Partial<ContactRow>) => Promise<void>;
  /** 单列布局（聊天 tab 右侧窄面板）。默认 false（双列网格，drawer 用） */
  compact?: boolean;
  /** 是否显示手机号字段（drawer 显示，聊天 tab 已经在头部显示了所以隐藏） */
  showPhone?: boolean;
}

export function ContactEditForm({
  contact,
  onSave,
  compact = false,
  showPhone = false,
}: ContactEditFormProps) {
  const [draft, setDraft] = useState({
    name: '',
    country: '',
    language: '',
    budget_usd: '',
    customer_stage: 'new' as CustomerStage,
    quality: 'potential' as CustomerQuality,
    destination_port: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      name: contact.name ?? '',
      country: contact.country ?? '',
      language: contact.language ?? '',
      budget_usd: contact.budget_usd?.toString() ?? '',
      customer_stage: contact.customer_stage,
      quality: contact.quality,
      destination_port: contact.destination_port ?? '',
      notes: contact.notes ?? '',
    });
  }, [contact.id]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: draft.name || null,
        country: draft.country || null,
        language: draft.language || null,
        budget_usd: draft.budget_usd ? Number(draft.budget_usd) : null,
        customer_stage: draft.customer_stage,
        quality: draft.quality,
        destination_port: draft.destination_port || null,
        notes: draft.notes || null,
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const fieldsBlock = (
    <>
      <label className="sgc-field">
        <span>姓名</span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      {showPhone && (
        <label className="sgc-field">
          <span>手机号</span>
          <input value={contact.phone} disabled />
        </label>
      )}
      <label className="sgc-field">
        <span>国家</span>
        <input
          value={draft.country}
          onChange={(e) => setDraft({ ...draft, country: e.target.value })}
        />
      </label>
      <label className="sgc-field">
        <span>语言</span>
        <input
          value={draft.language}
          onChange={(e) => setDraft({ ...draft, language: e.target.value })}
        />
      </label>
      <label className="sgc-field">
        <span>预算 (USD)</span>
        <input
          type="number"
          value={draft.budget_usd}
          onChange={(e) => setDraft({ ...draft, budget_usd: e.target.value })}
        />
      </label>
      <label className="sgc-field">
        <span>目的港</span>
        <input
          value={draft.destination_port}
          onChange={(e) =>
            setDraft({ ...draft, destination_port: e.target.value })
          }
        />
      </label>
      <label className="sgc-field">
        <span>客户质量</span>
        <select
          value={draft.quality}
          onChange={(e) =>
            setDraft({ ...draft, quality: e.target.value as CustomerQuality })
          }
        >
          {QUALITIES.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
      </label>
      <label className="sgc-field">
        <span>客户阶段</span>
        <select
          value={draft.customer_stage}
          onChange={(e) =>
            setDraft({
              ...draft,
              customer_stage: e.target.value as CustomerStage,
            })
          }
        >
          {STAGES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <>
      {compact ? (
        fieldsBlock
      ) : (
        <div className="sgc-form-grid">{fieldsBlock}</div>
      )}

      <label className="sgc-field sgc-field-full">
        <span>备注</span>
        <textarea
          rows={compact ? 4 : 3}
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </label>

      {error && <div className="sgc-error">{error}</div>}

      <div className="sgc-drawer-actions">
        <button
          className="sgc-btn-primary"
          onClick={handleSave}
          disabled={saving}
          type="button"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {savedAt && Date.now() - savedAt < 3000 && (
          <span className="sgc-saved-hint">已保存 ✓</span>
        )}
      </div>
    </>
  );
}
