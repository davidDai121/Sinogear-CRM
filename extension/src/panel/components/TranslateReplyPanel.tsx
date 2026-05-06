import { useState, useMemo, useEffect } from 'react';
import { LANG_OPTIONS, guessLangCode } from '@/lib/languages';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { jumpToChat } from '@/lib/jump-to-chat';
import { stringifyError } from '@/lib/errors';

interface Props {
  /** contact.language 字段的原值（"Spanish"/"french"/"en" 等） */
  contactLanguage: string | null | undefined;
  /** 用于 jumpToChat（drawer 模式用） */
  contactPhone?: string | null;
  needsJump?: boolean;
}

export function TranslateReplyPanel({
  contactLanguage,
  contactPhone,
  needsJump,
}: Props) {
  const guessed = useMemo(
    () => guessLangCode(contactLanguage) ?? 'en',
    [contactLanguage],
  );
  const [targetLang, setTargetLang] = useState(guessed);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);

  // 切客户时自动更新目标语言
  useEffect(() => {
    setTargetLang(guessed);
  }, [guessed]);

  const translate = async () => {
    if (!input.trim()) return;
    setTranslating(true);
    setError(null);
    setOutput('');
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        text: input.trim(),
        targetLang,
      })) as { ok: boolean; translation?: string; error?: string };
      if (!res?.ok) throw new Error(res?.error ?? '翻译失败');
      setOutput((res.translation ?? '').trim());
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setTranslating(false);
    }
  };

  const fill = async () => {
    if (!output) return;
    setFilling(true);
    setError(null);
    try {
      if (needsJump && contactPhone) {
        const ok = await jumpToChat(contactPhone.replace(/^\+/, ''));
        if (!ok) {
          setError('未能跳转到该客户聊天，请先手动打开聊天再点填入');
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      const ok = fillWhatsAppCompose(output);
      if (!ok) setError('找不到 WhatsApp 输入框，请确认聊天已打开');
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setFilling(false);
    }
  };

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
    } catch {
      // ignore
    }
  };

  return (
    <div className="sgc-translate-panel">
      <div className="sgc-translate-row">
        <label className="sgc-translate-lang">
          <span className="sgc-muted">翻译成</span>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
          >
            {LANG_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && input.trim()) {
            e.preventDefault();
            void translate();
          }
        }}
        placeholder="输入中文（或任意语言），翻译成上面选的目标语言…"
        rows={4}
        className="sgc-translate-input"
      />

      <div className="sgc-translate-actions">
        <button
          type="button"
          className="sgc-btn-primary"
          onClick={translate}
          disabled={translating || !input.trim()}
          title="翻译 (Cmd/Ctrl + Enter)"
        >
          {translating ? '翻译中…' : '🌐 翻译'}
        </button>
      </div>

      {output && (
        <div className="sgc-translate-output">
          <div className="sgc-translate-output-text">{output}</div>
          <div className="sgc-translate-actions">
            <button
              type="button"
              className="sgc-btn-primary"
              onClick={fill}
              disabled={filling}
            >
              {filling ? '填入中…' : '💬 填入聊天框'}
            </button>
            <button
              type="button"
              className="sgc-btn-secondary"
              onClick={copy}
            >
              📋 复制
            </button>
          </div>
        </div>
      )}

      {error && <div className="sgc-error">{error}</div>}
    </div>
  );
}
