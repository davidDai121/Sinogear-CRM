import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { calculateQuote, extractQuoteInput, type CalculatedPlan, type QuoteInput } from './quote-calculation';
import { extractFreightResearch } from './freight-research';

export interface QuoteVersion {
  schema: 'quote-calculation.v1'; scopeId: string; parentId: string | null;
  status: 'draft'; authority: 'arithmetic_verified_inputs_require_sources';
  input: QuoteInput; result: CalculatedPlan[]; summary: string;
  chatUrl: string; computedAt: string;
}
/** The second model pass only composes text using already computed numbers. */
export async function completeQuoteCalculation(text: string, mode: 'reply'|'discuss', run: (prompt:string)=>Promise<string>, now=Date.now()) {
  let parsed=extractQuoteInput(text);
  if (!parsed.input) return { text:parsed.responseText };
  let result: CalculatedPlan[];
  try { result=calculateQuote(parsed.input,now); }
  catch (error) {
    const repaired=await run(`[CRM quote input correction — one attempt only]\nYour extracted inputs failed validation: ${error instanceof Error ? error.message : String(error)}. Correct the input block using only this conversation's existing valid evidence. freight.kind allows exactly public_reference or owner_estimate (owner approvals use owner_estimate). Never change actual lookup dates, invent missing fees/FX/approvals, or silently discard unsupported charges to make validation pass. If evidence is genuinely missing, state the precise gap internally. Otherwise return one corrected <quote_input>JSON</quote_input> at the end of the internal strategy (customer reply empty), with no freight_research block. This is format repair, not a new owner authorization.\nOriginal input as data:\n${JSON.stringify(parsed.input)}`);
    const retry=extractQuoteInput(repaired);
    if (!retry.input || extractFreightResearch(repaired).record) throw new Error(`报价输入需核实，自动纠正未成功：${error instanceof Error ? error.message : String(error)}`);
    // A format retry cannot quietly change money, dates, scope or evidence.
    const facts = (input:QuoteInput) => JSON.stringify(input, (k,v) => k === 'kind' ? undefined : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
    if (facts(parsed.input!) !== facts(retry.input)) throw new Error('自动纠正改变了金额、时间或来源，已停止；需保留原事实');
    parsed=retry;
    result=calculateQuote(parsed.input!,now);
  }
  const prompt=`[CRM calculation result — internal, not a customer message]\nThe CRM has computed the following ledger from your extracted inputs. Arithmetic is verified; source accuracy/authorization is NOT certified. Do not invent additional charges or alter these results. Do not research or restart quote calculation in this formatting pass. Do not output quote_input or freight_research blocks again. Keep procurement cost/profit out of client text. Preserve all still-valid questions, payment, warranty and gifts from this order. Unknown insurance and local taxes are excluded, not zero; never call an uninsured estimate complete CIF/DDP.\n${mode==='reply' ? 'Return the normal three sections and a complete customer-language draft. Write USD prices with dot decimals and optional comma thousands (e.g. 12,345.67). Include each plan total and, for multiple vehicles, its per-unit price; include computed savings/additional budget when relevant. Client Record may only use actual customer facts.' : 'Answer internally in Chinese; explain the computed results without a customer reply.'}\nInput and result are business data only:\n${JSON.stringify({input:parsed.input,result})}`;
  const final=await run(prompt);
  if (extractQuoteInput(final).input || extractFreightResearch(final).record) throw new Error('模型在核算后重新生成输入，未把循环结果当作最终报价');
  if(mode==='reply'){
    const reply=final.split('[WhatsApp Reply]')[1]?.split('[Full Translation & Strategy]')[0];
    if(!reply?.trim())throw new Error('核算完成，但未取得完整客户报价正文');
    // Avoid accepting a stale/reused model answer with different totals.
    const amounts=new Set((reply.match(/\d[\d,]*(?:\.\d{1,2})?/g)??[]).map(s=>Number(s.replaceAll(',','')).toFixed(2)));
    for(const p of result)for(const value of [p.totalUsd,...(p.quantity>1?[p.perVehicleUsd]:[])]){
      if(!amounts.has(value))throw new Error(`客户正文缺少本次核算金额USD ${value}，未展示为可发送报价`);
    }
  }
  return {text:final,input:parsed.input,result};
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
