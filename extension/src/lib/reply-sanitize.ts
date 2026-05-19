/**
 * 把 LLM 生成的 [WhatsApp Reply] 段在 paste 给客户前做净化。
 *
 * 防御场景：parser 应该已经只取了 [WhatsApp Reply] 那段，但如果 LLM 没按规矩
 * 输出（比如 [Translation] 这个段名 parser 没认到、或者 LLM 在 reply 里夹了
 * "Note: ..." 这种内部注释），就有可能把"思考"作为客户消息发出去 —— 这是
 * P0 灾难。本函数是 last-mile safety net，永远在 fillWhatsAppCompose 之前调用。
 *
 * 策略：
 *   1. 找文本里第一个"已知 section header" 模式 [SomeHeader]，从那里截断
 *   2. 撤掉常见的 LLM 内部标记前缀（Note: / 注：/ Internal: / 备注：等）
 *   3. trim 多余空行
 */

const KNOWN_SECTION_HEADERS = [
  // English
  'Quick Summary',
  'Customer Read',
  'WhatsApp Reply',
  'WhatsApp 回复',
  'Translation',
  'Translation & Strategy',
  'Full Translation & Strategy',
  'Full Translation and Strategy',
  'Strategy',
  'Client Record',
  'Pain Points',
  'Decision Drivers',
  'Likely Objections',
  'Predicted Next Action',
  'Suggested Move',
  'Quote Draft',
  'Variant',
  // Future-proof — new sections we plan to add
  'Need from Sales Rep',
  'Followup Queue',
  'Mental Model',
  'Reply Discipline',
  'Anti-Patterns',
  // Chinese
  '摘要',
  '客户档案',
  '客户记录',
  '客户心思',
  '客户解读',
  '中文翻译',
  '翻译',
  '翻译与策略',
  '策略',
  '痛点',
  '决策驱动',
  '可能异议',
  '预测下一步',
  '建议行动',
  '报价草稿',
];

const HEADER_RE = (() => {
  const escaped = KNOWN_SECTION_HEADERS.map((h) =>
    h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');
  // 匹配 `[Header]` 或 `[Header — anything]` 形式（兼容 Variant 1 — Warm 这种）
  return new RegExp(`\\[(?:${escaped})(?:\\s*[—–\\-:]\\s*[^\\]]+)?\\]`, 'i');
})();

const INTERNAL_NOTE_PREFIX_RE =
  /^\s*(?:note|nb|internal|tip|备注|注|内部备注|说明)[:：]\s*.+$/gim;

/**
 * 新 prompt 让 AI 缺信息时输出 `(NEED FROM BOSS: ...)` 标记。
 * 用户 fill 前必须剥掉，避免误发给客户。
 */
const NEED_FROM_BOSS_RE =
  /^\s*[(（]\s*NEED FROM BOSS\s*[:：][^)）]*[)）]\s*$/gim;

/**
 * **MUST** be called on any text that gets paste 到客户聊天框前。
 *
 * - 检测到任何已知 section header → 从该位置截断（前面的内容才是真正的 reply）
 * - 删除"Note: ..." / "注: ..." 这种内部注释行
 * - 收紧多余空行
 */
export function sanitizeReplyForCustomer(text: string): string {
  if (!text) return '';

  let cleaned = text;

  // 1. 截掉第一个已知 section header 及之后所有内容
  const headerMatch = cleaned.match(HEADER_RE);
  if (headerMatch && headerMatch.index !== undefined && headerMatch.index > 0) {
    cleaned = cleaned.slice(0, headerMatch.index);
  }

  // 2. 删除 Note:/注: 这种内部注释行
  cleaned = cleaned.replace(INTERNAL_NOTE_PREFIX_RE, '');

  // 2b. 删除 (NEED FROM BOSS: ...) marker 行 — boss 看的，不能发客户
  cleaned = cleaned.replace(NEED_FROM_BOSS_RE, '');

  // 3. 收紧 3+ 连续空行 → 2 个
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * 检测 sanitizer 是否实际改了内容 — UI 可以用来在确认填入前给个 warning：
 * "Claude 的回复里夹了内部段落，已自动剥掉，你确认要发吗？"
 */
export function wasReplyDirty(original: string): boolean {
  return sanitizeReplyForCustomer(original) !== original.trim();
}
