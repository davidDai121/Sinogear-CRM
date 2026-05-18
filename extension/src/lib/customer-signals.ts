/**
 * 客户信号检测 — 让 Claude prompt 知道客户的英语水平/情绪/沉默时长，
 * 据此触发 HARD RULE 19 (basic/fluent 调档) + Move 14 (温度匹配) + Move 12 (follow-up cadence)。
 *
 * 注入位置：buildIndividualContext / buildGroupContext 里 [Chat History] 之前。
 * AI 先看信号 → 再看历史 → 写回复。
 */

import type { ChatMessage } from '@/content/whatsapp-messages';

export type EnglishLevel = 'basic' | 'fluent';
export type Temperature = 'warm' | 'neutral' | 'cool';

export interface CustomerSignals {
  englishLevel: EnglishLevel;
  temperature: Temperature;
  /** 距离最近一条 inbound 的天数。null = 客户从未发过消息（首次接触场景）。 */
  daysSinceLastInbound: number | null;
  /** 调试用 */
  inboundsConsidered: number;
}

const DAY = 24 * 3600 * 1000;

// 正向情绪关键词（任一命中 → warm）
const WARM_KEYWORDS =
  /\b(thank|thanks|appreciate|honored|glad|pleasure|excellent|wonderful|great\s*service|perfect|amazing|happy|excited|looking\s*forward|long.?term|partner(?:ship)?|trust|delivered|good\s*news|amigo|gracias|hermano)\b|谢谢|感谢|期待|愉快|很好|完美|太棒了/i;

