import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { jumpToChat } from '@/lib/jump-to-chat';
import {
  readChatMessages,
  waitForChatMessages,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { loadMessages } from '@/lib/message-sync';
import { stringifyError } from '@/lib/errors';
import { logContactEvent } from '@/lib/events-log';
import type {
  ExtractTagsResponse,
  TagSuggestion,
} from '@/lib/field-suggestions';

interface Props {
  contactId: string;
  contactPhone?: string;
}

export function TagsSection({ contactId, contactPhone }: Props) {
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
      // 1. 先试 DOM（WA Web 当前打开的聊天）；跳不到（如 David Eze 这类 WA Web
      //    本地无 chat 但已导入 .txt 的客户）就让 messages 留空，下面 fallback
      //    到 messages 表。这里 jumpToChat 不开 deep-link：reload 会中断这次 AI 调用。
      let messages: ChatMessage[] = [];
      if (contactPhone) {
        const queryDigits = contactPhone.replace(/^\+/, '');
        const ok = await jumpToChat(queryDigits);
        if (ok) messages = await waitForChatMessages(5000, 30, 1);
      } else {
        messages = readChatMessages(30);
      }
      // 2. DOM 空 → fallback 到数据库（导入的历史 + 之前 useMessageSync 同步过的）
      if (!messages.length) {
        const rows = await loadMessages(contactId, 50);
        if (!rows.length) {
          throw new Error(
            '当前聊天没有可读消息，且数据库里也没历史记录。请先打开 WhatsApp 聊天加载消息，或在「客户」tab 用「📥 导入手机聊天」导入 .txt 历史。',
          );
        }
        messages = rows.map((r) => ({
          id: r.wa_message_id,
          fromMe: r.direction === 'outbound',
          text: r.text,
          timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
          sender: null,
        }));
      }
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
