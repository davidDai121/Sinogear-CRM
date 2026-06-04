import { useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentChat } from '../hooks/useCurrentChat';
import { useCrmData, type CrmContact } from '../hooks/useCrmData';
import { ContactCard } from '../components/ContactCard';
import { FilterSidebar } from '../components/FilterSidebar';
import { FilteredChatList } from '../components/FilteredChatList';
import { LocalTimeBadge } from '../components/LocalTimeBadge';
import { useCollisionTag, useScope } from '../contexts/ScopeContext';

interface Props {
  orgId: string;
}

const SIDEBAR_COLLAPSED_KEY = 'sgc:filter-sidebar-collapsed';
const SIDE_PANEL_COLLAPSED_KEY = 'sgc:side-panel-collapsed';

export function ChatPage({ orgId }: Props) {
  const chat = useCurrentChat();
  const crm = useCrmData(orgId);
  const { scope, myContactIds } = useScope();
  const [filtered, setFiltered] = useState<CrmContact[] | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const [selectAllSignal, setSelectAllSignal] = useState(0);
  // 记住"上次为哪个 chat 自动 fallback 过"，避免对同 chat 反复触发
  const lastFallbackKeyRef = useRef<string | null>(null);

  // ⚠️ 已移除（2026-06 撞单大爆雷）：原代码会把"WA Web 里能看到 + 我不是
  // handler"的所有客户全部 bumpHandler 自己——但只校验"我不是 handler"，没
  // 校验"别人是不是已经在 handle"。每位销售扩展加载都跑一遍 → 共同客户
  // （早期共享号 / 偶发重叠）必撞单。
  //
  // 老客户 created_by=null 的回填工作改由 ScopeContext 的 orphan-claim
  // 负责（那里正确校验"无人 handle 才认领"）。打开聊天时 useMessageSync
  // 的 bumpHandler 会处理真实交互场景。

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
    void chrome.storage.local
      .get([SIDEBAR_COLLAPSED_KEY, SIDE_PANEL_COLLAPSED_KEY])
      .then((r) => {
        if (r[SIDEBAR_COLLAPSED_KEY] === true) setSidebarCollapsed(true);
        if (r[SIDE_PANEL_COLLAPSED_KEY] === true) setSidePanelCollapsed(true);
      });
  }, []);

  const toggleSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    void chrome.storage.local.set({ [SIDEBAR_COLLAPSED_KEY]: collapsed });
  };

  const toggleSidePanel = (collapsed: boolean) => {
    setSidePanelCollapsed(collapsed);
    void chrome.storage.local.set({ [SIDE_PANEL_COLLAPSED_KEY]: collapsed });
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
    // 只有 sidebar 没折叠 + 有筛选结果时才占用宽度
    // sidebar 折叠了 FilteredChatList 本身也会被 unmount，body class 也得跟着去掉
    document.body.classList.toggle(
      'sgc-filter-results-visible',
      filtered !== null && !sidebarCollapsed,
    );
    return () => {
      document.body.classList.remove('sgc-filter-results-visible');
    };
  }, [filtered, sidebarCollapsed]);

  // 右侧客户卡折叠：折叠时移除 sgc-side-panel-visible 让 WA 占满右边
  // ChatPage 独占管理这个 class（AppShell 不再插手），unmount 时清理
  useEffect(() => {
    if (sidePanelCollapsed) {
      document.body.classList.remove('sgc-side-panel-visible');
    } else {
      document.body.classList.add('sgc-side-panel-visible');
    }
    return () => {
      document.body.classList.remove('sgc-side-panel-visible');
    };
  }, [sidePanelCollapsed]);

  // 不自动关闭筛选 — 用户点 × 才关

  // 自动 fallback：当 WA 切到一个不在当前筛选结果里的客户时，
  // 自动清空筛选 + 选中"📋 所有客户"，确保左边列表能看到这个人。
  // 用 ref 锁定：每个 chat 只触发一次 fallback，避免无限循环 + 不覆盖用户后续手动选择。
  useEffect(() => {
    if (filtered === null) return; // 当前没有筛选，啥都不用做
    const key = chat.phone ?? chat.groupJid ?? null;
    if (!key) return;
    if (lastFallbackKeyRef.current === key) return;
    const inFiltered = filtered.some(
      (c) =>
        (chat.phone != null && c.phone === chat.phone) ||
        (chat.groupJid != null && c.contact?.group_jid === chat.groupJid),
    );
    if (!inFiltered) {
      lastFallbackKeyRef.current = key;
      setSelectAllSignal((n) => n + 1);
    }
  }, [chat.phone, chat.groupJid, filtered]);

  // 当前聊天对应的 CRM 客户（用于头部显示姓名）
  const currentCrmContact = chat.phone
    ? crm.contacts.find((c) => c.phone === chat.phone)
    : undefined;

  // ⚙️ 诊断：每次聊天切换 / 数据刷新自动打印一行
  // （Chrome 扩展 content script 跟页面是隔离 world，window.__sgcDiag 设了你 console 也访问不到，
  //  所以走 console.log 路径——content script 的 console.log 会出现在页面 DevTools 里）
  useEffect(() => {
    if (!chat.phone && !chat.groupJid) return;
    const inCrm = chat.phone
      ? crm.contacts.find((c) => c.phone === chat.phone)
      : crm.contacts.find((c) => c.contact?.group_jid === chat.groupJid);
    const inScoped = scopedContacts.find(
      (c) =>
        (chat.phone && c.phone === chat.phone) ||
        (chat.groupJid && c.contact?.group_jid === chat.groupJid),
    );
    console.log('[sgc/diag]', {
      phone: chat.phone,
      groupJid: chat.groupJid,
      name: chat.name,
      scope,
      myContactIdsCount: myContactIds.size,
      crmContactsCount: crm.contacts.length,
      scopedContactsCount: scopedContacts.length,
      inCrmContacts: !!inCrm,
      inScopedContacts: !!inScoped,
      contactId: inCrm?.contact?.id ?? null,
    });
  }, [chat.phone, chat.groupJid, chat.name, crm.contacts, scopedContacts, scope, myContactIds]);
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
          selectAllSignal={selectAllSignal}
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
          onSetPinned={crm.setPinned}
        />
      )}

      {!sidePanelCollapsed && (
        <aside className="sgc-side-panel">
          <div className="sgc-side-panel-header">
            <button
              type="button"
              className="sgc-side-panel-collapse"
              onClick={() => toggleSidePanel(true)}
              title="收起右侧客户卡"
              aria-label="收起右侧客户卡"
            >
              ›
            </button>
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
            {chat.phone && <LocalTimeBadge phone={chat.phone} />}
          </div>
          <div className="sgc-side-panel-body">
            <ContactCard chat={chat} orgId={orgId} />
          </div>
        </aside>
      )}

      {sidePanelCollapsed && (
        <button
          type="button"
          className="sgc-side-panel-expander"
          onClick={() => toggleSidePanel(false)}
          title="展开右侧客户卡"
          aria-label="展开右侧客户卡"
        >
          <span className="sgc-side-panel-expander-icon">👤</span>
          <span className="sgc-side-panel-expander-arrow">‹</span>
        </button>
      )}
    </>
  );
}
