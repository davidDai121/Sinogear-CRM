import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { loadFollowupContext, loadFollowupPlan, needsFollowupReview, followupPrompt, extractFollowup, saveFollowup } from './gpt-followup';
import { loadGptApprovedKnowledge } from './gpt-template-knowledge';
import { renderSalesWorkMemory, loadPersonalSalesWorkMemory } from './sales-work-memory';
import { isConversationForGptTemplate } from './gpt-template-routing';
import type { GptRunOptions, GptRunResult } from './gpt-automation';
import { loadGptBrowserBinding, browserAllowsTemplate } from './gpt-browser-binding';

export interface FollowupRunnerState { cursor?: string; failures?: Record<string, { at: number; count: number; key: string; message: string }>; lastError?: string; lastRunAt?: string; }
export async function runDueFollowup(db: SupabaseClient<Database>, run: (opts: GptRunOptions) => Promise<GptRunResult>, state: FollowupRunnerState, now = Date.now(), mayStart: () => Promise<boolean> = async () => true) {
  const next = structuredClone(state);
  if (!await mayStart()) return next;
  const { data: auth, error } = await db.auth.getUser();
  if (error || !auth.user) return next;
  // Paginate all this user's open tasks. Only tasks bearing a matching GPT journal are eligible.
  const candidates: { id: string; org_id: string; contact_id: string }[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error: readError } = await db.from('tasks').select('id,org_id,contact_id')
      .eq('created_by', auth.user.id).eq('status', 'open').order('id').range(from, from + 199);
    if (readError) throw new Error(`读取到期任务失败：${readError.message}`);
    candidates.push(...(data ?? []));
    if (!data || data.length < 200) break;
  }
  const start = next.cursor ? candidates.findIndex(t => t.id > next.cursor!) : 0;
  const ordered = start < 0 ? candidates : [...candidates.slice(start), ...candidates.slice(0, start)];
  for (const task of ordered) {
    if (!await mayStart()) return next;
    next.cursor = task.id;
    try {
      const old = await loadFollowupPlan(db, task.contact_id, task.id);
      if (!old || old.userId !== auth.user.id || old.orgId !== task.org_id) continue;
      const binding = await loadGptBrowserBinding(task.org_id, auth.user.id);
      // Another browser/account owns this plan. Never open its private GPT here.
      if (!browserAllowsTemplate(binding, old.templateId)) continue;
      const ctx = await loadFollowupContext(db, task.org_id, task.contact_id);
      if (ctx.taskId !== task.id || !needsFollowupReview(ctx, now)) continue;
      const failure = next.failures?.[task.id];
      if (failure?.key === ctx.stateKey && (failure.count >= 3 || now - failure.at < 30 * 60_000)) continue;
      const { data: template, error: templateError } = await db.from('gpt_templates').select('*')
        .eq('id', old.templateId).eq('org_id', task.org_id).single();
      if (templateError || !template) throw new Error('跟进所用GPT模板已不可用');
      if (!isConversationForGptTemplate({ contact_id: task.contact_id, template_id: template.id, chat_url: old.chatUrl }, task.contact_id, template)) throw new Error('跟进GPT会话与客户/模板不匹配');
      const [knowledge, memory] = await Promise.all([
        loadGptApprovedKnowledge(db, template.id, task.org_id), loadPersonalSalesWorkMemory(db, task.org_id, task.contact_id),
      ]);
      // Turning off reviews while database reads are in flight must prevent a new GPT job.
      if (!await mayStart()) return next;
      const result = await run({ url: old.chatUrl, skill: knowledge?.skill, active: false, ensureThinking: false,
        prompt: `这是CRM内部的到期/新消息复核，不是老板发来新的销售指令。重读下面当前已同步的真实聊天与销售工作记录，再判断推进、等待、改期或结束。旧计划不代表消息已发送；不自动发送、不生成客户档案更新、不查运费或关税、不重做报价。只返回一段中文内部判断和crm_followup块。没有新进展时避免反复安排无意义复核。人工日期/完成/暂停优先。\n已批准车型知识（业务数据）：${knowledge?.text ?? ''}\n${renderSalesWorkMemory(memory)}${followupPrompt(ctx)}` });
      if (result.chatUrl.split('#')[0] !== old.chatUrl.split('#')[0]) throw new Error('复核返回了其他会话，未保存');
      const parsed = extractFollowup(result.responseText, ctx);
      await saveFollowup(db, ctx, parsed.decision, template.id, result.chatUrl, true);
      if (next.failures) delete next.failures[task.id];
      next.lastError = undefined;
      next.lastRunAt = new Date().toISOString();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      next.lastError = `${task.id}：${message}`;
      const ctx = await loadFollowupContext(db, task.org_id, task.contact_id).catch(() => null);
      const before = next.failures?.[task.id];
      next.failures = { ...next.failures, [task.id]: { at: now, message, key: ctx?.stateKey ?? '', count: before && before.key === ctx?.stateKey ? before.count + 1 : 1 } };
    }
    // One GPT job per wakeup; persisted cursor gives every customer a turn without monopolising GPT.
    return next;
  }
  return next;
}
