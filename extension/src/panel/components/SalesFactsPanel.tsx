import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { FACT_CATEGORY_LABELS, loadSalesFacts, reviseSalesFact } from '@/lib/sales-facts';
import type { SalesFact } from '@/lib/sales-fact-types';

const STATUS = { approved: '已确认', reference: '历史参考', candidate: '待核实', retired: '已停用' };
const SCOPE = { org: '通用', product: '车型', customer: '此客户', order: '本单' };
export function SalesFactsPanel({ orgId, contactId, disabled }: { orgId: string; contactId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<SalesFact[]>([]);
  const [query, setQuery] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Record<string, { version: number; snapshot: Record<string, unknown>; changed_at: string }[]>>({});
  async function refresh() {
    setLoading(true); setError('');
    try {
      const { data: auth } = await supabase.auth.getUser();
      const [rows, membership] = await Promise.all([
        loadSalesFacts(supabase, orgId, contactId),
        supabase.from('organization_members').select('role').eq('org_id', orgId).eq('user_id', auth.user?.id ?? '').maybeSingle(),
      ]);
      setFacts(rows); setCanEdit(['owner', 'admin'].includes(membership.data?.role ?? ''));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  async function status(fact: SalesFact, value: SalesFact['status']) {
    setLoading(true);
    try { await reviseSalesFact(supabase, fact, { status: value }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
  }
  async function versions(f: SalesFact) {
    const { data, error } = await supabase.from('sales_fact_history').select('version,snapshot,changed_at')
      .eq('org_id', orgId).eq('fact_id', f.id).order('version', { ascending: false });
    if (error) setError(error.message); else setHistory(h => ({ ...h, [f.id]: data ?? [] }));
  }
  const visible = facts.filter(f => `${f.title} ${f.statement} ${f.product_key ?? ''} ${FACT_CATEGORY_LABELS[f.category]} ${STATUS[f.status]}`.toLowerCase().includes(query.toLowerCase()));
  return <details style={{ marginTop: 10 }} open={open} onToggle={e => {
    const next = e.currentTarget.open;
    if (next !== open) { setOpen(next); if (next) void refresh(); }
  }}>
    <summary>事实库 · 车价 / 运费 / 付款 / 保修</summary>
    <p style={{ fontSize: 12 }}>从已有记录整理，生成时按车型、本单和有效期选用。历史参考及待核实数据不自动变成当前报价。原话和修订记录保留。</p>
    <input aria-label="搜索销售事实" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜车型、港口或条款" />
    <button type="button" className="sgc-btn-link" disabled={loading} onClick={() => void refresh()}>刷新</button>
    {error && <p className="sgc-error">{error}</p>}
    {loading && <p>读取中…</p>}
    <p style={{ fontSize: 12 }}>{visible.length} 条{visible.length > 50 ? '，先显示 50 条，请搜索缩小范围' : ''}</p>
    {visible.slice(0, 50).map(f => <details key={f.id} style={{ marginBottom: 8, fontSize: 12 }}>
      <summary>{STATUS[f.status]} · {SCOPE[f.scope]} · {f.title}</summary>
      <p style={{ whiteSpace: 'pre-wrap' }}>{f.statement}</p>
      <p>来源日期：{new Date(f.observed_at).toLocaleDateString()} {f.valid_until ? ` · 有效至 ${new Date(f.valid_until).toLocaleString()}` : ''}</p>
      {f.scope === 'order' && <p>仅适用原订单；换需求不继承。</p>}
      <details><summary>来源原话</summary><p style={{ whiteSpace: 'pre-wrap' }}>{String(f.source.quote ?? '')}</p><p>{String(f.source.ref ?? '')}</p></details>
      {canEdit && <div>
        {f.status !== 'approved' && f.status !== 'retired' && <button type="button" className="sgc-btn-link" disabled={disabled || loading} onClick={() => void status(f, 'approved')}>确认在此范围采用</button>}
        {f.status !== 'retired' && <button type="button" className="sgc-btn-link" disabled={disabled || loading} onClick={() => void status(f, 'retired')}>停用</button>}
        {f.status === 'retired' && <button type="button" className="sgc-btn-link" disabled={disabled || loading} onClick={() => void status(f, 'reference')}>恢复为参考</button>}
      </div>}
      <button type="button" className="sgc-btn-link" onClick={() => void versions(f)}>查看修订记录（v{f.version}）</button>
      {history[f.id]?.map(h => <p key={h.version}>v{h.version} · {new Date(h.changed_at).toLocaleString()} · {STATUS[h.snapshot.status as SalesFact['status']] ?? String(h.snapshot.status)}</p>)}
    </details>)}
  </details>;
}
