import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import {
  readWhatsAppData,
  resolvePhone,
  type WAChat,
  type WALabel,
  type WALabelAssociation,
} from '@/lib/whatsapp-idb';
import { classifyChat, type ChatClassification } from '@/lib/chat-classifier';
import { countryToRegion } from '@/lib/regions';
import { stringifyError } from '@/lib/errors';
import { syncAutoStages } from '@/lib/stage-sync';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];
type ContactTagRow = Database['public']['Tables']['contact_tags']['Row'];

export interface CrmContact {
  contact: ContactRow | null;
  chat: WAChat | null;
  jid: string | null;
  phone: string;
  displayName: string;
  labels: WALabel[];
  vehicleInterests: VehicleInterestRow[];
  tags: string[];
  region: string;
  classification: ChatClassification | null;
}

export interface CrmData {
  contacts: CrmContact[];
  labels: WALabel[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function buildLabelAssocMap(
  associations: WALabelAssociation[],
  labels: WALabel[],
): Map<string, WALabel[]> {
  const byId = new Map(labels.map((l) => [l.id, l]));
  const byJid = new Map<string, WALabel[]>();
  for (const a of associations) {
    if (a.type !== 'jid') continue;
    const label = byId.get(a.labelId);
    if (!label || !label.isActive) continue;
    const arr = byJid.get(a.associationId) ?? [];
    arr.push(label);
    byJid.set(a.associationId, arr);
  }
  return byJid;
}

const POLL_INTERVAL_MS = 20000;

export function useCrmData(orgId: string | null): CrmData {
  const [state, setState] = useState<Omit<CrmData, 'refresh'>>({
    contacts: [],
    labels: [],
    loading: false,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!orgId) return;
    const timer = setInterval(() => setNonce((n) => n + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    if (nonce === 0) {
      setState((s) => ({ ...s, loading: true, error: null }));
    }

    void (async () => {
      try {
        const [
          { data: contactRows, error: contactErr },
          { data: vehicleRows, error: vehicleErr },
          { data: tagRows, error: tagErr },
          wa,
        ] = await Promise.all([
          supabase.from('contacts').select('*').eq('org_id', orgId),
          supabase
            .from('vehicle_interests')
            .select('*, contacts!inner(org_id)')
            .eq('contacts.org_id', orgId),
          supabase
            .from('contact_tags')
            .select('*, contacts!inner(org_id)')
            .eq('contacts.org_id', orgId),
          readWhatsAppData().catch(() => ({
            labels: [] as WALabel[],
            associations: [] as WALabelAssociation[],
            chats: [] as WAChat[],
            contacts: [],
            jidToPhoneJid: new Map<string, string>(),
          })),
        ]);

        if (contactErr) throw contactErr;
        if (vehicleErr) throw vehicleErr;
        if (tagErr) throw tagErr;

        const contacts = (contactRows ?? []) as ContactRow[];
        const vehicles = (vehicleRows ?? []) as VehicleInterestRow[];
        const tags = (tagRows ?? []) as ContactTagRow[];

        const vehicleByContact = new Map<string, VehicleInterestRow[]>();
        for (const v of vehicles) {
          const arr = vehicleByContact.get(v.contact_id) ?? [];
          arr.push(v);
          vehicleByContact.set(v.contact_id, arr);
        }

        const tagsByContact = new Map<string, string[]>();
        for (const t of tags) {
          const arr = tagsByContact.get(t.contact_id) ?? [];
          arr.push(t.tag);
          tagsByContact.set(t.contact_id, arr);
        }

        const chatByPhone = new Map<string, WAChat>();
        const chatByJid = new Map<string, WAChat>();
        for (const c of wa.chats) {
          chatByJid.set(c.id, c);
          const phone = resolvePhone(c.id, wa.jidToPhoneJid);
          if (phone) {
            const existing = chatByPhone.get(phone);
            if (!existing || c.t > existing.t) chatByPhone.set(phone, c);
          }
        }

        const labelsByJid = buildLabelAssocMap(wa.associations, wa.labels);

        const now = Date.now() / 1000;

        const merged: CrmContact[] = contacts
          .filter((c) => chatByPhone.has(c.phone))
          .map((c) => {
            const chat = chatByPhone.get(c.phone)!;
            const jid = chat.id;
            const classification = classifyChat(
              chat,
              {
                reminderAckAt: c.reminder_ack_at
                  ? new Date(c.reminder_ack_at).getTime() / 1000
                  : null,
                reminderDisabled: c.reminder_disabled,
              },
              now,
            );
            return {
              contact: c,
              chat,
              jid,
              phone: c.phone,
              displayName: c.name || c.wa_name || chat.name || c.phone,
              labels: labelsByJid.get(jid) ?? [],
              vehicleInterests: vehicleByContact.get(c.id) ?? [],
              tags: tagsByContact.get(c.id) ?? [],
              region: countryToRegion(c.country),
              classification,
            };
          });

        const contactPhones = new Set(contacts.map((c) => c.phone));
        const seenPhones = new Set<string>();
        for (const chat of wa.chats) {
          const phone = resolvePhone(chat.id, wa.jidToPhoneJid);
          if (!phone || contactPhones.has(phone) || seenPhones.has(phone)) continue;
          if (chat.archive) continue;
          seenPhones.add(phone);
          merged.push({
            contact: null,
            chat,
            jid: chat.id,
            phone,
            displayName: chat.name || phone,
            labels: labelsByJid.get(chat.id) ?? [],
            vehicleInterests: [],
            tags: [],
            region: 'other',
            classification: classifyChat(
              chat,
              { reminderAckAt: null, reminderDisabled: false },
              now,
            ),
          });
        }

        if (cancelled) return;
        setState({
          contacts: merged,
          labels: wa.labels.filter((l) => l.isActive),
          loading: false,
          error: null,
        });

        void syncAutoStages(merged).catch((e) =>
          console.warn('[stage-sync]', stringifyError(e)),
        );
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, error: stringifyError(err) }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId, nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
