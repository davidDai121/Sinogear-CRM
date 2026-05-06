import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, SaleStatus } from '@/lib/database.types';
import { VehicleModal } from '../components/VehicleModal';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];

const STATUS_LABEL: Record<SaleStatus, string> = {
  available: '在售',
  paused: '暂停',
  expired: '已过期',
};

interface Props {
  orgId: string;
}

export function VehiclesPage({ orgId }: Props) {
  const [items, setItems] = useState<VehicleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SaleStatus | ''>('');
  const [modalItem, setModalItem] = useState<VehicleRow | null | false>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false });
    if (error) setError(error.message);
    else setItems(data ?? []);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const filtered = useMemo(
    () =>
      items.filter((v) => {
        if (statusFilter && v.sale_status !== statusFilter) return false;
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          v.brand.toLowerCase().includes(q) ||
          v.model.toLowerCase().includes(q) ||
          (v.version?.toLowerCase().includes(q) ?? false)
        );
      }),
    [items, search, statusFilter],
  );

  return (
    <div className="sgc-page">
      <div className="sgc-page-header">
        <h1>车源库</h1>
        <div className="sgc-page-actions">
          <span className="sgc-page-count">共 {filtered.length} 条</span>
          <button
            className="sgc-btn-primary"
            onClick={() => setModalItem(null)}
            type="button"
          >
            + 新建车源
          </button>
        </div>
      </div>

      <div className="sgc-page-toolbar">
        <input
          className="sgc-toolbar-input"
          placeholder="搜索品牌 / 车型 / 版本"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SaleStatus | '')}
        >
          <option value="">全部销售状态</option>
          <option value="available">在售</option>
          <option value="paused">暂停</option>
          <option value="expired">已过期</option>
        </select>
      </div>

      {error && <div className="sgc-error">{error}</div>}

      {loading ? (
        <div className="sgc-empty">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="sgc-empty">
          {items.length === 0
            ? '还没有车源数据，点右上角新建。'
            : '没有匹配的车源'}
        </div>
      ) : (
        <div className="sgc-vehicle-grid">
          {filtered.map((v) => (
            <article
              key={v.id}
              className="sgc-vehicle-card"
              onClick={() => setModalItem(v)}
            >
              <header className="sgc-vehicle-head">
                <div>
                  <strong>
                    {v.brand} {v.model}
                  </strong>
                  <span className="sgc-muted">
                    {v.year ? `${v.year} ` : ''}
                    {v.version ?? ''}
                  </span>
                </div>
                <span className={`sgc-stage sgc-sale-${v.sale_status}`}>
                  {STATUS_LABEL[v.sale_status]}
                </span>
              </header>

              <div className="sgc-vehicle-meta">
                <div>
                  <span>状态</span>
                  <strong>{v.vehicle_condition === 'new' ? '新车' : '二手'}</strong>
                </div>
                <div>
                  <span>动力</span>
                  <strong>{v.fuel_type ? fuelLabel(v.fuel_type) : '—'}</strong>
                </div>
                <div>
                  <span>转向</span>
                  <strong>{v.steering ?? '—'}</strong>
                </div>
                <div>
                  <span>价格</span>
                  <strong>
                    {v.base_price
                      ? `${v.currency} ${v.base_price.toLocaleString()}`
                      : '—'}
                  </strong>
                </div>
              </div>

              {v.short_spec && (
                <p className="sgc-vehicle-spec">{v.short_spec}</p>
              )}
            </article>
          ))}
        </div>
      )}

      {modalItem !== false && (
        <VehicleModal
          orgId={orgId}
          vehicle={modalItem}
          onClose={() => setModalItem(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function fuelLabel(f: string) {
  return (
    { gas: '汽油', diesel: '柴油', hybrid: '混动', ev: '纯电' } as Record<string, string>
  )[f] ?? f;
}
