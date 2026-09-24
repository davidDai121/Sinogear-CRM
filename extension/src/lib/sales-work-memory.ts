import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { partitionHistoricalGuidance } from './sales-history-identity';
import { loadSalesPreferences, renderSalesPreferences, type SalesPreference } from './sales-preferences';
import { compactSalesFacts, renderSalesFacts } from './sales-facts';
import type { SalesFactSelection } from './sales-fact-types';
import type { ContextLayer } from './gpt-context-layer';

// Uses the existing append-only contact event journal and its contact-membership RLS.
// Never writes customer stages, quotes, sent messages or calendar tasks.
export const WORK_SCHEMA = 'sales-work.v1';
type Client = SupabaseClient<Database>;
export type WorkKind = 'scope' | 'sales_instruction' | 'sales_discussion' | 'assistant_draft' | 'freight_lookup';
export interface WorkEntry {
  id: string; at: string; scopeId: string; kind: WorkKind; text: string;
  templateId?: string; chatUrl?: string;
}
export interface SalesWorkMemory {
  contactId: string; scopeId: string; label: string; entries: WorkEntry[];
  historicalGuidance?: { id: string; payload: Record<string, unknown> }[];
  quarantinedGuidance?: { id: string; payload: Record<string, unknown>; reason: string }[];
  preferences?: SalesPreference[];
  standingPreferences?: string;
  factLibrary?: SalesFactSelection;
  quoteVersions?: { id: string; at: string; payload: Record<string, unknown> }[];
  tasks: { id: string; title: string; due_at: string | null; status: string }[];
}
const kinds: WorkKind[] = ['scope', 'sales_instruction', 'sales_discussion', 'assistant_draft', 'freight_lookup'];
function decode(row: Database['public']['Tables']['contact_events']['Row']): WorkEntry {
  const p = row.payload;
  if (p.schema !== WORK_SCHEMA || typeof p.scopeId !== 'string' || !p.scopeId
    || !kinds.includes(p.kind as WorkKind) || typeof p.text !== 'string') {
    throw new Error('客户工作记录格式异常，未忽略记录继续生成。');
  }
  return { id: row.id, at: row.created_at, scopeId: p.scopeId, kind: p.kind as WorkKind,
    text: p.text, templateId: typeof p.templateId === 'string' ? p.templateId : undefined,
    chatUrl: typeof p.chatUrl === 'string' ? p.chatUrl : undefined };
}
async function verifyContact(db: Client, orgId: string, contactId: string) {
  const { data, error } = await db.from('contacts').select('id,phone').eq('id', contactId).eq('org_id', orgId).single();
  if (error || !data) throw new Error('无法核实客户所属组织，未读写工作记录。');
  return data;
}
export async function loadSalesWorkMemory(db: Client, orgId: string, contactId: string): Promise<SalesWorkMemory> {
  const contact = await verifyContact(db, orgId, contactId);
  const { data: scopes, error: scopeError } = await db.from('contact_events')
    .select('id,contact_id,event_type,payload,created_at').eq('contact_id', contactId)
    .eq('event_type', 'ai_extracted').contains('payload', { schema: WORK_SCHEMA, kind: 'scope' })
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (scopeError) throw new Error(`读取需求范围失败：${scopeError.message}`);
  const scope = scopes?.[0] ? decode(scopes[0]) : undefined;
  const scopeId = scope?.scopeId ?? contactId;
  const entries: WorkEntry[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await db.from('contact_events')
      .select('id,contact_id,event_type,payload,created_at').eq('contact_id', contactId)
      .eq('event_type', 'ai_extracted').contains('payload', { schema: WORK_SCHEMA, scopeId })
      .order('created_at').order('id').range(from, from + 199);
    if (error) throw new Error(`读取客户工作记录失败：${error.message}`);
    entries.push(...(data ?? []).map(decode));
    if (!data || data.length < 200) break;
  }
  const tasks: SalesWorkMemory['tasks'] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await db.from('tasks').select('id,title,due_at,status')
      .eq('org_id', orgId).eq('contact_id', contactId).eq('status', 'open')
      .order('id').range(from, from + 199);
    if (error) throw new Error(`读取客户待办失败：${error.message}`);
    tasks.push(...(data ?? []));
    if (!data || data.length < 200) break;
  }
  const readJournal = async (schema: string, scoped: boolean) => {
    const result: { id: string; at: string; payload: Record<string, unknown> }[] = [];
    for (let from = 0; ; from += 200) {
      const { data, error } = await db.from('contact_events').select('id,payload,created_at')
        .eq('contact_id', contactId).eq('event_type', 'ai_extracted')
        .contains('payload', scoped ? { schema, scopeId } : { schema })
        .order('created_at').order('id').range(from, from + 199);
      if (error) throw new Error(`读取历史指导/报价版本失败：${error.message}`);
      result.push(...(data ?? []).map(r => ({ id:r.id, at:r.created_at, payload:r.payload })));
      if (!data || data.length < 200) break;
    }
    return result;
  };
  const [historicalGuidance, quoteVersions] = await Promise.all([
    readJournal('sales-history.v1', false), readJournal('quote-calculation.v1', true),
  ]);
  const { accepted, quarantined } = partitionHistoricalGuidance(historicalGuidance, contact.phone);
  return { contactId, scopeId, label: scope?.text ?? '当前需求', entries, tasks, historicalGuidance: accepted, quarantinedGuidance: quarantined, quoteVersions };
}

