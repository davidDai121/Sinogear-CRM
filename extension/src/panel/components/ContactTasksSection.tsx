import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, TaskStatus } from '@/lib/database.types';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  readChatMessages,
  waitForChatMessages,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { loadMessages } from '@/lib/message-sync';
import { stringifyError } from '@/lib/errors';
import { logContactEvent } from '@/lib/events-log';
import type {
  ExtractTasksResponse,
  TaskSuggestion,
} from '@/lib/field-suggestions';

type TaskRow = Database['public']['Tables']['tasks']['Row'];

interface Props {
  contactId: string;
  orgId: string;
  contactPhone?: string;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: '待处理',
  done: '已完成',
  cancelled: '已取消',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function dueLabel(days: number | null): string {
  if (days == null) return '无截止';
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days < 7) return `${days} 天后`;
  if (days < 30) return `${Math.round(days / 7)} 周后`;
  return `${Math.round(days / 30)} 月后`;
}

function dueDateFromDays(days: number | null): string | null {
  if (days == null) return null;
  const d = new Date(Date.now() + days * DAY_MS);
  // 默认下午 5 点
  d.setHours(17, 0, 0, 0);
  return d.toISOString();
}

export function ContactTasksSection({ contactId, orgId, contactPhone }: Props) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const refresh = async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setTasks(data ?? []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const cleanTitle = title.trim();
    const { error } = await supabase.from('tasks').insert({
      org_id: orgId,
      contact_id: contactId,
      title: cleanTitle,
      due_at: dueAt || null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    void logContactEvent(contactId, 'task_created', {
      title: cleanTitle,
      due_at: dueAt || null,
      source: 'manual',
    });
    setTitle('');
    setDueAt('');
    setAdding(false);
    await refresh();
  };

  const toggleStatus = async (task: TaskRow) => {
    const next: TaskStatus = task.status === 'open' ? 'done' : 'open';
    const prev = tasks;
    setTasks(tasks.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
    const { error } = await supabase
      .from('tasks')
      .update({ status: next })
      .eq('id', task.id);
    if (error) {
      setError(error.message);
      setTasks(prev);
    }
  };

  const requestSuggestions = async () => {
    setAiBusy(true);
    setAiError(null);
    setSuggestions([]);
    try {
      // 1. 先试 DOM（WA Web 当前打开的聊天）；跳不到（如 David Eze 这类 WA Web
      //    本地无 chat 但已导入 .txt 的客户）就让 messages 留空，下面 fallback
      //    到 messages 表。这里 jumpToChat 不开 deep-link：reload 会中断这次 AI 调用。
      let messages: ChatMessage[] = [];
      if (contactPhone) {
        const queryDigits = contactPhone.replace(/^\+/, '');
        const ok = await jumpToChat(queryDigits);
        if (ok) messages = await waitForChatMessages(5000, 30, 1);
      } else {
        messages = readChatMessages(30);
      }
      // 2. DOM 空 → fallback 到数据库（导入的历史 + 之前 useMessageSync 同步过的）
      if (!messages.length) {
        const rows = await loadMessages(contactId, 50);
        if (!rows.length) {
          throw new Error(
            '当前聊天没有可读消息，且数据库里也没历史记录。请先打开 WhatsApp 聊天加载消息，或在「客户」tab 用「📥 导入手机聊天」导入 .txt 历史。',
          );
        }
        messages = rows.map((r) => ({
          id: r.wa_message_id,
          fromMe: r.direction === 'outbound',
          text: r.text,
          timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
          sender: null,
        }));
      }

      const existingOpenTitles = tasks
        .filter((t) => t.status === 'open')
        .map((t) => t.title);

      const response = (await chrome.runtime.sendMessage({
        type: 'EXTRACT_TASKS',
        messages,
        existingTitles: existingOpenTitles,
      })) as ExtractTasksResponse;
      if (!response?.ok) throw new Error(response?.error ?? 'AI 抽取失败');

      const fresh = (response.tasks ?? []).filter(
        (s) => !existingOpenTitles.includes(s.title),
      );
      if (fresh.length === 0) {
        setAiError('没有新的任务建议');
      } else {
        setSuggestions(fresh);
      }
    } catch (err) {
      setAiError(stringifyError(err));
    } finally {
      setAiBusy(false);
    }
  };

  const acceptSuggestion = async (s: TaskSuggestion) => {
    const due_at = dueDateFromDays(s.due_in_days);
    const { error } = await supabase.from('tasks').insert({
      org_id: orgId,
      contact_id: contactId,
      title: s.title,
      due_at,
    });
    if (error) {
      setError(error.message);
      return;
    }
    void logContactEvent(contactId, 'task_created', {
      title: s.title,
      due_at,
      source: 'ai',
    });
    setSuggestions((prev) => prev.filter((p) => p.title !== s.title));
    await refresh();
  };

  const dismissSuggestion = (s: TaskSuggestion) => {
    setSuggestions((prev) => prev.filter((p) => p.title !== s.title));
  };

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">相关任务</div>
        <div className="sgc-section-actions">
          <button
            type="button"
            className="sgc-btn-link"
            onClick={requestSuggestions}
            disabled={aiBusy}
            title="基于最近聊天用 AI 建议任务"
          >
            {aiBusy ? '🤖 抽取中…' : '🤖 AI 建议'}
          </button>
          {!adding && (
            <button
              className="sgc-btn-link"
              type="button"
              onClick={() => setAdding(true)}
            >
              + 新建
            </button>
          )}
        </div>
      </div>

      {tasks.length === 0 && !adding && suggestions.length === 0 && (
        <span className="sgc-muted">暂无任务</span>
      )}

      <div className="sgc-stack">
        {tasks.map((t) => (
          <div key={t.id} className="sgc-stack-card">
            <div className="sgc-stack-header">
              <label className="sgc-task-row">
                <input
                  type="checkbox"
                  checked={t.status === 'done'}
                  onChange={() => toggleStatus(t)}
                />
                <strong className={t.status === 'done' ? 'sgc-task-done' : ''}>
                  {t.title}
                </strong>
              </label>
              <span className="sgc-muted">{STATUS_LABEL[t.status]}</span>
            </div>
            {t.due_at && (
              <div className="sgc-stack-meta">
                <span>截止 {new Date(t.due_at).toLocaleString()}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {suggestions.length > 0 && (
        <div className="sgc-task-suggestions">
          <div className="sgc-muted sgc-tag-suggestions-label">
            AI 任务建议（点 ✓ 加入）
          </div>
          <div className="sgc-stack">
            {suggestions.map((s) => (
              <div
                key={s.title}
                className="sgc-stack-card sgc-task-suggestion"
                title={s.evidence}
              >
                <div className="sgc-stack-header">
                  <strong>{s.title}</strong>
                  <span className="sgc-task-suggestion-actions">
                    <button
                      className="sgc-tag-accept"
                      onClick={() => acceptSuggestion(s)}
                      aria-label={`添加 ${s.title}`}
                    >
                      ✓
                    </button>
                    <button
                      className="sgc-tag-remove"
                      onClick={() => dismissSuggestion(s)}
                      aria-label={`忽略 ${s.title}`}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div className="sgc-stack-meta">
                  <span>{dueLabel(s.due_in_days)}</span>
                  {s.evidence && (
                    <span className="sgc-evidence">· {s.evidence.slice(0, 60)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <form className="sgc-inline-grid" onSubmit={create}>
          <label className="sgc-field sgc-field-full">
            <span>任务标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：跟进 BYD Denza D9 报价"
              required
            />
          </label>
          <label className="sgc-field sgc-field-full">
            <span>截止时间（可选）</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </label>
          <div className="sgc-form-actions sgc-field-full">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => {
                setAdding(false);
                setTitle('');
                setDueAt('');
              }}
            >
              取消
            </button>
            <button
              type="submit"
              className="sgc-btn-secondary"
              disabled={busy || !title.trim()}
            >
              {busy ? '保存中…' : '创建'}
            </button>
          </div>
        </form>
      )}

      {error && <div className="sgc-error">{error}</div>}
      {aiError && <div className="sgc-error">{aiError}</div>}
    </section>
  );
}
