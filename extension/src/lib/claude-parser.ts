/**
 * Claude 返回的多模式响应解析。
 *
 * 支持的 section header（按 ClaudeMode 出现）：
 *   reply / update:
 *     [Quick Summary] / [WhatsApp Reply] / [Translation] / [Strategy] / [Client Record]
 *   analyze:
 *     [Quick Summary] / [Pain Points] / [Decision Drivers] / [Likely Objections]
 *     / [Predicted Next Action] / [Suggested Move]
 *   variants:
 *     [Quick Summary] / [Variant 1 ...] / [Variant 2 ...] / [Variant 3 ...]
 *     / [Translation] / [Strategy]
 *   quote:
 *     [Quote Draft] / [WhatsApp Reply] / [Translation] / [Strategy]
 *   discuss:
 *     自由文本，无固定 header（直接当 raw 显示）
 *
 * 解析容错：找不到 section header 时把整段当 raw；
 *           [WhatsApp Reply] 没出现但 [Quick Summary] 出现 → 仍当作 reply mode
 */

export interface ParsedClientRecord {
  phone?: string;
  name?: string;
  country?: string;
  language?: string;
  budget?: string;
  interestedModel?: string;
  destinationPort?: string;
  condition?: string;
  steering?: string;
  customerStage?: string;
  tags?: string[];
}

export interface ParsedVariant {
  /** 'Warm & Friendly' / 'Direct & Concise' / 'Negotiation Push' */
  tone: string;
  reply: string;
  whenToUse?: string;
}

/**
 * 一条 followup 草稿（boss 在客户回复后 / 沉默 24h 后 / 立即等不同时机发）
 */
export interface ParsedFollowupItem {
  /** 短标签：e.g. "Payment terms" / "Hongqi spec details" */
  topic: string;
  /** 时机提示：'now' / 'after customer responds' / '24h if silent' / 自由文本 */
  whenToSend: string;
  /** 已经写好的客户语种回复文案，可直接复制 paste */
  draft: string;
}

export interface ParsedClaudeResponse {
  raw: string;
  quickSummary: string | null;
  /** Claude 写回复前对客户行为/心理的分析 — reply / variants / quote 模式都会有 */
  customerRead: string | null;
  reply: string | null;
  translation: string | null;
  strategy: string | null;
  clientRecord: ParsedClientRecord | null;

  // analyze
  painPoints: string | null;
  decisionDrivers: string | null;
  likelyObjections: string | null;
  predictedNextAction: string | null;
  suggestedMove: string | null;

  // variants
  variants: ParsedVariant[];

  // quote
  quoteDraft: string | null;

  // followup queue (reply / variants / quote 模式都会有)
  followups: ParsedFollowupItem[];
  /** boss 看的求助 section，非空时 [WhatsApp Reply] 应该是 placeholder */
  needFromSalesRep: string | null;
}

const SECTION_HEADERS = [
  'Quick Summary',
  'Customer Read',
  'WhatsApp Reply',
  'Translation',
  'Translation & Strategy',
  'Strategy',
  'Client Record',
  'Pain Points',
  'Decision Drivers',
  'Likely Objections',
  'Predicted Next Action',
  'Suggested Move',
  'Quote Draft',
  'Followup Queue',
  'Need from Sales Rep',
  // Variant headers are matched by regex below since they contain "—"
];

