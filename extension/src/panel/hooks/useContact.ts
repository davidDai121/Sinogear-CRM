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
): ContactState & { save: (patch: Partial<ContactRow>) => Promise<void> } {
  const [state, setState] = useState<ContactState>({
    contact: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!orgId || !phone) {
      setState({ contact: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      try {
        const existing = await supabase
          .from('contacts')
          .select('*')
          .eq('org_id', orgId)
          .eq('phone', phone)
          .maybeSingle();

        if (existing.error) throw existing.error;

        if (existing.data) {
          if (!cancelled) {
            setState({ contact: existing.data, loading: false, error: null });
          }
          return;
        }

        const inserted = await supabase
          .from('contacts')
          .insert({
            org_id: orgId,
            phone,
            wa_name: waName,
            name: waName,
          })
          .select('*')
          .single();

        if (inserted.error) throw inserted.error;

        if (inserted.data) {
          void logContactEvent(inserted.data.id, 'created', {
            phone: inserted.data.phone,
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
  }, [orgId, phone, waName]);

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