// 冷淡 / 拖延关键词
const COOL_KEYWORDS =
  /\b(let\s*me\s*think|i\s*will\s*check|maybe\s*later|not\s*now|later|no\s*rush|will\s*get\s*back|i'll\s*decide)\b|考虑(一下)?|想想|稍后|改天/i;

// "fluent" 英语标志：冠词 / 助动词 / 从属连词 — 出现这些代表完整句子
const FLUENT_MARKERS =
  /\b(the|an?|is|are|was|were|will|would|should|could|have|has|had|because|although|however|therefore|which|that|when|after|before|since|please)\b/i;

/**
 * 估算客户英语水平。看最近 5 条 inbound：
 * - fluent: 平均字符数 ≥ 30 且 ≥ 2 条出现 fluent markers
 * - basic: 其他（默认安全档，HARD RULE 19 的 default）
 */
export function detectEnglishLevel(messages: ChatMessage[]): EnglishLevel {
  const recent = messages.filter((m) => !m.fromMe).slice(-5);
  if (recent.length === 0) return 'basic';

  const totalChars = recent.reduce((sum, m) => sum + m.text.length, 0);
  const avgChars = totalChars / recent.length;

  const withMarkers = recent.filter((m) => FLUENT_MARKERS.test(m.text)).length;

  if (avgChars >= 30 && withMarkers >= 2) return 'fluent';
  return 'basic';
}

/**
 * 估算客户情绪。看最近 3 条 inbound + 最近沉默时长：
 * - warm: 任一条含正向情绪关键词
 * - cool: 最近 inbound ≥ 7 天前，或最近 3 条平均字符数 < 5，或含拖延关键词
 * - neutral: 其他
 */
export function detectTemperature(messages: ChatMessage[]): Temperature {
  const recent = messages.filter((m) => !m.fromMe).slice(-3);
  if (recent.length === 0) return 'neutral';

  for (const m of recent) {
    if (WARM_KEYWORDS.test(m.text)) return 'warm';
  }

  const totalChars = recent.reduce((sum, m) => sum + m.text.trim().length, 0);
  const avgChars = totalChars / recent.length;
  if (avgChars < 5) return 'cool';

  const days = daysSinceLastInbound(messages);
  if (days !== null && days >= 7) return 'cool';

  for (const m of recent) {
    if (COOL_KEYWORDS.test(m.text)) return 'cool';
  }

  return 'neutral';
}

/**
 * 距离最近一条 inbound 的天数。无 inbound 返回 null。
 */
export function daysSinceLastInbound(messages: ChatMessage[]): number | null {
  const inbounds = messages.filter((m) => !m.fromMe && m.timestamp);
  if (inbounds.length === 0) return null;
  const lastTs = Math.max(...inbounds.map((m) => m.timestamp ?? 0));
  if (!lastTs) return null;
  return Math.max(0, Math.floor((Date.now() - lastTs) / DAY));
}

export function analyzeCustomerSignals(messages: ChatMessage[]): CustomerSignals {
  return {
    englishLevel: detectEnglishLevel(messages),
    temperature: detectTemperature(messages),
    daysSinceLastInbound: daysSinceLastInbound(messages),
    inboundsConsidered: messages.filter((m) => !m.fromMe).length,
  };
}

/**
 * 把信号格式化成 prompt block。每条信号附上对应的 RULE / Move 提醒，
 * 让 Claude 不只看数据，而是看到"该应用哪条规则"。
 */
export function formatSignalsForPrompt(signals: CustomerSignals): string {
  const lines: string[] = ['[Customer Signals — auto-detected, use these to calibrate your reply]'];

  // English level
  if (signals.englishLevel === 'basic') {
    lines.push(
      `English level: basic — keep replies ESL-friendly per HARD RULE 19 (sentences ≤12 words, common verbs only, no idioms). Prefer "basic"-tagged Style Anchors.`,
    );
  } else {
    lines.push(
      `English level: fluent — customer writes full sentences. You can use slightly wider vocabulary, but still short sentences and NO native idioms (HARD RULE 19). Prefer "fluent"-tagged Style Anchors.`,
    );
  }

  // Temperature
  if (signals.temperature === 'warm') {
    lines.push(
      `Temperature: WARM — customer just signaled positive (thanks / yes sir / appreciate / long-term partner / personal share / etc). Apply Move 14: add reciprocal warmth at the open of your reply BEFORE the substance.`,
    );
  } else if (signals.temperature === 'cool') {
    lines.push(
      `Temperature: COOL — customer is short / silent / hesitant. Do NOT overcompensate with extra warmth (sounds desperate). Match their reduced energy. Consider Master Tactic 5 (Power of "No" question) to re-engage.`,
    );
  } else {
    lines.push(
      `Temperature: neutral — no strong emotion signal. Keep professional efficient tone, no extra warmth or coolness.`,
    );
  }

  // Days since last customer message
  const d = signals.daysSinceLastInbound;
  if (d === null) {
    lines.push(
      `Days since last customer message: N/A — this is your first reply to this customer. Apply Move 13 (lead with substance, not "what are you looking for").`,
    );
  } else if (d === 0) {
    lines.push(`Days since last customer message: 0 (live conversation — respond now-style, no "good morning" framing).`);
  } else if (d <= 2) {
    lines.push(`Days since last customer message: ${d} (recent — continue smoothly from where you left off).`);
  } else if (d <= 6) {
    lines.push(
      `Days since last customer message: ${d} (a few days gap — okay to ping if you have a new fact, otherwise let it breathe).`,
    );
  } else if (d <= 29) {
    lines.push(
      `Days since last customer message: ${d} (customer is cooling). If you ping, you MUST have genuinely NEW substance — price drop, new inventory, industry news, specific reference to their prior concern. Empty "how are you / morning my brother" pings are BANNED (Move 12). Consider Master Tactic 5 (Power of "No": "Have you given up on the [SKU]?").`,
    );
  } else {
    lines.push(
      `Days since last customer message: ${d} (long silence — this is a re-engagement attempt). Apply Master Tactic 5 strictly: reframe so customer's answer is NO ("Have you given up on this car?" / "Is the budget no longer feasible?" / "Have you decided to go with another supplier?"). Do NOT default to "morning my brother / how are you".`,
    );
  }

  return lines.join('\n');
}
