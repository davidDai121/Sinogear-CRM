import { useEffect } from 'react';
import { useCurrentChat } from './useCurrentChat';
import { supabase } from '@/lib/supabase';
import { readChatMessages } from '@/content/whatsapp-messages';
import { isLeadMessage, parseLeadFields } from '@/lib/lead-detector';
import { matchVehicleFromText } from '@/lib/vehicle-matcher';
import {
  getState,
  isContactAutoReplyEnabled,
  isInFlight,
  setState,
  type AutoReplyState,
} from '@/lib/auto-reply-state';
import { readWhatsAppData, resolvePhone } from '@/lib/whatsapp-idb';
import {
  readRecentInboundMessages,
  type InboundMessage,
} from '@/lib/whatsapp-idb-messages';
import type { Database } from '@/lib/database.types';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];

/** 历史窗口——超出就不再当 lead / 续聊触发 */
const MAX_LEAD_AGE_MS = 24 * 60 * 60 * 1000;
/** 触发前的等待——从扫到那刻起算 */
const DELAY_MS = 1 * 60 * 1000;
/** 后台 IDB watcher 扫描间隔 */
const SCAN_INTERVAL_MS = 45_000;
/** 切换聊天后给 useContact 创建 contact 的时间窗口 */
const POLL_INTERVAL_MS = 1500;
const POLL_ATTEMPTS = 8;

/**
 * 上一轮后台扫描的 chat→最新消息指纹。没变就整轮跳过（见 runBackgroundScan）。
 * 模块级而非 ref：路径 B 的 effect 只会挂载一次，跨 orgId 切换重置由
 * fingerprint 本身天然处理（chat 集合变了指纹就变）。
 */
let lastScanFingerprint = '';

/**
 * 两路检测：
 *
 *   A. **chat-changed 触发**（即时）：用户切到某个 chat → 800ms 后跑
 *      `tryDetectAndSchedule(orgId, phone)`，仅扫当前 chat。
 *
 *   B. **后台 IDB watcher**（每 45s）：扫 WhatsApp IndexedDB 的 message store
 *      最近 24h 内的所有 inbound 消息。不依赖用户切 chat，客户没点开过的
 *      chat 也能识别 + 排队。需要的 contact 不存在时自动 insert 一条。
 *
 * 两路都过同一个 dedup：state.lastHandledInboundId + isInFlight 检查，
 * 同一条 inbound 不会重复排队。
 *
 * 群聊跳过（lead 是 1 对 1 的）。
 */