export function parseClaudeResponse(rawText: string): ParsedClaudeResponse {
  const sections = splitSections(rawText);

  const reply =
    sections['whatsapp reply'] ||
    sections['whatsapp 回复'] ||
    null;

  const translation =
    sections['translation'] ||
    sections['translation & strategy'] ||
    sections['中文翻译'] ||
    null;

  const strategy = sections['strategy'] || sections['策略'] || null;
  const quickSummary = sections['quick summary'] || sections['摘要'] || null;
  const customerRead = sections['customer read'] || sections['客户心思'] || sections['客户解读'] || null;
  const painPoints = sections['pain points'] || sections['痛点'] || null;
  const decisionDrivers =
    sections['decision drivers'] || sections['决策驱动'] || null;
  const likelyObjections =
    sections['likely objections'] || sections['可能异议'] || null;
  const predictedNextAction =
    sections['predicted next action'] || sections['预测下一步'] || null;
  const suggestedMove = sections['suggested move'] || sections['建议行动'] || null;
  const quoteDraft = sections['quote draft'] || sections['报价草稿'] || null;

  const clientRecord = sections['client record']
    ? parseClientRecord(sections['client record'])
    : sections['客户档案']
      ? parseClientRecord(sections['客户档案'])
      : null;

  const variants = parseVariants(rawText);

  const followupRaw = sections['followup queue'] || sections['续聊队列'] || '';
  const followups = followupRaw ? parseFollowupQueue(followupRaw) : [];

  const needFromSalesRep =
    sections['need from sales rep'] || sections['需要老板确认'] || null;

  return {
    raw: rawText,
    quickSummary,
    customerRead,
    reply,
    translation,
    strategy,
    clientRecord,
    painPoints,
    decisionDrivers,
    likelyObjections,
    predictedNextAction,
    suggestedMove,
    variants,
    quoteDraft,
    followups,
    needFromSalesRep,
  };
}

/**
 * 解析 [Followup Queue] body 成 ParsedFollowupItem[]。
 *
 * Claude 会按这个 schema 输出（不一定 100% 严格，做容错）：
 *   1. **Topic**: payment terms
 *      **When to send**: now
 *      **Draft**: 30%/70% TT，问你定哪天 deposit
 *
 *   2. **Topic**: ...
 *      ...
 *
 * 容错：
 *   - 编号可以是 1./1)/破折号/星号 任意
 *   - "Topic" / "When" / "Draft" 字段可以是带 markdown 加粗或纯冒号
 *   - 如果 LLM 写了 "(none — single-shot resolved)" 或类似，返回空数组
 */
function parseFollowupQueue(body: string): ParsedFollowupItem[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  // "(none ...)" 或 "无" 或 "n/a" → 空
  if (/^[(（]?(none|无|n\/a|no\s+followups?)[)）]?/i.test(trimmed)) return [];

  // 按 Topic 行切块
  // 正则：(行首可选编号) **Topic** : value
  const items: ParsedFollowupItem[] = [];
  // 把 body 按 "Topic" 行切成段
  const blocks = trimmed.split(
    /\n(?=\s*(?:[-*•]|\d+[\.)）])\s*\*{0,2}Topic\*{0,2}\s*[:：])/i,
  );

  for (const block of blocks) {
    const item = parseSingleFollowup(block);
    if (item) items.push(item);
  }
  return items;
}

function parseSingleFollowup(block: string): ParsedFollowupItem | null {
  // 抓 Topic / When / Draft 三个字段
  const topicMatch = block.match(
    /\*{0,2}Topic\*{0,2}\s*[:：]\s*(.+?)(?=\n|$)/i,
  );
  const whenMatch = block.match(
    /\*{0,2}When(?:\s+to\s+send)?\*{0,2}\s*[:：]\s*(.+?)(?=\n|$)/i,
  );
  const draftMatch = block.match(
    /\*{0,2}Draft\*{0,2}\s*[:：]\s*([\s\S]+?)$/i,
  );
  if (!topicMatch || !draftMatch) return null;
  return {
    topic: topicMatch[1].trim(),
    whenToSend: whenMatch?.[1]?.trim() ?? '',
    draft: draftMatch[1].trim().replace(/\n+$/, ''),
  };
}

/**
 * 把整段文本按 [Section Name] 拆开。lowercase key → 内容。
 */
