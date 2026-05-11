import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, CustomerStage } from '@/lib/database.types';
import { ContactDetailDrawer } from '../components/ContactDetailDrawer';
import { GoogleSyncDialog } from '../components/GoogleSyncDialog';
import { ImportChatModal } from '../components/ImportChatModal';
import { ImportBackupModal } from '../components/ImportBackupModal';
import { LocalTimeBadge } from '../components/LocalTimeBadge';
import { jumpToChat } from '@/lib/jump-to-chat';
import { useScope } from '../contexts/ScopeContext';
import { shortNameOf } from '../hooks/useOrgMembers';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

const STAGE_LABEL: Record<CustomerStage, string> = {
  new: '新客户',
  qualifying: '资质确认',
  negotiating: '跟进中',
  stalled: '待跟进',
  quoted: '已报价',
  won: '成交',
  lost: '流失',
};

interface Props {
  orgId: string;
  onJumpToChat?: () => void;
}

export function ContactsPage({ orgId, onJumpToChat }: Props) {
  const { scope, myContactIds, handlersByContact, membersById, myUserId } =
    useScope();
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<CustomerStage | ''>('');
  const [kindFilter, setKindFilter] = useState<'all' | 'individual' | 'group'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBackupOpen, setImportBackupOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    // 突破 Supabase 1000 行默认上限：分页拉
    try {
      const PAGE = 1000;
      const all: ContactRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .eq('org_id', orgId)
          .order('updated_at', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) {
          setError(error.message);
          setLoading(false);
          return;
        }
        const rows = (data ?? []) as ContactRow[];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      setContacts(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const filtered = contacts.filter((c) => {
    if (stageFilter && c.customer_stage !== stageFilter) return false;
    if (kindFilter === 'individual' && c.group_jid) return false;
    if (kindFilter === 'group' && !c.group_jid) return false;
    // 视图过滤：搜索时永远查全部（方便查同事客户），否则按 scope 限制
    if (!search && scope === 'mine' && !myContactIds.has(c.id)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        c.name?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        c.country?.toLowerCase().includes(q) ||
        c.wa_name?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="sgc-page">
      <div className="sgc-page-header">
        <h1>客户管理</h1>
        <div className="sgc-page-actions">
          <span className="sgc-page-count">共 {filtered.length} 条</span>
          <button
            className="sgc-btn-secondary"
            onClick={() => setImportOpen(true)}
            type="button"
            title="把手机端导出的 WhatsApp 聊天 .txt 导入到 CRM"
          >
            📥 导入手机聊天
          </button>
          <button
            className="sgc-btn-secondary"
            onClick={() => setImportBackupOpen(true)}
            type="button"
            title="一次性把整个 WhatsApp Business 加密备份（msgstore.db.crypt15）导进来"
          >
            🔓 导入加密备份
          </button>
          <button
            className="sgc-btn-secondary"
            onClick={() => setSyncOpen(true)}
            type="button"
          >
            ↻ Google 同步
          </button>
        </div>
      </div>

      <div className="sgc-page-toolbar">
        <input
          className="sgc-toolbar-input"
          placeholder="搜索姓名 / 手机号 / 国家"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as CustomerStage | '')}
        >
          <option value="">全部阶段</option>
          {(Object.keys(STAGE_LABEL) as CustomerStage[]).map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as 'all' | 'individual' | 'group')}
          title="按客户类型筛选"
        >
          <option value="all">全部类型</option>
          <option value="individual">👤 个人</option>
          <option value="group">👥 群聊</option>
        </select>
      </div>

      {error && <div className="sgc-error">{error}</div>}

      {loading ? (
        <div className="sgc-empty">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="sgc-empty">
          {contacts.length === 0
            ? '还没有客户数据。打开 WhatsApp 聊天，会自动创建客户。'
            : '没有匹配的客户'}
        </div>
      ) : (
        <table className="sgc-table sgc-table-clickable">
          <thead>
            <tr>
              <th>姓名</th>
              <th>手机号</th>
              <th>国家</th>
              <th>预算</th>
              <th>阶段</th>
              <th>更新时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const handleJump = (e: React.MouseEvent) => {
                e.stopPropagation();
                // 群聊用群名搜，个人用手机号
                const query = c.phone ? c.phone.replace(/^\+/, '') : (c.name ?? c.wa_name ?? '');
                if (!query) return;
                void jumpToChat(query, { allowDeepLink: true });
                onJumpToChat?.();
              };
              return (
                <tr
                  key={c.id}
                  onClick={() => {
                    setOpenId(c.id);
                    const query = c.phone ? c.phone.replace(/^\+/, '') : (c.name ?? c.wa_name ?? '');
                    if (query) void jumpToChat(query, { allowDeepLink: true });
                  }}
                >
                  <td>
                    {c.group_jid && <span title="群聊">👥 </span>}
                    {c.name || c.wa_name || '—'}
                    {(() => {
                      const others = (handlersByContact.get(c.id) ?? []).filter(
                        (u) => u !== myUserId,
                      );
                      if (others.length === 0) return null;
                      const names = others
                        .map((u) => shortNameOf(membersById.get(u)))
                        .join('、');
                      return (
                        <span
                          className="sgc-collision-tag"
                          title={`同事 ${names} 也在跟这个客户`}
                        >
                          撞单：{names}
                        </span>
                      );
                    })()}
                  </td>
                  <td>{c.phone ?? (c.group_jid ? '群聊' : '—')}</td>
                  <td>
                    {c.country || '—'}
                    {c.phone && (
                      <LocalTimeBadge
                        phone={c.phone}
                        compact
                        className="sgc-local-time-inline"
                      />
                    )}
                  </td>
                  <td>
                    {c.budget_usd ? `USD ${c.budget_usd.toLocaleString()}` : '—'}
                  </td>
                  <td>
                    <span className={`sgc-stage sgc-stage-${c.customer_stage}`}>
                      {STAGE_LABEL[c.customer_stage]}
                    </span>
                  </td>
                  <td>{new Date(c.updated_at).toLocaleDateString()}</td>
                  <td>
                    <button
                      type="button"
                      className="sgc-btn-link"
                      onClick={handleJump}
                      title="跳转到 WhatsApp 聊天"
                    >
                      💬 聊天
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {openId && (
        <ContactDetailDrawer
          contactId={openId}
          orgId={orgId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            void refresh();
          }}
        />
      )}

      {syncOpen && (
        <GoogleSyncDialog
          orgId={orgId}
          onClose={() => setSyncOpen(false)}
          onDone={() => {
            void refresh();
          }}
        />
      )}

      {importOpen && (
        <ImportChatModal
          orgId={orgId}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            void refresh();
          }}
        />
      )}

      {importBackupOpen && (
        <ImportBackupModal
          orgId={orgId}
          onClose={() => setImportBackupOpen(false)}
          onDone={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}