export function useLeadDetector(orgId: string | null): void {
  const chat = useCurrentChat();

  // ── A. chat-changed 即时路径 ──
  useEffect(() => {
    if (!orgId) return;
    if (!chat.phone) return;
    if (chat.groupJid) return;

    let cancelled = false;
    let attempt = 0;

    const tick = async () => {
      if (cancelled) return;
      attempt++;
      const done = await tryDetectAndSchedule(orgId, chat.phone!);
      if (done || cancelled) return;
      if (attempt < POLL_ATTEMPTS) {
        setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    setTimeout(tick, 800);
    return () => {
      cancelled = true;
    };
  }, [orgId, chat.phone, chat.groupJid]);

  // ── B. 后台 IDB watcher（每 45s 扫一遍）──
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runOnce = async () => {
      if (cancelled) return;
      try {
        await runBackgroundScan(orgId);
      } catch (err) {
        console.warn('[lead-watch] scan 失败', err);
      }
      if (cancelled) return;
      timer = setTimeout(runOnce, SCAN_INTERVAL_MS);
    };

    // 初次稍延迟，让 IDB / WA SPA 都就位
    timer = setTimeout(runOnce, 3000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orgId]);
}

// ────────────────────────────────────────────────────────────────────────
// 路径 A：chat-changed 时单 chat 扫
// ────────────────────────────────────────────────────────────────────────

/**
 * @returns true = 决策完毕，停止轮询；false = 数据未就绪，再 poll
 */
async function tryDetectAndSchedule(
  orgId: string,
  phone: string,
): Promise<boolean> {
  const messages = readChatMessages(20);
  if (messages.length === 0) return false; // DOM 还没渲完

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, phone, org_id')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle();
  if (!contact) return false; // useContact 还没插入

  if (!(await isContactAutoReplyEnabled(contact.id))) {
    console.log('[lead-detect] 此客户未开启自动回复（默认关），跳过', contact.id);
    return true;
  }

  const existing = await getState(contact.id);
  if (isInFlight(existing)) {
    console.log(
      '[lead-detect] 已有正在跑的 state，跳过',
      contact.id,
      existing!.phase,
    );
    return true;
  }

  const latestInbound = [...messages].reverse().find((m) => !m.fromMe);
  if (!latestInbound) return true;

  const fakeMsg: SimpleMsg = {
    id: latestInbound.id,
    text: latestInbound.text,
    ts: latestInbound.timestamp ?? Date.now(),
  };

  if (!existing) {
    return processFirstRound(orgId, contact.id, phone, fakeMsg);
  }
  return processFollowup(contact.id, fakeMsg, existing);
}

// ────────────────────────────────────────────────────────────────────────
// 路径 B：后台 IDB 全 chat 扫
// ────────────────────────────────────────────────────────────────────────

async function runBackgroundScan(orgId: string): Promise<void> {
  const sinceMs = Date.now() - MAX_LEAD_AGE_MS;
  const inbound = await readRecentInboundMessages(sinceMs);
  if (inbound.length === 0) return;

  // 每个 chat 留最新一条
  const latestByChat = new Map<string, InboundMessage>();
  for (const msg of inbound) {
    const cur = latestByChat.get(msg.chatId);
    if (!cur || cur.t < msg.t) latestByChat.set(msg.chatId, msg);
  }

  // 指纹门控：45s 一轮里绝大多数时候没有任何新消息，指纹没变就整轮跳过，
  // 一个网络请求都不发。指纹只认「哪些 chat 的最新一条是哪条」——
  // 新消息进来 msgId 变，新 chat 出现 size 变，都会让指纹变化。
  const fingerprint = Array.from(latestByChat.entries())
    .map(([chatId, m]) => `${chatId}:${m.msgId}`)
    .sort()
    .join('|');
  if (fingerprint === lastScanFingerprint) return;
  lastScanFingerprint = fingerprint;

  // 拉 WA contacts / chats 用于 jid → phone 解析 + 取 wa_name
  const wa = await readWhatsAppData();
  const waContactByJid = new Map(wa.contacts.map((c) => [c.id, c]));

  // ── 批量解析 phone → contactId ──
  // 旧实现在下面的循环里逐个 chat 调 ensureContact，每个发一次
  // `contacts?select=id&phone=eq.X`。实测一轮 63 个请求，45s 一轮 =
  // ~12 万请求/天/人（2026-08-19 抓包确认）。改成一次 .in() 批量查 +
  // 一次批量 insert 补缺，稳态下整轮 1 个请求。
  const pendingByPhone = new Map<
    string,
    { chatId: string; msg: InboundMessage; waName: string | null }
  >();
  for (const [chatId, msg] of latestByChat) {
    if (chatId.endsWith('@g.us')) continue; // 群聊跳过
    const phone = resolvePhone(chatId, wa.jidToPhoneJid);
    if (!phone) continue;
    const waContact = waContactByJid.get(chatId);
    const waName =
      waContact?.name ?? waContact?.shortName ?? waContact?.pushname ?? null;
    pendingByPhone.set(phone, { chatId, msg, waName });
  }
  if (pendingByPhone.size === 0) return;

  const contactIdByPhone = await resolveContactIds(orgId, pendingByPhone);

  let vehicles: VehicleRow[] | null = null;
  const getVehicles = async () => {
    if (vehicles === null) {
      const { data } = await supabase
        .from('vehicles')
        .select('*')
        .eq('org_id', orgId)
        .eq('sale_status', 'available');
      vehicles = (data ?? []) as VehicleRow[];
    }
    return vehicles;
  };

  for (const [phone, { msg }] of pendingByPhone) {
    const contactId = contactIdByPhone.get(phone);
    if (!contactId) continue;

    if (!(await isContactAutoReplyEnabled(contactId))) continue;

    const existing = await getState(contactId);
    if (isInFlight(existing)) continue;

    const simple: SimpleMsg = { id: msg.msgId, text: msg.body, ts: msg.t };

    if (!existing) {
      // 首轮——必须是 lead 格式
      if (!isLeadMessage(msg.body)) continue;
      await scheduleFirstRoundDirect(
        contactId,
        phone,
        simple,
        await getVehicles(),
      );
    } else {
      await scheduleFollowupDirect(contactId, simple, existing);
    }
  }
}

/**
 * 批量把 phone 解析成 contact id，缺的补建。
 *
 * 旧实现是每个 chat 一次 `contacts?select=id&phone=eq.X` 的 N+1——实测一轮
 * 63 个请求，45s 一轮 ≈ 12 万请求/天/人。这里改成：
 *   1. 一次 `.in('phone', ...)` 把已有的全查回来
 *   2. 缺的用一次批量 upsert 补建（onConflict 吞掉与 useContact / bulk-sync 的竞态）
 *   3. 再查一次拿回新建的 id
 * 稳态（没有新客户）下就是 1 个请求。
 */
async function resolveContactIds(
  orgId: string,
  pending: Map<string, { waName: string | null }>,
): Promise<Map<string, string>> {
  const phones = Array.from(pending.keys());
  const byPhone = new Map<string, string>();
  if (phones.length === 0) return byPhone;

  // PostgREST 的 .in() 走 URL query string，一次塞太多会撞 URL 长度上限
  const CHUNK = 100;
  for (let i = 0; i < phones.length; i += CHUNK) {
    const chunk = phones.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', orgId)
      .in('phone', chunk);
    if (error) {
      console.warn('[lead-watch] 批量查 contact 失败', error.message);
      return byPhone;
    }
    for (const row of data ?? []) {
      if (row.phone) byPhone.set(row.phone, row.id);
    }
  }

  const missing = phones.filter((p) => !byPhone.has(p));
  if (missing.length === 0) return byPhone;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const rows = chunk.map((phone) => {
      const waName = pending.get(phone)?.waName ?? null;
      return { org_id: orgId, phone, wa_name: waName, name: waName };
    });
    // ignoreDuplicates：另一路径（useContact / bulk-sync）可能刚插入同样的
    // (org, phone)，撞了就当已存在，下面统一回查
    const { error } = await supabase
      .from('contacts')
      .upsert(rows, { onConflict: 'org_id,phone', ignoreDuplicates: true });
    if (error) {
      console.warn('[lead-watch] 批量建 contact 失败', error.message);
      continue;
    }
    const { data } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', orgId)
      .in('phone', chunk);
    for (const row of data ?? []) {
      if (row.phone) byPhone.set(row.phone, row.id);
    }
  }
  return byPhone;
}

