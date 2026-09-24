/**
 * CRM 上下文分层（2026-09-23，见 docs/技能对话体验_精简上下文方案_2026-09-23.md）。
 *
 * 判定只用 CRM 已知的变量，不猜意图、不加按钮：
 *   - full（A 层）：老板没写要求的生成 / 续聊 —— 资料、事实库、账本、跟进契约照旧。
 *   - compact（B 层）：老板写了要求（生成框指令）或走讨论框 —— 批准知识全文不动，
 *     其余按“本单相关”缩：事实库只发本客户/本单条目（报价轮再带费用口径），
 *     账本改成紧凑视图（老板指令逐字保留、最新报价渲染成已确认条件），聊天最近 20 条
 *     加更早的价格/承诺原句，语言规则压成短段。跟进契约按入口定（followupContractRequested）：
 *     生成回复带精简契约，讨论框只在明确要求跟进/任务时带。
 *
 * 纯函数，node --test 直接测（scripts/test-gpt-context-layer.mjs）。
 */
import type { ChatMessage } from '@/content/whatsapp-messages';
import { collapseMediaRuns, isMediaOnly } from './chat-media-utils';
import { isSalesPitch } from './sales-pitch';
import { preserveFollowupTasks } from './gpt-request-scope';

export type ContextLayer = 'full' | 'compact';

export function resolveContextLayer(input: { salesGuidance?: string | null; discussionQuestion?: string | null }): ContextLayer {
  return input.discussionQuestion?.trim() || input.salesGuidance?.trim() ? 'compact' : 'full';
}

// 讨论框：只有明确要求跟进安排或任务变更才注入跟进契约。
// 不算：复核一下这句 / 提醒我这句怎么写 / 跟他说有消息我再联系他（口述内容）/ 催款口述。
const ZH_TIME = '(?:天后|天以后|明天|后天|下周|周[一二三四五六日天]|下个月|月底|月初|号|点|小时后|到时候|过几天|之后再|再过)';
// “跟进”后面接话术/消息/稿/口径等是回复内容（帮我写一句跟进话术、跟他说我会跟进），不是任务
const ZH_FOLLOWUP_WORD = '跟进(?!话术|消息|稿|内容|口径|文案|语|信息|一句|的话)';
const ZH_FOLLOWUP = new RegExp([
  // 明确要求创建 / 调整 / 安排跟进：安排下周跟进、建个跟进任务、把跟进改到周五、三天后再跟进
  `(?:安排|建|新建|创建|加|改|调整|更新|取消|关闭|删|设置|定|排)[^。；！？\\n]{0,8}${ZH_FOLLOWUP_WORD}`,
  `${ZH_FOLLOWUP_WORD}(?:任务|提醒|安排|计划|时间)`,
  // 把跟进改到周五 / 跟进延到下周 / 跟进取消
  `${ZH_FOLLOWUP_WORD}[^。；！？\\n]{0,6}(?:改到|改成|调到|延到|提前到|取消|关闭|${ZH_TIME})`,
  `${ZH_TIME}[^。；！？\\n]{0,6}(?:再)?${ZH_FOLLOWUP_WORD}`,
  // 动词 + 任务 / 任务 + 动词：建个任务、把任务改到下周、取消任务
  '(?:新增|新建|创建|建|加|改|更新|调整|安排|取消|关闭|完成|删|动)[^。；！？\\n]{0,6}任务',
  '任务[^。；！？\\n]{0,6}(?:改|调|更新|取消|关闭|完成|删|建|加)',
  // 提醒 + 时间 / 联系动作：三天后提醒我、明天提醒我催他、提醒我联系他
  `提醒(?:我|一下)?[^。；！？\\n]{0,10}(?:${ZH_TIME}|联系|催|问他|问客户|回访|再问)`,
  `${ZH_TIME}[^。；！？\\n]{0,8}提醒`,
  // 安排回访 / 安排联系 / 什么时候再联系 / 几天后再催
  '安排[^。；！？\\n]{0,6}(?:回访|联系|提醒|复查|催)',
  '什么时候(?:再)?(?:联系|找|问|回访|催)',
  '(?:几天|多久|几周)(?:后|之后)?(?:再)?(?:联系|催|回访|问)',
  '待办',
].join('|'));
const EN_TIME = '(?:on|in|next|tomorrow|day|days|week|month|friday|monday|tuesday|wednesday|thursday|saturday|sunday|later|at \\d)';
const EN_FOLLOWUP = new RegExp([
  '\\bfollow[- ]?ups?\\b',
  '\\b(?:add|create|make|update|change|move|close|set|open)\\b[^.;\\n]{0,20}\\btasks?\\b',
  '\\btasks?\\b[^.;\\n]{0,12}\\b(?:add|create|update|change|move|close)\\b',
  `\\bremind(?:er)?\\b[^.;\\n]{0,24}\\b(?:${EN_TIME}|to (?:contact|call|message|check|chase|ping))\\b`,
  `\\b${EN_TIME}\\b[^.;\\n]{0,16}\\bremind(?:er)?\\b`,
  '\\bschedule\\b', '\\bcheck back\\b', '\\bnext contact\\b', '\\bto-?do\\b',
].join('|'), 'i');

