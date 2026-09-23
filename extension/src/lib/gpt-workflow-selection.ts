/**
 * 决定本轮 prompt 要不要加载「运费查询规程」和「确定性报价核算规程」。
 *
 * 背景（2026-09-18 诊断）：SALES_WORKFLOW 把两段合计约 1.4 万字符的规程无条件
 * 注入每一轮，客户问个颜色也要读完整的报价/运费契约。这里按 CRM 已知状态和
 * 明确请求来路由，关键词只是兜底信号，不是唯一依据：
 *
 *   - 未解决的报价需求：本 scope 有报价草稿且没有可靠的发送证据
 *   - 缺项补充 / 数量 / 港口 / 车型变化：最近入站与最新报价输入不一致
 *   - 明确查价 / 查运费请求：销售指令、讨论问题、未回复的客户入站
 *   - 客户在回答销售为报价而问的问题（数量 / 颜色 / 港口）→ 继续报价
 *   - 老板对报价阻塞的简短澄清（"就是dg" / "一台" / "美元"）继续报价
 *   - 历史开放任务保留在工作记忆，但其标题本身不触发报价 / 运费规程
 *
 * 保守原则：要报价就同时带运费规程（运费有效期 7 天、路线/柜型/动力一致等
 * 规则由 FREIGHT_RESEARCH_WORKFLOW 自己判断，这里不另造有效期），唯一例外
 * 是明确只要 FOB、完全不涉及运输的请求。证不了"已发送"就当未发送。
 * 没有任何信号才两块都不加载（纯转述已批准数字、普通问答）。
 *
 * 纯函数、不读网络，node --test 可直接测（scripts/test-gpt-workflow-selection.mjs）。
 */
import type { ChatMessage } from '@/content/whatsapp-messages';
import type { SalesWorkMemory } from './sales-work-memory';
import { isMediaOnly } from './chat-media-utils';
import { isSalesPitch } from './sales-pitch';

export interface WorkflowSelectionInput {
  salesGuidance?: string;
  discussionQuestion?: string;
  messages?: ChatMessage[];
  vehicleInterests?: { model: string }[];
  workMemory?: SalesWorkMemory;
  contact?: { destination_port?: string | null };
}

export interface WorkflowSelection {
  freight: boolean;
  quote: boolean;
  /** 每条一个触发依据，便于日志和验收对照 */
  reasons: string[];
}

/** 明确要价格 / 报价 / 总价的说法（销售侧中文 + 客户侧 en/es/fr/pt/ar 常见词） */
const QUOTE_REQUEST = /报价|价格|多少钱|出价|cif|fob|cfr|ddp|quot(?:e|ation)|pric(?:e|ing)|how much|precio|cu[aá]nto|cuesta|costo|cotiza|cotización|cotação|preço|quanto custa|prix|devis|combien|per unit|por unidad|每台|السعر|سعر|bei\b/i;
/** 明确涉及运输方式 / 运价 / 箱型 / 港口的说法 */
const FREIGHT_REQUEST = /运费|海运|运输|查运费|船期|危险品|箱型|整柜|拼箱|滚装|\bdg\b|20\s*gp|40\s*(?:hq|hc|gp)|ro-?ro|freight|shipping|ocean|container|contenedor|flete|env[ií]o|frete|fret|港口?|\bport\b|puerto|porto|cif|cfr|ddp|الشحن/i;
/** 老板对报价阻塞的简短澄清：只要含这些词就是在继续报价 */
const QUOTE_CLARIFICATION = /^(?:就是|按|用|是|对|要|走)?\s*(?:dg|危险品|美元|usd|一台|两台|三台|四台|\d+\s*台|20\s*gp|40\s*(?:hq|hc|gp)|整柜|拼箱|ro-?ro|滚装|cif|fob)(?![a-z])/i;
/** 只要 FOB、不要运输的说法（有它且没有任何运输词 → 不带运费规程） */
const FOB_ONLY = /\bfob\b|出厂价|离岸/i;
/** 单纯的确认/道谢，不是在提供报价所需信息 */
const ACKNOWLEDGEMENT = /^(?:si|sí|yes|yeah|ok|okay|vale|perfecto|perfect|good|great|bien|gracias|thanks?|thank you|merci|obrigado|好的?|可以|行|谢谢|收到|👍|🙏)[\s.!。！]*$/i;
/** 客户改数量："solo quiero 1" / "only 2 units" / "5 台" */
const QUANTITY_MENTION = /(?:solo|sólo|only|just|quiero|want|need|necesito|要|买)\s*(?:quiero\s*)?(\d{1,3})\b|\b(\d{1,3})\s*(?:units?|unidades?|vehicles?|veh[ií]culos?|pickups?|camionetas?|carros?|cars?|pcs|台|辆)/i;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function substantiveInbound(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) =>
    !m.fromMe && !isMediaOnly(m.text) && !isSalesPitch(m.text) && m.text.trim() !== '[已删除]');
}

