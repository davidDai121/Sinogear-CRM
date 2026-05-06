/**
 * 解析 Gemini Gem 返回的结构化文本：
 *
 *   [Client Record]
 *   Phone: +33626395962
 *   Country: Guinea
 *   Tags: T2 JMK, Bulk Inquiry
 *
 *   [WhatsApp Reply]      ← 可选
 *   Hi, regarding the Jetour T2...
 *
 *   [Full Translation & Strategy]   ← 可选
 *   关于捷途 T2，建议...
 *
 * 容错处理：如果 Gem 没用 [WhatsApp Reply] / [Translation] 标签，
 * 我们按 CJK 比例把 [Client Record] 之后的内容拆成"英文回复"和"中文翻译"。
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

export interface ParsedGemResponse {
  clientRecord: ParsedClientRecord | null;
  reply: string | null;        // 给客户的回复（多语言）
  translation: string | null;  // 中文翻译/策略（销售看）
  raw: string;                 // 原始全文（fallback）
}

const SECTION_HEADERS = [
  'Client Record',
  'WhatsApp Reply',
  'WhatsApp 回复',
  '客户档案',
  '客户记录',
  'Full Translation & Strategy',
  'Full Translation and Strategy',
  'Translation & Strategy',
  'Translation',
  '中文翻译',
  '翻译与策略',
  '翻译',
  'Strategy',
  '策略',
];

export function parseGemResponse(rawText: string): ParsedGemResponse {
  const sections = splitSections(rawText);

  let clientRecord: ParsedClientRecord | null = null;
  if (sections['client record'] || sections['客户档案'] || sections['客户记录']) {
    const text =
      sections['client record'] ||
      sections['客户档案'] ||
      sections['客户记录'] ||
      '';
    clientRecord = parseClientRecord(text);
  }

  const reply: string | null =
    sections['whatsapp reply'] ||
    sections['whatsapp 回复'] ||
    null;

  const translation: string | null =
    sections['full translation & strategy'] ||
    sections['full translation and strategy'] ||
    sections['translation & strategy'] ||
    sections['translation'] ||
    sections['中文翻译'] ||
    sections['翻译与策略'] ||
    sections['翻译'] ||
    sections['strategy'] ||
    sections['策略'] ||
    null;

  // Fallback：没明确 reply/translation section 但有 [Client Record] →
  // 把 [Client Record] 之后的内容按语言拆开
  if (!reply && !translation && clientRecord) {
    const after = extractAfterSection(rawText, [
      'Client Record',
      '客户档案',
      '客户记录',
    ]);
    const split = splitByLanguage(after);
    return {
      clientRecord,
      reply: split.nonChinese || null,
      translation: split.chinese || null,
      raw: rawText,
    };
  }

  return { clientRecord, reply, translation, raw: rawText };
}

/**
 * 把整个 raw 文本按 [Section Name] 拆分。
 * 返回 lowercase section name → 内容。
 */
function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const escaped = SECTION_HEADERS.map((h) =>
    h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');
  const headerPattern = new RegExp(`\\[(${escaped})\\]`, 'gi');

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
 * 取所有给定 section header 中**最后**一个之后到下一个 section 之间（或文本末）的内容。
 */
function extractAfterSection(text: string, headers: string[]): string {
  for (const h of headers) {
    const pattern = new RegExp(
      `\\[${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`,
      'i',
    );
    const m = pattern.exec(text);
    if (m) {
      const start = m.index + m[0].length;
      // 找下一个 section header（任意已知）
      const allEscaped = SECTION_HEADERS.filter((x) => x !== h)
        .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const nextPattern = new RegExp(`\\[(${allEscaped})\\]`, 'i');
      const tail = text.slice(start);
      const next = nextPattern.exec(tail);
      const segment = next ? tail.slice(0, next.index) : tail;
      // 还要跳过 key-value 行（仅在 [Client Record] 这种结构里）
      // 简单做：跳过紧跟着 header 的连续 "Key: value" 行
      return stripKeyValueLines(segment).trim();
    }
  }
  return '';
}

/** 跳过开头连续的 "Key: value" 行（[Client Record] 的扁平段） */
function stripKeyValueLines(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // "Key: value" 模式（短键，含冒号）
    if (/^[A-Za-z一-龥][A-Za-z0-9一-龥\s]{1,30}:\s*\S/.test(line)) {
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n');
}

function splitByLanguage(text: string): {
  chinese: string;
  nonChinese: string;
} {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const cn: string[] = [];
  const other: string[] = [];

  for (const p of paragraphs) {
    if (getCJKRatio(p) > 0.3) cn.push(p);
    else other.push(p);
  }
  return {
    chinese: cn.join('\n\n'),
    nonChinese: other.join('\n\n'),
  };
}

function getCJKRatio(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  let total = 0;
  for (const ch of s) {
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      cjk += 1;
    }
  }
  return total ? cjk / total : 0;
}

/** 解析 [Client Record] section 的 key-value 行 */
function parseClientRecord(text: string): ParsedClientRecord {
  const record: ParsedClientRecord = {};
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value || /^(unknown|n\/a|未知|无)$/i.test(value)) continue;

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
          .filter((t) => t && !/^unknown$/i.test(t));
        break;
    }
  }
  return record;
}

/** 把 budget 字符串（如 "$25,000"、"25k"、"25000 USD"）解析成数字 */
export function parseBudgetValue(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$€£¥,，]/g, '').trim();
  const k = cleaned.match(/^([\d.]+)\s*[kK]\s*(?:USD|$)?/);
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
