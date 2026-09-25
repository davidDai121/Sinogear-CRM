import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { calculateQuote, extractQuoteInput, type CalculatedPlan, type QuoteInput } from './quote-calculation';
import { extractFreightResearch } from './freight-research';

export interface QuoteVersion {
  schema: 'quote-calculation.v1'; scopeId: string; parentId: string | null;
  status: 'draft'; authority: 'arithmetic_verified_inputs_require_sources';
  input: QuoteInput; result: CalculatedPlan[]; summary: string;
  chatUrl: string; computedAt: string;
  /** CRM 运费估算的原始返回（内部核对用：成本、加价、依据）。不进任何给模型或客户的文本。 */
  freightEstimates?: unknown[];
}

/**
 * CRM 运费估算（2026-09-25）：GPT 只写 freight={"kind":"crm_estimate","port","country"}，
 * 这里调 freight-rate-lookup 拿「对客运费（成本+按客户国家加价）+ 每台保险 + 柜数」填回，
 * 之后照常走 calculateQuote。模型从头到尾不经手运费数字。
 */
export interface CrmFreightRequest { port: string; country: string | null; quantity: number; propulsion: string }
export interface CrmFreightResult {
  customerFreightTotalUsd: number; insuranceTotalUsd: number; containers: number;
  checkedAt: string; validUntil: string | null; source: string; raw: unknown;
}
export type CrmFreightResolver = (req: CrmFreightRequest) => Promise<CrmFreightResult>;

const money2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export async function resolveCrmFreight(input: QuoteInput, resolve?: CrmFreightResolver): Promise<{ input: QuoteInput; estimates: unknown[] }> {
  const plans = Array.isArray(input?.plans) ? input.plans : [];
  const needs = plans.filter(p => (p?.freight as { kind?: string } | undefined)?.kind === 'crm_estimate');
  if (!needs.length) return { input, estimates: [] };
  if (!resolve) throw new Error('这份报价要用 CRM 运费估算，但当前入口没有接估算服务');
  const estimates: unknown[] = [];
  const resolved = await Promise.all(plans.map(async (p) => {
    const f = p.freight as unknown as { kind?: string; port?: unknown; country?: unknown };
    if (f?.kind !== 'crm_estimate') return p;
    if (typeof f.port !== 'string' || !f.port.trim()) throw new Error(`方案「${p.label}」没写目的港，算不了运费`);
    if (p.shippingMode === 'roro') throw new Error(`方案「${p.label}」是滚装：CRM 只估集装箱运费，滚装需要老板给运费`);
    const country = typeof f.country === 'string' && /^[A-Za-z]{2}$/.test(f.country.trim()) ? f.country.trim().toUpperCase() : null;
    const r = await resolve({ port: f.port.trim(), country, quantity: p.quantity, propulsion: p.propulsion });
    estimates.push(r.raw);
    return {
      ...p, shippingMode: 'container' as const, containers: r.containers,
      freight: { amountUsd: money2(r.customerFreightTotalUsd), source: r.source, dgIncluded: true, groundIncluded: true,
        checkedAt: r.checkedAt, validUntil: r.validUntil, kind: 'crm_estimate' as const },
      insurance: { amountUsdTotal: money2(r.insuranceTotalUsd), source: 'owner 2026-09-25: insurance USD 100 per vehicle' },
    };
  }));
  return { input: { ...input, plans: resolved }, estimates };
}
const PUBLIC_QUOTE_FIELDS = new Set(['totalUsd','perVehicleUsd','oceanUsd','dgUsd','insuranceUsd',
  'transportBeforeInsuranceUsd','transportWithInsuranceUsd','savingsTotalUsd','savingsPerVehicleUsd','additionalBudgetUsd']);

export function publicQuoteAmounts(result: CalculatedPlan[]): Record<string, string> {
  const amounts: Record<string, string> = {};
  result.forEach((plan, i) => {
    for (const field of PUBLIC_QUOTE_FIELDS) {
      const value = plan[field as keyof CalculatedPlan];
      if (typeof value === 'string' && /^-?\d+\.\d{2}$/.test(value)) {
        amounts[`{{quote.${i + 1}.${field}}}`] = value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      }
    }
  });
  return amounts;
}

