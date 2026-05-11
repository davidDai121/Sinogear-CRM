import { useEffect, useState } from 'react';
import { manualRetranslate } from '@/content/auto-translate';
import { GemTemplatesModal } from './GemTemplatesModal';
import { TeamMembersModal } from './TeamMembersModal';
import { ScopePicker } from './ScopePicker';
import { DomHealthBadge } from './DomHealthBadge';
import { useScope } from '../contexts/ScopeContext';
import { supabase } from '@/lib/supabase';

export type TabKey =
  | 'dashboard'
  | 'chat'
  | 'contacts'
  | 'vehicles'
  | 'tasks'
  | 'tags';

interface Props {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  orgId: string;
  orgName: string | null;
  userEmail: string | null;
  onSignOut: () => void;
}

function useAutoTranslateToggle() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('autoTranslate').then((s) => {
      setOn(Boolean(s.autoTranslate));
    });
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && changes.autoTranslate) {
        setOn(Boolean(changes.autoTranslate.newValue));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    void chrome.storage.local.set({ autoTranslate: next });
  };

  return { on, toggle };
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dashboard', label: '看板' },
  { key: 'chat', label: '聊天' },
  { key: 'contacts', label: '客户' },
  { key: 'vehicles', label: '车源' },
  { key: 'tasks', label: '任务' },
  { key: 'tags', label: '标签' },
];

export function TopNav({
  active,
  onChange,
  orgId,
  orgName,
  userEmail,
  onSignOut,
}: Props) {
  const translate = useAutoTranslateToggle();
  const scope = useScope();
  const [showGemTemplates, setShowGemTemplates] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [allCount, setAllCount] = useState<number | undefined>();

  // 拉一次 org 总客户数（30s 一次跟着 ScopeContext 节奏）
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const { count } = await supabase
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId);
      if (!cancelled) setAllCount(count ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, scope.handlersByContact]);

  return (
    <div className="sgc-topnav">
      <div className="sgc-topnav-brand">
        <span className="sgc-topnav-logo">SG</span>
        <span className="sgc-topnav-title">
          Sino Gear CRM
          {orgName && <span className="sgc-topnav-org"> · {orgName}</span>}
        </span>
        <ScopePicker
          mineCount={scope.myContactIds.size}
          allCount={allCount}
        />
      </div>

      <nav className="sgc-topnav-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`sgc-tab ${active === tab.key ? 'sgc-tab-active' : ''}`}
            onClick={() => onChange(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="sgc-topnav-user">
        <button
          type="button"
          className={`sgc-topnav-toggle ${translate.on ? 'active' : ''}`}
          onClick={translate.toggle}
          title={translate.on ? '自动翻译已开启 — 点击关闭' : '开启 AI 自动翻译'}
        >
          🌐 {translate.on ? '翻译·开' : '翻译'}
        </button>
        <button
          type="button"
          className="sgc-topnav-toggle"
          onClick={() => {
            const n = manualRetranslate();
            if (n === 0) {
              alert('当前没有打开聊天 / 没有可翻译消息');
            }
          }}
          title="手动重译当前聊天的所有可见消息（不论开关状态）"
        >
          🔁 重译
        </button>
        <button
          type="button"
          className="sgc-topnav-toggle"
          onClick={() => setShowGemTemplates(true)}
          title="管理 Gemini Gem 模板（用于 AI 回复建议）"
        >
          🤖 Gem
        </button>
        <button
          type="button"
          className="sgc-topnav-toggle"
          onClick={() => setShowTeam(true)}
          title="管理团队成员（邀请同事 / 改角色 / 移除）"
        >
          👥 团队
        </button>
        <DomHealthBadge />
        {userEmail && <span className="sgc-topnav-email">{userEmail}</span>}
        <button className="sgc-btn-link" onClick={onSignOut} type="button">
          登出
        </button>
      </div>

      {showGemTemplates && (
        <GemTemplatesModal
          orgId={orgId}
          onClose={() => setShowGemTemplates(false)}
        />
      )}

      {showTeam && (
        <TeamMembersModal
          orgId={orgId}
          onClose={() => setShowTeam(false)}
        />
      )}
    </div>
  );
}
