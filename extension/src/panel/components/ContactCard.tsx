import { useEffect, useState } from 'react';
import type { CurrentChat } from '@/content/whatsapp-dom';
import { useContact } from '../hooks/useContact';
import { useAutoExtract } from '../hooks/useAutoExtract';
import type { SuggestedField } from '@/lib/field-suggestions';
import { ContactEditForm } from './ContactEditForm';
import { GroupMembersSection } from './GroupMembersSection';
import { TagsSection } from './TagsSection';
import { VehicleInterestsSection } from './VehicleInterestsSection';
import { QuotesSection } from './QuotesSection';
import { ContactTasksSection } from './ContactTasksSection';
import { TimelineSection } from './TimelineSection';
import { MessagesHistorySection } from './MessagesHistorySection';
import { AIReplyTab } from './AIReplyTab';

const HAS_QWEN_KEY = Boolean(import.meta.env.VITE_DASHSCOPE_API_KEY);

const FIELD_LABELS: Record<SuggestedField, string> = {
  name: '姓名',
  country: '国家',
  language: '语言',
  budget_usd: '预算',
  destination_port: '目的港',
};

type CardTab = 'profile' | 'ai';
const TAB_KEY = 'contactCardTab';

interface Props {
  chat: CurrentChat;
  orgId: string;
}

export function ContactCard({ chat, orgId }: Props) {
  const { contact, loading, error, save } = useContact(orgId, chat.phone, chat.name, chat.groupJid);
  const isGroup = !!contact?.group_jid;
  const [tab, setTab] = useState<CardTab>('profile');

  // 持久化 tab 选择
  useEffect(() => {
    void chrome.storage.local.get(TAB_KEY).then((s) => {
      const v = s[TAB_KEY];
      if (v === 'profile' || v === 'ai') setTab(v);
    });
  }, []);

  const switchTab = (next: CardTab) => {
    setTab(next);
    void chrome.storage.local.set({ [TAB_KEY]: next });
  };

  const extract = useAutoExtract({
    contact,
    save,
    // 群聊里 AI 字段提取语义会乱（多人发言、country/language/budget 不归属任何人），
    // 暂关；Phase 2 可加群专用 prompt
    enabled: HAS_QWEN_KEY && !isGroup,
  });

  if (!chat.phone && !chat.groupJid) {
    return (
      <div className="sgc-empty">
        <p>请在 WhatsApp 选择一个聊天</p>
      </div>
    );
  }

  if (loading) return <div className="sgc-empty">加载中…</div>;
  if (error) return <div className="sgc-error">{error}</div>;
  if (!contact) return <div className="sgc-empty">未找到客户</div>;

  return (
    <div className="sgc-card sgc-card-full">
      <div className="sgc-card-tabs">
        <button
          type="button"
          className={`sgc-card-tab ${tab === 'profile' ? 'sgc-card-tab-active' : ''}`}
          onClick={() => switchTab('profile')}
        >
          👤 客户
        </button>
        <button
          type="button"
          className={`sgc-card-tab ${tab === 'ai' ? 'sgc-card-tab-active' : ''}`}
          onClick={() => switchTab('ai')}
        >
          🤖 AI 回复
        </button>
      </div>

      {tab === 'profile' && (
        <>
          {extract.status === 'running' && (
            <div className="sgc-extract sgc-extract-running">🔍 正在分析对话…</div>
          )}
          {extract.status === 'done' && extract.appliedFields.length > 0 && (
            <div className="sgc-extract sgc-extract-done">
              ✨ 已自动识别：
              {extract.appliedFields.map((f) => FIELD_LABELS[f]).join('、')}
            </div>
          )}
          {extract.status === 'error' && (
            <div className="sgc-extract sgc-extract-error">
              ⚠️ 分析失败：{extract.error}
              <button className="sgc-btn-mini" onClick={extract.retry}>
                重试
              </button>
            </div>
          )}

          <section className="sgc-drawer-section">
            <div className="sgc-section-title">核心字段</div>
            <ContactEditForm contact={contact} onSave={save} compact />
          </section>

          {contact.group_jid && <GroupMembersSection groupJid={contact.group_jid} />}

          <TagsSection contactId={contact.id} contactPhone={contact.phone ?? undefined} />
          <VehicleInterestsSection contactId={contact.id} />
          <QuotesSection contactId={contact.id} />
          <ContactTasksSection
            contactId={contact.id}
            orgId={orgId}
            contactPhone={contact.phone ?? undefined}
          />
          <MessagesHistorySection
            contactId={contact.id}
            contactName={contact.name || contact.wa_name || contact.phone || '群聊'}
          />
          <TimelineSection contactId={contact.id} />
        </>
      )}

      {tab === 'ai' && <AIReplyTab orgId={orgId} contact={contact} />}
    </div>
  );
}