// ────────────────────────────────────────────────────────────────────────
// 共享：first round / followup 排队逻辑
// ────────────────────────────────────────────────────────────────────────

interface SimpleMsg {
  id: string;
  text: string;
  ts: number;
}

async function processFirstRound(
  orgId: string,
  contactId: string,
  phone: string,
  msg: SimpleMsg,
): Promise<boolean> {
  if (!isLeadMessage(msg.text)) return true; // 不归我管

  if (Date.now() - msg.ts > MAX_LEAD_AGE_MS) {
    console.log(
      '[lead-detect] lead 太老 (>24h)，跳过',
      Math.round((Date.now() - msg.ts) / 60000),
      '分钟前',
    );
    return true;
  }

  const { data: vehicles } = await supabase
    .from('vehicles')
    .select('*')
    .eq('org_id', orgId)
    .eq('sale_status', 'available');

  await scheduleFirstRoundDirect(
    contactId,
    phone,
    msg,
    (vehicles ?? []) as VehicleRow[],
  );
  return true;
}

async function scheduleFirstRoundDirect(
  contactId: string,
  phone: string,
  msg: SimpleMsg,
  vehicles: VehicleRow[],
): Promise<void> {
  if (Date.now() - msg.ts > MAX_LEAD_AGE_MS) return;

  const vehicle = matchVehicleFromText(msg.text, vehicles);
  const fields = parseLeadFields(msg.text);
  // 从现在起算 DELAY_MS（不是 msg.ts + DELAY_MS）— 保证倒计时可见
  const scheduledAt = Date.now() + DELAY_MS;

  const state: AutoReplyState = {
    contactId,
    phone,
    leadArrivedAt: msg.ts,
    scheduledAt,
    vehicleId: vehicle?.id ?? null,
    leadText: msg.text,
    lastInboundText: msg.text,
    vehicleHint: fields.vehicleHint,
    roundCount: 0,
    lastHandledInboundId: msg.id,
    phase: 'scheduled',
    updatedAt: Date.now(),
  };
  await setState(state);
  await scheduleAlarm(contactId, scheduledAt);
  console.log(
    '[lead-detect] 首轮已排',
    contactId,
    phone,
    '触发',
    new Date(scheduledAt).toLocaleTimeString(),
    vehicle ? `匹配车: ${vehicle.brand} ${vehicle.model}` : '未匹配车',
  );
  notifyStateChanged(contactId);
}