/** Interactive generation and background review use the same personal memory. */
export async function loadPersonalSalesWorkMemory(db: Client, orgId: string, contactId: string): Promise<SalesWorkMemory> {
  const { data: auth, error } = await db.auth.getUser();
  if (error || !auth.user) throw new Error('请登录CRM后读取个人销售偏好');
  const memory = await loadSalesWorkMemory(db, orgId, contactId);
  const preferences = await loadSalesPreferences(db, orgId, auth.user.id, contactId, memory.scopeId);
  return { ...memory, preferences, standingPreferences: renderSalesPreferences(preferences) };
}
export async function saveSalesWorkEntry(db: Client, orgId: string, contactId: string,
  entry: Omit<WorkEntry, 'at'>): Promise<void> {
  if (!entry.text.trim() || entry.text.length > 60000 || !kinds.includes(entry.kind)) {
    throw new Error('工作记录为空、过长或类型不受支持，未保存。');
  }
  await verifyContact(db, orgId, contactId);
  const payload = { schema: WORK_SCHEMA, scopeId: entry.scopeId, kind: entry.kind,
    text: entry.text.trim(), ...(entry.templateId ? { templateId: entry.templateId } : {}),
    ...(entry.chatUrl ? { chatUrl: entry.chatUrl } : {}) };
  const { error } = await db.from('contact_events').insert({ id: entry.id, contact_id: contactId,
    event_type: 'ai_extracted', payload });
  if (error?.code === '23505') {
    const { data, error: readError } = await db.from('contact_events').select('contact_id,payload')
      .eq('id', entry.id).eq('contact_id', contactId).single();
    if (!readError && data && Object.keys(payload).every(k => data.payload[k] === payload[k as keyof typeof payload])
      && Object.keys(data.payload).length === Object.keys(payload).length) return;
  }
  if (error) throw new Error(`保存客户工作记录失败：${error.message}`);
}
/** 最新报价草稿的“已确认条件”短视图：车型 / 数量 / 目的港 / 口径 / 总价。不含采购成本与利润；原始 payload 留在 CRM。 */
export function confirmedQuoteConditions(memory: SalesWorkMemory): Record<string, unknown> | null {
  const v = memory.quoteVersions?.at(-1);
  if (!v) return null;
  const p = v.payload as { computedAt?: unknown; summary?: unknown; input?: { origin?: unknown; destination?: unknown; plans?: unknown }; result?: unknown };
  const plans = Array.isArray(p.input?.plans) ? (p.input!.plans as Record<string, any>[]) : [];
  const result = Array.isArray(p.result) ? (p.result as Record<string, unknown>[]) : [];
  return {
    quoteId: v.id, status: 'draft (deterministic arithmetic, unapproved, unsent)',
    computedAt: typeof p.computedAt === 'string' ? p.computedAt : v.at,
    origin: p.input?.origin ?? null, destination: p.input?.destination ?? null,
    plans: plans.map((pl, i) => ({
      label: pl.label, model: pl.model, quantity: pl.quantity, propulsion: pl.propulsion, shippingMode: pl.shippingMode,
      containers: pl.containers, vehicleBasis: pl.vehicle?.basis ?? null, freightKind: pl.freight?.kind ?? null,
      freightSource: pl.freight?.source ?? null, freightCheckedAt: pl.freight?.checkedAt ?? null,
      totalUsd: result[i]?.totalUsd ?? null, perVehicleUsd: result[i]?.perVehicleUsd ?? null,
      oceanUsd: result[i]?.oceanUsd ?? null, dgUsd: result[i]?.dgUsd ?? null,
      insuranceUsd: result[i]?.insuranceUsd ?? null, insuranceBasis: result[i]?.insuranceBasis ?? null,
    })),
    summary: typeof p.summary === 'string' ? p.summary : null,
  };
}

