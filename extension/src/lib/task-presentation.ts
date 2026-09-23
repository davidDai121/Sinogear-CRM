import { sameTask, type FollowupPlan, type FollowupTask } from './gpt-followup';

export type TaskBucket = 'action' | 'waiting' | 'review';
export function taskBucket(task: FollowupTask, plan?: FollowupPlan): TaskBucket {
  // Stale journals must never hide a task which a salesperson has edited.
  if (task.status !== 'open' || !plan || plan.phase !== 'applied' || plan.protected
    || plan.orgId !== task.org_id || plan.taskId !== task.id || !sameTask(task, plan.after)) return 'action';
  if (plan.decision.decision === 'wait' && !task.due_at) return 'waiting';
  if (plan.decision.decision === 'review') return 'review';
  return 'action';
}
export const TASK_BUCKET_LABEL: Record<TaskBucket, string> = {
  action: '待处理', waiting: '等待客户 / 条件', review: '待复核',
};
