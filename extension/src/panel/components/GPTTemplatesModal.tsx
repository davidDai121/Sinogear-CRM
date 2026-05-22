import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';

type GptTemplateRow = Database['public']['Tables']['gpt_templates']['Row'];

interface Props {
  orgId: string;
  onClose: () => void;
}

type EditingState =
  | { mode: 'list' }
  | { mode: 'new' }
  | { mode: 'edit'; template: GptTemplateRow };

/**
 * Custom GPT 模板管理（mirror of GemTemplatesModal）。per-user：
 * RLS 限定 created_by = auth.uid()，每个销售只看到自己 ChatGPT 账号下
 * 建的 Custom GPT URL（别人的 URL 自己也访问不了，没必要互相看）。
 */
export function GPTTemplatesModal({ orgId, onClose }: Props) {
  const [templates, setTemplates] = useState<GptTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState>({ mode: 'list' });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('gpt_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) setError(error.message);
    else setTemplates(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, [orgId]);

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('gpt_templates').delete().eq('id', id);
    if (error) {
      setError(error.message);
      return;
    }
    setConfirmDeleteId(null);
    await refresh();
  };

  const setDefault = async (id: string) => {
    setError(null);
    // Clear other defaults in this org first (per-user RLS 会自动限定到自己的行)
    const { error: clearErr } = await supabase
      .from('gpt_templates')
      .update({ is_default: false })
      .eq('org_id', orgId)
      .neq('id', id);
    if (clearErr) {
      setError(clearErr.message);
      return;
    }
    const { error: setErr } = await supabase
      .from('gpt_templates')
      .update({ is_default: true })
      .eq('id', id);
    if (setErr) {
      setError(setErr.message);
      return;
    }
    await refresh();
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>Custom GPT 模板（per-user）</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="sgc-modal-body">
          {editing.mode === 'list' && (
            <>
              {loading && <div className="sgc-empty">加载中…</div>}
              {!loading && templates.length === 0 && (
                <div className="sgc-empty">
                  还没有 Custom GPT 模板。点击"+ 新建"添加你在 chatgpt.com/gpts 自建的 Custom GPT URL（形如
                  <code>https://chatgpt.com/g/g-xxxxx-name</code>）。
                </div>
              )}
              <div className="sgc-stack">
                {templates.map((t) => (
                  <div key={t.id} className="sgc-stack-card">
                    <div className="sgc-stack-header">
                      <div>
                        <strong>{t.name}</strong>
                        {t.is_default && (
                          <span className="sgc-badge sgc-badge-primary">
                            默认
                          </span>
                        )}
                      </div>
                      <div className="sgc-section-actions">
                        {!t.is_default && (
                          <button
                            type="button"
                            className="sgc-btn-link"
                            onClick={() => setDefault(t.id)}
                          >
                            设为默认
                          </button>
                        )}
                        <button
                          type="button"
                          className="sgc-btn-link"
                          onClick={() =>
                            setEditing({ mode: 'edit', template: t })
                          }
                        >
                          编辑
                        </button>
                        {confirmDeleteId === t.id ? (
                          <>
                            <button
                              type="button"
                              className="sgc-btn-link"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="sgc-btn-danger"
                              onClick={() => handleDelete(t.id)}
                            >
                              确认删除
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="sgc-btn-link sgc-btn-danger-link"
                            onClick={() => setConfirmDeleteId(t.id)}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="sgc-stack-meta">
                      <a
                        href={t.gpt_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t.gpt_url}
                      </a>
                    </div>
                    {t.description && (
                      <div className="sgc-muted">{t.description}</div>
                    )}
                  </div>
                ))}
              </div>

              <div className="sgc-modal-actions">
                <button
                  type="button"
                  className="sgc-btn-primary"
                  onClick={() => setEditing({ mode: 'new' })}
                >
                  + 新建模板
                </button>
              </div>
            </>
          )}

          {editing.mode !== 'list' && (
            <TemplateForm
              orgId={orgId}
              template={editing.mode === 'edit' ? editing.template : null}
              hasDefault={templates.some((t) => t.is_default)}
              onCancel={() => setEditing({ mode: 'list' })}
              onSaved={async () => {
                setEditing({ mode: 'list' });
                await refresh();
              }}
            />
          )}

          {error && <div className="sgc-error">{error}</div>}
        </div>
      </div>
    </>
  );
}

function TemplateForm({
  orgId,
  template,
  hasDefault,
  onCancel,
  onSaved,
}: {
  orgId: string;
  template: GptTemplateRow | null;
  hasDefault: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: template?.name ?? '',
    gpt_url: template?.gpt_url ?? '',
    description: template?.description ?? '',
    is_default: template?.is_default ?? !hasDefault,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = draft.gpt_url.trim();
    if (!draft.name.trim() || !url) return;
    // 允许 chatgpt.com（含 /g/ 自定义 GPT 和 /?model= 普通对话）+ 旧 chat.openai.com
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) {
      setError('URL 必须以 https://chatgpt.com/ 或 https://chat.openai.com/ 开头');
      return;
    }
    setBusy(true);
    try {
      // If marking this as default, clear other defaults (per-user RLS 限定到自己的行)
      if (draft.is_default) {
        await supabase
          .from('gpt_templates')
          .update({ is_default: false })
          .eq('org_id', orgId)
          .neq('id', template?.id ?? '00000000-0000-0000-0000-000000000000');
      }

      if (template) {
        const { error } = await supabase
          .from('gpt_templates')
          .update({
            name: draft.name.trim(),
            gpt_url: url,
            description: draft.description.trim() || null,
            is_default: draft.is_default,
          })
          .eq('id', template.id);
        if (error) throw new Error(error.message);
      } else {
        // created_by 由 trigger 自动填 auth.uid()，客户端不传
        const { error } = await supabase.from('gpt_templates').insert({
          org_id: orgId,
          name: draft.name.trim(),
          gpt_url: url,
          description: draft.description.trim() || null,
          is_default: draft.is_default,
        });
        if (error) throw new Error(error.message);
      }
      await onSaved();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sgc-inline-grid" onSubmit={submit}>
      <label className="sgc-field sgc-field-full">
        <span>模板名称</span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="如：Miles 销售助手"
          required
          autoFocus
        />
      </label>

      <label className="sgc-field sgc-field-full">
        <span>Custom GPT URL</span>
        <input
          value={draft.gpt_url}
          onChange={(e) => setDraft({ ...draft, gpt_url: e.target.value })}
          placeholder="https://chatgpt.com/g/g-xxxxx-name"
          required
        />
      </label>

      <label className="sgc-field sgc-field-full">
        <span>说明（可选）</span>
        <textarea
          rows={2}
          value={draft.description}
          onChange={(e) =>
            setDraft({ ...draft, description: e.target.value })
          }
          placeholder="这个 Custom GPT 用来做什么？例如：客户分析 + 回复建议"
        />
      </label>

      <label className="sgc-field sgc-field-full sgc-checkbox-row">
        <input
          type="checkbox"
          checked={draft.is_default}
          onChange={(e) =>
            setDraft({ ...draft, is_default: e.target.checked })
          }
        />
        <span>设为我的默认（生成回复时优先用这个）</span>
      </label>

      {error && <div className="sgc-error">{error}</div>}

      <div className="sgc-modal-actions sgc-field-full">
        <button type="button" className="sgc-btn-link" onClick={onCancel}>
          取消
        </button>
        <button
          type="submit"
          className="sgc-btn-primary"
          disabled={busy || !draft.name.trim() || !draft.gpt_url.trim()}
        >
          {busy ? '保存中…' : template ? '保存' : '创建'}
        </button>
      </div>
    </form>
  );
}
