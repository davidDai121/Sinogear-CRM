import { extractFollowup, type FollowupContext, type FollowupDecision, type FollowupPlan } from './gpt-followup';

/** Follow-up metadata failure must not discard an otherwise completed draft. */
export async function completeFollowupResult(
  text: string,
  ctx: FollowupContext,
  repair: () => Promise<string>,
  save: (decision: FollowupDecision) => Promise<FollowupPlan>,
): Promise<{ text: string; warning?: string }> {
  const marker = text.search(/<\/?crm_followup\b/i);
  const reply = text.indexOf('[WhatsApp Reply]');
  const strategy = text.indexOf('[Full Translation & Strategy]', reply);
  // Unsafe section placement is a response-format failure, not an optional task failure.
  if (reply >= 0 && marker >= 0 && (strategy < 0 || marker < strategy)) {
    throw new Error('跟进机器块出现在客户正文或档案中，未展示为可发送回复');
  }
  // On malformed/duplicate blocks, retain only prose before the first machine marker.
  const prose = marker >= 0 ? text.slice(0, marker).trim() : text.trim();
  try {
    let parsed;
    try { parsed = extractFollowup(text, ctx); }
    catch (error) {
      if (marker >= 0) throw error;
      parsed = extractFollowup(await repair(), ctx);
    }
    const plan = await save(parsed.decision);
    const summary = `\n\n[GPT跟进安排]\n${plan.decision.title}\n${plan.decision.reason}\n${plan.protected ? '保留人工任务安排；以上为GPT建议。' : plan.after?.due_at ? '安排时间：' + new Date(plan.after.due_at).toLocaleString() : '等待条件/已结束，无自动催促日期。'}`;
    return { text: (marker < 0 ? text : parsed.text) + summary };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const warning = `正文已保留；跟进安排未确认保存，请核对任务页。${reason}`;
    return { text: prose + '\n\n[GPT跟进状态]\n' + warning, warning };
  }
}
