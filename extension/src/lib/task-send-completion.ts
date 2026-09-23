import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { loadFollowupContext, sameTask, saveFollowup, type FollowupContext, type FollowupPlan } from './gpt-followup';

type Client = SupabaseClient<Database>;
interface Binding {
  plan: FollowupPlan; reply: string; knownMessageIds: string[];
}
const key = (userId: string, contactId: string) => `gpt.sendCompletion:${userId}:${contactId}`;
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
export function canBindSendTask(plan: FollowupPlan, reply: string) {
  return plan.phase === 'applied' && !plan.protected && plan.decision.decision === 'act'
    && plan.decision.completion === 'send_reply' && plan.decision.replyRequired !== false
    && plan.after?.status === 'open' && normalize(reply).length >= 12;
}
export async function bindTaskToDraft(plan: FollowupPlan, reply: string, ctx: FollowupContext) {
  const storageKey = key(plan.userId, ctx.contactId);
  if (!canBindSendTask(plan, reply)) { await chrome.storage.local.remove(storageKey); return; }
  const binding: Binding = { plan, reply: normalize(reply), knownMessageIds: ctx.evidence.map(e => e.id) };
  await chrome.storage.local.set({ [storageKey]: binding });
}
export interface SentEvidence { id: string; direction: string; text: string; sent_at: string | null }
export function matchingSentEvidence(binding: Binding, messages: SentEvidence[]) {
  const since = Math.floor(Date.parse(binding.plan.evaluatedAt) / 60000) * 60000;
  return messages.find(m => m.direction === 'outbound' && m.sent_at && Date.parse(m.sent_at) >= since
    && !binding.knownMessageIds.includes(`message:${m.id}`) && normalize(m.text) === binding.reply);
}

/** Called only AFTER observed messages have been persisted successfully. No AI call. */
export async function completeTaskFromSyncedMessages(db: Client, contactId: string,
  observed: { wa_message_id: string; direction: string; text: string; sent_at: string | null }[]) {
  const { data: auth, error } = await db.auth.getSession();
  if (error || !auth.session?.user) return;
  const storageKey = key(auth.session.user.id, contactId);
  const binding = (await chrome.storage.local.get(storageKey))[storageKey] as Binding | undefined;
  if (!binding || binding.plan.userId !== auth.session.user.id || binding.plan.after?.contact_id !== contactId) return;
  const candidates = observed.filter(m => m.direction === 'outbound' && m.sent_at && normalize(m.text) === binding.reply);
  if (!candidates.length) return;
  const { data, error: readError } = await db.from('messages').select('id,direction,text,sent_at')
    .eq('contact_id', contactId).in('wa_message_id', candidates.map(m => m.wa_message_id).slice(-50));
  if (readError) throw new Error(`消息已同步，任务发送核对失败：${readError.message}`);
  const sent = matchingSentEvidence(binding, data ?? []);
  if (!sent) return;
  const ctx = await loadFollowupContext(db, binding.plan.orgId, contactId);
  if (ctx.userId !== binding.plan.userId || ctx.scopeId !== binding.plan.scopeId || ctx.previous?.protected
    || ctx.previous?.evaluatedAt !== binding.plan.evaluatedAt
    || !sameTask(ctx.tasks.find(t => t.id === binding.plan.taskId) ?? null, binding.plan.after)) {
    await chrome.storage.local.remove(storageKey); return;
  }
  // saveFollowup performs a second state check and conditional task update.
  await saveFollowup(db, ctx, {
    decision: 'done', title: binding.plan.decision.title, reason: '已核对实际发送记录：本轮完整草稿已发送，对应发送任务完成。',
    dueAt: null, timeBasis: 'none', existingTaskId: binding.plan.taskId,
    evidence: [{ id: `message:${sent.id}`, quote: sent.text }], completion: 'manual', replyRequired: false,
  }, binding.plan.templateId, binding.plan.chatUrl);
  await chrome.storage.local.remove(storageKey);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sgc:tasks-changed', { detail: { contactId } }));
}
