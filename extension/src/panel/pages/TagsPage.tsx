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

export function TagsPage({ orgId }: Props) {
  const [stats, setStats] = useState<TagStat[]>([]);
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
      rows = await fetchAllPaged<{ tag: string }>((from, to) =>
        supabase
          .from('contact_tags')
          .select('tag, contacts!inner(org_id)')
          .eq('contacts.org_id', orgId)
          .range(from, to),
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
          共 {stats.length} 个标签 · {stats.reduce((s, t) => s + t.count, 0)} 条引用
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

      {!loading && filtered.length === 0 && (
        <div className="sgc-empty">
          {stats.length === 0 ? '还没有任何标签' : '没有匹配的标签'}
        </div>
      )}

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
    </div>
  );
}