export type FollowupRoute = 'reply' | 'discuss';

/**
 * 本轮要不要注入跟进契约并保存 crm_followup（2026-09-23 老板收窄：技能同轮判断要不要二次跟进）。
 *   reply（生成客户回复，含老板口述 / 改稿 / 翻译）：注入，由技能判断需不需要二次跟进；
 *     老板明确说不动任务 / 不安排跟进（preserveFollowupTasks）才不注入。
 *   discuss（讨论框）：默认不注入；只有问题明确要求创建 / 调整 / 安排跟进任务或提醒才注入。
 * 不注入的轮次走 preserveExisting：不产生、不保存任何任务变更。
 * 上下文层（full / compact）只决定资料怎么发，不决定契约；compact 的 reply 轮带精简契约（followupPrompt compact）。
 */
export function followupContractRequested(request: string | null | undefined, route: FollowupRoute): boolean {
  if (preserveFollowupTasks(request)) return false;
  if (route === 'reply') return true;
  const raw = request ?? '';
  return ZH_FOLLOWUP.test(raw.replace(/\s+/g, '')) || EN_FOLLOWUP.test(raw);
}

export const COMPACT_HISTORY_LIMIT = 20;
const COMPACT_ANCHOR_LIMIT = 12;

/**
 * 更早的消息里“带价格/承诺”的那些：金额、百分比、贸易术语、定金尾款、保修、柜型、PI 等。
 * 这些是已报价口径和旧承诺的原句，不能因为只取最近 20 条就丢掉。
 */
const COMMITMENT = new RegExp([
  String.raw`(?:USD|US\$|EUR|CNY|RMB|GBP|\$|€|¥|£)\s?\d`,
  String.raw`\d\s?(?:USD|usd|dollars?|euros?|美元|美金|人民币|元)`,
  String.raw`\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b`,
  String.raw`\d+\s?%`,
  String.raw`\b(?:deposit|balance|warranty|guarantee|garant[ií]a|FOB|CIF|CFR|DDP|RoRo|40\s?HC|40\s?HQ|20\s?GP|proforma|invoice|PI)\b`,
  '定金|尾款|保修|报价|运费|集装箱|滚装|发票',
].join('|'), 'i');

export interface CompactHistory {
  /** 最近 20 条（已合并媒体占位） */
  recent: ChatMessage[];
  /** 更早的价格/承诺原句（最多 12 条，按时间顺序） */
  anchors: ChatMessage[];
}

export function selectCompactHistory(messages: ChatMessage[], limit = COMPACT_HISTORY_LIMIT): CompactHistory {
  const collapsed = collapseMediaRuns(messages);
  const recent = collapsed.slice(-limit);
  const earlier = collapsed.slice(0, Math.max(0, collapsed.length - limit));
  const anchors = earlier
    .filter((m) => !isMediaOnly(m.text) && !isSalesPitch(m.text) && m.text.trim() !== '[已删除]' && COMMITMENT.test(m.text))
    .slice(-COMPACT_ANCHOR_LIMIT);
  return { recent, anchors };
}

/** compact 层实际渲染进 prompt 的消息（anchors 在前、recent 在后），供跟进证据去重用。 */
export function compactRenderedMessages(messages: ChatMessage[]): ChatMessage[] {
  const { recent, anchors } = selectCompactHistory(messages);
  return [...anchors, ...recent];
}

/**
 * 同一 ChatGPT 会话里上一轮是不是讨论（2026-09-23 Jaycee 实测：讨论“不要写客户回复，也不安排跟进”之后
 * 点续聊生成，模型继续讨论，不出三段和 crm_followup）。判定只看 CRM 账本，两条规则任一命中即为讨论态：
 *   1) 该会话最近一条 assistant_draft 没有三段标题 —— 会话最后一次输出就是讨论体（含“讨论后普通生成失败”
 *      这种没有 sales_instruction 的失败草稿）；
 *   2) 从最近一条草稿往前，跳过同会话的无指令草稿，最近的一条输入是 sales_discussion；遇到 sales_instruction
 *      或别的会话的草稿即停止。
 * 命中时生成不再续这个会话，改为带完整上下文另起新会话（prompt 里已有客户事实、本单记忆、最新草稿）。
 */
export function threadEndsWithDiscussion(
  entries: { kind: string; chatUrl?: string; text?: string }[],
  chatUrl: string | null | undefined,
): boolean {
  if (!chatUrl) return false;
  const thread = chatUrl.split('#')[0];
  const inThread = (e: { kind: string; chatUrl?: string }) => e.kind === 'assistant_draft' && !!e.chatUrl && e.chatUrl.split('#')[0] === thread;
  let lastDraft = -1;
  entries.forEach((e, i) => { if (inThread(e)) lastDraft = i; });
  if (lastDraft < 0) return false;
  if (!/\[WhatsApp Reply\]/.test(entries[lastDraft].text ?? '')) return true;
  for (let i = lastDraft - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'sales_discussion') return true;
    if (e.kind === 'sales_instruction') return false;
    if (e.kind === 'assistant_draft') { if (inThread(e)) continue; return false; }
  }
  return false;
}
