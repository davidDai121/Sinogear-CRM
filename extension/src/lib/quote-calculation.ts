/** Decimal arithmetic in integer millionths. Money is rounded only at output. */
const SCALE = 1_000_000n;
function decimal(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(value)) throw new Error('金额/汇率须是非负十进制字符串，最多6位小数');
  const [a, b = ''] = value.split('.');
  const n = BigInt(a) * SCALE + BigInt(b.padEnd(6, '0'));
  if (positive && n === 0n) throw new Error('汇率必须大于零');
  return n;
}
function round(n: bigint, divisor: bigint): bigint {
  return n < 0n ? -round(-n, divisor) : (n + divisor / 2n) / divisor;
}
function money(n: bigint): string {
  const cents = round(n, 10000n), abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
function string(v: unknown, label: string): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) throw new Error(`缺少或无效${label}`);
}
function keys(v: unknown, allowed: string[], required = allowed) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !(k in v))) throw new Error('报价字段缺失或含不支持的费用字段，未静默忽略');
}
function integer(v: unknown, label: string): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 10000) throw new Error(`无效${label}`);
}
export interface QuotePlanInput {
  label: string; model: string; quantity: number;
  propulsion: 'bev' | 'fuel' | 'phev' | 'unknown'; shippingMode: 'container' | 'roro';
  containers: number | null; loadingBasis: string;
  vehicle: { basis: 'approved_fob' | 'procurement'; amount: string; currency: 'USD' | 'CNY'; source: string; groundIncluded: boolean };
  freight: { amountUsd: string; source: string; dgIncluded: boolean; groundIncluded: boolean; checkedAt: string; validUntil: string | null; kind: 'public_reference' | 'owner_estimate' };
  profit: { amountCnyPerVehicle: string; source: string } | null;
  groundOverride: { amountCnyPerVehicle: string; source: string } | null;
  insurance: { amountUsdTotal: string; source: string } | { basis: 'freight_10_percent'; source: string } | null;
  fixedSelling: { amountUsdTotal: string; source: string } | null;
}
export interface QuoteInput {
  schema: 'quote-input.v1'; origin: string; destination: string;
  fx: { cnyPerUsd: string; source: string; at: string } | null;
  plans: QuotePlanInput[];
}
export interface CalculatedPlan {
  label: string; model: string; quantity: number; totalUsd: string; perVehicleUsd: string;
  oceanUsd: string; dgUsd: string; groundCny: string; insuranceUsd: string | null;
  insuranceBasis: 'fixed' | 'freight_10_percent' | null;
  transportBeforeInsuranceUsd: string; transportWithInsuranceUsd: string;
  internalCostUsd: string | null; internalProfitCny: string | null;
  savingsTotalUsd?: string; savingsPerVehicleUsd?: string; additionalBudgetUsd?: string;
}
export function calculateQuote(input: QuoteInput, now = Date.now()): CalculatedPlan[] {
  if (!input || input.schema !== 'quote-input.v1' || !Array.isArray(input.plans) || !input.plans.length || input.plans.length > 4) throw new Error('报价输入格式无效');
  keys(input,['schema','origin','destination','fx','plans']);
  string(input.origin, '起运港'); string(input.destination, '目的港');
  let fx: bigint | undefined;
  if (input.fx != null) {
    keys(input.fx,['cnyPerUsd','source','at']);
    string(input.fx.source, '汇率来源');
    if (!Number.isFinite(Date.parse(input.fx.at)) || Date.parse(input.fx.at) > now) throw new Error('汇率日期无效');
    fx = decimal(input.fx.cnyPerUsd, true);
  }
  const toUsd = (n: bigint) => { if (!fx) throw new Error('有人民币费用，缺少本单汇率及来源'); return round(n * SCALE, fx); };
  const seen = new Set<string>();
  const result: CalculatedPlan[] = input.plans.map(p => {
    keys(p,['label','model','quantity','propulsion','shippingMode','containers','loadingBasis','vehicle','freight','profit','groundOverride','insurance','fixedSelling']);
    keys(p.vehicle,['basis','amount','currency','source','groundIncluded']);
    keys(p.freight,['amountUsd','source','dgIncluded','groundIncluded','checkedAt','validUntil','kind']);
    string(p.label, '方案名称'); string(p.model, '车型'); integer(p.quantity, '车辆数量');
    if (seen.has(p.label)) throw new Error('方案名称重复'); seen.add(p.label);
    if (!['bev','fuel','phev','unknown'].includes(p.propulsion) || !['container','roro'].includes(p.shippingMode)) throw new Error('动力或运输方式无效');
    string(p.loadingBasis, '装载/运输依据');
    if (p.shippingMode === 'container') integer(p.containers, '柜数');
    else if (p.containers !== null) throw new Error('滚装不能计集装箱柜数');
    if (!p.vehicle || !['approved_fob','procurement'].includes(p.vehicle.basis) || !['USD','CNY'].includes(p.vehicle.currency)) throw new Error('车价口径无效');
    string(p.vehicle.source, '车价来源'); string(p.freight?.source, '海运来源');
    if (![p.vehicle.groundIncluded, p.freight.groundIncluded, p.freight.dgIncluded].every(v => typeof v === 'boolean')) throw new Error('须先核对费用是否已含，不能把未知当未含');
    const checked = Date.parse(p.freight.checkedAt);
    const expiry = p.freight.validUntil === null ? Infinity : Date.parse(p.freight.validUntil);
    if (!['public_reference','owner_estimate'].includes(p.freight.kind)) throw new Error('freight.kind只能是public_reference或owner_estimate；老板本单批准使用owner_estimate');
    if (!Number.isFinite(checked) || checked > now || Number.isNaN(expiry)) throw new Error('运费日期无效或晚于当前时间，须保留真实原始时间');
    if (now >= Math.min(checked + 7 * 86400000, expiry)) throw new Error('运费参考已到期，本轮应重新查询，不能以保存日期续期');
    const q = BigInt(p.quantity);
    const ocean = decimal(p.freight.amountUsd);
    const dg = p.propulsion === 'bev' && p.shippingMode === 'container' && !p.freight.dgIncluded ? BigInt(p.containers!) * 1000n * SCALE : 0n;
    let ground = 0n;
    if (!p.vehicle.groundIncluded && !p.freight.groundIncluded) {
      if (p.groundOverride != null) { string(p.groundOverride.source, '本单港杂覆盖来源'); ground = decimal(p.groundOverride.amountCnyPerVehicle) * q; }
      else if (p.propulsion === 'bev' || p.propulsion === 'fuel') ground = BigInt(p.propulsion === 'bev' ? 3000 : 2000) * SCALE * q;
      else throw new Error('混动/未知动力港杂口径未确认');
    }
    // PHEV remains PHEV. Once this order's sourced freight already includes DG
    // and ground is included/explicitly budgeted above, there is no missing fee
    // to resolve. Never add the BEV allowance again or relabel it as BEV.
    if (p.propulsion === 'unknown' || (p.propulsion === 'phev' && !p.freight.dgIncluded)) throw new Error('动力分类及DG适用性须确认后核算');
    const transport = ocean + dg + (ground ? toUsd(ground) : 0n);
    let insurance = 0n;
    let insuranceBasis: CalculatedPlan['insuranceBasis'] = null;
    if (p.insurance != null) {
      string(p.insurance.source, '保险来源');
      if ('basis' in p.insurance) {
        keys(p.insurance,['basis','source']);
        if (p.insurance.basis !== 'freight_10_percent') throw new Error('不支持的保险估算口径');
        insurance = round(transport, 10n);
        insuranceBasis = 'freight_10_percent';
      } else {
        keys(p.insurance,['amountUsdTotal','source']);
        insurance = decimal(p.insurance.amountUsdTotal);
        insuranceBasis = 'fixed';
      }
    }
    const base = decimal(p.vehicle.amount) * q;
    const cost = (p.vehicle.currency === 'CNY' ? toUsd(base) : base) + transport + insurance;
    let total = cost;
    if (p.vehicle.basis === 'procurement') {
      if (!p.profit) throw new Error('采购成本模式缺少本单利润批准');
      string(p.profit.source, '利润来源');
      total += toUsd(decimal(p.profit.amountCnyPerVehicle) * q);
    } else if (p.profit != null) throw new Error('已批准FOB车价不能再叠加采购利润');
    if (p.fixedSelling != null) { string(p.fixedSelling.source, '固定售价授权'); total = decimal(p.fixedSelling.amountUsdTotal); }
    // All comparisons use the outward rounded price.
    const rounded = decimal(money(total));
    return { label:p.label, model:p.model, quantity:p.quantity, totalUsd:money(total), perVehicleUsd:money(round(rounded,q)),
      oceanUsd:money(ocean), dgUsd:money(dg), groundCny:money(ground), insuranceUsd:p.insurance == null ? null : money(insurance),
      insuranceBasis, transportBeforeInsuranceUsd:money(transport), transportWithInsuranceUsd:money(transport+insurance),
      internalCostUsd:p.vehicle.basis === 'procurement' ? money(cost) : null,
      internalProfitCny:p.vehicle.basis === 'procurement' ? money(round((rounded-cost)*fx!,SCALE)) : null };
  });
  for (let i=0;i<result.length;i++) {
    const p = result[i], source = input.plans[i];
    const oneIndex = input.plans.findIndex(x => x.quantity === 1 && x.model === source.model && x.vehicle.basis === source.vehicle.basis && x.vehicle.amount === source.vehicle.amount && x.vehicle.currency === source.vehicle.currency && (x.insurance == null) === (source.insurance == null));
    if (p.quantity <= 1 || oneIndex < 0) continue;
    const one = result[oneIndex], saving = decimal(one.totalUsd)*BigInt(p.quantity)-decimal(p.totalUsd);
    p.savingsTotalUsd=money(saving); p.savingsPerVehicleUsd=money(round(saving,BigInt(p.quantity))); p.additionalBudgetUsd=money(decimal(p.totalUsd)-decimal(one.totalUsd));
  }
  return result;
}

