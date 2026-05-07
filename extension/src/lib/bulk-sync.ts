import { supabase } from './supabase';
import { readWhatsAppData, resolvePhone } from './whatsapp-idb';
import { stringifyError } from './errors';

export interface BulkSyncResult {
  scanned: number;
  skippedArchived: number;
  skippedNoPhone: number;
  alreadySynced: number;
  added: number;
}

export async function bulkSyncWhatsAppChats(orgId: string): Promise<BulkSyncResult> {
  const wa = await readWhatsAppData();

  const { data: existing, error: readErr } = await supabase
    .from('contacts')
    .select('phone')
    .eq('org_id', orgId);
  if (readErr) throw new Error(stringifyError(readErr));

  const existingPhones = new Set((existing ?? []).map((r) => r.phone));

  let skippedArchived = 0;
  let skippedNoPhone = 0;
  let alreadySynced = 0;
  const toInsert: Array<{
    org_id: string;
    phone: string;
    wa_name: string | null;
    name: string | null;
  }> = [];
  const seenPhones = new Set<string>();

  const contactByJid = new Map(wa.contacts.map((c) => [c.id, c]));

  for (const chat of wa.chats) {
    if (chat.archive) {
      skippedArchived++;
      continue;
    }
    const phone = resolvePhone(chat.id, wa.jidToPhoneJid);
    if (!phone) {
      skippedNoPhone++;
      continue;
    }
    if (seenPhones.has(phone) || existingPhones.has(phone)) {
      alreadySynced++;
      continue;
    }
    seenPhones.add(phone);
    const c = contactByJid.get(chat.id);
    const displayName =
      (c?.name ?? '').trim() ||
      (c?.shortName ?? '').trim() ||
      (c?.pushname ?? '').trim() ||
      (chat.name ?? '').trim() ||
      null;
    toInsert.push({
      org_id: orgId,
      phone,
      wa_name: displayName,
      name: displayName,
    });
  }

  if (toInsert.length === 0) {
    return {
      scanned: wa.chats.length,
      skippedArchived,
      skippedNoPhone,
      alreadySynced,
      added: 0,
    };
  }

  const CHUNK = 100;
  let added = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .upsert(batch, { onConflict: 'org_id,phone', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(stringifyError(error));
    added += data?.length ?? 0;
  }

  return {
    scanned: wa.chats.length,
    skippedArchived,
    skippedNoPhone,
    alreadySynced,
    added,
  };
}
