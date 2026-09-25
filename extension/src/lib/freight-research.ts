/** A model's browsing report is evidence to review, never an approved freight quote. */
export function extractFreightResearch(text: string): { responseText: string; record?: string } {
  const open = '<freight_research>';
  const close = '</freight_research>';
  if (!text.includes(open) && !text.includes(close)) return { responseText: text };
  const matches = [...text.matchAll(/<freight_research>([\s\S]*?)<\/freight_research>/g)];
  if (matches.length !== 1 || text.split(open).length !== 2 || text.split(close).length !== 2
    || !matches[0][1].trim() || matches[0][1].length > 40000) {
    throw new Error('运费研究记录不完整，未把它当作可发送回复。');
  }
  const strategy = text.indexOf('[Full Translation & Strategy]');
  // Discussion is internal and has no three-section contract. Customer replies must
  // keep the record inside the internal strategy, never in WhatsApp Reply.
  if (text.includes('[WhatsApp Reply]') && (strategy < 0 || matches[0].index! < strategy)) {
    throw new Error('运费研究记录出现在客户正文中，已阻止展示为客户回复。');
  }
  return { responseText: text.replace(matches[0][0], '').trim(), record: matches[0][1].trim() };
}

// 2026-09-25 起运费由 CRM 估算（物流巴巴平台价 + 老板规则，见 supabase/functions/freight-rate-lookup），
// GPT 不再上网查运费。标题行保持不变：gpt-workflow-selection 的测试按这一行判断运费模块是否加载。
export const FREIGHT_RESEARCH_WORKFLOW = `[Freight research — conversational, no form]
Freight is estimated by the CRM this turn, not researched by you. Do not browse for freight, carriers, sailing schedules or exchange rates, do not reuse freight figures from older chat or old AI answers, and do not output a <freight_research> block. When the current request needs a CIF or freight-inclusive price, follow [CRM deterministic quote calculation]: name the destination port and its country code in quote_input and let CRM fill freight and insurance. Default origin is Shanghai. If the destination country is unknown and it genuinely blocks the price, ask the customer for the country or port; otherwise use the customer's country and its main port. Container loading: one vehicle per 20GP, two per 40HQ, no consolidation with other customers. An owner-given freight or RoRo figure for this order overrides the CRM estimate (owner_estimate). Customer text states the CIF total as a reference price for the stated port; local import taxes, customs clearance and registration are excluded.`;
