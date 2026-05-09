/**
 * 「🔓 导入手机加密备份」弹窗。
 *
 * 流程：
 *   1) 选 msgstore.db.crypt15
 *   2) 输入 64 位 hex 密钥
 *   3) 解密 + 解析 → 显示统计
 *   4) 点导入 → 批量写库 + 进度条
 */
import { useEffect, useMemo, useState } from 'react';
import { decryptCrypt15 } from '@/lib/wa-backup-decrypt';
import {
  openBackup,
  summarizeBackup,
  type BackupSummary,
} from '@/lib/wa-backup-extract';
import {
  importBackupToSupabase,
  type BackupImportResult,
  type ImportProgress,
} from '@/lib/wa-backup-import';
import { stringifyError } from '@/lib/errors';
import type { Database } from 'sql.js';

interface Props {
  orgId: string;
  onClose: () => void;
  onDone?: (result: BackupImportResult) => void;
}

type Phase = 'pickFile' | 'enterKey' | 'analyzing' | 'preview' | 'importing' | 'done' | 'error';

export function ImportBackupModal({ orgId, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('pickFile');
  const [file, setFile] = useState<File | null>(null);
  const [keyHex, setKeyHex] = useState('');
  const [stage, setStage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [minMessages, setMinMessages] = useState<number>(1);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<BackupImportResult | null>(null);

  // 卸载时关 sql.js db
  useEffect(() => {
    return () => {
      db?.close();
    };
  }, [db]);

  const cleanKey = useMemo(() => keyHex.replace(/\s+/g, '').toLowerCase(), [keyHex]);
  const keyValid = /^[0-9a-f]{64}$/.test(cleanKey);

  const handleFile = (f: File) => {
    setFile(f);
    setError(null);
    setPhase('enterKey');
  };

  const handleAnalyze = async () => {
    if (!file || !keyValid) return;
    setPhase('analyzing');
    setError(null);
    try {
      setStage('读文件');
      const buf = new Uint8Array(await file.arrayBuffer());
      setStage('解密');
      const { sqlite } = await decryptCrypt15(buf, cleanKey, (s) => setStage(s));
      setStage('打开 SQLite');
      const opened = await openBackup(sqlite);
      setStage('统计');
      const sum = summarizeBackup(opened);
      setDb(opened);
      setSummary(sum);
      setPhase('preview');
    } catch (err) {
      setError(stringifyError(err));
      setPhase('error');
    }
  };

  const handleImport = async () => {
    if (!db || !summary) return;
    setPhase('importing');
    setError(null);
    setProgress(null);
    try {
      const r = await importBackupToSupabase(orgId, db, summary, {
        minMessages,
        onProgress: (p) => setProgress(p),
      });
      setResult(r);
      onDone?.(r);
      setPhase('done');
    } catch (err) {
      setError(stringifyError(err));
      setPhase('error');
    }
  };

  const filteredChats = useMemo(() => {
    if (!summary) return { count: 0, messages: 0 };
    const list = summary.chats.filter((c) => c.messageCount >= minMessages);
    return {
      count: list.length,
      messages: list.reduce((n, c) => n + c.messageCount, 0),
    };
  }, [summary, minMessages]);

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={phase === 'importing' ? undefined : onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>🔓 导入手机加密备份（msgstore.db.crypt15）</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            disabled={phase === 'importing'}
            aria-label="关闭"
            type="button"
          >
            ×
          </button>
        </header>

        <div className="sgc-modal-body">
          {phase === 'pickFile' && (
            <>
              <div className="sgc-muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
                一次性把 <strong>WhatsApp Business 安卓端</strong>整个聊天历史导进 CRM。
                <br />
                需要在手机里先开「端到端加密备份 → 使用 64 位密钥」并截图保存密钥，
                再把 <code>msgstore.db.crypt15</code>（在手机
                <code>/Android/media/com.whatsapp.w4b/WhatsApp Business/Databases/</code>
                ）拷到电脑。
                <br />
                所有解密 / 解析都在本地浏览器里完成，文件和密钥不会离开你的电脑。
              </div>
              <label
                style={{
                  border: '2px dashed #d1d7db',
                  borderRadius: 8,
                  padding: 24,
                  textAlign: 'center',
                  cursor: 'pointer',
                  display: 'block',
                  marginTop: 12,
                }}
              >
                <input
                  type="file"
                  accept=".crypt15,application/octet-stream"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔐</div>
                <div>点击选择 msgstore.db.crypt15</div>
                <div className="sgc-muted" style={{ fontSize: 12, marginTop: 6 }}>
                  通常 几十 MB ~ 几百 MB
                </div>
              </label>
            </>
          )}

          {(phase === 'enterKey' || phase === 'analyzing') && (
            <>
              <div className="sgc-muted" style={{ fontSize: 12 }}>
                文件：{file?.name} · {file ? formatBytes(file.size) : ''}
              </div>
              <div className="sgc-modal-section">
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: '#667781' }}>
                    64 位加密密钥（截图里 16 组每组 4 位 hex，可带空格直接粘贴）
                  </span>
                  <textarea
                    rows={3}
                    value={keyHex}
                    onChange={(e) => setKeyHex(e.target.value)}
                    placeholder="abcd 1234 ef56 7890 ... (16 组每组 4 位 hex，截图里是什么粘什么)"
                    style={{
                      padding: 8,
                      border: '1px solid #d1d7db',
                      borderRadius: 4,
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 13,
                      resize: 'vertical',
                    }}
                    disabled={phase === 'analyzing'}
                  />
                  <div className="sgc-muted" style={{ fontSize: 12 }}>
                    {keyHex.length === 0
                      ? '去掉空格后应该是 64 个字符'
                      : keyValid
                        ? '✓ 格式正确'
                        : `去掉空格后是 ${cleanKey.length} 个字符（需要 64）`}
                  </div>
                </label>
              </div>

              {phase === 'analyzing' && (
                <div className="sgc-muted" style={{ fontSize: 13 }}>
                  ⏳ {stage}…
                </div>
              )}

              <div className="sgc-modal-actions">
                <button
                  type="button"
                  className="sgc-btn-secondary"
                  onClick={() => {
                    setFile(null);
                    setKeyHex('');
                    setPhase('pickFile');
                  }}
                  disabled={phase === 'analyzing'}
                >
                  换个文件
                </button>
                <button
                  type="button"
                  className="sgc-btn-primary"
                  onClick={() => void handleAnalyze()}
                  disabled={!keyValid || phase === 'analyzing'}
                >
                  {phase === 'analyzing' ? '处理中…' : '解密 + 分析'}
                </button>
              </div>
            </>
          )}

          {phase === 'preview' && summary && (
            <>
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                <div>
                  总聊天数：<strong>{summary.totalChats.toLocaleString()}</strong>
                  （个人 {summary.personalChats.toLocaleString()} · 群{' '}
                  {summary.groupChats.toLocaleString()} · 业务号 lid{' '}
                  {summary.lidChats.toLocaleString()}）
                </div>
                <div>
                  总消息数：<strong>{summary.totalMessages.toLocaleString()}</strong>
                  （个人 {summary.personalMessages.toLocaleString()}）
                </div>
                {summary.dateRange && (
                  <div>
                    时间范围：{fmtDate(summary.dateRange.from)} →{' '}
                    {fmtDate(summary.dateRange.to)}
                  </div>
                )}
                {summary.lidChats > 0 && (
                  <div className="sgc-muted" style={{ fontSize: 12, marginTop: 4 }}>
                    ⚠ 业务号 lid 这版先跳过（需要再 join 表反查真号）
                  </div>
                )}
              </div>

              <div className="sgc-modal-section">
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: '#667781' }}>
                    最少消息数门槛（只导消息 ≥ N 的聊天，过滤一次性骚扰）
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={minMessages}
                    onChange={(e) => setMinMessages(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    style={{
                      padding: '6px 8px',
                      border: '1px solid #d1d7db',
                      borderRadius: 4,
                      width: 120,
                    }}
                  />
                </label>
                <div className="sgc-muted" style={{ fontSize: 13, marginTop: 8 }}>
                  按当前过滤会导 <strong>{filteredChats.count.toLocaleString()}</strong> 个客户的{' '}
                  <strong>{filteredChats.messages.toLocaleString()}</strong> 条原始消息
                  （系统消息和无内容媒体会被自动跳过，实际入库会少一些）。
                </div>
              </div>

              <details>
                <summary
                  style={{ fontSize: 13, color: '#667781', cursor: 'pointer' }}
                >
                  Top 10 聊天预览
                </summary>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    fontFamily: 'ui-monospace, monospace',
                    background: '#f6f7f9',
                    padding: 8,
                    borderRadius: 4,
                  }}
                >
                  {summary.chats.slice(0, 10).map((c) => (
                    <div key={c.chatRowId}>
                      +{c.jidUser.padEnd(15)} {String(c.messageCount).padStart(5)} 条
                      {c.lastTs > 0 && `  最后 ${fmtDate(c.lastTs)}`}
                    </div>
                  ))}
                </div>
              </details>

              <div className="sgc-modal-actions">
                <button type="button" className="sgc-btn-secondary" onClick={onClose}>
                  取消
                </button>
                <button
                  type="button"
                  className="sgc-btn-primary"
                  onClick={() => void handleImport()}
                  disabled={filteredChats.count === 0}
                >
                  开始导入 {filteredChats.count.toLocaleString()} 个客户
                </button>
              </div>
            </>
          )}

          {phase === 'importing' && (
            <>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                ⏳ {progress?.stage ?? '准备中'}…
              </div>
              <div
                style={{
                  height: 8,
                  background: '#e5e7eb',
                  borderRadius: 4,
                  overflow: 'hidden',
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.round((progress?.ratio ?? 0) * 100)}%`,
                    background: '#16a34a',
                    transition: 'width 200ms ease',
                  }}
                />
              </div>
              <div className="sgc-muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
                聊天进度：{progress?.contactsProcessed ?? 0}/{progress?.contactsTotal ?? 0}
                <br />
                新建客户：{progress?.contactsCreated ?? 0}
                <br />
                消息已写入：{progress?.messagesInserted.toLocaleString() ?? 0} /{' '}
                {progress?.messagesQueued.toLocaleString() ?? 0} 条
              </div>
              <div className="sgc-muted" style={{ fontSize: 12, marginTop: 12 }}>
                ⚠ 不要关闭这个窗口或刷新页面，否则进度会丢失
              </div>
            </>
          )}

          {phase === 'done' && result && (
            <>
              <div style={{ fontSize: 14, marginBottom: 8 }}>✅ 导入完成</div>
              <div className="sgc-muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
                聊天处理：<strong>{result.chatsProcessed.toLocaleString()}</strong> 个
                <br />
                匹配到已有客户：{result.contactsMatched.toLocaleString()}
                <br />
                新建客户：<strong>{result.contactsCreated.toLocaleString()}</strong>
                <br />
                消息可写入：{result.messagesQueued.toLocaleString()}
                <br />
                实际新增：<strong>{result.messagesInserted.toLocaleString()}</strong>{' '}
                条（重复 {(result.messagesQueued - result.messagesInserted).toLocaleString()} 已跳过）
                <br />
                跳过（系统/空消息）：{result.messagesSkipped.toLocaleString()}
              </div>
              <div className="sgc-modal-actions">
                <button type="button" className="sgc-btn-primary" onClick={onClose}>
                  完成
                </button>
              </div>
            </>
          )}

          {phase === 'error' && (
            <>
              <div className="sgc-error" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {error}
              </div>
              <div className="sgc-modal-actions">
                <button
                  type="button"
                  className="sgc-btn-secondary"
                  onClick={() => {
                    setError(null);
                    if (file && keyHex) setPhase('enterKey');
                    else setPhase('pickFile');
                  }}
                >
                  返回
                </button>
                <button type="button" className="sgc-btn-primary" onClick={onClose}>
                  关闭
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
