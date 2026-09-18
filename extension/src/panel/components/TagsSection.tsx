import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { loadChatContext, type ChatContextTarget } from '@/lib/chat-context';
import { stringifyError } from '@/lib/errors';
import { logContactEvent } from '@/lib/events-log';
import type {
  ExtractTagsResponse,
  TagSuggestion,
} from '@/lib/field-suggestions';

interface Props {
  /** 传整个 contact（ContactRow 结构兼容）——AI 建议读消息时要做身份校验 */
  contact: ChatContextTarget;
}

export function TagsSection({ contact }: Props) {
  const contactId = contact.id;
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('contact_tags')
        .select('tag')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (error) setError(error.message);
      else setTags(data?.map((r) => r.tag) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const insertTag = async (
    tag: string,
    source: 'manual' | 'ai' = 'manual',
  ): Promise<boolean> => {
    if (tags.includes(tag)) return false;
    const { error } = await supabase
      .from('contact_tags')
      .insert({ contact_id: contactId, tag });
    if (error) {
      setError(error.message);
      return false;
    }
    setTags((prev) => [...prev, tag]);
    void logContactEvent(contactId, 'tag_added', { tag, source });
    return true;
  };

  const addTag = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const ok = await insertTag(trimmed);
    setBusy(false);
    if (ok) setInput('');
  };

  const removeTag = async (tag: string) => {
    const prev = tags;
    setTags(tags.filter((t) => t !== tag));
    const { error } = await supabase
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag', tag);
    if (error) {
      setError(error.message);
      setTags(prev);
    }
  };

  const requestSuggestions = async () => {
    setAiBusy(true);
    setAiError(null);
    setSuggestions([]);
    try {
      // DOM 优先 + DB 兜底，共享实现见 lib/chat-context.ts。
      // 以前这里 jumpToChat 没传 requireMatch、syncMessages 前也没身份校验
      //（跨聊天污染洞），统一后补上了
      const { messages } = await loadChatContext(contact, {
        needsJump: true,
        logTag: 'TagsSection.suggest',
      });
      const response = (await chrome.runtime.sendMessage({
        type: 'EXTRACT_TAGS',
        messages,
        existingTags: tags,
      })) as ExtractTagsResponse;
      if (!response?.ok) throw new Error(response?.error ?? 'AI 抽取失败');
      const fresh = (response.tags ?? []).filter((s) => !tags.includes(s.tag));
      if (fresh.length === 0) {
        setAiError('没有新的标签建议');
      } else {
        setSuggestions(fresh);
      }
    } catch (err) {
      setAiError(stringifyError(err));
    } finally {
      setAiBusy(false);
    }
  };

  const acceptSuggestion = async (s: TagSuggestion) => {
    const ok = await insertTag(s.tag, 'ai');
    if (ok) setSuggestions((prev) => prev.filter((p) => p.tag !== s.tag));
  };

  const dismissSuggestion = (s: TagSuggestion) => {
    setSuggestions((prev) => prev.filter((p) => p.tag !== s.tag));
  };

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-header">
        <div className="sgc-section-title">标签</div>
        <button
          type="button"
          className="sgc-btn-link"
          onClick={requestSuggestions}
          disabled={aiBusy}
          title="基于最近聊天用 AI 建议标签"
        >
          {aiBusy ? '🤖 抽取中…' : '🤖 AI 建议'}
        </button>
      </div>

      <div className="sgc-tag-list">
        {tags.length === 0 && <span className="sgc-muted">暂无标签</span>}
        {tags.map((tag) => (
          <span key={tag} className="sgc-tag">
            {tag}
            <button
              className="sgc-tag-remove"
              onClick={() => removeTag(tag)}
              aria-label={`删除 ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {suggestions.length > 0 && (
        <div className="sgc-tag-suggestions">
          <div className="sgc-muted sgc-tag-suggestions-label">AI 建议（点 ✓ 加入）</div>
          <div className="sgc-tag-list">
            {suggestions.map((s) => (
              <span
                key={s.tag}
                className="sgc-tag sgc-tag-suggestion"
                title={s.evidence}
              >
                {s.tag}
                <button
                  className="sgc-tag-accept"
                  onClick={() => acceptSuggestion(s)}
                  aria-label={`添加 ${s.tag}`}
                >
                  ✓
                </button>
                <button
                  className="sgc-tag-remove"
                  onClick={() => dismissSuggestion(s)}
                  aria-label={`忽略 ${s.tag}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <form className="sgc-inline-form" onSubmit={addTag}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="新标签（如：高预算、CIF偏好）"
          disabled={busy}
        />
        <button type="submit" className="sgc-btn-secondary" disabled={busy || !input.trim()}>
          添加
        </button>
      </form>

      {error && <div className="sgc-error">{error}</div>}
      {aiError && <div className="sgc-error">{aiError}</div>}
    </section>
  );
}
