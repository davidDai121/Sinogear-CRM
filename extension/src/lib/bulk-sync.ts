import { supabase } from './supabase';
import { readWhatsAppData, resolvePhone } from './whatsapp-idb';
import { stringifyError } from './errors';

export interface BulkSyncResult {
  scanned: number;
  skippedArchived: number;
  skippedNoPhone: number;
  alreadySynced: number;
  added: number;
  /** 新增：本次新建的群 contact 数（不含个人） */
  addedGroups: number;
}

interface IndividualInsert {
  org_id: string;
  phone: string;
  wa_name: string | null;
  name: string | null;
}

interface GroupInsert {
  org_id: string;
  group_jid: string;
  wa_name: string | null;
  name: string | null;
}

export async function bulkSyncWhatsAppChats(orgId: string): Promise<BulkSyncResult> {
  const wa = await readWhatsAppData();

  const { data: existing, error: readErr } = await supabase
    .from('contacts')
    .select('phone, group_jid')
    .eq('org_id', orgId);
  if (readErr) throw new Error(stringifyError(readErr));

  const existingPhones = new Set<string>();
  const existingGroupJids = new Set<string>();
  for (const r of existing ?? []) {
    if (r.phone) existingPhones.add(r.phone);
    if (r.group_jid) existingGroupJids.add(r.group_jid);
  }

  let skippedArchived = 0;
  let skippedNoPhone = 0;
  let alreadySynced = 0;
  const toInsertIndividual: IndividualInsert[] = [];
  const toInsertGroup: GroupInsert[] = [];
  const seenPhones = new Set<string>();
  const seenGroupJids = new Set<string>();

  const contactByJid = new Map(wa.contacts.map((c) => [c.id, c]));

  for (const chat of wa.chats) {
    if (chat.archive) {
      skippedArchived++;
      continue;
    }

    // 群聊分支：jid 以 @g.us 结尾，按 group_jid 入库（无 phone）
    if (chat.id.endsWith('@g.us')) {
      if (seenGroupJids.has(chat.id) || existingGroupJids.has(chat.id)) {
        alreadySynced++;
        continue;
      }
      seenGroupJids.add(chat.id);
      const groupName = (chat.name ?? '').trim() || null;
      toInsertGroup.push({
        org_id: orgId,
        group_jid: chat.id,
        wa_name: groupName,
        name: groupName,
      });
      continue;
    }

    // 个人聊天分支
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
    toInsertIndividual.push({
      org_id: orgId,
      phone,
      wa_name: displayName,
      name: displayName,
    });
  }

  const CHUNK = 100;
  let added = 0;
  let addedGroups = 0;

  for (let i = 0; i < toInsertIndividual.length; i += CHUNK) {
    const batch = toInsertIndividual.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .upsert(batch, { onConflict: 'org_id,phone', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(stringifyError(error));
    added += data?.length ?? 0;
  }

  for (let i = 0; i < toInsertGroup.length; i += CHUNK) {
    const batch = toInsertGroup.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .upsert(batch, { onConflict: 'org_id,group_jid', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(stringifyError(error));
    addedGroups += data?.length ?? 0;
  }

  return {
    scanned: wa.chats.length,
    skippedArchived,
    skippedNoPhone,
    alreadySynced,
    added,
    addedGroups,
  };
}
