import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database, CustomerStage } from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';
import { logContactEvent } from '@/lib/events-log';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

export interface ContactState {
  contact: ContactRow | null;
  loading: boolean;
  error: string | null;
}

export function useContact(
  orgId: string | null,
  phone: string | null,
  waName: string | null,
  groupJid: string | null = null,
): ContactState & { save: (patch: Partial<ContactRow>) => Promise<void> } {
  const [state, setState] = useState<ContactState>({
    contact: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    // 必须至少有 phone（个人）或 groupJid（群聊）之一
    if (!orgId || (!phone && !groupJid)) {
      setState({ contact: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    const lookupCol: 'phone' | 'group_jid' = groupJid ? 'group_jid' : 'phone';
    const lookupVal = groupJid ?? phone!;

    (async () => {
      try {
        const existing = await supabase
          .from('contacts')
          .select('*')
          .eq('org_id', orgId)
          .eq(lookupCol, lookupVal)
          .maybeSingle();

        if (existing.error) throw existing.error;

        if (existing.data) {
          if (!cancelled) {
            setState({ contact: existing.data, loading: false, error: null });
          }
          return;
        }

        const insertRow: Database['public']['Tables']['contacts']['Insert'] = {
          org_id: orgId,
          wa_name: waName,
          name: waName,
        };
        if (groupJid) insertRow.group_jid = groupJid;
        else insertRow.phone = phone;

        const inserted = await supabase
          .from('contacts')
          .insert(insertRow)
          .select('*')
          .single();

        if (inserted.error) {
          // 23505 = race with another path (bulk-sync, label-sync's auto, etc.)
          // creating the same (org_id, phone) or (org_id, group_jid). Re-fetch.
          const code = (inserted.error as { code?: string }).code;
          if (code === '23505') {
            const refetched = await supabase
              .from('contacts')
              .select('*')
              .eq('org_id', orgId)
              .eq(lookupCol, lookupVal)
              .single();
            if (refetched.error) throw refetched.error;
            if (!cancelled) {
              setState({
                contact: refetched.data,
                loading: false,
                error: null,
              });
            }
            return;
          }
          throw inserted.error;
        }

        if (inserted.data) {
          void logContactEvent(inserted.data.id, 'created', {
            phone: inserted.data.phone,
            group_jid: inserted.data.group_jid,
            wa_name: inserted.data.wa_name,
          });
        }

        if (!cancelled) {
          setState({ contact: inserted.data, loading: false, error: null });
        }
      } catch (err) {
        if (cancelled) return;
        setState({ contact: null, loading: false, error: stringifyError(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId, phone, waName, groupJid]);

  const save = async (patch: Partial<ContactRow>) => {
    if (!state.contact) return;
    const allowed: Database['public']['Tables']['contacts']['Update'] = {
      name: patch.name ?? undefined,
      country: patch.country ?? undefined,
      language: patch.language ?? undefined,
      budget_usd: patch.budget_usd ?? undefined,
      customer_stage: (patch.customer_stage as CustomerStage) ?? undefined,
      quality: patch.quality ?? undefined,
      destination_port: patch.destination_port ?? undefined,
      notes: patch.notes ?? undefined,
      reminder_ack_at: patch.reminder_ack_at ?? undefined,
      reminder_disabled: patch.reminder_disabled ?? undefined,
    };
    const before = state.contact;
    const { data, error } = await supabase
      .from('contacts')
      .update(allowed)
      .eq('id', state.contact.id)
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
    setState({ contact: data, loading: false, error: null });
  };

  return { ...state, save };
}
