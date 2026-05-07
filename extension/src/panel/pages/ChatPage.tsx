import { useEffect, useState } from 'react';
import { useCurrentChat } from '../hooks/useCurrentChat';
import { useCrmData, type CrmContact } from '../hooks/useCrmData';
import { ContactCard } from '../components/ContactCard';
import { FilterSidebar } from '../components/FilterSidebar';
import { FilteredChatList } from '../components/FilteredChatList';

interface Props {
  orgId: string;
}

const SIDEBAR_COLLAPSED_KEY = 'sgc:filter-sidebar-collapsed';

export function ChatPage({ orgId }: Props) {
  const chat = useCurrentChat();
  const crm = useCrmData(orgId);
  const [filtered, setFiltered] = useState<CrmContact[] | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);

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

  return (
    <>
      {!sidebarCollapsed && (
        <FilterSidebar
          contacts={crm.contacts}
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
