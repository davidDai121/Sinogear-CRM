import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, TaskStatus } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type TaskRow = Database['public']['Tables']['tasks']['Row'];

interface Props {
  orgId: string;
  task?: TaskRow | null;
  onClose: () => void;
  onSaved: () => void;
}

export function TaskModal({ orgId, task, onClose, onSaved }: Props) {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [title, setTitle] = useState(task?.title ?? '');
  const [contactId, setContactId] = useState(task?.contact_id ?? '');
  const [dueAt, setDueAt] = useState(() => {
    if (!task?.due_at) return '';
    const d = new Date(task.due_at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('org_id', orgId)
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      if (error) setError(error.message);
      else setContacts(data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !contactId) return;
    setBusy(true);
    setError(null);

    const payload = {
      title: title.trim(),
      contact_id: contactId,
      due_at: dueAt ? new Date(dueAt).toISOString() : null,
      status,
    };

    if (task) {
      const { error } = await supabase
        .from('tasks')
        .update(payload)
        .eq('id', task.id);
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
    } else {
      const { error } = await supabase
        .from('tasks')
        .insert({ ...payload, org_id: orgId });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
    }

    setBusy(false);
    onSaved();
    onClose();
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal" role="dialog">
        <header className="sgc-modal-header">
          <strong>{task ? '编辑任务' : '新建任务'}</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <form className="sgc-modal-body" onSubmit={submit}>
          <label className="sgc-field">
            <span>任务标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：跟进 BYD Denza D9 报价"
              required
              autoFocus
            />
          </label>

          <label className="sgc-field">
            <span>关联客户</span>
            <select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              required
            >
              <option value="">选择客户…</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.group_jid ? '👥 ' : ''}
                  {c.name || c.wa_name || c.phone || '群聊'}
                  {c.phone ? ` (${c.phone})` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="sgc-field">
            <span>截止时间（可选）</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </label>

          {task && (
            <label className="sgc-field">
              <span>状态</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                <option value="open">待处理</option>
                <option value="done">已完成</option>
                <option value="cancelled">已取消</option>
              </select>
            </label>
          )}

          {error && <div className="sgc-error">{error}</div>}

          <div className="sgc-modal-actions">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="sgc-btn-primary"
              disabled={busy || !title.trim() || !contactId}
            >
              {busy ? '保存中…' : task ? '保存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
