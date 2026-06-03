import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  RealtimePostgresChangesPayload,
  RealtimePostgresInsertPayload,
  RealtimePostgresUpdatePayload,
  RealtimePostgresDeletePayload,
} from '@supabase/supabase-js';
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
import {
  updatePendingReplyMap,
  type PendingReplyMap,
} from '@/lib/pending-reply-store';
import { countryToRegion } from '@/lib/regions';
import { stringifyError } from '@/lib/errors';
import { syncAutoStages } from '@/lib/stage-sync';
import {
  fetchMyPinnedIdsForOrg,
  pinContact,
  unpinContact,
} from '@/lib/contact-pins';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];
type ContactTagRow = Database['public']['Tables']['contact_tags']['Row'];

/**
 * 左边聊天列表 + 撞单 + autoStage 实际只用 11 列；select('*') 会把 notes
 * （自由文本，可能很长）/ google_* / created_at 等大字段全拉回来，是 Supabase
 * egress 大头。AI prompt 用的 contact 走的是 useContact 单查（详情卡），跟这个
 * hook 无关，所以可以放心砍。
 *
 * 加新功能要读 contact 上别的列时（reminder_*, google_*, notes…）有两个选择：
 *   1. 把该列加回这里的 select（并扩 Realtime 事件处理：默认 payload 已含
 *      完整行因为 REPLICA IDENTITY FULL）
 *   2. 在该组件内单独 useContact 一次（推荐：详情类页面别让列表 hook 背锅）
 */
const CONTACT_LIST_COLS =
  'id, phone, group_jid, wa_name, name, country, language, budget_usd, customer_stage, quality, destination_port';

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
  /** 当前 user 是否置顶了这个客户（contact_pins 表） */
  pinned: boolean;
}

