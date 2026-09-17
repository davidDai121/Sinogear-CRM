import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { decodeGptTemplateDescription, encodeGptTemplateDescription } from '@/lib/gpt-template-knowledge';
import { validateGptSkill } from '@/lib/gpt-skill';

type GptTemplateRow = Database['public']['Tables']['gpt_templates']['Row'];

interface Props {
  orgId: string;
  onClose: () => void;
}

type EditingState =
  | { mode: 'list' }
  | { mode: 'new' }
  | { mode: 'edit'; template: GptTemplateRow };

function readMetadataForUi(description: string | null) {
  try {
    return { value: decodeGptTemplateDescription(description), error: null };
  } catch (error) {
    return { value: null, error: stringifyError(error) };
  }
}

function TemplateDescription({ template }: { template: GptTemplateRow }) {
  const metadata = readMetadataForUi(template.description);
  if (metadata.error) return <div className="sgc-error">{metadata.error}</div>;
  return (
    <>
      {metadata.value?.description && <div className="sgc-muted">{metadata.value.description}</div>}
      {metadata.value?.skill && <div className="sgc-muted">ChatGPT 技能 · {metadata.value.skill.name}</div>}
      {metadata.value?.hasEnvelope && (
        <div className="sgc-muted">
          {metadata.value.approvedKnowledge.trim()
            ? `已确认业务知识 · ${metadata.value.approvedKnowledge.trim().length} 字`
            : '已清空共享业务知识'}
          {metadata.value.updatedAt && ` · 保存于 ${new Date(metadata.value.updatedAt).toLocaleString()}`}
        </div>
      )}
    </>
  );
}

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
          <strong>GPT / 技能模板（个人）</strong>
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
                    <TemplateDescription template={t} />
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
  const [metadata] = useState(() => readMetadataForUi(template?.description ?? null));
  const [draft, setDraft] = useState({
    name: template?.name ?? '',
    gpt_url: template?.gpt_url ?? '',
    description: metadata.value?.description ?? template?.description ?? '',
    approvedKnowledge: metadata.value?.approvedKnowledge ?? '',
    useSkill: !!metadata.value?.skill,
    skillId: metadata.value?.skill?.id ?? '',
    skillName: metadata.value?.skill?.name ?? '',
    is_default: template?.is_default ?? !hasDefault,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (metadata.error) {
      setError(metadata.error);
      return;
    }
    const url = draft.useSkill ? 'https://chatgpt.com/' : draft.gpt_url.trim();
    if (!draft.name.trim() || !url) return;
    // 允许 chatgpt.com（含 /g/ 自定义 GPT 和 /?model= 普通对话）+ 旧 chat.openai.com
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) {
      setError('URL 必须以 https://chatgpt.com/ 或 https://chat.openai.com/ 开头');
      return;
    }
    setBusy(true);
    try {
      const description = encodeGptTemplateDescription(
        draft.description,
        draft.approvedKnowledge,
        metadata.value?.hasEnvelope,
        new Date().toISOString(),
        draft.useSkill ? validateGptSkill({ id: draft.skillId.trim(), name: draft.skillName.trim() }) : undefined,
      );
      let savedTemplateId: string;
      if (template) {
        const { data, error } = await supabase
          .from('gpt_templates')
          .update({
            name: draft.name.trim(),
            gpt_url: url,
            description,
            is_default: draft.is_default,
          })
          .eq('id', template.id)
          .eq('org_id', orgId)
          .eq('updated_at', template.updated_at)
          .select('id')
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error('模板已在其他窗口更新，请重新打开后保存。');
        savedTemplateId = data.id;
      } else {
        // created_by 由 trigger 自动填 auth.uid()，客户端不传
        const { data, error } = await supabase.from('gpt_templates')
          .insert({
            org_id: orgId,
            name: draft.name.trim(),
            gpt_url: url,
            description,
            is_default: draft.is_default,
          })
          .select('id')
          .single();
        if (error) throw new Error(error.message);
        savedTemplateId = data.id;
      }

      // 先通过本模板的并发检查，再变更其他默认项。默认选项没变时不写无关模板。
      if (draft.is_default && !template?.is_default) {
        const { error: clearErr } = await supabase
          .from('gpt_templates')
          .update({ is_default: false })
          .eq('org_id', orgId)
          .neq('id', savedTemplateId);
        if (clearErr) throw new Error(`模板内容已保存，但更新默认模板失败：${clearErr.message}`);
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

      <label className="sgc-field sgc-field-full sgc-checkbox-row">
        <input type="checkbox" checked={draft.useSkill}
          onChange={(e) => setDraft({ ...draft, useSkill: e.target.checked })} />
        <span>使用已安装的 ChatGPT 技能</span>
      </label>

      {draft.useSkill ? <>
        <label className="sgc-field sgc-field-full">
          <span>技能名称（ChatGPT 中显示的名称）</span>
          <input value={draft.skillName} required placeholder="sino gear r08 miles"
            onChange={(e) => setDraft({ ...draft, skillName: e.target.value })} />
        </label>
        <label className="sgc-field sgc-field-full">
          <span>技能 ID（技能编辑页链接末尾）</span>
          <input value={draft.skillId} required pattern="[a-f0-9]{32}"
            onChange={(e) => setDraft({ ...draft, skillId: e.target.value })} />
          <span className="sgc-muted">先在当前 ChatGPT 账号安装技能。生成时会核对技能身份；旧 GPT 对话保留，新技能从新会话开始。</span>
        </label>
      </> : <label className="sgc-field sgc-field-full">
        <span>Custom GPT URL</span>
        <input
          value={draft.gpt_url}
          onChange={(e) => setDraft({ ...draft, gpt_url: e.target.value })}
          placeholder="https://chatgpt.com/g/g-xxxxx-name"
          required
        />
      </label>}

      <label className="sgc-field sgc-field-full">
        <span>说明（可选）</span>
        <textarea
          rows={2}
          value={draft.description}
          readOnly={!!metadata.error}
          onChange={(e) =>
            setDraft({ ...draft, description: e.target.value })
          }
          placeholder="这个 Custom GPT 用来做什么？例如：客户分析 + 回复建议"
        />
      </label>

      <label className="sgc-field sgc-field-full">
        <span>已确认业务知识</span>
        <textarea
          rows={10}
          value={draft.approvedKnowledge}
          readOnly={!!metadata.error}
          onChange={(e) => setDraft({ ...draft, approvedKnowledge: e.target.value })}
          placeholder="填写老板已确认、可供这个模板重复使用的业务答案，并注明适用范围和日期。"
        />
        <span className="sgc-muted">
          该模板的首次回复、续聊和内部讨论都会读取最新内容，用于不同客户。仅针对当前订单的特批请写在客户销售指令中。
        </span>
        {metadata.value?.updatedAt && (
          <span className="sgc-muted">上次保存：{new Date(metadata.value.updatedAt).toLocaleString()}</span>
        )}
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

      {(error || metadata.error) && <div className="sgc-error">{error || metadata.error}</div>}

      <div className="sgc-modal-actions sgc-field-full">
        <button type="button" className="sgc-btn-link" onClick={onCancel}>
          取消
        </button>
        <button
          type="submit"
          className="sgc-btn-primary"
          disabled={busy || !!metadata.error || !draft.name.trim()
            || (draft.useSkill ? !draft.skillId.trim() || !draft.skillName.trim() : !draft.gpt_url.trim())}
        >
          {busy ? '保存中…' : template ? '保存' : '创建'}
        </button>
      </div>
    </form>
  );
}
