import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { CustomerStage } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { canonicalizeModel } from '@/lib/vehicle-aliases';
import { brandOf } from '@/lib/filters';
import { useScope } from '../contexts/ScopeContext';

interface Props {
  orgId: string;
}

type Period = 'week' | 'month';

interface DashboardData {
  newContacts: number;
  newQuotes: number;
  newTasks: number;
  aiExtracts: number;
  stageDist: Record<CustomerStage, number>;
  topVehicles: Array<{ model: string; brand: string; count: number }>;
  stalledTotal: number;
  wonTotal: number;
}

const STAGE_LABEL: Record<CustomerStage, string> = {
  new: '新客户',
  qualifying: '资质确认',
  negotiating: '跟进中',
  stalled: '待跟进',
  quoted: '已报价',
  won: '成交',
  lost: '流失',
};

const STAGE_ORDER: CustomerStage[] = [
  'new',
  'qualifying',
  'negotiating',
  'quoted',
  'won',
  'stalled',
  'lost',
];

function startOfPeriod(period: Period): Date {
  const now = new Date();
  if (period === 'week') {
    const d = new Date(now);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function DashboardPage({ orgId }: Props) {
  const { scope, myContactIds } = useScope();
  const [period, setPeriod] = useState<Period>('week');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const start = useMemo(() => startOfPeriod(period), [period]);
  const myContactIdsKey = useMemo(
    () => Array.from(myContactIds).sort().join(','),
    [myContactIds],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const startIso = start.toISOString();
        const myIds = scope === 'mine' ? Array.from(myContactIds) : null;

        // scope=mine 时如果没有任何主理客户，全部清零
        if (myIds && myIds.length === 0) {
          if (!cancelled) {
            setData({
              newContacts: 0,
              newQuotes: 0,
              newTasks: 0,
              aiExtracts: 0,
              stageDist: {
                new: 0,
                qualifying: 0,
                negotiating: 0,
                stalled: 0,
                quoted: 0,
                won: 0,
                lost: 0,
              },
              topVehicles: [],
              stalledTotal: 0,
              wonTotal: 0,
            });
            setLoading(false);
          }
          return;
        }

        let newContactsQ = supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .gte('created_at', startIso);
        let stagesQ = supabase
          .from('contacts')
          .select('customer_stage')
          .eq('org_id', orgId);
        let newQuotesQ = supabase
          .from('quotes')
          .select('id, contacts!inner(org_id)', {
            count: 'exact',
            head: true,
          })
          .eq('contacts.org_id', orgId)
          .gte('created_at', startIso);
        let newTasksQ = supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .gte('created_at', startIso);
        let aiExtractsQ = supabase
          .from('contact_events')
          .select('id, contacts!inner(org_id)', {
            count: 'exact',
            head: true,
          })
          .eq('contacts.org_id', orgId)
          .eq('event_type', 'ai_extracted')
          .gte('created_at', startIso);
        let vehiclesQ = supabase
          .from('vehicle_interests')
          .select('model, contacts!inner(org_id)')
          .eq('contacts.org_id', orgId);

        if (myIds) {
          newContactsQ = newContactsQ.in('id', myIds);
          stagesQ = stagesQ.in('id', myIds);
          newQuotesQ = newQuotesQ.in('contact_id', myIds);
          newTasksQ = newTasksQ.in('contact_id', myIds);
          aiExtractsQ = aiExtractsQ.in('contact_id', myIds);
          vehiclesQ = vehiclesQ.in('contact_id', myIds);
        }

        const [
          newContactsRes,
          stagesRes,
          newQuotesRes,
          newTasksRes,
          aiExtractsRes,
          vehiclesRes,
        ] = await Promise.all([
          newContactsQ,
          stagesQ,
          newQuotesQ,
          newTasksQ,
          aiExtractsQ,
          vehiclesQ,
        ]);

        if (cancelled) return;
        if (newContactsRes.error) throw newContactsRes.error;
        if (stagesRes.error) throw stagesRes.error;
        if (newQuotesRes.error) throw newQuotesRes.error;
        if (newTasksRes.error) throw newTasksRes.error;
        if (aiExtractsRes.error) throw aiExtractsRes.error;
        if (vehiclesRes.error) throw vehiclesRes.error;

        const stageDist: Record<CustomerStage, number> = {
          new: 0,
          qualifying: 0,
          negotiating: 0,
          stalled: 0,
          quoted: 0,
          won: 0,
          lost: 0,
        };
        for (const row of (stagesRes.data ?? []) as Array<{
          customer_stage: CustomerStage;
        }>) {
          stageDist[row.customer_stage] = (stageDist[row.customer_stage] ?? 0) + 1;
        }

        const modelCounts = new Map<string, number>();
        for (const row of (vehiclesRes.data ?? []) as Array<{ model: string }>) {
          const canon = canonicalizeModel(row.model);
          if (!canon) continue;
          modelCounts.set(canon, (modelCounts.get(canon) ?? 0) + 1);
        }
        const topVehicles = Array.from(modelCounts.entries())
          .map(([model, count]) => ({ model, brand: brandOf(model), count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);

        if (cancelled) return;
        setData({
          newContacts: newContactsRes.count ?? 0,
          newQuotes: newQuotesRes.count ?? 0,
          newTasks: newTasksRes.count ?? 0,
          aiExtracts: aiExtractsRes.count ?? 0,
          stageDist,
          topVehicles,
          stalledTotal: stageDist.stalled,
          wonTotal: stageDist.won,
        });
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(stringifyError(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId, start.getTime(), scope, myContactIdsKey]);

  const periodLabel = period === 'week' ? '本周' : '本月';
  const totalContacts = data
    ? Object.values(data.stageDist).reduce((s, n) => s + n, 0)
    : 0;
  const maxStageCount = data
    ? Math.max(...Object.values(data.stageDist), 1)
    : 1;

  return (
    <div className="sgc-page">
      <div className="sgc-page-header">
        <h1>看板</h1>
        <div className="sgc-period-toggle">
          <button
            type="button"
            className={`sgc-period-btn ${period === 'week' ? 'active' : ''}`}
            onClick={() => setPeriod('week')}
          >
            本周
          </button>
          <button
            type="button"
            className={`sgc-period-btn ${period === 'month' ? 'active' : ''}`}
            onClick={() => setPeriod('month')}
          >
            本月
          </button>
        </div>
      </div>

      {loading && <div className="sgc-empty">加载中…</div>}
      {error && <div className="sgc-error">{error}</div>}

      {data && !loading && (
        <>
          <div className="sgc-kpi-grid">
            <div className="sgc-kpi-card">
              <div className="sgc-kpi-value">{data.newContacts}</div>
              <div className="sgc-kpi-label">{periodLabel}新增客户</div>
            </div>
            <div className="sgc-kpi-card">
              <div className="sgc-kpi-value">{data.newQuotes}</div>
              <div className="sgc-kpi-label">{periodLabel}发出报价</div>
            </div>
            <div className="sgc-kpi-card">
              <div className="sgc-kpi-value">{data.newTasks}</div>
              <div className="sgc-kpi-label">{periodLabel}新增任务</div>
            </div>
            <div className="sgc-kpi-card">
              <div className="sgc-kpi-value">{data.aiExtracts}</div>
              <div className="sgc-kpi-label">{periodLabel} AI 抽取</div>
            </div>
            <div className="sgc-kpi-card sgc-kpi-secondary">
              <div className="sgc-kpi-value">{data.stalledTotal}</div>
              <div className="sgc-kpi-label">待跟进 (累计)</div>
            </div>
            <div className="sgc-kpi-card sgc-kpi-secondary">
              <div className="sgc-kpi-value">{data.wonTotal}</div>
              <div className="sgc-kpi-label">成交 (累计)</div>
            </div>
          </div>

          <div className="sgc-dashboard-grid">
            <div className="sgc-dashboard-card">
              <div className="sgc-section-title">
                客户阶段分布
                <span className="sgc-muted"> · 共 {totalContacts}</span>
              </div>
              <div className="sgc-funnel">
                {STAGE_ORDER.map((s) => {
                  const count = data.stageDist[s];
                  const pct = (count / maxStageCount) * 100;
                  return (
                    <div key={s} className="sgc-funnel-row">
                      <span className={`sgc-funnel-label sgc-stage-${s}`}>
                        {STAGE_LABEL[s]}
                      </span>
                      <div className="sgc-funnel-bar-wrap">
                        <div
                          className={`sgc-funnel-bar sgc-stage-bg-${s}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="sgc-funnel-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="sgc-dashboard-card">
              <div className="sgc-section-title">热门车型 Top 5</div>
              {data.topVehicles.length === 0 ? (
                <span className="sgc-muted">暂无车型数据</span>
              ) : (
                <div className="sgc-top-list">
                  {data.topVehicles.map((v, i) => {
                    const pct =
                      (v.count / data.topVehicles[0].count) * 100;
                    return (
                      <div key={v.model} className="sgc-top-row">
                        <span className="sgc-top-rank">#{i + 1}</span>
                        <div className="sgc-top-body">
                          <div className="sgc-top-name">
                            <strong>{v.model}</strong>
                            {v.brand && (
                              <span className="sgc-muted"> · {v.brand}</span>
                            )}
                          </div>
                          <div className="sgc-top-bar-wrap">
                            <div
                              className="sgc-top-bar"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                        <span className="sgc-top-count">{v.count}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