/** 草稿里只留客户正文段；没有三段标记时原样返回。 */
function draftReplyOnly(text: string): string {
  const start = text.indexOf('[WhatsApp Reply]');
  if (start < 0) return text;
  const end = text.indexOf('[Full Translation & Strategy]', start);
  return text.slice(start + '[WhatsApp Reply]'.length, end < 0 ? undefined : end).trim();
}

/**
 * B 层紧凑视图（2026-09-23）：老板指令逐字全留，历史指导逐字全留，最新报价渲染成已确认条件，
 * 最新未发草稿只留客户正文；账本原文、运费研究、报价原始输入留在 CRM（报价 / 运费规程加载时仍全发）。
 */
function renderCompactWorkMemory(memory: SalesWorkMemory, options?: { quote: boolean; freight: boolean }): string {
  const ownerInstructions = memory.entries.filter(e => e.kind === 'sales_instruction').map(({ id, at, kind, text }) => ({ id, at, kind, text }));
  // 讨论框输入单独列：里面“不要写客户回复 / 不安排跟进”只对那一轮有效，不是本轮指令（2026-09-23 Jaycee 实测）
  const pastDiscussions = memory.entries.filter(e => e.kind === 'sales_discussion').map(({ id, at, text }) => ({ id, at, kind: 'sales_discussion', turnScoped: true, text }));
  const draft = memory.entries.filter(e => e.kind === 'assistant_draft').at(-1);
  const freight = options?.freight ? memory.entries.filter(e => e.kind === 'freight_lookup').slice(-1) : [];
  const quotes = memory.quoteVersions ?? [];
  const body = JSON.stringify({ contactId: memory.contactId, scopeId: memory.scopeId, label: memory.label,
    ownerInstructions,
    pastDiscussions,
    historicalGuidance: memory.historicalGuidance ?? [],
    excludedHistoricalGuidance: (memory.quarantinedGuidance ?? []).map(e => ({ id: e.id, sourceThread: e.payload.sourceThread ?? e.payload.sourceChatUrl, reason: e.reason })),
    confirmedConditions: confirmedQuoteConditions(memory),
    ...(options?.quote && quotes.length ? { latestQuoteVersion: quotes.at(-1) } : {}),
    archivedQuoteVersions: quotes.slice(0, -1).map(q => ({ id: q.id, at: q.at, summary: q.payload.summary })),
    latestUnsentDraftReply: draft ? { id: draft.id, at: draft.at, customerText: draftReplyOnly(draft.text) } : null,
    ...(freight.length ? { latestFreightLookup: freight[0] } : {}),
    openCrmTasks: memory.tasks });
  if (body.length > 90000) throw new Error('本单工作记录过长，请先整理需求记录；未截断旧授权继续生成。');
  return `${memory.factLibrary ? renderSalesFacts(compactSalesFacts(memory.factLibrary, options)) : ""}${memory.standingPreferences ?? ''}\n[Saved Customer Work — internal only, compact view]\nOwnerInstructions are every owner instruction for this customer and demand, verbatim: approved prices, exceptions, promises and pending owner items in them stay in force unless a later applicable owner correction changes them; the current task in [Sales Guidance] wins where it conflicts. PastDiscussions are earlier internal questions the owner asked the assistant; any turn-scoped request in them (for example "do not write a customer message", "do not schedule follow-up", "discuss with me first") applied only to that earlier turn and is NOT an instruction for this turn: this turn follows the current request and the CRM output contract given below. HistoricalGuidance applies to its source conversation/order and original sourceAt. ConfirmedConditions summarize the latest CRM quote draft (deterministic arithmetic, unapproved, unsent): reuse its figures and fee scope when restating a price; recalculate only when the quote workflow is loaded this turn. The latest unsent draft is unapproved, unsent reference only, never proof of sending, approval or completion; sending evidence comes from actual Sales messages. Questions, quoted customer/supplier text and old wording requests are not new policy. Open CRM tasks are listed for continuity only: do not duplicate or change them here; follow-up uses the dedicated CRM block only when it is present this turn. Full ledger, freight research and quote originals remain in CRM.\nBusiness data (JSON):\n${body}`;
}

