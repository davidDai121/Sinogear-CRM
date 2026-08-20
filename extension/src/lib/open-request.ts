/**
 * 从客户消息里识别「他明确要我们给的东西」。
 *
 * 为什么要这个（2026-08-19 实测）：
 *   全库 3,936 个客户收到过报价，只有 36 个口头确认、24 个成交。漏斗的窟窿
 *   在报价之后。逐个读聊天发现的是同一个病 —— 客户张口要的东西没给到：
 *     · Brian  要电池 SOH 报告 / VIN 照片 / 车辆历史 / 书面质保 → 给了个 92MB 打不开的视频
 *     · Amr    要 catalog + PDF 规格书，问了两次 → 至今没发（他要买 10 台全新车）
 *     · ÀL-Mìsbãh 要 CIF Lagos 报价 → 58 天没给
 *   tasks 表本来就是干这个的，但要手动建，6/22 之后再没人用过（46 条，近 30 天 0 条）。
 *   销售在 WhatsApp 里打字，不会切 tab 填表单——所以必须自动认出来 + 一键入库。
 *
 * 只做规则匹配，不调 AI：确定性、零延迟、零成本，且销售能一眼看懂为什么命中。
 */

export type RequestKind =
  | 'quote'
  | 'spec'
  | 'media'
  | 'condition'
  | 'document'
  | 'logistics'
  | 'stock'
  | 'payment';

export interface OpenRequest {
  kind: RequestKind;
  /** 中文短标签，直接用作待办标题 */
  label: string;
  /** 命中的原句，给销售看上下文 */
  quote: string;
}

const KIND_LABEL: Record<RequestKind, string> = {
  quote: '报价',
  spec: '规格书 / 目录',
  media: '照片 / 视频',
  condition: '车况证明（里程 / VIN / 电池 / 事故史）',
  document: '单证（PI / 合同 / 证书）',
  logistics: '运费 / 交期',
  stock: '现车 / 可选车型',
  payment: '付款方式',
};

/** 「他在要东西」的语气标记——没有这个就不算请求，只是闲聊里提到了某个词 */
const ASK =
  /\b(send|share|provide|give|show|need|want|require|forward|attach|can you|could you|would you|will you|will u|do you|are you|accept|please|kindly|let me know|waiting for|looking for|interested in having)\b|[?？]|请(发|给|提供|报)|麻烦|能否|可以.*吗/i;

const TOPICS: Array<[RequestKind, RegExp]> = [
  ['quote',     /\b(quot\w*|price|pricing|cost|CIF|FOB|C&F|CFR|offer|proforma price)\b|报价|价格|多少钱/i],
  ['spec',      /\b(catalog\w*|brochure|spec\w*|specification|configuration|datasheet|PDF|technical (detail|info)|colou?rs? available|range per charge|km ?\/ ?charge|km per charge|fuel consumption|battery capacity)\b|规格|配置|参数|目录|续航|catalogue/i],
  ['media',     /\b(photo\w*|picture\w*|image\w*|video\w*|walk[- ]?around|footage|clip)\b|照片|图片|视频/i],
  ['condition', /\b(mileage|odometer|VIN|chassis (no|number)|battery (health|report|SOH|diagnostic)|SOH|accident|repair history|vehicle history|registration detail|inspection report|year of manufacture|manufacturing year)\b|里程|车架号|电池健康|事故|车况/i],
  ['document',  /\b(PI\b|proforma|invoice|contract|agreement|certificate|export licen[cs]e|documents?)\b|合同|发票|单证|证书/i],
  ['logistics', /\b(shipping cost|freight|sea freight|delivery time|lead time|how long|ETA|arrive|shipment schedule|transit time)\b|运费|海运费|多久|交期|船期/i],
  ['stock',     /\b(in stock|available|availability|inventory|ready stock|what (models|cars) do you have|other options?)\b|现车|有货|库存|还有什么/i],
  ['payment',   /\b(payment (term|method|plan)|bank guarantee|L\/C|letter of credit|deposit|installment|T\/T)\b|付款方式|定金|分期|信用证/i],
];

/** 广告推送 / 表单自动消息 / 引用块污染——这些不是客户在说话 */
const NOISE =
  /logo-(facebook|instagram)|Grow Your EV Business|media-play|filled (out|in) your form|rempli votre formulaire|Formunuzu doldurdum|заполнил|Completé el formulario/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?？。！\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 400);
}

/**
 * 从一条客户消息里抽出所有「明确的索取」。
 * 同一 kind 只保留第一句，避免一条长消息刷屏。
 */
export function detectOpenRequests(text: string | null | undefined): OpenRequest[] {
  const raw = (text ?? '').trim();
  if (!raw || NOISE.test(raw)) return [];
  // 引用块污染的历史数据（2026-03~06）：以「你」开头且后面接我方话术
  if (/^你\s*[A-Za-z]/.test(raw)) return [];

  const sentences = splitSentences(raw);
  if (sentences.length === 0) return [];

  // 请求语气和「要什么」经常不在同一行——最典型的是带项目符号的清单：
  //   "Could you please provide the following information:"   ← 只有语气
  //   "– Photo/video showing the current mileage"             ← 只有主题
  //   "– Battery diagnostic report showing the battery SOH"
  // 所以只要整条消息里出现过请求语气，就在全部句子里找主题。
  // 代价是偶有误命中，但界面会把命中的原句一起显示，销售一眼能判断。
  const asking = sentences.some((s) => ASK.test(s));
  if (!asking) return [];

  const seen = new Set<RequestKind>();
  const out: OpenRequest[] = [];
  for (const sentence of sentences) {
    for (const [kind, re] of TOPICS) {
      if (seen.has(kind)) continue;
      if (!re.test(sentence)) continue;
      seen.add(kind);
      out.push({
        kind,
        label: KIND_LABEL[kind],
        quote: sentence.length > 160 ? sentence.slice(0, 160) + '…' : sentence,
      });
    }
  }
  return out;
}

/** 多条消息合并去重，新的覆盖旧的（保留最近一次提出时的原句） */
export function collectOpenRequests(
  messages: Array<{ text: string | null; sent_at: string | null }>,
): Array<OpenRequest & { askedAt: string | null }> {
  const byKind = new Map<RequestKind, OpenRequest & { askedAt: string | null }>();
  // 由旧到新遍历，后面的覆盖前面的
  const sorted = [...messages].sort((a, b) =>
    (a.sent_at ?? '').localeCompare(b.sent_at ?? ''),
  );
  for (const m of sorted) {
    for (const r of detectOpenRequests(m.text)) {
      byKind.set(r.kind, { ...r, askedAt: m.sent_at });
    }
  }
  return Array.from(byKind.values()).sort((a, b) =>
    (b.askedAt ?? '').localeCompare(a.askedAt ?? ''),
  );
}
