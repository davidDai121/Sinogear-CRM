import { useEffect, useState } from 'react';
import type { Database } from '@/lib/database.types';
import { loadAllMessages } from '@/lib/message-sync';

type MessageRow = Database['public']['Tables']['messages']['Row'];

interface Props {
  contactId: string;
  contactName: string;
  onClose: () => void;
}

export function MessagesHistoryModal({ contactId, contactName, onClose }: Props) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadAllMessages(contactId).then((data) => {
      if (!cancelled) {
        setMessages(data);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>消息历史 · {contactName}</strong>
          <span className="sgc-muted">{messages.length} 条</span>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="sgc-modal-body sgc-messages-history-body">
          {loading ? (
            <div className="sgc-empty">加载中…</div>
          ) : messages.length === 0 ? (
            <div className="sgc-empty">
              还没有保存过消息。打开聊天会自动同步当前可见的 30 条；多打开几次或滚动加载历史，更多消息会被入库。
            </div>
          ) : (
            <div className="sgc-msg-history">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`sgc-msg-bubble ${
                    m.direction === 'outbound'
                      ? 'sgc-msg-out'
                      : 'sgc-msg-in'
                  }`}
                >
                  <div className="sgc-msg-text">{m.text}</div>
                  <div className="sgc-msg-meta">
                    {m.sent_at
                      ? new Date(m.sent_at).toLocaleString()
                      : '时间未知'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
