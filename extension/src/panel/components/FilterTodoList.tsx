import { useMemo } from 'react';
import type { CrmContact } from '../hooks/useCrmData';
import { todoCounts, type TodoBucket } from '@/lib/filters';

const BUCKETS: { id: TodoBucket; icon: string; label: string }[] = [
  { id: 'all', icon: '📋', label: '所有客户' },
  { id: 'needs_reply', icon: '⚠️', label: '我该回' },
  { id: 'negotiating', icon: '🔥', label: '谈判中' },
  { id: 'priority', icon: '⭐', label: '重点客户' },
  { id: 'stalled', icon: '💤', label: '长期未联系' },
  { id: 'new', icon: '🆕', label: '新客户' },
];

interface Props {
  contacts: CrmContact[];
  active: TodoBucket | null;
  onSelect: (bucket: TodoBucket | null) => void;
}

export function FilterTodoList({ contacts, active, onSelect }: Props) {
  const todos = useMemo(() => todoCounts(contacts), [contacts]);

  return (
    <div className="sgc-filter-today">
      <div className="sgc-filter-today-title">🚨 今日待办</div>
      {BUCKETS.map((b) => (
        <button
          key={b.id}
          className={
            'sgc-filter-todo-item' +
            (active === b.id ? ' sgc-filter-todo-item-active' : '')
          }
          onClick={() => onSelect(active === b.id ? null : b.id)}
        >
          <span className="sgc-filter-todo-icon">{b.icon}</span>
          <span className="sgc-filter-todo-label">{b.label}</span>
          <span className="sgc-filter-todo-count">{todos[b.id]}</span>
        </button>
      ))}
    </div>
  );
}
