/**
 * 老板本轮指令里的“范围限制”判定。纯函数，node --test 直接测。
 *
 * 2026-09-23 David 测试链路实测：老板写“只改未发送草稿，不更新客户资料和跟进任务”，
 * 旧正则要求“不”后面紧接动词、动词后紧接“跟进任务”，中间隔了“客户资料和”就不命中，
 * 于是跟进契约照常注入、模型照常输出 crm_followup、CRM 照常把任务从“跟进”改成
 * “等待”又改回“跟进”。保护必须落在代码层：命中就不注入跟进契约，也不保存任何任务变更。
 */

const ZH_NEG = '(?:不|不要|勿|别|无需|不用|不必|禁止)';
const ZH_VERB = '(?:新增|创建|新建|建立|更新|调整|修改|改动|变动|安排|生成|改|变|碰|触碰|动)';
// 否定词 + 动词 + 同一小句内（不跨逗号/句号）24 字以内 + （跟进）任务
const ZH_TASK = new RegExp(`${ZH_NEG}${ZH_VERB}[^。；！？，,\\n]{0,24}?(?:跟进)?任务`);
// 明确“只讨论 / 仅讨论”这类纯内部轮
const ZH_DISCUSS_ONLY = /(?:本轮|这次|这轮)?(?:只|仅)(?:是)?讨论(?![^。；\n]{0,6}(?:后|完|再))/;
// 2026-09-23 Jaycee 复测：“不要写客户回复，也不安排跟进”没有“任务”二字，旧正则不命中，
// 契约照常注入，模型按老板要求没返回 crm_followup，保存时却报“未返回跟进判断”。否定的跟进 / 提醒 / 回访也算“本轮不动任务”。
const ZH_NO_FOLLOWUP = new RegExp(`${ZH_NEG}(?:用|要|必|需)?(?:再)?(?:安排|建|新建|创建|加|设|设置|定|做|搞|排|去)?[^。；！？，,\\n]{0,4}?(?:跟进|提醒|回访)`);
const EN_TASK = /(?:do not|don't|never|without|\bno)\s+(?:[a-z]+\s+){0,6}?(?:follow[- ]?ups?|reminders?|tasks?)\b/i;

/** 本轮老板明确不让动跟进任务：不注入跟进契约，也不保存任何任务变更。 */
export function preserveFollowupTasks(request: string | null | undefined): boolean {
  const raw = request ?? '';
  const zh = raw.replace(/\s+/g, '');
  return ZH_TASK.test(zh) || ZH_NO_FOLLOWUP.test(zh) || ZH_DISCUSS_ONLY.test(zh) || EN_TASK.test(raw);
}

const ZH_NO_STRATEGY = /(?:不写|别写|不要|无需|不用|不必|去掉|删掉)(?:策略|分析|策略分析|内部分析|说明)/;
const ZH_TRANSLATION_ONLY = /(?:只|仅)(?:附|要|给|需|加|带)?[^。；\n]{0,8}?(?:翻译|译文)(?![^。；\n]{0,4}(?:和|及|加|与)(?:策略|分析))/;
const EN_NO_STRATEGY = /\b(?:no|without|skip)\s+(?:the\s+)?(?:strategy|analysis)\b|translation only\b/i;

/** 本轮老板只要译文、不要策略：第三段只放中文翻译。 */
export function translationOnlyRequested(request: string | null | undefined): boolean {
  const raw = request ?? '';
  const zh = raw.replace(/\s+/g, '');
  return ZH_NO_STRATEGY.test(zh) || ZH_TRANSLATION_ONLY.test(zh) || EN_NO_STRATEGY.test(raw);
}

/** 追加到 prompt 末尾的一句，明确第三段只放译文。 */
export const TRANSLATION_ONLY_NOTE = '\n[Translation only this turn] In [Full Translation & Strategy], write ONLY the faithful Chinese translation of the reply. No strategy, no bullet notes, no internal remarks. If a CRM metadata block is required this turn it may follow the translation; nothing else.';

/** 追加到 prompt 末尾的一句，明确本轮不动任务。 */
export const PRESERVE_TASKS_NOTE = '\n[Current owner scope] This turn must not create or modify follow-up tasks. Omit crm_followup metadata; CRM will preserve all existing tasks.';
