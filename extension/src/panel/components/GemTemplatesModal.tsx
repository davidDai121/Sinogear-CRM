import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';

type GemTemplateRow = Database['public']['Tables']['gem_templates']['Row'];

interface Props {
  orgId: string;
  onClose: () => void;
}

type EditingState =
  | { mode: 'list' }
  | { mode: 'new' }
  | { mode: 'edit'; template: GemTemplateRow };

export function GemTemplatesModal({ orgId, onClose }: Props) {
  const [templates, setTemplates] = useState<GemTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState>({ mode: 'list' });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('gem_templates')
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
    const { error } = await supabase.from('gem_templates').delete().eq('id', id);
    if (error) {
      setError(error.message);
      return;
    }
    setConfirmDeleteId(null);
    await refresh();
  };

  const setDefault = async (id: string) => {
    setError(null);
    // Clear other defaults in this org first
    const { error: clearErr } = await supabase
      .from('gem_templates')
      .update({ is_default: false })
      .eq('org_id', orgId)
      .neq('id', id);
    if (clearErr) {
      setError(clearErr.message);
      return;
    }
    const { error: setErr } = await supabase
      .from('gem_templates')
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
          <strong>Gemini Gem 模板</strong>
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
                  还没有 Gem 模板。点击"+ 新建"添加你在 gemini.google.com 自建的 Gem URL。
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
                        href={t.gem_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t.gem_url}
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
  template: GemTemplateRow | null;
  hasDefault: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: template?.name ?? '',
    gem_url: template?.gem_url ?? '',
    description: template?.description ?? '',
    is_default: template?.is_default ?? !hasDefault,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = draft.gem_url.trim();
    if (!draft.name.trim() || !url) return;
    if (!/^https:\/\/gemini\.google\.com\//.test(url)) {
      setError('URL 必须以 https://gemini.google.com/ 开头');
      return;
    }
    setBusy(true);
    try {
      // If marking this as default, clear other defaults
      if (draft.is_default) {
        await supabase
          .from('gem_templates')
          .update({ is_default: false })
          .eq('org_id', orgId)
          .neq('id', template?.id ?? '00000000-0000-0000-0000-000000000000');
      }

      if (template) {
        const { error } = await supabase
          .from('gem_templates')
          .update({
            name: draft.name.trim(),
            gem_url: url,
            description: draft.description.trim() || null,
            is_default: draft.is_default,
          })
          .eq('id', template.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from('gem_templates').insert({
          org_id: orgId,
          name: draft.name.trim(),
          gem_url: url,
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
          placeholder="如：销售助理 Gem"
          required
          autoFocus
        />
      </label>

      <label className="sgc-field sgc-field-full">
        <span>Gem URL</span>
        <input
          value={draft.gem_url}
          onChange={(e) => setDraft({ ...draft, gem_url: e.target.value })}
          placeholder="https://gemini.google.com/gem/xxxxxxxx"
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
          placeholder="这个 Gem 用来做什么？例如：客户分析 + 回复建议"
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
        <span>设为默认模板（聊天卡片会用它生成回复建议）</span>
      </label>

      {error && <div className="sgc-error">{error}</div>}

      <div className="sgc-modal-actions sgc-field-full">
        <button type="button" className="sgc-btn-link" onClick={onCancel}>
          取消
        </button>
        <button
          type="submit"
          className="sgc-btn-primary"
          disabled={busy || !draft.name.trim() || !draft.gem_url.trim()}
        >
          {busy ? '保存中…' : template ? '保存' : '创建'}
        </button>
      </div>
    </form>
  );
}
