import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Database,
  VehicleCondition,
  VehicleSteering,
} from '@/lib/database.types';
import { logContactEvent } from '@/lib/events-log';

type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  contactId: string;
}

const initialDraft = {
  model: '',
  year: '',
  condition: '' as VehicleCondition | '',
  steering: '' as VehicleSteering | '',
  notes: '',
};

export function VehicleInterestsSection({ contactId }: Props) {
  const [items, setItems] = useState<VehicleInterestRow[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const refresh = async () => {
    const { data, error } = await supabase
      .from('vehicle_interests')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setItems(data ?? []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.model.trim()) return;
    setBusy(true);
    setError(null);
    const cleanModel = draft.model.trim();
    const { error } = await supabase.from('vehicle_interests').insert({
      contact_id: contactId,
      model: cleanModel,
      year: draft.year ? Number(draft.year) : null,
      condition: draft.condition || null,
      steering: draft.steering || null,
      notes: draft.notes.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    void logContactEvent(contactId, 'vehicle_added', {
      model: cleanModel,
      condition: draft.condition || null,
      year: draft.year ? Number(draft.year) : null,
      source: 'manual',
    });
    setDraft(initialDraft);
    setAdding(false);
    await refresh();
  };

  const remove = async (id: string) => {
    const prev = items;
    setItems(items.filter((i) => i.id !== id));
    const { error } = await supabase
      .from('vehicle_interests')
      .delete()
      .eq('id', id);
    if (error) {
      setError(error.message);
      setItems(prev);
    }
  };

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">车辆兴趣</div>
        {!adding && (
          <button
            className="sgc-btn-link"
            type="button"
            onClick={() => setAdding(true)}
          >
            + 添加
          </button>
        )}
      </div>

      {items.length === 0 && !adding && (
        <span className="sgc-muted">暂无车辆兴趣</span>
      )}

      <div className="sgc-stack">
        {items.map((item) => (
          <div key={item.id} className="sgc-stack-card">
            <div className="sgc-stack-header">
              <strong>{item.model}</strong>
              <button
                className="sgc-tag-remove"
                onClick={() => remove(item.id)}
                aria-label="删除"
              >
                ×
              </button>
            </div>
            <div className="sgc-stack-meta">
              {item.year && <span>{item.year} 年款</span>}
              {item.condition && (
                <span>{item.condition === 'new' ? '新车' : '二手'}</span>
              )}
              {item.steering && <span>{item.steering}</span>}
            </div>
            {item.notes && <div className="sgc-stack-notes">{item.notes}</div>}
          </div>
        ))}
      </div>

      {adding && (
        <form className="sgc-inline-grid" onSubmit={submit}>
          <label className="sgc-field">
            <span>车型</span>
            <input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="如：Jetour G700"
              required
            />
          </label>
          <label className="sgc-field">
            <span>年款</span>
            <input
              type="number"
              value={draft.year}
              onChange={(e) => setDraft({ ...draft, year: e.target.value })}
            />
          </label>
          <label className="sgc-field">
            <span>新/二手</span>
            <select
              value={draft.condition}
              onChange={(e) =>
                setDraft({ ...draft, condition: e.target.value as VehicleCondition })
              }
            >
              <option value="">未指定</option>
              <option value="new">新车</option>
              <option value="used">二手</option>
            </select>
          </label>
          <label className="sgc-field">
            <span>左/右舵</span>
            <select
              value={draft.steering}
              onChange={(e) =>
                setDraft({ ...draft, steering: e.target.value as VehicleSteering })
              }
            >
              <option value="">未指定</option>
              <option value="LHD">LHD</option>
              <option value="RHD">RHD</option>
            </select>
          </label>
          <label className="sgc-field sgc-field-full">
            <span>备注</span>
            <input
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>
          <div className="sgc-form-actions sgc-field-full">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => {
                setAdding(false);
                setDraft(initialDraft);
              }}
            >
              取消
            </button>
            <button
              type="submit"
              className="sgc-btn-secondary"
              disabled={busy || !draft.model.trim()}
            >
              {busy ? '保存中…' : '添加'}
            </button>
          </div>
        </form>
      )}

      {error && <div className="sgc-error">{error}</div>}
    </section>
  );
}
