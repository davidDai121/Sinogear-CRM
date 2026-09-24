import { normalizeGptReply } from './gpt-reply-state';
import { extractFollowup, type FollowupContext, type FollowupDecision, type FollowupPlan } from './gpt-followup';

/** 判定逻辑移到 gpt-request-scope.ts（2026-09-23）；这里保留导出，调用方不变。 */
export { preserveFollowupTasks } from './gpt-request-scope';

/** Validate placement before normalization so NO_REPLY cannot hide an unsafe machine block. */
export function followupProse(text: string) {
  const marker = text.search(/<\/?crm_followup\b/i);
  const reply = text.indexOf('[WhatsApp Reply]');
  const strategy = text.indexOf('[Full Translation & Strategy]', reply);
  if (reply >= 0 && marker >= 0 && (strategy < 0 || marker < strategy)) {
    throw new Error('跟进机器块出现在客户正文或档案中，未展示为可发送回复');
  }
  text = normalizeGptReply(text);
  const normalizedMarker = text.search(/<\/?crm_followup\b/i);
  return normalizedMarker >= 0 ? text.slice(0, normalizedMarker).trim() : text.trim();
}

/** Follow-up metadata failure must not discard an otherwise completed draft. */
export async function completeFollowupResult(
  text: string,
  ctx: FollowupContext,
  repair: (() => Promise<string>) | null,
  save: (decision: FollowupDecision) => Promise<FollowupPlan>,
  onReady?: (text: string) => Promise<void>,
  preserveExisting = false,
): Promise<{ text: string; warning?: string; retryable?: boolean }> {
  const prose = followupProse(text);
  if (preserveExisting) {
    await onReady?.(prose);
    return { text: prose };
  }
  text = normalizeGptReply(text);
  const marker = text.search(/<\/?crm_followup\b/i);
  let saving = false;
  try {
    let parsed;
    try { parsed = extractFollowup(text, ctx); }
    catch (error) {
      if (marker >= 0) throw error;
      if (!repair) throw new Error('本轮未返回跟进判断，未追加GPT调用或改动已有任务。');
      parsed = extractFollowup(await repair(), ctx);
    }
    await onReady?.(marker < 0 ? text : parsed.text);
    saving = true;
    const plan = await save(parsed.decision);
    const summary = `\n\n[GPT跟进安排]\n${plan.decision.title}\n${plan.decision.reason}\n${plan.protected ? '保留人工任务安排；以上为GPT建议。' : plan.after?.due_at ? '安排时间：' + new Date(plan.after.due_at).toLocaleString() : '等待条件/已结束，无自动催促日期。'}`;
    return { text: (marker < 0 ? text : parsed.text) + summary };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await onReady?.(prose);
    const warning = `正文已保留；跟进安排未确认保存，请核对任务页。${reason}`;
    return { text: prose + '\n\n[GPT跟进状态]\n' + warning, warning, retryable: saving };
  }
}