async function processFollowup(
  contactId: string,
  msg: SimpleMsg,
  prev: AutoReplyState,
): Promise<boolean> {
  await scheduleFollowupDirect(contactId, msg, prev);
  return true;
}

async function scheduleFollowupDirect(
  contactId: string,
  msg: SimpleMsg,
  prev: AutoReplyState,
): Promise<void> {
  if (msg.id === prev.lastHandledInboundId) return;
  if (Date.now() - msg.ts > MAX_LEAD_AGE_MS) {
    console.log('[lead-detect] 客户新消息太老，跳过续聊', msg.id);
    return;
  }

  const scheduledAt = Date.now() + DELAY_MS;
  const next: AutoReplyState = {
    ...prev,
    phase: 'scheduled',
    roundCount: (prev.roundCount ?? 0) + 1,
    lastHandledInboundId: msg.id,
    lastInboundText: msg.text,
    leadArrivedAt: msg.ts,
    scheduledAt,
    error: undefined,
    imagesSentAt: undefined,
    gemStartedAt: undefined,
    replyFilledAt: undefined,
    doneAt: undefined,
    updatedAt: Date.now(),
  };
  await setState(next);
  await scheduleAlarm(contactId, scheduledAt);
  console.log(
    '[lead-detect] 续聊已排',
    contactId,
    `round ${next.roundCount}`,
    '触发',
    new Date(scheduledAt).toLocaleTimeString(),
  );
  notifyStateChanged(contactId);
}

async function scheduleAlarm(
  contactId: string,
  fireAt: number,
): Promise<void> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'SCHEDULE_AUTO_REPLY',
    contactId,
    fireAt,
  })) as { ok: boolean; error?: string };
  if (!resp?.ok) {
    console.warn('[lead-detect] SW SCHEDULE_AUTO_REPLY 失败', resp?.error);
  }
}

function notifyStateChanged(contactId: string): void {
  window.dispatchEvent(
    new CustomEvent('sgc:auto-reply-state-changed', {
      detail: { contactId },
    }),
  );
}
