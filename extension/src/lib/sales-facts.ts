import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { ChatMessage } from '@/content/whatsapp-messages';
import type { SalesWorkMemory } from './sales-work-memory';
import { selectGptWorkflows } from './gpt-workflow-selection';
import type { FactCategory, SalesFact, SalesFactSelection } from './sales-fact-types';

type Client = SupabaseClient<Database>;
export interface FactContext {
  orgId: string; contactId: string; scopeId: string;
  contact?: { customer_stage?: string; destination_port?: string | null };
  messages?: ChatMessage[]; vehicleInterests?: { model: string }[];
  salesGuidance?: string; discussionQuestion?: string; workMemory?: SalesWorkMemory;
}
export const FACT_CATEGORY_LABELS: Record<FactCategory, string> = {
  price: '车价', freight: '运费', payment: '付款', warranty: '保修', logistics: '交付与装载', insurance: '保险与费用规则',
};
const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const rank = { org: 0, product: 1, customer: 2, order: 3 };

export function factCategories(ctx: FactContext): FactCategory[] {
  let lastOutbound = -1;
  (ctx.messages ?? []).forEach((m, i) => { if (m.fromMe) lastOutbound = i; });
  const request = [ctx.salesGuidance, ctx.discussionQuestion, ...(ctx.messages ?? []).slice(lastOutbound + 1).map(m => m.text)].join('\n');
  const cats = new Set<FactCategory>();
  const flow = selectGptWorkflows(ctx);
  if (flow.quote) { cats.add('price'); cats.add('payment'); }
  if (flow.freight) { cats.add('freight'); cats.add('insurance'); cats.add('logistics'); }
  if (/保修|售后|配件|保养|warrant|guarantee|garant[ií]|after.?sales|spare parts|mantenimiento|maintenan|garantie/i.test(request)) cats.add('warranty');
  if (/付款|支付|定金|尾款|payment|deposit|balance|proforma|invoice|pago|anticipo|acompte|paiement|\bpi\b/i.test(request)
    || ['quoted', 'negotiating'].includes(ctx.contact?.customer_stage ?? '')) cats.add('payment');
  if (/交付|交期|排产|装载|production|delivery|lead.?time|container|contenedor|entrega|livraison/i.test(request)) cats.add('logistics');
  if (/保险|insurance|seguro|assurance/i.test(request)) cats.add('insurance');
  return [...cats];
}

export async function loadSalesFacts(db: Client, orgId: string, contactId?: string, categories?: FactCategory[]): Promise<SalesFact[]> {
  if (categories?.length === 0) return [];
  const result: SalesFact[] = [];
  for (let from = 0; ; from += 200) {
    let q = db.from('sales_facts').select('*').eq('org_id', orgId);
    if (contactId) q = q.or(`contact_id.is.null,contact_id.eq.${contactId}`);
    if (categories) q = q.in('category', categories);
    const { data, error } = await q.order('id').range(from, from + 199);
    if (error) throw new Error(`读取销售事实库失败：${error.message}`);
    result.push(...(data ?? []));
    if (!data || data.length < 200) return result;
  }
}

