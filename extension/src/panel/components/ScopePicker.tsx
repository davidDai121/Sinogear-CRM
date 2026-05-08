import { useEffect, useRef, useState } from 'react';
import { useScope } from '../contexts/ScopeContext';

interface Props {
  /** 我的客户数（已应用过 scope=mine 时的数量） */
  mineCount?: number;
  /** 全部客户数 */
  allCount?: number;
}

export function ScopePicker({ mineCount, allCount }: Props) {
  const { scope, setScope, myUserId } = useScope();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const label = scope === 'mine' ? '👤 只看我的' : '🏢 全部';
  const count = scope === 'mine' ? mineCount : allCount;

  return (
    <div className="sgc-scope-picker" ref={ref}>
      <button
        type="button"
        className="sgc-scope-trigger"
        onClick={() => setOpen((o) => !o)}
        title={
          myUserId
            ? '切换视图：只看我的客户 / 全部客户'
            : '加载中…'
        }
      >
        {label}
        {typeof count === 'number' && (
          <span className="sgc-scope-count">{count}</span>
        )}
        <span className="sgc-scope-caret">▾</span>
      </button>

      {open && (
        <div className="sgc-scope-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className={`sgc-scope-item ${scope === 'mine' ? 'sgc-scope-item-active' : ''}`}
            onClick={() => {
              setScope('mine');
              setOpen(false);
            }}
          >
            <span className="sgc-scope-icon">👤</span>
            <span className="sgc-scope-text">
              <strong>只看我的</strong>
              <span className="sgc-muted">我打开/聊过的客户</span>
            </span>
            {typeof mineCount === 'number' && (
              <span className="sgc-scope-num">{mineCount}</span>
            )}
            {scope === 'mine' && <span className="sgc-scope-check">✓</span>}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`sgc-scope-item ${scope === 'all' ? 'sgc-scope-item-active' : ''}`}
            onClick={() => {
              setScope('all');
              setOpen(false);
            }}
          >
            <span className="sgc-scope-icon">🏢</span>
            <span className="sgc-scope-text">
              <strong>全部客户</strong>
              <span className="sgc-muted">团队所有客户</span>
            </span>
            {typeof allCount === 'number' && (
              <span className="sgc-scope-num">{allCount}</span>
            )}
            {scope === 'all' && <span className="sgc-scope-check">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}
