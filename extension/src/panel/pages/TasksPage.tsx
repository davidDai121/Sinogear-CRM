import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, TaskStatus } from '@/lib/database.types';
import { TaskModal } from '../components/TaskModal';

type TaskRow = Database['public']['Tables']['tasks']['Row'];
type ContactRow = Database['public']['Tables']['contacts']['Row'];

interface Props {
  orgId: string;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: '待处理',
  done: '已完成',
  cancelled: '已取消',
};

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function startOfWeek(d: Date) {
  const r = new Date(d);
  const day = r.getDay() || 7;
  r.setDate(r.getDate() - day + 1);
  r.setHours(0, 0, 0, 0);
  return r;
}

function shortName(c: ContactRow | undefined, fallbackPhone: string): string {
  if (!c) return fallbackPhone;
  const raw = c.name?.trim() || c.wa_name?.trim() || c.phone || fallbackPhone;
  // 截短：手机号显示后 4 位
  if (/^[+\d\s\-()]+$/.test(raw)) return raw.slice(-6);
  return raw.length > 8 ? raw.slice(0, 7) + '…' : raw;
}

export function TasksPage({ orgId }: Props) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [contactMap, setContactMap] = useState<Record<string, ContactRow>>({});
  const [statusFilter, setStatusFilter] = useState<TaskStatus>('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalTask, setModalTask] = useState<TaskRow | null | false>(false);
  const [calendarAnchor, setCalendarAnchor] = useState(() => new Date());
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(
    toDateKey(new Date()),
  );
  const [stalledTotal, setStalledTotal] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    const tasksRes = await supabase
      .from('tasks')
      .select('*')
      .eq('org_id', orgId)
      .eq('status', statusFilter)
      .order('due_at', { ascending: true, nullsFirst: false });

    if (tasksRes.error) {
      setError(tasksRes.error.message);
      setLoading(false);
      return;
    }

    const taskList = tasksRes.data ?? [];
    setTasks(taskList);

    const contactIds = Array.from(new Set(taskList.map((t) => t.contact_id)));
    if (contactIds.length) {
      const contactsRes = await supabase
        .from('contacts')
        .select('*')
        .in('id', contactIds);
      if (contactsRes.data) {
        const map: Record<string, ContactRow> = {};
        for (const c of contactsRes.data) map[c.id] = c;
        setContactMap(map);
      }
    } else {
      setContactMap({});
    }

    const stalledRes = await supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('customer_stage', 'stalled');
    if (!stalledRes.error) setStalledTotal(stalledRes.count ?? 0);

    setLoading(false);
  }, [orgId, statusFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const toggleStatus = async (task: TaskRow) => {
    const next: TaskStatus = task.status === 'open' ? 'done' : 'open';
    const prev = tasks;
    setTasks(tasks.filter((t) => t.id !== task.id));
    const { error } = await supabase
      .from('tasks')
      .update({ status: next })
      .eq('id', task.id);
    if (error) {
      setError(error.message);
      setTasks(prev);
    }
  };

  const tasksByDate = useMemo(() => {
    const map: Record<string, TaskRow[]> = {};
    for (const t of tasks) {
      if (!t.due_at) continue;
      const key = toDateKey(new Date(t.due_at));
      (map[key] ??= []).push(t);
    }
    return map;
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    if (selectedDateKey) {
      return tasksByDate[selectedDateKey] ?? [];
    }
    return tasks;
  }, [selectedDateKey, tasks, tasksByDate]);

  const todayKey = toDateKey(new Date());
  const weekStart = startOfWeek(new Date());
  const todayCount = (tasksByDate[todayKey] ?? []).length;
  const thisWeekCount = useMemo(
    () =>
      tasks.filter((t) => {
        if (!t.due_at) return false;
        return new Date(t.due_at) >= weekStart;
      }).length,
    [tasks, weekStart],
  );

  const calendarDays = useMemo(() => {
    const start = startOfMonth(calendarAnchor);
    const end = endOfMonth(calendarAnchor);
    const firstWeekday = start.getDay();
    const days: Array<{ date: Date; key: string; inMonth: boolean }> = [];
    for (let i = 0; i < firstWeekday; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() - (firstWeekday - i));
      days.push({ date: d, key: toDateKey(d), inMonth: false });
    }
    for (let i = 1; i <= end.getDate(); i++) {
      const d = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth(), i);
      days.push({ date: d, key: toDateKey(d), inMonth: true });
    }
    while (days.length % 7 !== 0) {
      const last = days[days.length - 1].date;
      const d = new Date(last);
      d.setDate(d.getDate() + 1);
      days.push({ date: d, key: toDateKey(d), inMonth: false });
    }
    return days;
  }, [calendarAnchor]);

  const monthLabel = `${calendarAnchor.getFullYear()} 年 ${calendarAnchor.getMonth() + 1} 月`;

  const detailLabel = selectedDateKey
    ? selectedDateKey === todayKey
      ? `今天的任务（${visibleTasks.length} 条）`
      : `${selectedDateKey} 的任务（${visibleTasks.length} 条）`
    : `全部${STATUS_LABEL[statusFilter]}任务（${visibleTasks.length} 条）`;

  return (
    <div className="sgc-page">
      <div className="sgc-page-header">
        <h1>任务</h1>
        <div className="sgc-page-actions">
          <div className="sgc-segmented">
            {(['open', 'done', 'cancelled'] as TaskStatus[]).map((s) => (
              <button
                key={s}
                className={statusFilter === s ? 'sgc-segmented-active' : ''}
                onClick={() => setStatusFilter(s)}
                type="button"
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <button
            className="sgc-btn-primary"
            onClick={() => setModalTask(null)}
            type="button"
          >
            + 新建任务
          </button>
        </div>
      </div>

      <div className="sgc-task-kpi">
        <div className="sgc-task-kpi-cell">
          <div className="sgc-kpi-value">{todayCount}</div>
          <div className="sgc-kpi-label">今日待办</div>
        </div>
        <div className="sgc-task-kpi-cell">
          <div className="sgc-kpi-value">{thisWeekCount}</div>
          <div className="sgc-kpi-label">本周待办</div>
        </div>
        <div className="sgc-task-kpi-cell">
          <div className="sgc-kpi-value">{stalledTotal}</div>
          <div className="sgc-kpi-label">累计待跟进客户</div>
        </div>
        <div className="sgc-task-kpi-cell">
          <div className="sgc-kpi-value">{tasks.length}</div>
          <div className="sgc-kpi-label">{STATUS_LABEL[statusFilter]}总数</div>
        </div>
      </div>

      {error && <div className="sgc-error">{error}</div>}

      <div className="sgc-calendar">
        <div className="sgc-calendar-header">
          <button
            className="sgc-btn-link"
            type="button"
            onClick={() =>
              setCalendarAnchor(
                new Date(
                  calendarAnchor.getFullYear(),
                  calendarAnchor.getMonth() - 1,
                  1,
                ),
              )
            }
          >
            ‹ 上月
          </button>
          <strong>{monthLabel}</strong>
          <button
            className="sgc-btn-link"
            type="button"
            onClick={() => {
              setCalendarAnchor(new Date());
              setSelectedDateKey(toDateKey(new Date()));
            }}
          >
            今天
          </button>
          <button
            className="sgc-btn-link"
            type="button"
            onClick={() =>
              setCalendarAnchor(
                new Date(
                  calendarAnchor.getFullYear(),
                  calendarAnchor.getMonth() + 1,
                  1,
                ),
              )
            }
          >
            下月 ›
          </button>
        </div>

        <div className="sgc-calendar-grid sgc-calendar-grid-rich">
          {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
            <div key={w} className="sgc-calendar-weekday">
              {w}
            </div>
          ))}
          {calendarDays.map((d) => {
            const dayTasks = tasksByDate[d.key] ?? [];
            const previews = dayTasks.slice(0, 2);
            const more = dayTasks.length - previews.length;
            return (
              <button
                key={d.key + (d.inMonth ? 'in' : 'out')}
                type="button"
                className={[
                  'sgc-calendar-day',
                  'sgc-calendar-day-rich',
                  d.inMonth ? '' : 'sgc-calendar-day-out',
                  d.key === todayKey ? 'sgc-calendar-day-today' : '',
                  d.key === selectedDateKey ? 'sgc-calendar-day-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() =>
                  setSelectedDateKey(d.key === selectedDateKey ? null : d.key)
                }
              >
                <span className="sgc-calendar-day-num">{d.date.getDate()}</span>
                <div className="sgc-cal-customers">
                  {previews.map((t) => {
                    const c = contactMap[t.contact_id];
                    return (
                      <div key={t.id} className="sgc-cal-customer" title={`${c?.name || c?.wa_name || c?.phone || ''}: ${t.title}`}>
                        {shortName(c, '—')}
                      </div>
                    );
                  })}
                  {more > 0 && (
                    <div className="sgc-cal-more">+{more}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sgc-task-detail-header">
        <strong>{detailLabel}</strong>
        {selectedDateKey && (
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => setSelectedDateKey(null)}
          >
            显示全部
          </button>
        )}
      </div>

      {loading ? (
        <div className="sgc-empty">加载中…</div>
      ) : visibleTasks.length === 0 ? (
        <div className="sgc-empty">
          {selectedDateKey
            ? `${selectedDateKey === todayKey ? '今天' : selectedDateKey} 没有任务`
            : `没有${STATUS_LABEL[statusFilter]}的任务`}
        </div>
      ) : (
        <table className="sgc-table sgc-table-clickable">
          <thead>
            <tr>
              <th></th>
              <th>客户</th>
              <th>任务</th>
              <th>截止</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.map((t) => {
              const contact = contactMap[t.contact_id];
              const time = t.due_at
                ? new Date(t.due_at).toLocaleString()
                : '未设定';
              return (
                <tr key={t.id} onClick={() => setModalTask(t)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={t.status === 'done'}
                      onChange={() => toggleStatus(t)}
                    />
                  </td>
                  <td>
                    <div className="sgc-task-customer">
                      <strong>
                        {contact?.name || contact?.wa_name || contact?.phone || '—'}
                      </strong>
                      {contact?.country && (
                        <span className="sgc-muted"> · {contact.country}</span>
                      )}
                    </div>
                    {contact?.phone && contact.name && (
                      <div className="sgc-muted sgc-task-phone">
                        {contact.phone}
                      </div>
                    )}
                  </td>
                  <td>{t.title}</td>
                  <td>{time}</td>
                  <td>
                    <span className="sgc-muted">{STATUS_LABEL[t.status]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {modalTask !== false && (
        <TaskModal
          orgId={orgId}
          task={modalTask}
          onClose={() => setModalTask(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