function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const escaped = SECTION_HEADERS.map((h) =>
    h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');
  // Section header 也可能是 Variant 1 — Warm & Friendly 这种带破折号
  const variantPattern = `Variant\\s+\\d+(?:\\s*[—–\\-]\\s*[^\\]]*)?`;
  const headerPattern = new RegExp(
    `\\[((?:${escaped})|${variantPattern})\\]`,
    'gi',
  );

  type Match = { name: string; index: number; afterEnd: number };
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerPattern.exec(text)) !== null) {
    matches.push({
      name: m[1].toLowerCase().trim(),
      index: m.index,
      afterEnd: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].afterEnd;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[matches[i].name] = text.slice(start, end).trim();
  }
  return sections;
}

/**
 * 抽出 [Variant 1 — Warm & Friendly] 等三段。
 */
function parseVariants(text: string): ParsedVariant[] {
  const variantHeaderRe = /\[Variant\s+(\d+)\s*[—–\-]?\s*([^\]]*)\]/gi;
  type Hit = { num: number; toneLabel: string; index: number; afterEnd: number };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = variantHeaderRe.exec(text)) !== null) {
    hits.push({
      num: parseInt(m[1], 10),
      toneLabel: m[2].trim(),
      index: m.index,
      afterEnd: m.index + m[0].length,
    });
  }
  if (hits.length === 0) return [];

  // 找下一个 section header 来截断每个 variant 的内容
  // 简单做法：到下一个 variant header 或下一个 [...] section 为止
  const anyHeaderRe = /\[[^\]]+\]/g;

  const variants: ParsedVariant[] = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].afterEnd;
    // 找 start 之后第一个 [...] 出现的位置
    anyHeaderRe.lastIndex = start;
    const next = anyHeaderRe.exec(text);
    const end = next ? next.index : text.length;
    const body = text.slice(start, end).trim();

    // body 形如：
    //   <reply text...>
    //   When to use: <one line>
    const { reply, whenToUse } = splitReplyAndWhenToUse(body);

    variants.push({
      tone: hits[i].toneLabel || `Variant ${hits[i].num}`,
      reply,
      whenToUse,
    });
  }
  return variants;
}

function splitReplyAndWhenToUse(body: string): { reply: string; whenToUse?: string } {
  // 用 "When to use:" 切分（不区分大小写，多语言）
  const re = /\n\s*(when to use|when to pick|何时用|何时使用)[:：]\s*/i;
  const idx = body.search(re);
  if (idx === -1) {
    return { reply: body.trim() };
  }
  const reply = body.slice(0, idx).trim();
  const m = body.slice(idx).match(re);
  const after = m ? body.slice(idx + m[0].length).trim() : '';
  return { reply, whenToUse: after || undefined };
}

function parseClientRecord(text: string): ParsedClientRecord {
  const record: ParsedClientRecord = {};
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value || /^(unknown|n\/a|未知|无|none|\-+)$/i.test(value)) continue;

    switch (key) {
      case 'phone':
      case '电话':
      case '手机':
        record.phone = value;
        break;
      case 'name':
      case '姓名':
        record.name = value;
        break;
      case 'country':
      case '国家':
        record.country = value;
        break;
      case 'language':
      case '语言':
        record.language = value;
        break;
      case 'budget':
      case '预算':
        record.budget = value;
        break;
      case 'interested model':
      case 'model':
      case '车型':
      case '感兴趣车型':
        record.interestedModel = value;
        break;
      case 'destination port':
      case 'port':
      case '目的港':
        record.destinationPort = value;
        break;
      case 'condition':
      case '车况':
      case '新旧':
        record.condition = value;
        break;
      case 'steering':
      case '舵向':
        record.steering = value;
        break;
      case 'customer stage':
      case 'stage':
      case '阶段':
        record.customerStage = value;
        break;
      case 'tags':
      case '标签':
        record.tags = value
          .split(/[,，、]/)
          .map((t) => t.trim())
          .filter((t) => t && !/^(unknown|未知|无)$/i.test(t));
        break;
    }
  }
  return record;
}

/** "$25,000" / "25k" / "25000 USD" → 25000 */
export function parseBudgetValue(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$€£¥,，]/g, '').trim();
  const k = cleaned.match(/^([\d.]+)\s*[kK]\s*(?:USD)?/);
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
