import { useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentChat } from '../hooks/useCurrentChat';
import { useCrmData, type CrmContact } from '../hooks/useCrmData';
import { ContactCard } from '../components/ContactCard';
import { FilterSidebar } from '../components/FilterSidebar';
import { FilteredChatList } from '../components/FilteredChatList';
import { useCollisionTag, useScope } from '../contexts/ScopeContext';
import { batchBumpHandlers } from '@/lib/contact-handlers';

interface Props {
  orgId: string;
}

const SIDEBAR_COLLAPSED_KEY = 'sgc:filter-sidebar-collapsed';

export function ChatPage({ orgId }: Props) {
  const chat = useCurrentChat();
  const crm = useCrmData(orgId);
  const { scope, myContactIds, myUserId, refresh: refreshScope } = useScope();
  const [filtered, setFiltered] = useState<CrmContact[] | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const autoAttributedRef = useRef(false);

  // 自动归属：扩展加载时，把当前用户 WA 聊天里的所有联系人一次性登记到我名下
  // 这样老客户（created_by=null 没被 migration 回填的）也能被识别为"我的"
  // 只跑一次（每次 reload extension 一次），避免 20s 轮询时反复 upsert
  useEffect(() => {
    if (autoAttributedRef.current) return;
    if (!myUserId || crm.loading || crm.contacts.length === 0) return;
    const toBump = crm.contacts
      .filter((c) => c.contact && !myContactIds.has(c.contact.id))
      .map((c) => c.contact!.id);
    if (toBump.length === 0) {
      autoAttributedRef.current = true;
      return;
    }
    autoAttributedRef.current = true;
    void batchBumpHandlers(toBump, myUserId).then((n) => {
      if (n > 0) {
        console.log(`[scope] 自动归属 ${n} 个客户到当前用户`);
        refreshScope();
      }
    });
  }, [myUserId, crm.loading, crm.contacts, myContactIds, refreshScope]);

  // 视图过滤：scope=mine 时只保留 myContactIds 里的客户
  // 当前打开的客户始终显示（即使不是我的，方便接同事单时对照）
  const scopedContacts = useMemo(() => {
    if (scope === 'all') return crm.contacts;
    return crm.contacts.filter((c) => {
      if (!c.contact) return false; // 没建 contact 的 WA 聊天，scope=mine 时隐藏
      return (
        myContactIds.has(c.contact.id) || c.phone === chat.phone
      );
    });
  }, [crm.contacts, scope, myContactIds, chat.phone]);

  useEffect(() => {
    void chrome.storage.local.get(SIDEBAR_COLLAPSED_KEY).then((r) => {
      if (r[SIDEBAR_COLLAPSED_KEY] === true) setSidebarCollapsed(true);
    });
  }, []);

  const toggleSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    void chrome.storage.local.set({ [SIDEBAR_COLLAPSED_KEY]: collapsed });
  };

  useEffect(() => {
    if (sidebarCollapsed) {
      document.body.classList.remove('sgc-filter-sidebar-visible');
    } else {
      document.body.classList.add('sgc-filter-sidebar-visible');
    }
    return () => {
      document.body.classList.remove('sgc-filter-sidebar-visible');
    };
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.body.classList.toggle(
      'sgc-filter-results-visible',
      filtered !== null,
    );
    return () => {
      document.body.classList.remove('sgc-filter-results-visible');
    };
  }, [filtered]);

  // 不自动关闭筛选 — 用户点 × 才关

  // 当前聊天对应的 CRM 客户（用于头部显示姓名）
  const currentCrmContact = chat.phone
    ? crm.contacts.find((c) => c.phone === chat.phone)
    : undefined;
  const headerName =
    currentCrmContact?.contact?.name ||
    currentCrmContact?.contact?.wa_name ||
    chat.name ||
    chat.phone ||
    '当前客户';
  const collisionNames = useCollisionTag(currentCrmContact?.contact?.id);

  return (
    <>
      {!sidebarCollapsed && (
        <FilterSidebar
          contacts={scopedContacts}
          loading={crm.loading}
          orgId={orgId}
          onFilterChange={setFiltered}
          onRefresh={crm.refresh}
          onCollapse={() => toggleSidebar(true)}
          clearSignal={clearSignal}
        />
      )}
      {sidebarCollapsed && (
        <button
          className="sgc-filter-sidebar-expander"
          onClick={() => toggleSidebar(false)}
          title="展开筛选栏"
          aria-label="展开筛选栏"
        >
          <span className="sgc-filter-expander-icon">🔍</span>
          <span className="sgc-filter-expander-arrow">▶</span>
        </button>
      )}

      {!sidebarCollapsed && filtered !== null && (
        <FilteredChatList
          contacts={filtered}
          activePhone={chat.phone}
          onClose={() => setClearSignal((n) => n + 1)}
          onAction={crm.refresh}
        />
      )}

      <aside className="sgc-side-panel">
        <div className="sgc-side-panel-header">
          <strong className="sgc-side-panel-name">{headerName}</strong>
          {collisionNames && (
            <span
              className="sgc-collision-tag"
              title={`同事 ${collisionNames} 也在跟这个客户`}
            >
              撞单：{collisionNames}
            </span>
          )}
          {chat.phone && headerName !== chat.phone && (
            <span className="sgc-side-panel-phone">{chat.phone}</span>
          )}
        </div>
        <div className="sgc-side-panel-body">
          <ContactCard chat={chat} orgId={orgId} />
        </div>
      </aside>
    </>
  );
}