export interface CrmData {
  contacts: CrmContact[];
  labels: WALabel[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * 乐观更新置顶：本地 state 立刻翻转 → DB 后台写。失败回滚 + 抛错。
   * 这样右键置顶后 UI 不用等几秒重拉所有 contacts。
   */
  setPinned: (contactId: string, pinned: boolean) => Promise<void>;
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

// ============================================================================
// Realtime + slim select 替代了 20s 轮询。Egress 模型：
//   - 初次加载：~1.4 MB（contacts + 关联表分页拉一遍）
//   - Realtime 事件：每条变更几 KB，正常使用 < 1 MB/天/销售
//   - 30 分钟兜底 refetch：~1.4 MB × 12 次/天（断网恢复 / 漏事件兜底）
//   - msg_directions：5 分钟 RPC ~50KB × 72 次 = ~3.6 MB/天
//   - 总计：~20-30 MB/天/销售，月度 3 销售 × 25 天 = ~1.5 GB，远低于 5GB
//
// WA 数据从 IDB 本地读取，不走 Supabase，所以可以保持 30 秒高频。
// ============================================================================

/** WA IDB 数据轮询频率。本地 IDB 读，不走网络，零 egress */
const WA_POLL_MS = 30 * 1000;
/** DB 完整 refetch 兜底间隔。覆盖 Realtime 漏事件 / websocket 断线。
 *  国内访问 Supabase 新加坡区域单次 fetchAllContacts ~7-10s，60min 一次能
 *  把后台 fetch 总成本压到几乎可忽略。Realtime 在线时基本不靠这个 */
const DB_REFETCH_INTERVAL_MS = 60 * 60 * 1000;
/** visibilitychange 触发 refetch 的最短间隔。15min 内切回不再触发，避免日常
 *  切 tab 的几秒卡顿 */
const VISIBILITY_REFRESH_THROTTLE_MS = 15 * 60 * 1000;
/** msg_directions RPC 刷新间隔。比 DB refetch 频繁（新消息影响"我该回"判定） */
const MSG_DIRECTIONS_REFRESH_MS = 5 * 60 * 1000;

interface MsgDirection {
  lastInboundT: number | null;
  lastOutboundT: number | null;
  inboundCount: number;
  outboundCount: number;
}

interface DbState {
  contactsById: Map<string, ContactRow>;
  /** 按 contact_id 聚合，方便 merge 时 O(1) 查 */
  vehicleInterestsByContactId: Map<string, VehicleInterestRow[]>;
  /** 按 contact_id 聚合 */
  tagsByContactId: Map<string, string[]>;
  msgDirections: Map<string, MsgDirection>;
  pinnedIds: Set<string>;
  loading: boolean;
  error: string | null;
}

interface WaPolledState {
  labels: WALabel[];
  associations: WALabelAssociation[];
  chats: WAChat[];
  jidToPhoneJid: Map<string, string>;
  jidPhoneCache: Record<string, string>;
  pendingMap: PendingReplyMap;
}

const EMPTY_DB: DbState = {
  contactsById: new Map(),
  vehicleInterestsByContactId: new Map(),
  tagsByContactId: new Map(),
  msgDirections: new Map(),
  pinnedIds: new Set(),
  loading: true,
  error: null,
};

const EMPTY_WA: WaPolledState = {
  labels: [],
  associations: [],
  chats: [],
  jidToPhoneJid: new Map(),
  jidPhoneCache: {},
  pendingMap: {},
};

/**
 * 从 messages 表回填"客户最后发的没回"信号。需要 migration 0019 提供
 * 的 RPC；如果 RPC 不在（migration 还没上）就返回空 map，"我该回"判定
 * 退回 unreadCount + pending 两路兜底。
 */
async function fetchMessageDirections(
  org: string,
): Promise<Map<string, MsgDirection>> {
  const out = new Map<string, MsgDirection>();
  try {
    // RPC 是 migration 0019 加的，0022 扩展了返回 inbound_count/outbound_count；
    // TS 类型还没回填 database.types.ts，用 unknown 中转避免硬编码 RPC 名进类型
    // 联合。运行时如果 RPC 不存在（0019 没上）返回 PostgrestError，catch
    // 走静默降级；旧版 RPC（有 0019 没 0022）count 字段 undefined，按 0 处理
    //——不影响"我该回"判定，"有历史保护"暂不生效。
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
      inbound_count?: number | null;
      outbound_count?: number | null;
    }>;
    for (const r of rows) {
      out.set(r.contact_id, {
        lastInboundT: r.last_inbound_t
          ? new Date(r.last_inbound_t).getTime() / 1000
          : null,
        lastOutboundT: r.last_outbound_t
          ? new Date(r.last_outbound_t).getTime() / 1000
          : null,
        inboundCount: r.inbound_count ?? 0,
        outboundCount: r.outbound_count ?? 0,
      });
    }
  } catch {
    // RPC 不存在 / 网络挂——静默回退到 pending-only 路径
  }
  return out;
}

/** 突破 Supabase 1000 行默认上限：分页拉。
 *  必须加 .order(...) — 否则 PostgREST 不保证 range 跨页稳定，并发写入
 *  时同一行可能在 page N 和 page N+1 都返回，导致 contacts 数组重复。 */
async function fetchAllContacts(org: string): Promise<ContactRow[]> {
  const PAGE = 1000;
  const out: ContactRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contacts')
      .select(CONTACT_LIST_COLS)
      .eq('org_id', org)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    // slim select：CONTACT_LIST_COLS 之外的列实际是 undefined。
    // 当 ContactRow 用是该 hook 的约定（外部消费方都只读 list 列）。
    const rows = (data ?? []) as unknown as ContactRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchAllVehicleInterests(
  org: string,
): Promise<VehicleInterestRow[]> {
  const PAGE = 1000;
  const out: VehicleInterestRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('vehicle_interests')
      .select('*, contacts!inner(org_id)')
      .eq('contacts.org_id', org)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as VehicleInterestRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchAllContactTags(org: string): Promise<ContactTagRow[]> {
  const PAGE = 1000;
  const out: ContactTagRow[] = [];
  for (let from = 0; ; from += PAGE) {
    // contact_tags PK 是 (contact_id, tag) 复合主键，没单列 id；
    // 用复合 order 保证完全稳定
    const { data, error } = await supabase
      .from('contact_tags')
      .select('*, contacts!inner(org_id)')
      .eq('contacts.org_id', org)
      .order('contact_id', { ascending: true })
      .order('tag', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as ContactTagRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchPinnedIds(org: string): Promise<Set<string>> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return new Set<string>();
  return fetchMyPinnedIdsForOrg(org, userId).catch(() => new Set<string>());
}

function indexVehiclesByContact(
  rows: VehicleInterestRow[],
): Map<string, VehicleInterestRow[]> {
  const m = new Map<string, VehicleInterestRow[]>();
  for (const v of rows) {
    const arr = m.get(v.contact_id) ?? [];
    arr.push(v);
    m.set(v.contact_id, arr);
  }
  return m;
}

function indexTagsByContact(rows: ContactTagRow[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of rows) {
    const arr = m.get(t.contact_id) ?? [];
    arr.push(t.tag);
    m.set(t.contact_id, arr);
  }
  return m;
}

// ============================================================================
// Realtime 事件 reducer。每个事件单独更新 state map 上的一行 / 几行，避免重拉
// 全表。REPLICA IDENTITY FULL（见 migration 0025）确保 DELETE / UPDATE 事件
// payload.old 包含完整旧行——关联表 (vehicle_interests / contact_tags) 需要
// 旧行的 contact_id 才能定位前端 state 里的归属。
// ============================================================================

function applyContactChange(
  prev: DbState,
  payload: RealtimePostgresChangesPayload<ContactRow>,
): DbState {
  const next = new Map(prev.contactsById);
  if (payload.eventType === 'DELETE') {
    const old = (payload as RealtimePostgresDeletePayload<ContactRow>).old;
    if (old.id) next.delete(old.id);
  } else {
    const row = (
      payload as
        | RealtimePostgresInsertPayload<ContactRow>
        | RealtimePostgresUpdatePayload<ContactRow>
    ).new;
    next.set(row.id, row);
  }
  return { ...prev, contactsById: next };
}

function applyVehicleInterestChange(
  prev: DbState,
  payload: RealtimePostgresChangesPayload<VehicleInterestRow>,
): DbState {
  const next = new Map(prev.vehicleInterestsByContactId);
  const removeFromContact = (contactId: string, vId: string): void => {
    const arr = (next.get(contactId) ?? []).filter((v) => v.id !== vId);
    if (arr.length === 0) next.delete(contactId);
    else next.set(contactId, arr);
  };
  const upsertToContact = (row: VehicleInterestRow): void => {
    const arr = (next.get(row.contact_id) ?? []).filter((v) => v.id !== row.id);
    arr.push(row);
    next.set(row.contact_id, arr);
  };

  if (payload.eventType === 'DELETE') {
    const old = (payload as RealtimePostgresDeletePayload<VehicleInterestRow>).old;
    if (old.contact_id && old.id) removeFromContact(old.contact_id, old.id);
  } else if (payload.eventType === 'INSERT') {
    const row = (payload as RealtimePostgresInsertPayload<VehicleInterestRow>).new;
    upsertToContact(row);
  } else {
    // UPDATE — 可能换了 contact_id（理论上不发生但保险），先按旧的删一遍
    const up = payload as RealtimePostgresUpdatePayload<VehicleInterestRow>;
    if (up.old.contact_id && up.old.id && up.old.contact_id !== up.new.contact_id) {
      removeFromContact(up.old.contact_id, up.old.id);
    }
    upsertToContact(up.new);
  }
  return { ...prev, vehicleInterestsByContactId: next };
}

function applyTagChange(
  prev: DbState,
  payload: RealtimePostgresChangesPayload<ContactTagRow>,
): DbState {
  const next = new Map(prev.tagsByContactId);
  if (payload.eventType === 'INSERT') {
    const row = (payload as RealtimePostgresInsertPayload<ContactTagRow>).new;
    const arr = next.get(row.contact_id) ?? [];
    if (!arr.includes(row.tag)) next.set(row.contact_id, [...arr, row.tag]);
  } else if (payload.eventType === 'DELETE') {
    const old = (payload as RealtimePostgresDeletePayload<ContactTagRow>).old;
    if (old.contact_id && old.tag) {
      const arr = (next.get(old.contact_id) ?? []).filter((t) => t !== old.tag);
      if (arr.length === 0) next.delete(old.contact_id);
      else next.set(old.contact_id, arr);
    }
  }
  // UPDATE 对 contact_tags 不会发生（PK 包含全部列），忽略
  return { ...prev, tagsByContactId: next };
}

export function useCrmData(orgId: string | null): CrmData {
  const [dbState, setDbState] = useState<DbState>(EMPTY_DB);
  const [waState, setWaState] = useState<WaPolledState>(EMPTY_WA);
  /** 触发 DB 重新全量拉取（manual refresh / 30min 兜底 / visibilitychange） */
  const [refetchNonce, setRefetchNonce] = useState(0);
  /** msg_directions 单独刷新节奏（比 DB refetch 更频繁） */
  const [msgDirNonce, setMsgDirNonce] = useState(0);
  const lastDbFetchRef = useRef(0);

  // ----- Effect 1: 初次加载 + 手动 refresh / 兜底 refetch -----
  useEffect(() => {
    if (!orgId) return;
    const org = orgId;
    let cancelled = false;
    // 仅初次加载时显示 loading；后续 refetch 保留旧数据，安静刷新
    if (refetchNonce === 0) {
      setDbState((s) => ({ ...s, loading: true, error: null }));
    }
    void (async () => {
      try {
        const [contacts, vehicles, tags, msgDirections, pinnedIds] =
          await Promise.all([
            fetchAllContacts(org),
            fetchAllVehicleInterests(org),
            fetchAllContactTags(org),
            fetchMessageDirections(org),
            fetchPinnedIds(org),
          ]);
        if (cancelled) return;
        lastDbFetchRef.current = Date.now();
        const contactsById = new Map<string, ContactRow>(
          contacts.map((c) => [c.id, c]),
        );
        setDbState({
          contactsById,
          vehicleInterestsByContactId: indexVehiclesByContact(vehicles),
          tagsByContactId: indexTagsByContact(tags),
          msgDirections,
          pinnedIds,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setDbState((s) => ({
          ...s,
          loading: false,
          error: stringifyError(err),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, refetchNonce]);

  // ----- Effect 2: msg_directions 5min 单独刷新（小 RPC，影响"我该回"） -----
  useEffect(() => {
    if (!orgId) return;
    const org = orgId;
    let cancelled = false;
    if (msgDirNonce === 0) return; // 初次由 Effect 1 一并拉了
    void (async () => {
      const msgDirections = await fetchMessageDirections(org);
      if (cancelled) return;
      setDbState((s) => ({ ...s, msgDirections }));
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, msgDirNonce]);

  // ----- Effect 3: Realtime 订阅（增量更新本地 state） -----
  useEffect(() => {
    if (!orgId) return;
    const org = orgId;
    const channel = supabase
      .channel(`crm-${org}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'contacts',
          filter: `org_id=eq.${org}`,
        },
        (payload) => {
          setDbState((prev) =>
            applyContactChange(
              prev,
              payload as RealtimePostgresChangesPayload<ContactRow>,
            ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'vehicle_interests',
          // 无 filter — vehicle_interests 无 org_id 列；Realtime filter 只支持
          // 单列 equality，没法 join。RLS 已在服务端确保只下发本 org 可见的行。
        },
        (payload) => {
          setDbState((prev) =>
            applyVehicleInterestChange(
              prev,
              payload as RealtimePostgresChangesPayload<VehicleInterestRow>,
            ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'contact_tags',
        },
        (payload) => {
          setDbState((prev) =>
            applyTagChange(
              prev,
              payload as RealtimePostgresChangesPayload<ContactTagRow>,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [orgId]);

  // ----- Effect 4: 30min DB 兜底 refetch + 5min msg_directions 刷新 -----
  useEffect(() => {
    if (!orgId) return;
    const dbTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setRefetchNonce((n) => n + 1);
    }, DB_REFETCH_INTERVAL_MS);
    const msgTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setMsgDirNonce((n) => n + 1);
    }, MSG_DIRECTIONS_REFRESH_MS);
    // tab 切回来：若距上次 DB fetch 超过 throttle 才触发，避免狂切 tab 烧 egress
    const onVisible = (): void => {
      if (typeof document === 'undefined' || document.hidden) return;
      if (Date.now() - lastDbFetchRef.current > VISIBILITY_REFRESH_THROTTLE_MS) {
        setRefetchNonce((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(dbTimer);
      clearInterval(msgTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [orgId]);

  // ----- Effect 5: WA IDB 数据轮询（本地读，零 egress） -----
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    const fetchWa = async (): Promise<void> => {
      try {
        const [wa, jidPhoneCache] = await Promise.all([
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
        ]);
        if (cancelled) return;
        // pending-reply 持久化：根据本次扫到的 unreadCount / chat.t 更新
        const pendingMap = await updatePendingReplyMap(
          wa.chats,
          Date.now() / 1000,
        );
        if (cancelled) return;
        setWaState({
          labels: wa.labels,
          associations: wa.associations,
          chats: wa.chats,
          jidToPhoneJid: wa.jidToPhoneJid,
          jidPhoneCache,
          pendingMap,
        });
      } catch (err) {
        console.warn('[wa-poll]', stringifyError(err));
      }
    };
    void fetchWa();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void fetchWa();
    }, WA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orgId]);

  // ----- 计算 merged：DB 数据 + WA chats 合并 -----
  const merged = useMemo<{ contacts: CrmContact[]; labels: WALabel[] }>(() => {
    const {
      contactsById,
      vehicleInterestsByContactId,
      tagsByContactId,
      msgDirections,
      pinnedIds,
    } = dbState;
    const { chats, jidToPhoneJid, jidPhoneCache, labels, associations, pendingMap } =
      waState;

    const chatByPhone = new Map<string, WAChat>();
    for (const c of chats) {
      let phone = resolvePhone(c.id, jidToPhoneJid);
      // @lid 业务号兜底链：
      //   1. chrome.storage 持久缓存（用户打开过聊天时 readCurrentChat 已写入）
      //   2. 从 chat.name 抓手机号（部分情况 IDB 也存的是 "+591 ..." 字串)
      if (!phone && c.id.endsWith('@lid')) {
        phone = jidPhoneCache[c.id] ?? extractPhoneFromName(c.name);
      }
      if (!phone) continue;
      const existing = chatByPhone.get(phone);
      // t=0 是 WA Web IDB 的 "空 chat" 占位（@lid 业务号 / 多端复制 / 幽灵
      // chat 常见）。这种 chat 没消息，classifyChat 会判 autoStage='new'。
      // 如果同 phone 已经有 t > 0 的真实 chat 占着，t=0 chat 跳过——避免在
      // 不同轮 IDB 读 + resolvePhone 抖动时，chat 选择在 t=large↔t=0 间跳，
      // 拖着 autoStage 在 active↔new↔stalled↔lost 间疯翻。
      // 只在 phone 完全没绑定时 t=0 才能占位（真·全新无消息客户的正常路径）。
      if (c.t === 0 && existing && existing.t > 0) continue;
      if (!existing || c.t > existing.t) chatByPhone.set(phone, c);
    }

    const labelsByJid = buildLabelAssocMap(associations, labels);
    const now = Date.now() / 1000;
    const contacts = Array.from(contactsById.values());

    // 群聊（phone=null, group_jid=...）不参与 WA chat 列表合并；
    // 群聊通过 useCurrentChat 即时识别，不走这个 lens
    const mergedList: CrmContact[] = contacts
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
            inboundCount: dir?.inboundCount ?? 0,
            outboundCount: dir?.outboundCount ?? 0,
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
          vehicleInterests: vehicleInterestsByContactId.get(c.id) ?? [],
          tags: tagsByContactId.get(c.id) ?? [],
          region: countryToRegion(c.country),
          classification,
          pinned: pinnedIds.has(c.id),
        };
      });

    const contactPhones = new Set(contacts.map((c) => c.phone));
    const seenPhones = new Set<string>();
    for (const chat of chats) {
      const phone = resolvePhone(chat.id, jidToPhoneJid);
      if (!phone || contactPhones.has(phone) || seenPhones.has(phone)) continue;
      if (chat.archive) continue;
      seenPhones.add(phone);
      mergedList.push({
        contact: null,
        chat,
        jid: chat.id,
        phone,
        displayName: chat.name || phone,
        labels: labelsByJid.get(chat.id) ?? [],
        vehicleInterests: [],
        tags: [],
        region: 'other',
        pinned: false,
        classification: classifyChat(
          chat,
          { capturedAt: pendingMap[chat.id]?.capturedAt ?? null },
          { lastInboundT: null, lastOutboundT: null },
          now,
        ),
      });
    }

    // 第 3 路：补"我置顶了但没匹配到 WA chat"的客户。痛点（boss 2026-06
    // 反馈"置顶数量绝对不对"）：上面第 1 路 filter 要求 contact.phone 非
    // null 且 chatByPhone 命中——这会把导入的客户（加密备份 / .txt 导入，
    // IDB chat 表里没有）、群聊（phone=null）、@lid 业务号 phone 解析不到
    // 的客户全过滤掉。置顶 count 因此严重偏低。
    const alreadyMergedIds = new Set(
      mergedList.filter((m) => m.contact).map((m) => m.contact!.id),
    );
    for (const c of contacts) {
      if (!pinnedIds.has(c.id)) continue;
      if (alreadyMergedIds.has(c.id)) continue;
      // 这条 push 没 chat → classification 也置 null（matchTodoBucket /
      // todoCounts 对 'pinned' 的判定都在 classification 之前，不影响）
      mergedList.push({
        contact: c,
        chat: null,
        jid: null,
        phone: c.phone ?? '',
        displayName:
          c.name || c.wa_name || c.phone || (c.group_jid ? '(群聊)' : '(无 WA 会话)'),
        labels: [],
        vehicleInterests: vehicleInterestsByContactId.get(c.id) ?? [],
        tags: tagsByContactId.get(c.id) ?? [],
        region: countryToRegion(c.country),
        pinned: true,
        classification: null,
      });
    }

    return {
      contacts: mergedList,
      labels: labels.filter((l) => l.isActive),
    };
  }, [dbState, waState]);

  // ----- 副作用：syncAutoStages throttled 跑 -----
  // 历史踩坑：merged.contacts 每次都是新引用（dbState/waState 任一变就重算），
  // WA poll 每 30s 就触发一次 syncAutoStages 全表对比。chat-classifier 因
  // @lid 多 chat 抖动会让 autoStage 在 active↔stalled↔lost↔new 反复跳，
  // 把 contact_events 表写到 7 天 88 万行（99.6% stage_changed auto=true）。
  //
  // 现在：每 10 分钟最多跑一次（remove 写事件后即便跑也只是几个 UPDATE，
  // 但还是不希望频繁动 DB；10min 足够让自动 stage 推断保持新鲜）。
  const lastStageSyncRef = useRef(0);
  useEffect(() => {
    if (merged.contacts.length === 0) return;
    const now = Date.now();
    if (now - lastStageSyncRef.current < 10 * 60 * 1000) return;
    lastStageSyncRef.current = now;
    void syncAutoStages(merged.contacts).catch((e) =>
      console.warn('[stage-sync]', stringifyError(e)),
    );
  }, [merged.contacts]);

  const setPinned = useCallback(
    async (contactId: string, pinned: boolean): Promise<void> => {
      // 1. 乐观更新：本地 state 立刻翻转
      setDbState((s) => {
        const next = new Set(s.pinnedIds);
        if (pinned) next.add(contactId);
        else next.delete(contactId);
        return { ...s, pinnedIds: next };
      });
      // 2. 后台写 DB
      try {
        if (pinned) {
          await pinContact(contactId);
        } else {
          await unpinContact(contactId);
        }
      } catch (err) {
        // 3. 失败回滚
        setDbState((s) => {
          const next = new Set(s.pinnedIds);
          if (pinned) next.delete(contactId);
          else next.add(contactId);
          return { ...s, pinnedIds: next };
        });
        throw err;
      }
    },
    [],
  );

  return {
    contacts: merged.contacts,
    labels: merged.labels,
    loading: dbState.loading,
    error: dbState.error,
    refresh: () => setRefetchNonce((n) => n + 1),
    setPinned,
  };
}
