import { useEffect, useState } from 'react';
import { useAuth, signOut } from './hooks/useAuth';
import { useOrg } from './hooks/useOrg';
import { LoginForm } from './components/LoginForm';
import { OrgSetup } from './components/OrgSetup';
import { TopNav, type TabKey } from './components/TopNav';
import { ChatPage } from './pages/ChatPage';
import { ContactsPage } from './pages/ContactsPage';
import { VehiclesPage } from './pages/VehiclesPage';
import { TasksPage } from './pages/TasksPage';
import { TagsPage } from './pages/TagsPage';
import { DashboardPage } from './pages/DashboardPage';
import { MediaStagingTray } from './components/MediaStagingTray';

export function AppShell() {
  const { session, user, loading: authLoading } = useAuth();
  const org = useOrg(user?.id ?? null);
  const [tab, setTab] = useState<TabKey>('chat');

  useEffect(() => {
    const showSide = !!session && !!org.orgId && tab === 'chat';
    const showOverlay = !!session && !!org.orgId && tab !== 'chat';
    document.body.classList.toggle('sgc-side-panel-visible', showSide);
    document.body.classList.toggle('sgc-page-overlay-active', showOverlay);
    return () => {
      document.body.classList.remove('sgc-side-panel-visible');
      document.body.classList.remove('sgc-page-overlay-active');
    };
  }, [session, org.orgId, tab]);

  if (authLoading || (session && org.loading)) {
    return (
      <div className="sgc-shell sgc-shell-overlay">
        <div className="sgc-empty">加载中…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="sgc-shell sgc-shell-overlay">
        <div className="sgc-overlay-card">
          <LoginForm />
        </div>
      </div>
    );
  }

  if (org.error) {
    return (
      <div className="sgc-shell sgc-shell-overlay">
        <div className="sgc-overlay-card">
          <div className="sgc-error">{org.error}</div>
        </div>
      </div>
    );
  }

  if (!org.orgId) {
    return (
      <div className="sgc-shell sgc-shell-overlay">
        <div className="sgc-overlay-card">
          <OrgSetup onCreate={org.createOrg} />
        </div>
      </div>
    );
  }

  return (
    <div className="sgc-shell">
      <TopNav
        active={tab}
        onChange={setTab}
        orgId={org.orgId}
        orgName={org.orgName}
        userEmail={user?.email ?? null}
        onSignOut={signOut}
      />

      {tab === 'chat' && <ChatPage orgId={org.orgId} />}

      {tab !== 'chat' && (
        <div className="sgc-page-overlay">
          {tab === 'dashboard' && <DashboardPage orgId={org.orgId} />}
          {tab === 'contacts' && (
            <ContactsPage
              orgId={org.orgId}
              onJumpToChat={() => setTab('chat')}
            />
          )}
          {tab === 'vehicles' && <VehiclesPage orgId={org.orgId} />}
          {tab === 'tasks' && <TasksPage orgId={org.orgId} />}
          {tab === 'tags' && <TagsPage orgId={org.orgId} />}
        </div>
      )}

      <MediaStagingTray orgId={org.orgId} />
    </div>
  );
}