/** Match authority, product/order and original time window before reusing data. */
export function selectSalesFacts(rows: SalesFact[], ctx: FactContext, now = Date.now()): SalesFactSelection {
  const result: SalesFactSelection = { usable: [], unavailable: [] };
  const cats = factCategories(ctx);
  const products = clean([ctx.salesGuidance, ctx.discussionQuestion, ...(ctx.vehicleInterests ?? []).map(v => v.model),
    ...(ctx.messages ?? []).slice(-12).map(m => m.text)].join(' '));
  const groups = new Map<string, SalesFact[]>();
  for (const f of rows) {
    if (f.org_id !== ctx.orgId || !cats.includes(f.category) || f.status === 'retired') continue;
    if (f.contact_id && f.contact_id !== ctx.contactId) continue;
    if (f.scope === 'order' && f.scope_id !== ctx.scopeId) continue;
    if (f.product_key && f.scope !== 'order' && !products.includes(clean(f.product_key))) continue;
    let reason = f.status === 'approved' ? '' : f.status === 'reference' ? '历史或供应商参考，未批准为本轮输入' : '待核实来源或适用条件';
    const observed = Date.parse(f.observed_at);
    if (!Number.isFinite(observed) || observed > now) reason = '原始日期无效或在未来';
    if (f.valid_until && Date.parse(f.valid_until) <= now) reason = '已过有效期';
    if (f.category === 'freight') {
      const checked = typeof f.value.checkedAt === 'string' ? Date.parse(f.value.checkedAt) : observed;
      if (!Number.isFinite(checked) || checked > now || now - checked >= 7 * 86400000) reason = '距原查价已满7天，需重新核查';
      const input = ctx.workMemory?.quoteVersions?.at(-1)?.payload.input as {origin?: string; destination?: string; plans?: Record<string, unknown>[]} | undefined;
      const matchingPlan = input?.plans?.find(p => ['model','quantity','propulsion','shippingMode','containers'].every(k =>
        f.value[k] == null || p[k] === f.value[k]));
      if (!matchingPlan || !input?.destination || clean(input.destination) !== clean(String(f.value.destination))
        || (input.origin && clean(input.origin) !== clean(String(f.value.origin)))) reason = '本单车型、数量、运输方式或航线尚未匹配';
      const pending = [ctx.salesGuidance, ctx.discussionQuestion, ...(ctx.messages ?? []).slice(
        (ctx.messages ?? []).reduce((last, m, i) => m.fromMe ? i + 1 : last, 0)).map(m => m.text)].join(' ');
      const quantities = [...pending.matchAll(/(\d{1,3})\s*(?:台|辆|units?\b|vehicles?\b|cars?\b|unidades?\b)/gi)].map(m => Number(m[1]));
      if (quantities.some(n => n !== f.value.quantity)) reason = '本轮数量发生变化，运费不可直接沿用';
      const container = pending.match(/\b(20\s*GP|40\s*(?:HQ|HC|GP))\b/i)?.[1].replace(/\s/g,'').toUpperCase();
      if (container && container !== f.value.containerType) reason = '本轮柜型与运费不匹配';
      if ((/roro|ro-ro|滚装/i.test(pending) && f.value.shippingMode !== 'roro')
        || (/集装箱|container|contenedor/i.test(pending) && f.value.shippingMode === 'roro')) reason = '本轮运输方式与运费不匹配';
      const port = ctx.contact?.destination_port;
      const destination = f.value.destination;
      if (!destination || (port && !clean(String(destination)).includes(clean(port)) && !clean(port).includes(clean(String(destination))))) reason = '运费缺目的港依据或与本单不匹配';
    }
    if (reason) { result.unavailable.push({ id: f.id, title: f.title, reason }); continue; }
    const key = `${f.category}:${f.fact_key}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const facts of groups.values()) {
    facts.sort((a, b) => rank[b.scope] - rank[a.scope] || Date.parse(b.observed_at) - Date.parse(a.observed_at));
    const best = facts[0];
    const peers = facts.filter(f => rank[f.scope] === rank[best.scope] && Date.parse(f.observed_at) === Date.parse(best.observed_at));
    const canonical = (v: unknown): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v);
    if (peers.some(f => canonical(f.value) !== canonical(best.value) || (!Object.keys(f.value).length && f.statement !== best.statement))) {
      result.unavailable.push(...peers.map(f => ({ id: f.id, title: f.title, reason: '同范围同日期存在冲突，不能自动选择' })));
    } else result.usable.push(best);
  }
  // A newer order-specific full price list replaces the standing product list for this order.
  const orderLists = result.usable.filter(f => f.category === 'price' && f.scope === 'order' && f.value.kind === 'order_price_list');
  if (orderLists.length) result.usable = result.usable.filter(f => !(f.value.kind === 'base_price_list'
    && orderLists.some(o => o.value.product === f.product_key && Date.parse(o.observed_at) >= Date.parse(f.observed_at))));
  return result;
}

export async function loadApplicableSalesFacts(db: Client, ctx: FactContext): Promise<SalesFactSelection> {
  return selectSalesFacts(await loadSalesFacts(db, ctx.orgId, ctx.contactId, factCategories(ctx)), ctx);
}

export function renderSalesFacts(s?: SalesFactSelection): string {
  if (!s || (!s.usable.length && !s.unavailable.length)) return '';
  // Share identical provenance only; no summarization, omission or changed fact selection.
  const provenance = new Map<string, string>();
  const sources: Record<string, unknown> = {};
  const facts = s.usable.map(f => {
    const source = { scope: f.scope, product: f.product_key, source: f.source.ref,
      sourceDate: f.observed_at, validUntil: f.valid_until };
    const key = JSON.stringify(source);
    let ref = provenance.get(key);
    if (!ref) { ref = `p${provenance.size + 1}`; provenance.set(key, ref); sources[ref] = source; }
    return { id: f.id, key: f.fact_key, category: f.category, provenanceRef: ref, statement: f.statement, value: f.value };
  });
  return `[Sales Fact Library — sourced business data]\nUse these applicable facts directly instead of asking the owner to repeat them. Current explicit owner instructions and newer applicable confirmations win. Match exact variant, trade term, quantity and freight charge scope before calculation. Unavailable records supply no usable numbers; older copies in chat do not regain current authority. A fact does not prove stock, a booked shipment or payment. Keep internal costs and source notes out of customer text. Each fact's provenanceRef points to its scope, product, source and original dates in sources below; those conditions apply to the complete fact.\n${JSON.stringify({
    sources, facts, unavailable: s.unavailable.slice(0, 8), unavailableCount: s.unavailable.length,
  })}\n`;
}

/** Database journals edits; version comparison prevents overwriting concurrent work. */
export async function reviseSalesFact(db: Client, fact: SalesFact, change: { status?: SalesFact['status']; statement?: string; value?: Record<string, unknown>; valid_until?: string | null }) {
  const { data, error } = await db.from('sales_facts').update(change).eq('id', fact.id).eq('org_id', fact.org_id)
    .eq('version', fact.version).select('id').maybeSingle();
  if (error) throw new Error(`保存事实失败：${error.message}`);
  if (!data) throw new Error('事实已被更新或没有编辑权限，请刷新后重试');
}
