import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import { logContactEvent } from '@/lib/events-log';
import { ContactEditForm } from './ContactEditForm';
import { TagsSection } from './TagsSection';
import { VehicleInterestsSection } from './VehicleInterestsSection';
import { QuotesSection } from './QuotesSection';
import { ContactTasksSection } from './ContactTasksSection';
import { TimelineSection } from './TimelineSection';
import { MessagesHistorySection } from './MessagesHistorySection';
import { AIReplyTab } from './AIReplyTab';
import { LocalTimeBadge } from './LocalTimeBadge';

type CardTab = 'profile' | 'ai';
const TAB_KEY = 'contactCardTab';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

interface Props {
  contactId: string;
  orgId: string;
  onClose: () => void;
  onChanged: () => void;
}

export function ContactDetailDrawer({ contactId, orgId, onClose, onChanged }: Props) {
  const [contact, setContact] = useState<ContactRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CardTab>('profile');

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('id', contactId)
        .single();
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      setContact(data);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const handleSave = async (patch: Partial<ContactRow>) => {
    if (!contact) return;
    const before = contact;
    const { data, error } = await supabase
      .from('contacts')
      .update({
        name: patch.name ?? null,
        country: patch.country ?? null,
        language: patch.language ?? null,
        budget_usd: patch.budget_usd ?? null,
        customer_stage: patch.customer_stage,
        quality: patch.quality,
        destination_port: patch.destination_port ?? null,
        notes: patch.notes ?? null,
      })
      .eq('id', contact.id)
      .select('*')
      .single();
    if (error) throw error;
    if (data && before.customer_stage !== data.customer_stage) {
      void logContactEvent(data.id, 'stage_changed', {
        from: before.customer_stage,
        to: data.customer_stage,
        automatic: false,
      });
    }
    setContact(data);
    onChanged();
  };

  return (
    <>
      <div className="sgc-drawer-backdrop" onClick={onClose} />
      <aside className="sgc-drawer" role="dialog" aria-label="客户详情">
        <header className="sgc-drawer-header">
          <div className="sgc-drawer-title">
            <strong>{contact?.name || contact?.wa_name || '客户'}</strong>
            <span className="sgc-drawer-subtitle">{contact?.phone}</span>
            {contact?.phone && <LocalTimeBadge phone={contact.phone} />}
          </div>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="sgc-drawer-body">
          {loading ? (
            <div className="sgc-empty">加载中…</div>
          ) : error && !contact ? (
            <div className="sgc-error">{error}</div>
          ) : contact ? (
            <>
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
                  <section className="sgc-drawer-section">
                    <div className="sgc-section-title">核心字段</div>
                    <ContactEditForm
                      contact={contact}
                      onSave={handleSave}
                      showPhone
                    />
                  </section>

                  <TagsSection contactId={contact.id} contactPhone={contact.phone} />
                  <VehicleInterestsSection contactId={contact.id} />
                  <QuotesSection contactId={contact.id} />
                  <ContactTasksSection
                    contactId={contact.id}
                    orgId={orgId}
                    contactPhone={contact.phone}
                  />
                  <MessagesHistorySection
                    contactId={contact.id}
                    contactName={contact.name || contact.wa_name || contact.phone}
                    needsJump
                  />
                  <TimelineSection contactId={contact.id} />
                </>
              )}

              {tab === 'ai' && (
                <AIReplyTab orgId={orgId} contact={contact} needsJump />
              )}
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
