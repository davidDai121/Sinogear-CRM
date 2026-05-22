import { useEffect, useMemo, useState } from 'react';
import type { Database } from '@/lib/database.types';
import { loadAllMessages } from '@/lib/message-sync';

type MessageRow = Database['public']['Tables']['messages']['Row'];

interface Props {
  contactId: string;
  contactName: string;
  onClose: () => void;
}

/** AI 来源 chip 配置 —— messages.ai_source 枚举映射到图标 + 标签 + 颜色 */
const SOURCE_CHIP: Record<
  string,
  { icon: string; label: string; bg: string; color: string }
> = {
  claude: { icon: '✨', label: 'Claude', bg: '#f3e8ff', color: '#7c3aed' },
  gem: { icon: '🤖', label: 'Gem', bg: '#dbeafe', color: '#1d4ed8' },
  gem_auto: { icon: '⚡', label: '自动', bg: '#fef3c7', color: '#a16207' },
  gpt: { icon: '🧠', label: 'GPT', bg: '#dcfce7', color: '#15803d' },
  translate: { icon: '🌐', label: '翻译', bg: '#e0f2fe', color: '#0369a1' },
};

const MANUAL_CHIP = {
  icon: '⌨️',
  label: '手打',
  bg: '#f3f4f6',
  color: '#6b7280',
};

function SourceChip({ source }: { source: string | null }) {
  const c = source ? SOURCE_CHIP[source] ?? MANUAL_CHIP : MANUAL_CHIP;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        background: c.bg,
        color: c.color,
        padding: '1px 6px',
        borderRadius: 4,
        marginLeft: 6,
        whiteSpace: 'nowrap',
      }}
      title={`来源：${c.label}`}
    >
      {c.icon} {c.label}
    </span>
  );
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

  // 出站消息按来源分组统计（review 时一眼看哪个 AI 用得多）
  const outboundStats = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const m of messages) {
      if (m.direction !== 'outbound') continue;
      total++;
      const key = m.ai_source ?? 'manual';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return { counts, total };
  }, [messages]);

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

        {/* 出站消息来源统计：让用户一眼看哪个 AI 用得多 */}
        {outboundStats.total > 0 && (
          <div
            style={{
              padding: '6px 16px',
              borderBottom: '1px solid #e9edef',
              fontSize: 11,
              color: '#667781',
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <span>出站 {outboundStats.total} 条：</span>
            {Object.entries(outboundStats.counts)
              .sort(([, a], [, b]) => b - a)
              .map(([key, n]) => {
                const c = key === 'manual' ? MANUAL_CHIP : SOURCE_CHIP[key] ?? MANUAL_CHIP;
                return (
                  <span
                    key={key}
                    style={{
                      fontSize: 11,
                      background: c.bg,
                      color: c.color,
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontWeight: 600,
                    }}
                  >
                    {c.icon} {c.label} {n}
                  </span>
                );
              })}
          </div>
        )}

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
                    {m.direction === 'outbound' && (
                      <SourceChip source={m.ai_source} />
                    )}
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
