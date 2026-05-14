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
import { ensureJidPhoneCacheLoaded } from '@/lib/jid-phone-cache';
import { classifyChat, type ChatClassification } from '@/lib/chat-classifier';
import { updatePendingReplyMap } from '@/lib/pending-reply-store';
import { countryToRegion } from '@/lib/regions';
import { stringifyError } from '@/lib/errors';
import { syncAutoStages } from '@/lib/stage-sync';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];
type ContactTagRow = Database['public']['Tables']['contact_tags']['Row'];

/**
 * 从 chat.name 兜底解析手机号。WA 业务号（@lid）在没把
 * lid→phone 映射写进 IDB 之前，name 字段往往存的就是"+591 69820483"，
 * 直接抓数字位返回 +-prefix 标准格式。
 */
function extractPhoneFromName(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  // 必须看起来是手机号（开头 + 或第一个字符是数字，后面 7+ 位有效数字）
  if (!/^\+?\s*\d/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `+${digits}`;
}

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
    const org = orgId; // narrowed const for inner closures
    let cancelled = false;
    if (nonce === 0) {
      setState((s) => ({ ...s, loading: true, error: null }));
    }

    // 突破 Supabase 1000 行默认上限：分页拉
    async function fetchAllContacts(): Promise<ContactRow[]> {
      const PAGE = 1000;
      const out: ContactRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .eq('org_id', org)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as ContactRow[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    }

    async function fetchAllVehicleInterests(): Promise<VehicleInterestRow[]> {
      const PAGE = 1000;
      const out: VehicleInterestRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('vehicle_interests')
          .select('*, contacts!inner(org_id)')
          .eq('contacts.org_id', org)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as unknown as VehicleInterestRow[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    }

    async function fetchAllContactTags(): Promise<ContactTagRow[]> {
      const PAGE = 1000;
      const out: ContactTagRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('contact_tags')
          .select('*, contacts!inner(org_id)')
          .eq('contacts.org_id', org)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as unknown as ContactTagRow[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    }

    /**
     * 从 messages 表回填"客户最后发的没回"信号。需要 migration 0019 提供
     * 的 RPC；如果 RPC 不在（migration 还没上）就返回空 map，"我该回"判定
     * 退回 unreadCount + pending 两路兜底。
     */
    async function fetchMessageDirections(): Promise<
      Map<string, { lastInboundT: number | null; lastOutboundT: number | null }>
    > {
      const out = new Map<
        string,
        { lastInboundT: number | null; lastOutboundT: number | null }
      >();
      try {
        // RPC 是 migration 0019 加的；TS 类型还没回填 database.types.ts，
        // 用 unknown 中转避免硬编码 RPC 名进类型联合。运行时如果 RPC 不存在
        // 会返回 PostgrestError，catch 走静默降级路径。
        const { data, error } = await (
          supabase.rpc as unknown as (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: unknown }>
        )('last_message_direction_per_contact', { p_org_id: org });
        if (error || !data) return out;
        const rows = data as Array<{
          contact_id: string;
          last_inbound_t: string | null;
          last_outbound_t: string | null;
        }>;
        for (const r of rows) {
          out.set(r.contact_id, {
            lastInboundT: r.last_inbound_t
              ? new Date(r.last_inbound_t).getTime() / 1000
              : null,
            lastOutboundT: r.last_outbound_t
              ? new Date(r.last_outbound_t).getTime() / 1000
              : null,
          });
        }
      } catch {
        // RPC 不存在 / 网络挂——静默回退到 pending-only 路径
      }
      return out;
    }

    void (async () => {
      try {
        const [contacts, vehicles, tags, wa, jidPhoneCache, msgDirections] =
          await Promise.all([
            fetchAllContacts(),
            fetchAllVehicleInterests(),
            fetchAllContactTags(),
            readWhatsAppData().catch(() => ({
              labels: [] as WALabel[],
              associations: [] as WALabelAssociation[],
              chats: [] as WAChat[],
              contacts: [],
              jidToPhoneJid: new Map<string, string>(),
            })),
            ensureJidPhoneCacheLoaded().catch(
              () => ({}) as Record<string, string>,
            ),
            fetchMessageDirections(),
          ]);

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
          let phone = resolvePhone(c.id, wa.jidToPhoneJid);
          // @lid 业务号兜底链：
          //   1. chrome.storage 持久缓存（用户打开过聊天时 readCurrentChat 已写入）
          //   2. 从 chat.name 抓手机号（部分情况 IDB 也存的是 "+591 ..." 字串）
          if (!phone && c.id.endsWith('@lid')) {
            phone = jidPhoneCache[c.id] ?? extractPhoneFromName(c.name);
          }
          if (phone) {
            const existing = chatByPhone.get(phone);
            if (!existing || c.t > existing.t) chatByPhone.set(phone, c);
          }
        }

        const labelsByJid = buildLabelAssocMap(wa.associations, wa.labels);

        const now = Date.now() / 1000;

        // "点开了没回"追踪：根据本次扫到的 unreadCount / chat.t 更新持久化
        // 状态，传给 classifyChat 做 needsReply 判定。详见 pending-reply-store.ts
        const pendingMap = await updatePendingReplyMap(wa.chats, now);

        // 群聊（phone=null, group_jid=...）不参与 WA chat 列表合并；
        // 群聊通过 useCurrentChat 即时识别，不走这个 lens
        const merged: CrmContact[] = contacts
          .filter((c) => c.phone != null && chatByPhone.has(c.phone))
          .map((c) => {
            const chat = chatByPhone.get(c.phone!)!;
            const jid = chat.id;
            const dir = msgDirections.get(c.id);
            const classification = classifyChat(
              chat,
              { capturedAt: pendingMap[chat.id]?.capturedAt ?? null },
              {
                lastInboundT: dir?.lastInboundT ?? null,
                lastOutboundT: dir?.lastOutboundT ?? null,
              },
              now,
            );
            return {
              contact: c,
              chat,
              jid,
              phone: c.phone!,
              displayName: c.name || c.wa_name || chat.name || c.phone!,
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
              { capturedAt: pendingMap[chat.id]?.capturedAt ?? null },
              { lastInboundT: null, lastOutboundT: null },
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
