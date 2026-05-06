import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, QuoteStatus } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { logContactEvent } from '@/lib/events-log';

type QuoteRow = Database['public']['Tables']['quotes']['Row'];
type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];

interface Props {
  contactId: string;
}

const STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: '草稿',
  sent: '已发送',
  accepted: '已接受',
  rejected: '已拒绝',
};

const STATUS_OPTIONS: { value: QuoteStatus; label: string }[] = [
  { value: 'draft', label: '草稿' },
  { value: 'sent', label: '已发送' },
  { value: 'accepted', label: '已接受' },
  { value: 'rejected', label: '已拒绝' },
];

interface Draft {
  vehicle_model: string;
  price_usd: string;
  status: QuoteStatus;
  sent_at: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = {
  vehicle_model: '',
  price_usd: '',
  status: 'sent',
  sent_at: '',
  notes: '',
};

function toLocalDatetime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // datetime-local 需要本地时间且无 Z 后缀
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function QuotesSection({ contactId }: Props) {
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleInterestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const refresh = async () => {
    const [q, v] = await Promise.all([
      supabase
        .from('quotes')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false }),
      supabase
        .from('vehicle_interests')
        .select('*')
        .eq('contact_id', contactId),
    ]);
    if (q.error) {
      setError(q.error.message);
      setLoading(false);
      return;
    }
    setQuotes(q.data ?? []);
    setVehicles(v.data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const startAdd = () => {
    const defaultModel = vehicles[0]?.model ?? '';
    setDraft({ ...EMPTY_DRAFT, vehicle_model: defaultModel });
    setEditingId(null);
    setAdding(true);
  };

  const startEdit = (q: QuoteRow) => {
    setDraft({
      vehicle_model: q.vehicle_model,
      price_usd: String(q.price_usd),
      status: q.status,
      sent_at: toLocalDatetime(q.sent_at),
      notes: q.notes ?? '',
    });
    setEditingId(q.id);
    setAdding(true);
  };

  const cancelEdit = () => {
    setAdding(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const price = Number(draft.price_usd);
    if (!draft.vehicle_model.trim() || !Number.isFinite(price) || price <= 0) {
      setError('请填写车型和有效价格');
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      vehicle_model: draft.vehicle_model.trim(),
      price_usd: price,
      status: draft.status,
      sent_at: draft.sent_at ? new Date(draft.sent_at).toISOString() : null,
      notes: draft.notes.trim() || null,
    };
    try {
      if (editingId) {
        const { error: e } = await supabase
          .from('quotes')
          .update(payload)
          .eq('id', editingId);
        if (e) throw e;
      } else {
        const { error: e } = await supabase
          .from('quotes')
          .insert({ ...payload, contact_id: contactId });
        if (e) throw e;
        void logContactEvent(contactId, 'quote_created', {
          vehicle_model: payload.vehicle_model,
          price_usd: payload.price_usd,
          status: payload.status,
        });
      }
      cancelEdit();
      await refresh();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setConfirmingDelete(null);
    setBusy(true);
    setError(null);
    try {
      const { error: e } = await supabase.from('quotes').delete().eq('id', id);
      if (e) throw e;
      await refresh();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">
          报价历史
          {quotes.length > 0 && (
            <span className="sgc-muted"> · {quotes.length} 条</span>
          )}
        </div>
        {!adding && (
          <button
            className="sgc-btn-link"
            type="button"
            onClick={startAdd}
          >
            + 新增报价
          </button>
        )}
      </div>

      {loading ? (
        <span className="sgc-muted">加载中…</span>
      ) : quotes.length === 0 && !adding ? (
        <span className="sgc-muted">暂无报价</span>
      ) : (
        <div className="sgc-stack">
          {quotes.map((q) => (
            <div key={q.id} className="sgc-stack-card">
              <div className="sgc-stack-header">
                <strong>{q.vehicle_model}</strong>
                <span className={`sgc-quote-status sgc-quote-status-${q.status}`}>
                  {STATUS_LABEL[q.status]}
                </span>
              </div>
              <div className="sgc-stack-meta">
                <span className="sgc-quote-price">
                  USD {Number(q.price_usd).toLocaleString()}
                </span>
                {q.sent_at && (
                  <span> · 发送 {new Date(q.sent_at).toLocaleDateString()}</span>
                )}
              </div>
              {q.notes && <div className="sgc-stack-note">{q.notes}</div>}
              <div className="sgc-stack-actions">
                {confirmingDelete === q.id ? (
                  <>
                    <button
                      type="button"
                      className="sgc-btn-link sgc-btn-danger"
                      onClick={() => void remove(q.id)}
                      disabled={busy}
                    >
                      {busy ? '删除中…' : '确认删除'}
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={() => setConfirmingDelete(null)}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={() => startEdit(q)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-link sgc-btn-danger"
                      onClick={() => setConfirmingDelete(q.id)}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <form className="sgc-inline-grid" onSubmit={submit}>
          <label className="sgc-field sgc-field-full">
            <span>车型</span>
            <input
              list={`vehicle-list-${contactId}`}
              value={draft.vehicle_model}
              onChange={(e) =>
                setDraft({ ...draft, vehicle_model: e.target.value })
              }
              placeholder="如：Toyota Hilux 2024 / BYD Yuan UP"
              required
            />
            <datalist id={`vehicle-list-${contactId}`}>
              {vehicles.map((v) => (
                <option key={v.id} value={v.model} />
              ))}
            </datalist>
          </label>

          <label className="sgc-field">
            <span>价格 USD</span>
            <input
              type="number"
              step="100"
              min="0"
              value={draft.price_usd}
              onChange={(e) => setDraft({ ...draft, price_usd: e.target.value })}
              placeholder="25000"
              required
            />
          </label>

          <label className="sgc-field">
            <span>状态</span>
            <select
              value={draft.status}
              onChange={(e) =>
                setDraft({ ...draft, status: e.target.value as QuoteStatus })
              }
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="sgc-field sgc-field-full">
            <span>发送时间（可选）</span>
            <input
              type="datetime-local"
              value={draft.sent_at}
              onChange={(e) => setDraft({ ...draft, sent_at: e.target.value })}
            />
          </label>

          <label className="sgc-field sgc-field-full">
            <span>备注（可选）</span>
            <input
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="如：含 CIF / 含运费 / 含 1 年质保"
            />
          </label>

          <div className="sgc-form-actions sgc-field-full">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={cancelEdit}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="submit"
              className="sgc-btn-secondary"
              disabled={busy || !draft.vehicle_model.trim() || !draft.price_usd}
            >
              {busy ? '保存中…' : editingId ? '保存' : '创建'}
            </button>
          </div>
        </form>
      )}

      {error && <div className="sgc-error">{error}</div>}
    </section>
  );
}
