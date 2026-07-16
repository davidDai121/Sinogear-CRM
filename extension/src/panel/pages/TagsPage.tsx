import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { stringifyError } from '@/lib/errors';
import { fetchAllPaged } from '@/lib/supabase-paged';

interface Props {
  orgId: string;
}

interface TagStat {
  tag: string;
  count: number;
}

interface WhatsAppTagStat {
  key: string;
  name: string;
  colorIndex: number;
  count: number;
  sources: number;
}

const WHATSAPP_LABEL_COLORS = [
  '#53bdeb',
  '#ffd279',
  '#99d793',
  '#ff8a80',
  '#d7aefb',
  '#6fd3c3',
  '#f7b955',
  '#7f8de1',
  '#c9df55',
  '#f59ad7',
];

export function TagsPage({ orgId }: Props) {
  const [stats, setStats] = useState<TagStat[]>([]);
  const [whatsAppStats, setWhatsAppStats] = useState<WhatsAppTagStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{
    oldTag: string;
    newTag: string;
  } | null>(null);

  const refresh = async () => {
    setError(null);
    // 分页拉全集，规避 1000 行上限——大 org 的 contact_tags 经常 3000+
    let rows: Array<{ tag: string }>;
    try {
      const [crmRows, waLabels] = await Promise.all([
        fetchAllPaged<{ tag: string }>((from, to) =>
          supabase
            .from('contact_tags')
            .select('tag, contacts!inner(org_id)')
            .eq('contacts.org_id', orgId)
            .order('contact_id', { ascending: true })
            .order('tag', { ascending: true })
            .range(from, to),
        ),
        fetchAllPaged<{
          id: string;
          name: string;
          color_index: number;
          user_id: string;
        }>((from, to) =>
          supabase
            .from('whatsapp_labels')
            .select('id, name, color_index, user_id')
            .eq('org_id', orgId)
            .eq('is_active', true)
            .order('id', { ascending: true })
            .range(from, to),
        ),
      ]);
      rows = crmRows;

      const associationRows: Array<{
        contact_id: string;
        whatsapp_label_id: string;
      }> = [];
      for (let i = 0; i < waLabels.length; i += 100) {
        const labelIds = waLabels.slice(i, i + 100).map((label) => label.id);
        const chunkRows = await fetchAllPaged<{
          contact_id: string;
          whatsapp_label_id: string;
        }>((from, to) =>
          supabase
            .from('contact_whatsapp_labels')
            .select('contact_id, whatsapp_label_id')
            .in('whatsapp_label_id', labelIds)
            .order('id', { ascending: true })
            .range(from, to),
        );
        associationRows.push(...chunkRows);
      }

      const contactIdsByLabel = new Map<string, Set<string>>();
      for (const row of associationRows) {
        const ids = contactIdsByLabel.get(row.whatsapp_label_id) ?? new Set();
        ids.add(row.contact_id);
        contactIdsByLabel.set(row.whatsapp_label_id, ids);
      }
      const grouped = new Map<
        string,
        {
          name: string;
          colorIndex: number;
          contactIds: Set<string>;
          sourceIds: Set<string>;
        }
      >();
      for (const label of waLabels) {
        const key = label.name.trim().toLowerCase();
        const current = grouped.get(key) ?? {
          name: label.name,
          colorIndex: label.color_index,
          contactIds: new Set<string>(),
          sourceIds: new Set<string>(),
        };
        current.sourceIds.add(label.user_id);
        for (const contactId of contactIdsByLabel.get(label.id) ?? []) {
          current.contactIds.add(contactId);
        }
        grouped.set(key, current);
      }
      setWhatsAppStats(
        Array.from(grouped.entries())
          .map(([key, value]) => ({
            key,
            name: value.name,
            colorIndex: value.colorIndex,
            count: value.contactIds.size,
            sources: value.sourceIds.size,
          }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
      return;
    }
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.tag, (counts.get(row.tag) ?? 0) + 1);
    }
    const arr: TagStat[] = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    setStats(arr);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return stats;
    const q = search.trim().toLowerCase();
    return stats.filter((s) => s.tag.toLowerCase().includes(q));
  }, [stats, search]);
  const filteredWhatsApp = useMemo(() => {
    if (!search.trim()) return whatsAppStats;
    const q = search.trim().toLowerCase();
    return whatsAppStats.filter((s) => s.name.toLowerCase().includes(q));
  }, [whatsAppStats, search]);

  const startRename = (tag: string) => {
    setRenaming(tag);
    setRenameValue(tag);
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameValue('');
  };

  const submitRename = async (oldTag: string) => {
    const newTag = renameValue.trim();
    if (!newTag) return;
    if (newTag === oldTag) {
      cancelRename();
      return;
    }

    const merging = stats.some((s) => s.tag === newTag);
    if (merging && !pendingMerge) {
      setPendingMerge({ oldTag, newTag });
      return;
    }

    setPendingMerge(null);
    setBusyTag(oldTag);
    setError(null);
    try {
      const { data: oldRows } = await supabase
        .from('contact_tags')
        .select('contact_id, contacts!inner(org_id)')
        .eq('tag', oldTag)
        .eq('contacts.org_id', orgId);
      const oldIds = ((oldRows ?? []) as Array<{ contact_id: string }>).map(
        (r) => r.contact_id,
      );

      const { data: newRows } = await supabase
        .from('contact_tags')
        .select('contact_id, contacts!inner(org_id)')
        .eq('tag', newTag)
        .eq('contacts.org_id', orgId);
      const newSet = new Set(
        ((newRows ?? []) as Array<{ contact_id: string }>).map(
          (r) => r.contact_id,
        ),
      );

      const idsToTransfer = oldIds.filter((id) => !newSet.has(id));

      if (oldIds.length) {
        const { error: delErr } = await supabase
          .from('contact_tags')
          .delete()
          .eq('tag', oldTag)
          .in('contact_id', oldIds);
        if (delErr) throw delErr;
      }

      if (idsToTransfer.length) {
        const { error: insErr } = await supabase
          .from('contact_tags')
          .insert(
            idsToTransfer.map((contact_id) => ({ contact_id, tag: newTag })),
          );
        if (insErr) throw insErr;
      }

      cancelRename();
      await refresh();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyTag(null);
    }
  };

  const deleteTag = async (tag: string) => {
    setConfirmingDelete(null);
    setBusyTag(tag);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from('contact_tags')
        .delete()
        .eq('tag', tag);
      if (delErr) throw delErr;
      await refresh();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyTag(null);
    }
  };

  return (
    <div className="sgc-page">
      <div className="sgc-page-header">
        <h1>标签管理</h1>
        <span className="sgc-page-count">
          WhatsApp {whatsAppStats.length} 个 · CRM {stats.length} 个
        </span>
      </div>

      <div className="sgc-page-toolbar">
        <input
          className="sgc-search-input"
          placeholder="搜索标签…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && <div className="sgc-empty">加载中…</div>}
      {error && <div className="sgc-error">{error}</div>}

      {!loading &&
        filtered.length === 0 &&
        filteredWhatsApp.length === 0 && (
          <div className="sgc-empty">
            {stats.length === 0 && whatsAppStats.length === 0
              ? '还没有任何标签'
              : '没有匹配的标签'}
          </div>
        )}
      {!loading && filteredWhatsApp.length > 0 && (
        <>
          <div className="sgc-tags-section-title">WhatsApp 标签</div>
          <div className="sgc-tags-table">
            {filteredWhatsApp.map((s) => (
              <div key={s.key} className="sgc-tags-row">
                <span
                  className="sgc-wa-label-swatch"
                  style={{
                    background:
                      WHATSAPP_LABEL_COLORS[
                        Math.abs(s.colorIndex) % WHATSAPP_LABEL_COLORS.length
                      ],
                  }}
                  aria-hidden="true"
                />
                <span className="sgc-tags-row-name">{s.name}</span>
                <span className="sgc-muted sgc-tags-row-count">
                  {s.count} 个客户
                  {s.sources > 1 ? ` · ${s.sources} 个销售来源` : ''}
                </span>
                <span className="sgc-source-badge">WhatsApp</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!loading && filtered.length > 0 && (
        <>
          <div className="sgc-tags-section-title">CRM 标签</div>
          <div className="sgc-tags-table">
            {filtered.map((s) => {
          const isRenaming = renaming === s.tag;
          const isBusy = busyTag === s.tag;
          const isConfirmingDelete = confirmingDelete === s.tag;
          const isConfirmingMerge =
            pendingMerge?.oldTag === s.tag && pendingMerge?.newTag !== s.tag;
          return (
            <div key={s.tag} className="sgc-tags-row">
              {isRenaming ? (
                <input
                  className="sgc-tags-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename(s.tag);
                    else if (e.key === 'Escape') cancelRename();
                  }}
                />
              ) : (
                <span className="sgc-tag sgc-tags-row-tag">{s.tag}</span>
              )}

              <span className="sgc-muted sgc-tags-row-count">
                {isConfirmingDelete
                  ? `从 ${s.count} 个客户移除？`
                  : isConfirmingMerge
                  ? `合并到已有 "${pendingMerge!.newTag}"，两者会去重？`
                  : `${s.count} 个客户`}
              </span>

              <div className="sgc-tags-row-actions">
                {isConfirmingDelete ? (
                  <>
                    <button
                      type="button"
                      className="sgc-btn-secondary sgc-btn-danger-bg"
                      onClick={() => void deleteTag(s.tag)}
                      disabled={isBusy}
                    >
                      {isBusy ? '删除中…' : '确认删除'}
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={() => setConfirmingDelete(null)}
                      disabled={isBusy}
                    >
                      取消
                    </button>
                  </>
                ) : isConfirmingMerge ? (
                  <>
                    <button
                      type="button"
                      className="sgc-btn-secondary"
                      onClick={() => void submitRename(s.tag)}
                      disabled={isBusy}
                    >
                      {isBusy ? '合并中…' : '确认合并'}
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={() => setPendingMerge(null)}
                      disabled={isBusy}
                    >
                      取消
                    </button>
                  </>
                ) : isRenaming ? (
                  <>
                    <button
                      type="button"
                      className="sgc-btn-secondary"
                      onClick={() => void submitRename(s.tag)}
                      disabled={isBusy || !renameValue.trim()}
                    >
                      {isBusy ? '保存中…' : '保存'}
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={cancelRename}
                      disabled={isBusy}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={() => startRename(s.tag)}
                      disabled={isBusy}
                    >
                      改名 / 合并
                    </button>
                    <button
                      type="button"
                      className="sgc-btn-link sgc-btn-danger"
                      onClick={() => setConfirmingDelete(s.tag)}
                      disabled={isBusy}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          );
            })}
          </div>
        </>
      )}
    </div>
  );
}