/** 最后一条销售出站之后的客户消息 = 尚未回复的需求；同时返回被回答的那条销售消息 */
function pendingExchange(messages: ChatMessage[]): { inbound: ChatMessage[]; lastOutbound: ChatMessage | null } {
  let lastOutbound = -1;
  messages.forEach((m, i) => { if (m.fromMe) lastOutbound = i; });
  return {
    inbound: substantiveInbound(messages.slice(lastOutbound + 1)),
    lastOutbound: lastOutbound >= 0 ? messages[lastOutbound] : null,
  };
}

interface QuoteDraft {
  computedAt: number | null;
  destination: string | null;
  quantities: number[];
  models: string[];
  /** 每个方案的主总价（result[i].totalUsd），不含保险等分项 */
  totals: string[];
}

function latestQuoteDraft(memory: SalesWorkMemory | undefined): QuoteDraft | null {
  const version = memory?.quoteVersions?.at(-1);
  if (!version) return null;
  const p = version.payload as { computedAt?: unknown; input?: { destination?: unknown; plans?: unknown }; result?: unknown };
  const plans = Array.isArray(p.input?.plans) ? (p.input!.plans as Array<{ quantity?: unknown; model?: unknown }>) : [];
  const result = Array.isArray(p.result) ? (p.result as Array<{ totalUsd?: unknown }>) : [];
  const computedAt = typeof p.computedAt === 'string' ? Date.parse(p.computedAt) : Date.parse(version.at);
  return {
    computedAt: Number.isFinite(computedAt) ? computedAt : null,
    destination: typeof p.input?.destination === 'string' ? p.input.destination : null,
    quantities: plans.map((x) => Number(x.quantity)).filter((n) => Number.isFinite(n)),
    models: plans.map((x) => (typeof x.model === 'string' ? x.model : '')).filter(Boolean),
    totals: result.map((r) => r.totalUsd).filter((v): v is string => typeof v === 'string'),
  };
}

/**
 * 「已发送」只认强证据：真实销售出站 + 有时间戳且晚于草稿核算时间 + 正文里
 * 以数字边界完整出现某个方案的主总价（带或不带千分位）。任一条件缺失都当
 * 未发送 → 继续加载报价规程（保守方向）。这只能说明"可能已发"，所以它只用来
 * 取消"草稿未发"这一个触发，不影响其它信号。
 */
function draftAppearsSent(draft: QuoteDraft, messages: ChatMessage[]): boolean {
  if (draft.totals.length === 0 || draft.computedAt == null) return false;
  const patterns = draft.totals.map((t) => {
    const [int, frac] = t.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const fracPart = frac ? `(?:\\.${frac})?` : '';
    return new RegExp(`(?<![\\d.,])(?:${int}|${grouped.replace(/,/g, ',')})${fracPart}(?![\\d])`);
  });
  return messages.some((m) => m.fromMe && m.timestamp != null && m.timestamp > draft.computedAt! && patterns.some((re) => re.test(m.text)));
}

