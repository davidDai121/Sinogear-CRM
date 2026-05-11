import { supabase } from './supabase';
import { readWhatsAppData, resolvePhone, type WAChat } from './whatsapp-idb';
import {
  ensureJidPhoneCacheLoaded,
} from './jid-phone-cache';
import type { Database } from './database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

export type Vitality = 'active' | 'stale' | 'cold' | 'imported' | 'orphan';

export interface ContactVitality {
  contactId: string;
  phone: string | null;
  groupJid: string | null;
  name: string;
  vitality: Vitality;
  lastActivityUnix: number | null; // chat.t from IDB
  daysSinceActivity: number | null;
  hasMessagesInDb: boolean;
  inIdbChat: boolean;
}

export interface VitalityReport {
  total: number;
  active: ContactVitality[]; // 在 WA Web + ≤ 30 天
  stale: ContactVitality[]; // 在 WA Web + 30-180 天
  cold: ContactVitality[]; // 在 WA Web + > 180 天
  /**
   * 不在 WA Web 本地缓存里，但 messages 表里有导入的聊天历史。
   * 这些是真客户——WA Web 搜索框搜不到只是因为本地缓存装不下太多 chat。
   * 用 💬 跳转聊天会自动走 deep link 协议进入。**绝对不要删**。
   */
  imported: ContactVitality[];
  /** 既不在 WA Web 也没导入历史。大概率是 Google 联系人/旧 CRM 导入的没用过的号，可清理。 */
  orphan: ContactVitality[];
}

const DAY = 24 * 3600;

async function fetchAllContacts(orgId: string): Promise<ContactRow[]> {
  const PAGE = 1000;
  const out: ContactRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('org_id', orgId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as ContactRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchContactsWithMessages(orgId: string): Promise<Set<string>> {
  // 找 messages 表里有记录的 contact_id（任何 inbound/outbound 都算证据）
  const PAGE = 1000;
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('messages')
      .select('contact_id, contacts!inner(org_id)')
      .eq('contacts.org_id', orgId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as { contact_id: string }[];
    for (const r of rows) out.add(r.contact_id);
    if (rows.length < PAGE) break;
  }
  return out;
}

function extractPhoneFromName(name: string | null): string | null {
  if (!name) return null;
  const t = name.trim();
  if (!/^\+?\s*\d/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `+${digits}`;
}

export async function analyzeContactVitality(
  orgId: string,
): Promise<VitalityReport> {
  const [contacts, contactIdsWithMsgs, wa, jidPhoneCache] = await Promise.all([
    fetchAllContacts(orgId),
    fetchContactsWithMessages(orgId),
    readWhatsAppData().catch(() => ({
      labels: [],
      associations: [],
      chats: [] as WAChat[],
      contacts: [],
      jidToPhoneJid: new Map<string, string>(),
    })),
    ensureJidPhoneCacheLoaded().catch(() => ({}) as Record<string, string>),
  ]);

  // 建 phone -> 最新 chat.t 索引（个人）+ groupJid -> 最新 chat.t（群）
  const lastChatByPhone = new Map<string, number>();
  const lastChatByGroupJid = new Map<string, number>();
  for (const c of wa.chats) {
    if (c.id.endsWith('@g.us')) {
      const prev = lastChatByGroupJid.get(c.id) ?? 0;
      if (c.t > prev) lastChatByGroupJid.set(c.id, c.t);
      continue;
    }
    let phone = resolvePhone(c.id, wa.jidToPhoneJid);
    if (!phone && c.id.endsWith('@lid')) {
      phone = jidPhoneCache[c.id] ?? extractPhoneFromName(c.name);
    }
    if (!phone) continue;
    const prev = lastChatByPhone.get(phone) ?? 0;
    if (c.t > prev) lastChatByPhone.set(phone, c.t);
  }

  const now = Date.now() / 1000;
  const report: VitalityReport = {
    total: contacts.length,
    active: [],
    stale: [],
    cold: [],
    imported: [],
    orphan: [],
  };

  for (const c of contacts) {
    const lastT = c.group_jid
      ? lastChatByGroupJid.get(c.group_jid) ?? 0
      : c.phone
        ? lastChatByPhone.get(c.phone) ?? 0
        : 0;
    const inIdb = lastT > 0;
    const hasMsgs = contactIdsWithMsgs.has(c.id);
    const ageSec = inIdb ? now - lastT : null;
    const days = ageSec != null ? Math.floor(ageSec / DAY) : null;

    let v: Vitality;
    if (!inIdb && !hasMsgs) v = 'orphan';
    else if (!inIdb) v = 'imported'; // 不在 WA Web 但 messages 表有数据 → 真客户，仅本地缓存没有
    else if (ageSec! <= 30 * DAY) v = 'active';
    else if (ageSec! <= 180 * DAY) v = 'stale';
    else v = 'cold';

    const item: ContactVitality = {
      contactId: c.id,
      phone: c.phone,
      groupJid: c.group_jid,
      name: c.name || c.wa_name || c.phone || c.group_jid || '(无名)',
      vitality: v,
      lastActivityUnix: inIdb ? lastT : null,
      daysSinceActivity: days,
      hasMessagesInDb: hasMsgs,
      inIdbChat: inIdb,
    };
    report[v].push(item);
  }

  return report;
}