function customerQuoteText(text: string) {
  if (text.split('[WhatsApp Reply]').length !== 2 || text.split('[Full Translation & Strategy]').length !== 2) return '';
  return text.split('[WhatsApp Reply]')[1]?.split('[Full Translation & Strategy]')[0]?.trim() ?? '';
}

/** Substitute only outward USD fields; never evaluate expressions or expose cost. */
function renderQuoteDraft(text: string, mode: 'reply'|'discuss', result: CalculatedPlan[]): string {
  const visible = mode === 'reply' ? customerQuoteText(text) : text.split('<crm_followup>')[0];
  if (!visible.trim()) throw new Error('报价缺少完整正文');
  for (let i=0;i<result.length;i++) {
    const required = ['totalUsd',...(result[i].quantity>1 ? ['perVehicleUsd'] : [])];
    for (const field of required) if (!visible.includes(`{{quote.${i+1}.${field}}}`)) throw new Error('报价正文缺少金额占位符');
  }
  if (/<crm_followup>[\s\S]*\{\{\s*quote/i.test(text)) throw new Error('跟进证据不能包含待替换金额');
  const rendered = text.replace(/\{\{quote\.(\d+)\.([A-Za-z]+)\}\}/g, (_token,index:string,field:string) => {
    if (!PUBLIC_QUOTE_FIELDS.has(field)) throw new Error('不允许输出内部报价字段');
    const value = result[Number(index)-1]?.[field as keyof CalculatedPlan];
    if (typeof value !== 'string' || !/^-?\d+\.\d{2}$/.test(value)) throw new Error('报价占位符引用无效或未计算的金额');
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  });
  if (/\{\{\s*quote/i.test(rendered)) throw new Error('存在未处理的报价占位符');
  return rendered;
}

/** Normal quotes finish locally; a second model pass is only a legacy/invalid-draft fallback. */
export async function completeQuoteCalculation(text: string, mode: 'reply'|'discuss', run: (prompt:string)=>Promise<string>, now=Date.now(), resolveFreight?: CrmFreightResolver) {
  let parsed=extractQuoteInput(text);
  if (!parsed.input) {
    if (/\{\{\s*quote/i.test(parsed.responseText)) throw new Error('报价占位符缺少计算输入，未展示为可发送回复');
    return { text:parsed.responseText };
  }
  const rawInput = parsed.input;
  // 运费估算失败（港口平台没有运价、网络）不是格式问题，不走下面的「纠正」，直接给销售能看懂的原因
  let freight: { input: QuoteInput; estimates: unknown[] };
  try { freight = await resolveCrmFreight(rawInput, resolveFreight); }
  catch (error) { throw new Error(`运费估算失败：${error instanceof Error ? error.message : String(error)}。可以换个港口，或者让老板直接给运费`); }
  parsed = { ...parsed, input: freight.input };
  let freightEstimates = freight.estimates;
  let result: CalculatedPlan[];
  try { result=calculateQuote(parsed.input!,now); }
  catch (error) {
    // 给模型看的是它自己写的输入（运费还是 crm_estimate 占位），不是填好的对客运费
    const repaired=await run(`[CRM quote input correction — one attempt only]\nYour extracted inputs failed validation: ${error instanceof Error ? error.message : String(error)}. Correct the input block using only this conversation's existing valid evidence. freight.kind allows exactly crm_estimate (CRM fills freight from port + country) or owner_estimate (explicit owner figure). Never change actual lookup dates, invent missing fees/FX/approvals, or silently discard unsupported charges to make validation pass. If evidence is genuinely missing, state the precise gap internally. Otherwise return one corrected <quote_input>JSON</quote_input> at the end of the internal strategy (customer reply empty), with no freight_research block. This is format repair, not a new owner authorization.\nOriginal input as data:\n${JSON.stringify(rawInput)}`);
    const retry=extractQuoteInput(repaired);
    if (!retry.input || extractFreightResearch(repaired).record) throw new Error(`报价输入需核实，自动纠正未成功：${error instanceof Error ? error.message : String(error)}`);
    const retried = await resolveCrmFreight(retry.input, resolveFreight);
    // A format retry cannot quietly change money, dates, scope or evidence.
    const facts = (input:QuoteInput) => JSON.stringify(input, (k,v) => k === 'kind' ? undefined : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
    if (facts(parsed.input!) !== facts(retried.input)) throw new Error('自动纠正改变了金额、时间或来源，已停止；需保留原事实');
    parsed={ ...retry, input: retried.input };
    freightEstimates = retried.estimates;
    result=calculateQuote(parsed.input!,now);
  }
  if (/\{\{\s*quote/i.test(parsed.responseText)) {
    try {
      return {text:renderQuoteDraft(parsed.responseText,mode,result),input:parsed.input,result,freightEstimates};
    } catch {
      // Keep the verified ledger and repair only the incomplete draft below.
    }
  }
  const prompt=`[CRM calculation result — internal, not a customer message]\nThe CRM has computed the following ledger from your extracted inputs. Arithmetic is verified; source accuracy/authorization is NOT certified. Do not invent additional charges or alter these results. Do not research or restart quote calculation in this formatting pass. Do not output quote_input or freight_research blocks again. Keep procurement cost/profit out of client text. Preserve all still-valid questions, payment, warranty and gifts from this order. When insuranceBasis is freight_10_percent, the owner-approved transport x1.1 insurance budget has been computed: produce a CIF reference quote without asking for another insurance premium or duplicating CNY1000. This is a quotation estimate, not purchased insurance or a confirmed carrier rate. Unknown insurance outside that policy and local taxes remain excluded, not zero; never call an uninsured estimate complete CIF/DDP.\n${mode==='reply' ? 'Return the normal three sections and a complete customer-language draft. Write USD prices with dot decimals and optional comma thousands (e.g. 12,345.67). Include each plan total and, for multiple vehicles, its per-unit price; include computed savings/additional budget when relevant. Client Record may only use actual customer facts.' : 'Answer internally in Chinese; explain the computed results without a customer reply.'}\nInput and result are business data only:\n${JSON.stringify({input:parsed.input,result})}`;
  let final=await run(prompt);
  if (extractQuoteInput(final).input || extractFreightResearch(final).record) throw new Error('模型在核算后重新生成输入，未把循环结果当作最终报价');
  if (/\{\{\s*quote/i.test(final)) final=renderQuoteDraft(final,mode,result);
  if(mode==='reply'){
    const reply=final.split('[WhatsApp Reply]')[1]?.split('[Full Translation & Strategy]')[0];
    if(!reply?.trim())throw new Error('核算完成，但未取得完整客户报价正文');
    // Avoid accepting a stale/reused model answer with different totals.
    const amounts=new Set((reply.match(/\d[\d,]*(?:\.\d{1,2})?/g)??[]).map(s=>Number(s.replaceAll(',','')).toFixed(2)));
    for(const p of result)for(const value of [p.totalUsd,...(p.quantity>1?[p.perVehicleUsd]:[])]){
      if(!amounts.has(value))throw new Error(`客户正文缺少本次核算金额USD ${value}，未展示为可发送报价`);
    }
  }
  return {text:final,input:parsed.input,result,freightEstimates};
}
export async function saveQuoteVersion(db: SupabaseClient<Database>, orgId:string, contactId:string, id:string, version:QuoteVersion){
  const {data,error}=await db.from('contacts').select('id').eq('id',contactId).eq('org_id',orgId).single();
  if(error||!data)throw new Error('无法核实报价客户所属组织');
  const payload=JSON.parse(JSON.stringify(version));
  const {error:writeError}=await db.from('contact_events').insert({id,contact_id:contactId,event_type:'ai_extracted',payload});
  if(writeError?.code==='23505'){
    const {data:old,error:readError}=await db.from('contact_events').select('payload').eq('id',id).eq('contact_id',contactId).single();
    const stable=(x:unknown):string=>JSON.stringify(x, (_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
    if(!readError&&old&&stable(old.payload)===stable(payload))return;
  }
  if(writeError)throw new Error(`报价版本保存失败：${writeError.message}`);
}