export function extractQuoteInput(text: string): { responseText: string; input?: QuoteInput } {
  const matches = [...text.matchAll(/<quote_input>([\s\S]*?)<\/quote_input>/g)];
  if (!text.includes('<quote_input') && !text.includes('</quote_input')) return { responseText:text };
  if (matches.length !== 1 || text.split('<quote_input>').length !== 2 || text.split('</quote_input>').length !== 2 || matches[0][1].length > 30000) throw new Error('报价输入记录不完整，未展示为可发送回复');
  if (text.includes('[WhatsApp Reply]') && (text.indexOf('[Full Translation & Strategy]') < 0 || matches[0].index! < text.indexOf('[Full Translation & Strategy]'))) throw new Error('报价输入出现在客户正文，已阻止');
  try { return { responseText:text.replace(matches[0][0],'').trim(), input:JSON.parse(matches[0][1]) }; }
  catch { throw new Error('报价输入不是有效JSON，未保存或发送'); }
}

export const QUOTE_WORKFLOW = `[CRM deterministic quote calculation]
Default CIF reference policy approved by the owner on 2026-09-18: "总运费x1.1". For a new CIF reference calculation set insurance={"basis":"freight_10_percent","source":"owner global CIF rule 2026-09-18: 总运费x1.1"}. The engine computes a 10% insurance budget on total additional transport (ocean + applicable DG + the uncovered owner CNY2000/3000-per-vehicle surcharge budget converted using sourced FX), then adds it to approved FOB vehicles. Do NOT multiply the vehicle price or entire order by 1.1. Do NOT add CNY1000 insurance as well. Already-included FOB/provider costs are not charged again. This is the owner's insurance-inclusive quoting budget, not an insurer's premium/110% insured cargo value or evidence that a policy was purchased. It supports a clearly labelled CIF reference quote; no missing-insurance/surcharge blocker for this covered scope. Use a newer explicit order-specific insurance amount/inclusion instruction instead when applicable; preserve old quote versions, ordinary FOB-only quotes and deliberate uninsured comparisons.
Owner clarification (2026-09-18): the existing fuel CNY2000/vehicle and BEV CNY3000/vehicle ground allowance covers the discussed port/ground/loading and additional freight charges together. Keep using the existing ground calculation, not a second surcharge field. Do not block a reference estimate for missing itemized carrier surcharges covered by this owner budget. Count included costs only once; do not mistake inclusion in outward FOB for zero internal expense. Destination clearance/taxes are not thereby included.
When THIS turn calculates/revises a numeric export quote or one/multiple-car comparison, prepare inputs, not mental arithmetic. Extract known values from applicable owner approvals/current knowledge, current freight research and this demand's history. Do not ask the owner to fill a form. Do not emit this block for simple questions, an unchanged quote acknowledgment, or an input that is still missing. A missing input remains an explicit internal gap; do not invent an exchange rate, fee inclusion, loading approval or profit.
ONE-PASS QUOTING: Compose the COMPLETE customer-language draft and Chinese translation NOW, alongside one <quote_input>JSON</quote_input> block at the END of [Full Translation & Strategy] (or the end of internal discussion). Do not leave WhatsApp Reply empty just to wait for arithmetic. CRM computes locally and substitutes numeric placeholders immediately, without another GPT turn. In both customer prose and translation use {{quote.1.totalUsd}} and {{quote.1.perVehicleUsd}} for plan 1 total and per-unit USD values; use 2/3/4 for subsequent plans. Each quoted plan needs its total and (if quantity > 1) per-unit placeholder in customer text. Optional USD fields: oceanUsd, dgUsd, insuranceUsd, transportBeforeInsuranceUsd, transportWithInsuranceUsd, savingsTotalUsd, savingsPerVehicleUsd, additionalBudgetUsd. Use only fields applicable to the calculation (savings/additionalBudget currently require a comparable single-car baseline); no formula/arbitrary expressions or internal cost/profit placeholders. Example draft: "CIF reference: USD {{quote.1.totalUsd}} total, USD {{quote.1.perVehicleUsd}} per vehicle." Put units/currency outside placeholders. Input JSON values must remain literal sourced numbers, never placeholders. Do not put placeholders in follow-up evidence. Include the follow-up decision in the SAME response if requested. These latest instructions override old two-turn/empty-reply instructions in this chat. Do not claim local substitution or saving has already happened.
PHEV is supported when this order explicitly confirms DG handling and the sourced freight.amountUsd ALREADY includes its confirmed DG allowance (dgIncluded=true). Keep propulsion=phev; do not relabel it BEV. State the ocean/DG breakdown and actual owner/carrier evidence in freight.source. Ground must be already included in approved FOB/freight or have a sourced groundOverride and FX; never assume a BEV/fuel default for an unclassified hybrid. Such a complete PHEV input must not be refused merely because it is a hybrid.
JSON contract: {"schema":"quote-input.v1","origin":"Shanghai","destination":"actual port","fx":{"cnyPerUsd":"7.00","source":"actual dated source/owner approval, not this example","at":"ISO timestamp"},"plans":[{"label":"plan name","model":"exact model/version","quantity":2,"propulsion":"bev","shippingMode":"container","containers":1,"loadingBasis":"actual order-specific approved loading or explicitly provisional calculation assumption","vehicle":{"basis":"approved_fob","amount":"25000","currency":"USD","source":"actual approved price source/version","groundIncluded":true},"freight":{"amountUsd":"actual ocean TOTAL for this plan","source":"actual record ID/URL/owner statement","dgIncluded":false,"groundIncluded":false,"checkedAt":"ORIGINAL lookup ISO timestamp, not reuse/save time","validUntil":null,"kind":"public_reference"},"profit":null,"groundOverride":null,"insurance":null,"fixedSelling":null}]}.
freight.kind MUST be exactly public_reference for browsed references or owner_estimate for explicit owner-authorized estimates (including test authorizations); do not invent owner_approved or other enum values. All amounts are decimal STRINGS; examples are schema ONLY, never approved values. fx can be null only if no CNY conversion is needed. propulsion: bev/fuel/phev/unknown (unknown cannot calculate; PHEV may calculate with explicitly confirmed DG included and ground covered as above); shippingMode: container/roro (roro containers=null). vehicle is PER CAR; freight and insurance are TOTAL per plan. Up to four plans; model must identify the same version for quantity comparisons. vehicle.basis may be procurement; then profit={amountCnyPerVehicle,source} is required, based on actual owner approval, not a default. approved_fob forbids extra profit. Optional groundOverride={amountCnyPerVehicle,source}, insurance={amountUsdTotal,source}, fixedSelling={amountUsdTotal,source} need explicit sources. No unsupported buffer/other allowance fields. Existing FOB/provided freight that already includes port/ground costs must mark the matching inclusion true; don't double charge. Confirm DG inclusion from source; don't infer unknown inclusion as false. The engine separately adds owner BEV DG USD1000/container and ground BEV CNY3000/car or fuel2000/car only where not included. Preserve order-specific conditions and unknown insurance/local taxes. No calculation is an approval or a sent quote. Current request language/style wins over archival one-turn instructions.`;
