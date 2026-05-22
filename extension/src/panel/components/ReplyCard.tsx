import { useEffect, useState } from 'react';
import { stringifyError } from '@/lib/errors';

/**
 * 客户回复卡 — Claude / Gem / variants / quote 全部共用
 *
 * 功能：
 *   - 默认折叠态显示
 *   - "🔍 放大" 按钮 → 切大视图（70vh tall + scroll，看长回复舒服）
 *   - 没 [Translation] 时显示 "🌐 一键翻译" 按钮 → 调 TRANSLATE_TEXT 兜底
 *   - 💬 填入聊天框 + 📋 复制
 */
interface Props {
  label: string;
  reply: string;
  /** 如果 LLM 已经给了中文翻译，传进来；不会再显示一键翻译按钮 */
  existingTranslation: string | null;
  /** 可选附加提示，显示在 reply body 下方（variants 模式的"何时用"） */
  extraNote?: string;
  onFillReply: (text: string) => void;
  onCopy: (text: string) => void;
}

export function ReplyCard({
  label,
  reply,
  existingTranslation,
  extraNote,
  onFillReply,
  onCopy,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [fallbackTrans, setFallbackTrans] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateErr, setTranslateErr] = useState<string | null>(null);

  // 切客户/换 reply 时清掉 fallback 翻译
  useEffect(() => {
    setFallbackTrans(null);
    setTranslateErr(null);
    setExpanded(false);
  }, [reply]);

  const handleTranslate = async () => {
    setTranslating(true);
    setTranslateErr(null);
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        text: reply,
      })) as { ok: boolean; translation?: string; error?: string };
      if (resp?.ok && resp.translation) {
        setFallbackTrans(resp.translation.trim());
      } else {
        setTranslateErr(resp?.error ?? '翻译失败');
      }
    } catch (err) {
      setTranslateErr(stringifyError(err));
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="sgc-gem-card sgc-gem-card-reply">
      <div className="sgc-gem-card-label">
        {label}
        <button
          type="button"
          className="sgc-btn-link"
          onClick={() => setExpanded((v) => !v)}
          style={{ marginLeft: 'auto', fontSize: 11 }}
          title={expanded ? '折叠回默认大小' : '放大查看（看长回复舒服些）'}
        >
          {expanded ? '⤡ 折叠' : '🔍 放大'}
        </button>
      </div>
      <div
        className="sgc-gem-card-body"
        style={
          expanded
            ? {
                maxHeight: '70vh',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                fontSize: 14,
                lineHeight: 1.6,
                padding: '10px 12px',
                background: '#fafbfc',
                border: '1px solid #e9edef',
                borderRadius: 4,
              }
            : { whiteSpace: 'pre-wrap' }
        }
      >
        {reply}
      </div>
      {extraNote && (
        <div className="sgc-muted" style={{ fontSize: 11, marginTop: 4 }}>
          {extraNote}
        </div>
      )}
      <div className="sgc-gem-result-actions">
        <button
          type="button"
          className="sgc-btn-primary"
          onClick={() => onFillReply(reply)}
        >
          💬 填入聊天框
        </button>
        <button
          type="button"
          className="sgc-btn-secondary"
          onClick={() => onCopy(reply)}
        >
          📋 复制
        </button>
        {!existingTranslation && !fallbackTrans && (
          <button
            type="button"
            className="sgc-btn-link"
            onClick={() => void handleTranslate()}
            disabled={translating}
            title="LLM 没生成中文翻译时，调 Google Translate 兜底"
          >
            {translating ? '翻译中…' : '🌐 一键翻译为中文'}
          </button>
        )}
      </div>
      {existingTranslation && (
        <div
          className="sgc-gem-card"
          style={{
            background: '#f0fdf4',
            borderColor: '#bbf7d0',
            marginTop: 6,
            padding: '6px 10px',
          }}
        >
          <div className="sgc-gem-card-label" style={{ fontSize: 11 }}>
            🌐 中文翻译与策略（AI 输出）
          </div>
          <div
            className="sgc-gem-card-body"
            style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}
          >
            {existingTranslation}
          </div>
        </div>
      )}
      {fallbackTrans && (
        <div
          className="sgc-gem-card"
          style={{
            background: '#f0f9ff',
            borderColor: '#bae6fd',
            marginTop: 6,
            padding: '6px 10px',
          }}
        >
          <div className="sgc-gem-card-label" style={{ fontSize: 11 }}>
            🌐 中文翻译（Google Translate 兜底）
          </div>
          <div
            className="sgc-gem-card-body"
            style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}
          >
            {fallbackTrans}
          </div>
        </div>
      )}
      {translateErr && <div className="sgc-error">{translateErr}</div>}
    </div>
  );
}
