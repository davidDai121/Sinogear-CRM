import { useEffect, useRef, useState } from 'react';
import type { CrmContact } from '../hooks/useCrmData';
import { jumpToChat } from '@/lib/jump-to-chat';
import { stringifyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

interface Props {
  contacts: CrmContact[];
  /** 当前 WhatsApp Web 打开的聊天 phone，命中的 row 会高亮 */
  activePhone?: string | null;
  onClose: () => void;
  onAction: () => void;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const QUALITY_ICON: Record<string, string> = {
  big: '⭐⭐⭐',
  potential: '⭐⭐',
  normal: '⭐',
  spam: '🗑',
};

export function FilteredChatList({
  contacts,
  activePhone,
  onClose,
  onAction,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const sorted = [...contacts].sort((a, b) => {
    const ta = a.chat?.t ?? 0;
    const tb = b.chat?.t ?? 0;
    return tb - ta;
  });

  // 切到新聊天时如果选中行不在视野内，平滑滚到可见
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [activePhone]);

  const go = async (c: CrmContact) => {
    setBusyId(c.jid ?? c.phone);
    setError(null);
    try {
      const query = c.phone.replace(/^\+/, '');
      const ok = await jumpToChat(query);
      if (!ok) setError('未找到聊天，可能需要手动打开');
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyId(null);
    }
  };

  const ackReminder = async (c: CrmContact, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!c.contact) return;
    setBusyId(c.contact.id);
    setError(null);
    try {
      const { error: err } = await supabase
        .from('contacts')
        .update({ reminder_ack_at: new Date().toISOString() })
        .eq('id', c.contact.id);
      if (err) throw err;
      onAction();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyId(null);
    }
  };

  const disableReminder = async (c: CrmContact, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!c.contact) return;
    if (!confirm(`确认对 ${c.displayName} 永远不提醒？`)) return;
    setBusyId(c.contact.id);
    setError(null);
    try {
      const { error: err } = await supabase
        .from('contacts')
        .update({ reminder_disabled: true })
        .eq('id', c.contact.id);
      if (err) throw err;
      onAction();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="sgc-filtered-list">
      <div className="sgc-filtered-list-header">
        <span>找到 {contacts.length} 个客户</span>
        <button className="sgc-filtered-list-close" onClick={onClose}>
          ×
        </button>
      </div>
      {error && <div className="sgc-filtered-list-error">{error}</div>}
      <div className="sgc-filtered-list-body">
        {sorted.length === 0 && (
          <div className="sgc-empty">没有匹配的客户</div>
        )}
        {sorted.map((c) => {
          const q = c.contact?.quality ?? 'potential';
          const id = c.contact?.id ?? c.jid ?? c.phone;
          const isBusy = busyId === id;
          const isActive =
            activePhone != null && c.phone === activePhone;
          return (
            <div
              key={id}
              ref={isActive ? activeRowRef : undefined}
              className={`sgc-filtered-row ${isActive ? 'sgc-filtered-row-active' : ''}`}
            >
              <button
                className="sgc-filtered-row-clickable"
                onClick={() => go(c)}
                disabled={isBusy}
              >
                <div className="sgc-filtered-row-main">
                  <div className="sgc-filtered-row-top">
                    <span className="sgc-filtered-row-name">
                      {c.displayName}
                    </span>
                    <span className="sgc-filtered-row-quality">
                      {QUALITY_ICON[q]}
                    </span>
                    {c.chat?.unreadCount
                      ? (
                        <span className="sgc-filtered-row-unread">
                          {c.chat.unreadCount}
                        </span>
                      )
                      : null}
                  </div>
                  <div className="sgc-filtered-row-meta">
                    <span>{c.phone}</span>
                    {c.contact?.country && <span>· {c.contact.country}</span>}
                    {c.vehicleInterests[0] && (
                      <span>· {c.vehicleInterests[0].model}</span>
                    )}
                  </div>
                  {c.labels.length > 0 && (
                    <div className="sgc-filtered-row-tags">
                      {c.labels.slice(0, 3).map((l) => (
                        <span key={l.id} className="sgc-filtered-row-tag">
                          {l.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="sgc-filtered-row-time">
                  {c.chat?.t ? relativeTime(c.chat.t) : ''}
                </div>
              </button>
              {c.contact && c.classification?.needsReply && (
                <div className="sgc-filtered-row-actions">
                  <button
                    className="sgc-row-action"
                    onClick={(e) => ackReminder(c, e)}
                    disabled={isBusy}
                    title="标记已处理（客户下次发新消息会再提醒）"
                  >
                    ✓ 已处理
                  </button>
                  <button
                    className="sgc-row-action sgc-row-action-danger"
                    onClick={(e) => disableReminder(c, e)}
                    disabled={isBusy}
                    title="永久不再提醒此客户"
                  >
                    🔇 不提醒
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
