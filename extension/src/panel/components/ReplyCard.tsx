import { useEffect, useState } from 'react';
import { stringifyError } from '@/lib/errors';
import { splitReplyParts } from '@/lib/reply-parts';
import { readWhatsAppComposeText } from '@/content/whatsapp-compose';

/**
 * 客户回复卡 — Claude / Gem / variants / quote 全部共用
 *
 * 功能：
 *   - 默认折叠态显示
 *   - "🔍 放大" 按钮 → 切大视图（70vh tall + scroll，看长回复舒服）
 *   - 没 [Translation] 时显示 "🌐 一键翻译" 按钮 → 调 TRANSLATE_TEXT 兜底
 *   - 💬 填入聊天框 + 📋 复制
 *   - splitParts：按空行拆成几条，一次只填一条，业务员发出去后再填下一条（Miles V3）
 */
interface Props {
  label: string;
  reply: string;
  /** 如果 LLM 已经给了中文翻译，传进来；不会再显示一键翻译按钮 */
  existingTranslation: string | null;
  /** 可选附加提示，显示在 reply body 下方（variants 模式的"何时用"） */
  extraNote?: string;
  /** 返回 false 表示没填进去（已经弹过提示），逐条模式不会跳到下一条 */
  onFillReply: (text: string) => void | boolean | Promise<void | boolean>;
  onCopy: (text: string) => void;
  /** 空行代表「下一条消息」时传 true。只有一条时和普通模式一样。 */
  splitParts?: boolean;
}

export function ReplyCard({
  label,
  reply,
  existingTranslation,
  extraNote,
  onFillReply,
  onCopy,
  splitParts = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [fallbackTrans, setFallbackTrans] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateErr, setTranslateErr] = useState<string | null>(null);
  // 逐条模式：下一条要填的是第几条（parts.length = 全部填过了）
  const [nextPart, setNextPart] = useState(0);
  const [filling, setFilling] = useState(false);

  const parts = splitParts ? splitReplyParts(reply) : [];
  const partMode = parts.length > 1;

  // 切客户/换 reply 时清掉 fallback 翻译，逐条进度也从头开始
  useEffect(() => {
    setFallbackTrans(null);
    setTranslateErr(null);
    setExpanded(false);
    setNextPart(0);
  }, [reply]);

  const fillPart = async (index: number) => {
    if (filling) return;
    // 填入是接在输入框已有内容后面的：上一条还没发出去就填，两条会粘成一条
    if (index > 0) {
      const pending = readWhatsAppComposeText();
      if (pending) {
        const go = confirm(
          '输入框里还有没发出去的内容。\n\n先在 WhatsApp 里把上一条发出去，再填下一条。\n\n仍然要接在后面填入吗？',
        );
        if (!go) return;
      }
    }
    setFilling(true);
    try {
      const ok = await onFillReply(parts[index]);
      if (ok !== false) setNextPart(index + 1);
    } finally {
      setFilling(false);
    }
  };

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
        {partMode
          ? parts.map((part, i) => (
              <div
                key={i}
                style={{
                  borderLeft: `3px solid ${i < nextPart ? '#d1d7db' : i === nextPart ? '#00a884' : '#e9edef'}`,
                  padding: '2px 0 2px 8px',
                  margin: i === 0 ? 0 : '8px 0 0',
                  opacity: i < nextPart ? 0.6 : 1,
                }}
              >
                <div
                  className="sgc-muted"
                  style={{ fontSize: 11, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}
                >
                  <span>
                    第 {i + 1} 条{i < nextPart ? ' · ✓ 已填入' : ''}
                  </span>
                  <button
                    type="button"
                    className="sgc-btn-link"
                    style={{ fontSize: 11 }}
                    disabled={filling}
                    onClick={() => void fillPart(i)}
                    title="只填这一条（重填、跳着填时用）"
                  >
                    填这条
                  </button>
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{part}</div>
              </div>
            ))
          : reply}
      </div>
      {extraNote && (
        <div className="sgc-muted" style={{ fontSize: 11, marginTop: 4 }}>
          {extraNote}
        </div>
      )}
      {partMode && (
        <div className="sgc-muted" style={{ fontSize: 11, marginTop: 4 }}>
          一共 {parts.length} 条：填一条、在 WhatsApp 里发出去，再回来填下一条。
        </div>
      )}
      <div className="sgc-gem-result-actions">
        {partMode ? (
          <>
            {nextPart < parts.length ? (
              <button
                type="button"
                className="sgc-btn-primary"
                disabled={filling}
                onClick={() => void fillPart(nextPart)}
              >
                💬 填入第 {nextPart + 1}/{parts.length} 条
              </button>
            ) : (
              <button type="button" className="sgc-btn-primary" disabled>
                ✓ {parts.length} 条都填过了
              </button>
            )}
            {nextPart > 0 && (
              <button
                type="button"
                className="sgc-btn-link"
                disabled={filling}
                onClick={() => setNextPart(0)}
                title="进度回到第 1 条（不会动输入框）"
              >
                从第 1 条重来
              </button>
            )}
            <button
              type="button"
              className="sgc-btn-link"
              disabled={filling}
              onClick={() => void onFillReply(reply)}
              title="不拆条，整段一次填进输入框"
            >
              整段填入
            </button>
          </>
        ) : (
          <button
            type="button"
            className="sgc-btn-primary"
            onClick={() => void onFillReply(reply)}
          >
            💬 填入聊天框
          </button>
        )}
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
