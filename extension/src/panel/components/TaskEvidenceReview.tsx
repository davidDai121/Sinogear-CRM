import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { FollowupTask } from '@/lib/gpt-followup';

/** Manual legacy-task reconciliation: evidence is displayed before any mutation. */
export function TaskEvidenceReview({ task, onComplete }: { task: FollowupTask; onComplete: () => void }) {
  const [messages, setMessages] = useState<{ id: string; text: string; sent_at: string | null }[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = async () => {
    setBusy(true); setError('');
    try {
      const result = await supabase.from('messages').select('id,text,sent_at')
        .eq('contact_id', task.contact_id).eq('direction', 'outbound')
        .order('sent_at', { ascending: false, nullsFirst: false }).order('id').limit(50);
      if (result.error) throw result.error;
      setMessages(result.data ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const complete = async () => {
    const evidence = messages?.find(m => m.id === selected);
    if (!evidence) return;
    setBusy(true); setError('');
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth.user) throw new Error('请先登录');
      // Preserve the selected original and the exact task the user reviewed.
      const record = { schema: 'task-completion-review.v1', phase: 'intent', orgId: task.org_id,
        userId: auth.user.id, taskId: task.id, before: task, evidence,
        reason: '销售核对实际发送记录，确认已兑现此任务' };
      const intent = await supabase.from('contact_events').insert({ contact_id: task.contact_id,
        event_type: 'ai_extracted', payload: JSON.parse(JSON.stringify(record)) });
      if (intent.error) throw intent.error;
      let q = supabase.from('tasks').update({ status: 'done' }).eq('id', task.id)
        .eq('org_id', task.org_id).eq('contact_id', task.contact_id).eq('status', 'open').eq('title', task.title);
      q = task.due_at === null ? q.is('due_at', null) : q.eq('due_at', task.due_at);
      q = task.created_by === null ? q.is('created_by', null) : q.eq('created_by', task.created_by);
      const updated = await q.select('id');
      if (updated.error) throw updated.error;
      if (!updated.data?.length) throw new Error('任务已被修改，请刷新后重新核对');
      const receipt = await supabase.from('contact_events').insert({ contact_id: task.contact_id,
        event_type: 'ai_extracted', payload: JSON.parse(JSON.stringify({ ...record, phase: 'applied' })) });
      if (receipt.error) throw new Error('任务已完成，但回执保存失败；原核对记录已保留，请刷新查看');
      onComplete();
      window.dispatchEvent(new CustomEvent('sgc:tasks-changed', { detail: { contactId: task.contact_id } }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (task.status !== 'open') return null;
  return <div onClick={e => e.stopPropagation()}>
    <button type="button" className="sgc-btn-link" disabled={busy} onClick={() => messages ? setMessages(null) : void read()}>
      {messages ? '收起发送记录' : busy ? '读取中…' : '核对已发送记录'}
    </button>
    {error && <div role="alert" className="sgc-error">{error}</div>}
    {messages && <div style={{ maxWidth: 550, padding: 8, whiteSpace: 'normal' }}>
      <div className="sgc-muted">最近50条已同步的发出消息。选择确实完成“{task.title}”的记录；无对应证据请保留任务。</div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>{messages.map(m => <label key={m.id} style={{ display: 'block', margin: '8px 0', whiteSpace: 'pre-wrap' }}>
        <input type="radio" name={`evidence-${task.id}`} checked={selected === m.id} onChange={() => setSelected(m.id)} />
        {m.sent_at ? new Date(m.sent_at).toLocaleString() : '发送时间未知'}<br />{m.text}
      </label>)}</div>
      {!messages.length && <div>没有已同步的发出消息。</div>}
      <button type="button" className="sgc-btn-primary" disabled={!selected || busy} onClick={() => void complete()}>确认此任务已完成</button>
    </div>}
  </div>;
}
