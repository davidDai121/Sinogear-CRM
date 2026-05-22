import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import {
  formatLogAsMarkdown,
  listAiReplyLogs,
  type AiReplyLog,
  type AiReplySource,
} from '@/lib/ai-reply-log';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

interface Props {
  orgId: string;
  onClose: () => void;
}

type SourceFilter = 'all' | AiReplySource;

interface FilterState {
  source: SourceFilter;
  onlyFilled: boolean;
  onlyErrored: boolean;
}

const SOURCE_LABELS: Record<AiReplySource, string> = {
  claude: '✨ Claude',
  gem: '🤖 Gemini',
  gem_auto: '⚡ 自动回复',
  gpt: '🧠 GPT',
};

export function AIReplyLogModal({ orgId, onClose }: Props) {
  const [logs, setLogs] = useState<AiReplyLog[]>([]);
  const [contactById, setContactById] = useState<Map<string, ContactRow>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>({
    source: 'all',
    onlyFilled: false,
    onlyErrored: false,
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listAiReplyLogs({
        orgId,
        limit: 100,
        source: filter.source === 'all' ? undefined : filter.source,
        onlyFilled: filter.onlyFilled || undefined,
        onlyErrored: filter.onlyErrored || undefined,
      });
      setLogs(data);

      // 拉对应的 contact 资料用于显示
      const ids = Array.from(new Set(data.map((l) => l.contact_id)));
      if (ids.length > 0) {
        const { data: contacts } = await supabase
          .from('contacts')
          .select('*')
          .in('id', ids);
        const map = new Map<string, ContactRow>();
        (contacts ?? []).forEach((c) => map.set(c.id, c as ContactRow));
        setContactById(map);
      } else {
        setContactById(new Map());
      }
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [orgId, filter.source, filter.onlyFilled, filter.onlyErrored]);

  const stats = useMemo(() => {
    const total = logs.length;
    const filled = logs.filter((l) => l.was_filled).length;
    const errored = logs.filter((l) => l.error).length;
    const fillRate = total ? Math.round((filled / Math.max(1, total - errored)) * 100) : 0;
    return { total, filled, errored, fillRate };
  }, [logs]);

  const copyAsMarkdown = async (log: AiReplyLog) => {
    const contact = contactById.get(log.contact_id);
    const md = formatLogAsMarkdown(log, {
      name: contact?.name ?? contact?.wa_name ?? null,
      phone: contact?.phone ?? null,
      country: contact?.country ?? null,
      stage: contact?.customer_stage ?? null,
    });
    try {
      await navigator.clipboard.writeText(md);
      setCopiedId(log.id);
      setTimeout(() => setCopiedId((cur) => (cur === log.id ? null : cur)), 1500);
    } catch (err) {
      alert('复制失败：' + stringifyError(err));
    }
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>📊 AI 回复日志</div>
            <div className="sgc-muted" style={{ fontSize: 12, marginTop: 2 }}>
              最近 100 条 · 共 {stats.total} 条 · 填入率 {stats.fillRate}% ({stats.filled}/{stats.total - stats.errored}) · 失败 {stats.errored}
            </div>
          </div>
          <button
            type="button"
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className="sgc-modal-body">
          {/* 筛选栏 */}
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginBottom: 12,
              padding: '8px 12px',
              background: '#f6f7f9',
              borderRadius: 6,
              flexWrap: 'wrap',
            }}
          >
            <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
              来源:
              <select
                value={filter.source}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, source: e.target.value as SourceFilter }))
                }
              >
                <option value="all">全部</option>
                <option value="claude">✨ Claude</option>
                <option value="gem">🤖 Gemini (手动)</option>
                <option value="gem_auto">⚡ 自动回复</option>
              </select>
            </label>
            <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={filter.onlyFilled}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, onlyFilled: e.target.checked }))
                }
              />
              只看已填入
            </label>
            <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={filter.onlyErrored}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, onlyErrored: e.target.checked }))
                }
              />
              只看失败
            </label>
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => void refresh()}
              style={{ marginLeft: 'auto' }}
            >
              🔁 刷新
            </button>
          </div>

          {error && <div className="sgc-error">{error}</div>}

          {loading ? (
            <div className="sgc-muted">加载中…</div>
          ) : logs.length === 0 ? (
            <div className="sgc-muted">没有匹配的日志。</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {logs.map((log) => {
                const contact = contactById.get(log.contact_id);
                const isExpanded = expandedId === log.id;
                const sourceLabel =
                  SOURCE_LABELS[log.source as AiReplySource] ?? log.source;
                return (
                  <LogRow
                    key={log.id}
                    log={log}
                    contact={contact}
                    sourceLabel={sourceLabel}
                    isExpanded={isExpanded}
                    onToggle={() =>
                      setExpandedId((cur) => (cur === log.id ? null : log.id))
                    }
                    onCopy={() => void copyAsMarkdown(log)}
                    copyJustClicked={copiedId === log.id}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

interface LogRowProps {
  log: AiReplyLog;
  contact: ContactRow | undefined;
  sourceLabel: string;
  isExpanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
  copyJustClicked: boolean;
}

function LogRow({
  log,
  contact,
  sourceLabel,
  isExpanded,
  onToggle,
  onCopy,
  copyJustClicked,
}: LogRowProps) {
  const ts = new Date(log.generated_at);
  const tsLabel = `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
  const customerLabel =
    contact?.name?.trim() ||
    contact?.wa_name?.trim() ||
    contact?.phone ||
    `(unknown ${log.contact_id.slice(0, 8)})`;
  const stageLabel = contact?.customer_stage ?? '?';
  const responsePreview = log.response
    ? log.response.replace(/\s+/g, ' ').slice(0, 100)
    : log.error
      ? `❌ ${log.error.slice(0, 100)}`
      : '(无响应)';

  return (
    <div
      style={{
        border: '1px solid #e9edef',
        borderRadius: 6,
        background: log.error ? '#fef2f2' : '#fff',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 10px',
          cursor: 'pointer',
        }}
        onClick={onToggle}
      >
        <span style={{ fontSize: 11, color: '#667781', minWidth: 60 }}>
          {tsLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            padding: '1px 6px',
            background: '#e9edef',
            borderRadius: 3,
            minWidth: 70,
            textAlign: 'center',
          }}
        >
          {sourceLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            padding: '1px 6px',
            background: '#f0f9ff',
            color: '#075985',
            borderRadius: 3,
          }}
        >
          {log.mode}
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, flex: '1 1 auto' }}>
          {customerLabel}
          <span className="sgc-muted" style={{ fontWeight: 400, marginLeft: 6 }}>
            · {stageLabel}
          </span>
        </span>
        {log.was_filled ? (
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              background: '#dcfce7',
              color: '#15803d',
              borderRadius: 3,
            }}
            title="销售点了 💬 填入聊天框（或自动回复已自动发出）"
          >
            ✅ 填入
          </span>
        ) : log.error ? (
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              background: '#fee2e2',
              color: '#b91c1c',
              borderRadius: 3,
            }}
          >
            ❌ 失败
          </span>
        ) : (
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              background: '#f3f4f6',
              color: '#6b7280',
              borderRadius: 3,
            }}
            title="生成了但销售没填入"
          >
            ◯ 未填
          </span>
        )}
        <span style={{ fontSize: 11, color: '#667781' }}>
          {isExpanded ? '▼' : '▸'}
        </span>
      </div>

      {!isExpanded && (
        <div
          style={{
            padding: '0 10px 8px 10px',
            fontSize: 11,
            color: '#667781',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {responsePreview}
        </div>
      )}

      {isExpanded && (
        <div
          style={{
            padding: '0 10px 12px 10px',
            borderTop: '1px solid #f3f4f6',
            marginTop: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '8px 0',
              fontSize: 11,
              color: '#667781',
              alignItems: 'center',
            }}
          >
            <span>
              📊 {log.message_count ?? '?'} 条上下文 · 来源 {log.message_source ?? '?'}
            </span>
            {log.duration_ms != null && (
              <span>· ⏱ {(log.duration_ms / 1000).toFixed(1)}s</span>
            )}
            {log.chat_url && (
              <a
                href={log.chat_url}
                target="_blank"
                rel="noopener noreferrer"
                className="sgc-btn-link"
                style={{ fontSize: 11 }}
              >
                🔗 在 LLM 网页打开
              </a>
            )}
            <button
              type="button"
              className={copyJustClicked ? 'sgc-btn-secondary' : 'sgc-btn-primary'}
              onClick={onCopy}
              style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 8px' }}
            >
              {copyJustClicked ? '✅ 已复制' : '📋 复制为 markdown 给 Claude review'}
            </button>
          </div>

          {log.guidance?.trim() && (
            <DetailBlock title="🎯 销售指令 (textarea)" body={log.guidance} />
          )}
          {log.error && <DetailBlock title="❌ 错误" body={log.error} danger />}
          <DetailBlock title="📝 完整 Prompt" body={log.prompt} collapsed />
          {log.response && (
            <DetailBlock title="💬 LLM 响应" body={log.response} />
          )}
        </div>
      )}
    </div>
  );
}

function DetailBlock({
  title,
  body,
  danger,
  collapsed,
}: {
  title: string;
  body: string;
  danger?: boolean;
  collapsed?: boolean;
}) {
  return (
    <details open={!collapsed} style={{ marginTop: 8 }}>
      <summary
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: danger ? '#b91c1c' : '#111b21',
          cursor: 'pointer',
        }}
      >
        {title}
      </summary>
      <pre
        style={{
          fontSize: 11,
          background: danger ? '#fef2f2' : '#f6f7f9',
          padding: 8,
          borderRadius: 4,
          maxHeight: 280,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          marginTop: 4,
        }}
      >
        {body}
      </pre>
    </details>
  );
}
