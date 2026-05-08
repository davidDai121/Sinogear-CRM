import { useMemo, useState } from 'react';
import {
  parseExportedChat,
  phoneFromFilename,
  type ParsedChat,
} from '@/lib/import-chat-parser';
import { importParsedChat, type ImportResult } from '@/lib/chat-import';
import { stringifyError } from '@/lib/errors';

interface Props {
  orgId: string;
  onClose: () => void;
  onDone?: (result: ImportResult) => void;
}

export function ImportChatModal({ orgId, onClose, onDone }: Props) {
  const [filename, setFilename] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedChat | null>(null);
  const [phoneOverride, setPhoneOverride] = useState<string>('');
  const [meSenderOverride, setMeSenderOverride] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setResult(null);
    setFilename(file.name);
    try {
      const text = await file.text();
      const p = parseExportedChat(text);
      setParsed(p);
      setPhoneOverride(p.phone ?? phoneFromFilename(file.name) ?? '');
      setMeSenderOverride(p.meSender ?? '');
    } catch (err) {
      setError(stringifyError(err));
    }
  };

  const stats = useMemo(() => {
    if (!parsed) return null;
    const me = meSenderOverride || parsed.meSender;
    let inbound = 0;
    let outbound = 0;
    let noTs = 0;
    for (const m of parsed.messages) {
      if (!m.ts) noTs++;
      if (m.sender === me) outbound++;
      else inbound++;
    }
    return { inbound, outbound, noTs, total: parsed.messages.length };
  }, [parsed, meSenderOverride]);

  const senderOptions = useMemo(() => {
    if (!parsed) return [];
    return Object.entries(parsed.senderCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => ({ sender: s, count: c }));
  }, [parsed]);

  const handleImport = async () => {
    if (!parsed || !meSenderOverride) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importParsedChat(
        orgId,
        parsed,
        meSenderOverride,
        phoneOverride || null,
      );
      setResult(r);
      onDone?.(r);
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>📥 导入手机端聊天记录</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
            type="button"
          >
            ×
          </button>
        </header>

        <div className="sgc-modal-body">
          {!parsed && (
            <>
              <div className="sgc-muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
                在 WhatsApp 手机端打开聊天 → 右上角菜单 → 更多 → 导出聊天 → 选「不附媒体」
                → 把 .txt 发到电脑（微信文件传输助手 / 邮件 / AirDrop 都行）→ 在这里选这个文件。
                重复导入同一个文件不会产生重复消息。
              </div>
              <label
                style={{
                  border: '2px dashed #d1d7db',
                  borderRadius: 8,
                  padding: 24,
                  textAlign: 'center',
                  cursor: 'pointer',
                  display: 'block',
                }}
              >
                <input
                  type="file"
                  accept=".txt,text/plain"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                />
                <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                <div>点击选择 .txt 聊天文件</div>
                <div className="sgc-muted" style={{ fontSize: 12, marginTop: 6 }}>
                  例如「与+224 623 21 70 09的 WhatsApp 聊天.txt」
                </div>
              </label>
            </>
          )}

          {parsed && !result && (
            <>
              <div className="sgc-muted" style={{ fontSize: 12 }}>
                文件：{filename}
              </div>

              <div className="sgc-modal-section">
                <label
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <span style={{ fontSize: 12, color: '#667781' }}>
                    客户手机号（自动识别 / 可手改）
                  </span>
                  <input
                    type="text"
                    value={phoneOverride}
                    onChange={(e) => setPhoneOverride(e.target.value)}
                    placeholder="+224623217009"
                    style={{
                      padding: '6px 8px',
                      border: '1px solid #d1d7db',
                      borderRadius: 4,
                    }}
                  />
                </label>
              </div>

              <div className="sgc-modal-section">
                <label
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <span style={{ fontSize: 12, color: '#667781' }}>
                    我的发件人名（不在列表里就手填，必须和文件里一字不差）
                  </span>
                  <input
                    type="text"
                    list="sgc-sender-list"
                    value={meSenderOverride}
                    onChange={(e) => setMeSenderOverride(e.target.value)}
                    placeholder="Sino Gear Miles"
                    style={{
                      padding: '6px 8px',
                      border: '1px solid #d1d7db',
                      borderRadius: 4,
                    }}
                  />
                  <datalist id="sgc-sender-list">
                    {senderOptions.map((o) => (
                      <option key={o.sender} value={o.sender}>
                        {o.count} 条
                      </option>
                    ))}
                  </datalist>
                </label>
                <div className="sgc-muted" style={{ fontSize: 12, marginTop: 6 }}>
                  文件里出现的发件人：
                  {senderOptions.map((o, i) => (
                    <span key={o.sender}>
                      {i > 0 ? '、' : ' '}
                      <code>{o.sender}</code>（{o.count}）
                    </span>
                  ))}
                </div>
              </div>

              {stats && (
                <div className="sgc-muted" style={{ fontSize: 13 }}>
                  共 <strong>{stats.total}</strong> 条 · 我发出{' '}
                  <strong>{stats.outbound}</strong> · 客户发来{' '}
                  <strong>{stats.inbound}</strong>
                  {stats.noTs > 0 && (
                    <>
                      {' '}
                      · <span style={{ color: '#b91c1c' }}>{stats.noTs} 条无时间戳，会被跳过</span>
                    </>
                  )}
                </div>
              )}

              {parsed.messages.length > 0 && (
                <details>
                  <summary
                    style={{
                      fontSize: 13,
                      color: '#667781',
                      cursor: 'pointer',
                    }}
                  >
                    预览前 5 条
                  </summary>
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      maxHeight: 200,
                      overflowY: 'auto',
                      background: '#f6f7f9',
                      padding: 8,
                      borderRadius: 4,
                    }}
                  >
                    {parsed.messages.slice(0, 5).map((m, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        <span style={{ color: '#667781' }}>
                          {m.ts?.toLocaleString() ?? '?'} · {m.sender}：
                        </span>
                        <span> {m.text.slice(0, 120)}</span>
                        {m.text.length > 120 && '…'}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div className="sgc-modal-actions">
                <button
                  type="button"
                  className="sgc-btn-secondary"
                  onClick={() => {
                    setParsed(null);
                    setFilename(null);
                  }}
                  disabled={busy}
                >
                  换个文件
                </button>
                <button
                  type="button"
                  className="sgc-btn-primary"
                  onClick={() => void handleImport()}
                  disabled={
                    busy ||
                    !phoneOverride.trim() ||
                    !meSenderOverride.trim() ||
                    parsed.messages.length === 0
                  }
                >
                  {busy ? '导入中…' : `导入 ${stats?.total ?? 0} 条`}
                </button>
              </div>
            </>
          )}

          {result && (
            <div>
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                ✅ 导入完成
                {result.contactCreated && '（已自动创建客户）'}
              </div>
              <div className="sgc-muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
                共解析 {result.total} 条 · 新写入{' '}
                <strong>{result.inserted}</strong> 条 · 重复跳过{' '}
                {result.total - result.inserted} 条
                {result.skippedNoTimestamp > 0 &&
                  ` · 无时间戳跳过 ${result.skippedNoTimestamp} 条`}
              </div>
              <div className="sgc-modal-actions">
                <button
                  type="button"
                  className="sgc-btn-primary"
                  onClick={onClose}
                >
                  完成
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="sgc-error" style={{ fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
