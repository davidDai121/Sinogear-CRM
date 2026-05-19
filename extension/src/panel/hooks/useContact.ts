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
    // 必须至少有 phone（个人）/ groupJid（群聊）/ waName（fallback）之一
    if (!orgId || (!phone && !groupJid && !waName)) {
      setState({ contact: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      try {
        // 优先级 1: groupJid（群聊）
        // 优先级 2: phone（标准路径）
        // 优先级 3: waName（fallback — WA Web 新版有时 IDB 没缓存 phone 但 header 有名字）
        let existingData: ContactRow | null = null;

        if (groupJid) {
          const res = await supabase
            .from('contacts')
            .select('*')
            .eq('org_id', orgId)
            .eq('group_jid', groupJid)
            .maybeSingle();
          if (res.error) throw res.error;
          existingData = res.data ?? null;
        } else if (phone) {
          const res = await supabase
            .from('contacts')
            .select('*')
            .eq('org_id', orgId)
            .eq('phone', phone)
            .maybeSingle();
          if (res.error) throw res.error;
          existingData = res.data ?? null;
        } else if (waName) {
          // WA IDB 缓存里没有这个聊天的 phone 映射，按显示名查 Supabase。
          // 重名场景下取 ≥2 行就放弃（避免错配到同名的别人）。
          const res = await supabase
            .from('contacts')
            .select('*')
            .eq('org_id', orgId)
            .eq('wa_name', waName)
            .limit(2);
          if (res.error) throw res.error;
          if (res.data && res.data.length === 1) {
            existingData = res.data[0];
          }
        }

        if (existingData) {
          if (!cancelled) {
            setState({ contact: existingData, loading: false, error: null });
          }
          return;
        }

        // 没找到 → 只在有 phone 或 groupJid 时新建（DB constraint 不允许两者都 null）
        if (!phone && !groupJid) {
          if (!cancelled) {
            setState({ contact: null, loading: false, error: null });
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
            const refetchQuery = supabase
              .from('contacts')
              .select('*')
              .eq('org_id', orgId);
            const refetched = await (groupJid
              ? refetchQuery.eq('group_jid', groupJid)
              : refetchQuery.eq('phone', phone!)
            ).single();
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
