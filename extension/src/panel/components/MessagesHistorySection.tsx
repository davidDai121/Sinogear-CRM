import { useState } from 'react';
import { useMessageSync } from '../hooks/useMessageSync';
import { MessagesHistoryModal } from './MessagesHistoryModal';

interface Props {
  contactId: string;
  contactName: string;
  needsJump?: boolean;
}

export function MessagesHistorySection({
  contactId,
  contactName,
  needsJump,
}: Props) {
  const sync = useMessageSync(contactId, needsJump);
  const [showModal, setShowModal] = useState(false);

  return (
    <section className="sgc-drawer-section sgc-msg-history-row">
      <div className="sgc-section-header">
        <div className="sgc-section-title">📜 历史消息</div>
        <div className="sgc-section-actions">
          {!needsJump && (
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => sync.triggerSync()}
              disabled={sync.syncing}
              title="把当前 WhatsApp 可见消息同步到云端"
            >
              {sync.syncing ? '同步中…' : '💾 同步当前'}
            </button>
          )}
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => setShowModal(true)}
          >
            查看全部
          </button>
        </div>
      </div>
      <div className="sgc-muted" style={{ fontSize: 12 }}>
        已存 <strong>{sync.count}</strong> 条
        {sync.lastInserted != null && sync.lastInserted > 0 && (
          <span style={{ marginLeft: 8, color: '#00805f' }}>
            刚同步 +{sync.lastInserted}
          </span>
        )}
      </div>

      {showModal && (
        <MessagesHistoryModal
          contactId={contactId}
          contactName={contactName}
          onClose={() => setShowModal(false)}
        />
      )}
    </section>
  );
}
