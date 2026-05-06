import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, CustomerStage } from '@/lib/database.types';
import { ContactDetailDrawer } from '../components/ContactDetailDrawer';
import { GoogleSyncDialog } from '../components/GoogleSyncDialog';
import { jumpToChat } from '@/lib/jump-to-chat';

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
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<CustomerStage | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false });
    if (error) setError(error.message);
    else setContacts(data ?? []);
    setLoading(false);
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
    if (search) {
      const q = search.toLowerCase();
      return (
        c.name?.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
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
                const digits = c.phone.replace(/^\+/, '');
                void jumpToChat(digits);
                onJumpToChat?.();
              };
              return (
                <tr
                  key={c.id}
                  onClick={() => {
                    setOpenId(c.id);
                    const digits = c.phone.replace(/^\+/, '');
                    void jumpToChat(digits);
                  }}
                >
                  <td>{c.name || c.wa_name || '—'}</td>
                  <td>{c.phone}</td>
                  <td>{c.country || '—'}</td>
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
    </div>
  );
}