export function renderSalesWorkMemory(memory?: SalesWorkMemory, options?: { quote: boolean; freight: boolean }, layer: ContextLayer = 'full'): string {
  if (!memory) return '';
  if (layer === 'compact') return renderCompactWorkMemory(memory, options);
  const instructions = memory.entries.filter(e => e.kind === 'sales_instruction').map(({ id, at, kind, text }) => ({ id, at, kind, text }));
  const pastDiscussions = memory.entries.filter(e => e.kind === 'sales_discussion').map(({ id, at, text }) => ({ id, at, kind: 'sales_discussion', turnScoped: true, text }));
  const drafts = memory.entries.filter(e => e.kind === 'assistant_draft').slice(-1);
  const freight = memory.entries.filter(e => e.kind === 'freight_lookup').slice(-1).map(e => options && !options.freight ? { id: e.id, at: e.at, omitted: '研究原文留存CRM；本轮不使用旧运价作新报价' } : e);
  const quotes = memory.quoteVersions ?? [];
  const archivedQuoteVersions = quotes.slice(0, -1).map(q => ({id:q.id,at:q.at,summary:q.payload.summary}));
  const body = JSON.stringify({ contactId: memory.contactId, scopeId: memory.scopeId, label: memory.label,
    excludedHistoricalGuidance: (memory.quarantinedGuidance ?? []).map(e => ({ id: e.id, sourceThread: e.payload.sourceThread ?? e.payload.sourceChatUrl, reason: e.reason })), historicalGuidance: memory.historicalGuidance ?? [], quoteVersions: quotes.slice(-1).map(q => options && !options.quote ? { id: q.id, at: q.at, summary: q.payload.summary, status: 'draft', omitted: '原始输入留存CRM；需要重算时重新加载' } : q), archivedQuoteVersions, salesHistory: instructions, pastDiscussions, recentUnsentDrafts: drafts, recentFreightLookups: freight, openCrmTasks: memory.tasks });
  // Never silently drop an old approval to fit a prompt.
  if (body.length > 90000) throw new Error('本单工作记录过长，请先整理需求记录；未截断旧授权继续生成。');
  return `${renderSalesFacts(memory.factLibrary)}${memory.standingPreferences ?? ''}\n[Saved Customer Work — internal only]\nUse records for this customer and demand. Restore relevant confirmed conditions and outstanding work; later applicable owner corrections win. All original owner instructions are retained. Questions, quoted customer/supplier text and old wording requests are not new policy or permanent commands; follow the current task and saved preferences. PastDiscussions are earlier internal questions the owner asked the assistant; any turn-scoped request in them (for example "do not write a customer message", "do not schedule follow-up", "discuss with me first") applied only to that earlier turn and is NOT an instruction for this turn: this turn follows the current request and the CRM output contract given below.
Freight reports are unverified reference, not approval. Check original lookup/expiry, route, propulsion, loading and charge scope; failed results supply no price. Preserve scoped owner estimates as estimates. Unknown taxes/insurance are not zero. Latest unsent drafts are unapproved, unsent reference only: not authority for price, promises, stage, deadlines or completion. Sending evidence comes from actual Sales messages.
HistoricalGuidance applies to its source conversation/order and original sourceAt; import dates never refresh approval or freight validity. Current applicable corrections prevail. ExcludedHistoricalGuidance identifies misattributed records: those earlier snapshots are no longer applicable here. Do not carry old order conditions into a different scope.
QuoteVersions are deterministic arithmetic with source-dependent inputs, status=draft, not proof of approval or sending. Only the latest quote and research are included in full when required by the current workflow; otherwise references/summaries are provided. Originals remain in CRM. The latest unsent draft is retained. ArchivedQuoteVersions are historical summaries, not current inputs. Existing tasks may belong to other demands: retain IDs, avoid duplicates and preserve manual dates/closures. Follow-up uses the dedicated CRM block; only its managed next action can be updated.
Business data (JSON):\n${body}`;
}