export function selectGptWorkflows(input: WorkflowSelectionInput): WorkflowSelection {
  const messages = input.messages ?? [];
  const reasons: string[] = [];
  let quote = false;
  let freight = false;
  const requestTexts: string[] = [];

  const requests = [input.salesGuidance, input.discussionQuestion].filter((t): t is string => !!t?.trim());
  for (const text of requests) {
    requestTexts.push(text);
    if (QUOTE_REQUEST.test(text)) { quote = true; reasons.push('销售指令/讨论明确涉及价格或报价'); }
    if (FREIGHT_REQUEST.test(text)) { freight = true; reasons.push('销售指令/讨论明确涉及运输或运费'); }
    if (QUOTE_CLARIFICATION.test(text.trim())) { quote = true; freight = true; reasons.push('老板对报价阻塞的简短澄清，继续报价'); }
  }

  const { inbound: pending, lastOutbound } = pendingExchange(messages);
  const pendingText = pending.map((m) => m.text).join('\n');
  if (pendingText) {
    requestTexts.push(pendingText);
    if (QUOTE_REQUEST.test(pendingText)) { quote = true; reasons.push('客户尚未回复的消息在问价格'); }
    if (FREIGHT_REQUEST.test(pendingText)) { freight = true; reasons.push('客户尚未回复的消息涉及运输/港口'); }
    // 客户在回答销售为了报价而问的问题（"1"、"Negra"、"Buenaventura"）→ 报价在继续。
    // 要求：销售那条是问句且涉及报价/运输；客户的回复是在提供信息，而不是
    // 单纯的 是/好/谢谢（那是对已报价的回应，不需要重算）
    const isQuestion = !!lastOutbound && /[?？¿]/.test(lastOutbound.text);
    const onlyAcknowledges = pending.every((m) => ACKNOWLEDGEMENT.test(m.text.trim()));
    if (lastOutbound && isQuestion && !onlyAcknowledges && !isSalesPitch(lastOutbound.text)
      && (QUOTE_REQUEST.test(lastOutbound.text) || FREIGHT_REQUEST.test(lastOutbound.text))) {
      quote = true;
      if (FREIGHT_REQUEST.test(lastOutbound.text)) freight = true;
      reasons.push('客户在回答销售为报价提出的问题');
    }
  }

  const draft = latestQuoteDraft(input.workMemory);
  if (draft) {
    if (!draftAppearsSent(draft, messages)) { quote = true; reasons.push('本需求有报价草稿且没有可靠的发送证据'); }
    const port = input.contact?.destination_port?.trim();
    if (port && draft.destination && !normalize(draft.destination).includes(normalize(port)) && !normalize(port).includes(normalize(draft.destination))) {
      quote = true; freight = true; reasons.push('目的港与最新报价输入不一致');
    }
    const recentInbound = substantiveInbound(messages).filter((m) => draft.computedAt == null || m.timestamp == null || m.timestamp >= draft.computedAt);
    for (const m of recentInbound) {
      const q = m.text.match(QUANTITY_MENTION);
      const n = q ? Number(q[1] ?? q[2]) : NaN;
      if (Number.isFinite(n) && n > 0 && draft.quantities.length && !draft.quantities.includes(n)) {
        quote = true; freight = true; reasons.push(`客户提到的数量 ${n} 与最新报价方案不一致`);
        break;
      }
    }
    const interest = input.vehicleInterests?.at(-1)?.model;
    if (interest && draft.models.length && !draft.models.some((m) => normalize(m).includes(normalize(interest)) || normalize(interest).includes(normalize(m)))) {
      quote = true; freight = true; reasons.push('最新车型兴趣不在报价方案内');
    }
  }

  // Task titles are historical commitments, not a request to reprice this turn.
  // Keep them in work memory for review; current requests and unresolved quote
  // inputs above decide which procedures to load. A completed-but-open legacy
  // freight task must not make every greeting run the quotation workflow.

  // 运费研究的结果必须进 quote_input，所以要运费就一定要报价规程
  if (freight) quote = true;
  // 要报价就带运费规程（有效期/路线一致性交给规程本身判断）；唯一例外：
  // 请求明确只要 FOB 且没有任何运输词
  if (quote && !freight) {
    const joined = requestTexts.join('\n');
    const fobOnly = FOB_ONLY.test(joined) && !FREIGHT_REQUEST.test(joined);
    if (fobOnly) reasons.push('只要 FOB，不涉及运输，不加载运费规程');
    else { freight = true; reasons.push('报价默认带运费规程（有效期与路线一致性由规程判断）'); }
  }

  return { freight, quote, reasons: [...new Set(reasons)] };
}
