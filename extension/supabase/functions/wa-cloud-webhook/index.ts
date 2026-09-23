// WhatsApp Cloud API webhook receiver（coexistence 模式）
//
// 背景：2026-08-19 排查确认，扩展靠抓 WhatsApp Web DOM 攒 messages 表，
// 只覆盖「人点开过的聊天」的「渲染出来的 30 条」——近 7 天实测丢 69%，
// 还产生 5733 条无时间戳的行。coexistence 接上之后消息由 Meta 主动推来，
// 这条路可以退役。
//
// coexistence = 同一个号码同时挂 WhatsApp Business App 和 Cloud API：
//   - 销售继续在 App / WhatsApp Web 里干活，标签目录群组照旧
//   - 客户来信      → 'messages' 字段
//   - 销售发出去的  → 'smb_message_echoes' 字段（关键，否则只有一半对话）
//   - 接入时 180 天历史 → 'history' 字段，分 day0-1 / 1-90 / 90-180 三段推
//   - 手机通讯录       → 'smb_app_state_sync' 字段（Meta 要求必须订阅），只用来给
//     还没名字的客户补上销售存的备注名
//
// 业务号码（0043/0044）：每个 change 的 metadata.display_phone_number 是我们自己的号。
//   - 号码登记在哪个 org，消息就写进哪个 org（测试号 1355 在独立测试 org，不进主库）；
//     没登记过的新号码走 FB_ORG_ID
//   - 每条消息记 business_phone，分得清是哪个业务员的对话
//   - 没有任何主理人的客户，归给这个号在 wa_business_numbers 里登记的业务员
//   - 刷新 last_webhook_at：App 13–14 天不打开会静默断开，靠它发现
//
// ⚠️ 只有受支持的 companion device 会触发 echo：WhatsApp Web / WhatsApp for Mac 可以，
//    WhatsApp for Windows 和 WearOS 不行——那些设备发的消息会静默不同步。
//
// 部署：supabase functions deploy wa-cloud-webhook --no-verify-jwt
//   （Meta 不带 JWT，必须公开。安全靠 verify_token + X-Hub-Signature-256）
//
// 必需 env vars：
//   FB_APP_SECRET      - 算 X-Hub-Signature-256
//   WA_VERIFY_TOKEN    - 订阅握手用，没配则回退到 FB_VERIFY_TOKEN
//   FB_ORG_ID          - 默认 org：没在 wa_business_numbers 登记过的号码归这里
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY（自动注入）

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const FB_APP_SECRET = Deno.env.get('FB_APP_SECRET') ?? '';
const VERIFY_TOKEN =
  Deno.env.get('WA_VERIFY_TOKEN') ?? Deno.env.get('FB_VERIFY_TOKEN') ?? '';
const ORG_ID = Deno.env.get('FB_ORG_ID') ?? '';
// 通过 Dualhook（BSP）接入的号码：WABA 订阅在 Dualhook 的 Meta App 上，Meta 用它的 app secret
// 签名，我们验不了（Dualhook 文档明说不会重新签名）。改用「回调地址里的高熵密钥段」认证：
//   https://…/functions/v1/wa-cloud-webhook/<WA_PATH_SECRET>
// 并且这条路径只收已登记在 wa_business_numbers 的号码，陌生号码一律 403。
const WA_PATH_SECRET = Deno.env.get('WA_PATH_SECRET') ?? '';

function pathSecretOk(pathname: string): boolean {
  if (WA_PATH_SECRET.length < 24) return false;
  const seg = pathname.split('/').filter(Boolean).pop() ?? '';
  if (seg.length !== WA_PATH_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < seg.length; i++) diff |= seg.charCodeAt(i) ^ WA_PATH_SECRET.charCodeAt(i);
  return diff === 0;
}

const MESSAGE_UPSERT_CHUNK = 500;
const CONTACT_LOOKUP_CHUNK = 100;

// ─────────────────────────────────────────────────────────
// 签名 / 手机号（与 fb-lead-webhook 同款，两个函数各自独立部署故不共享模块）
// ─────────────────────────────────────────────────────────

async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!FB_APP_SECRET || !/^sha256=[0-9a-f]{64}$/.test(signatureHeader ?? '')) return false;
  const expected = signatureHeader!.slice(7);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(FB_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  );
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (expected.length !== computed.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ computed.charCodeAt(i);
  }
  return diff === 0;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  return digits ? '+' + digits : '';
}

// ─────────────────────────────────────────────────────────
// wamid → WhatsApp 原生 key_id
// ─────────────────────────────────────────────────────────

/**
 * Cloud API 用 `wamid.<base64>` 标识消息，而 messages.wa_message_id 里存的是
 * WhatsApp 原生 key_id（形如 3EB0C92FBCD18A6747989F / AC1B15F3...）——
 * DOM 抓取和 crypt15 备份导入用的都是它。
 *
 * wamid 解开来是：
 *   \x1c\x18<len><手机号ascii>\x15\x02\x00\x11\x18<len><KEYID ascii>\x00
 * 抠出 KEYID，新消息就能和已入库的 118,506 条靠
 * (contact_id, wa_message_id) 唯一约束天然去重，不会重复也不用迁移。
 *
 * 解不出来时回退到整个 wamid 字符串——宁可偶尔重复一条，也不能丢。
 */
function wamidToKeyId(wamid: string): string {
  if (!wamid?.startsWith('wamid.')) return wamid;
  try {
    const b64 = wamid.slice(6).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // 从后往前找 \x11\x18 标记
    let idx = -1;
    for (let i = bytes.length - 3; i >= 0; i--) {
      if (bytes[i] === 0x11 && bytes[i + 1] === 0x18) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return wamid;
    const len = bytes[idx + 2]!;
    const slice = bytes.subarray(idx + 3, idx + 3 + len);
    const out = new TextDecoder('ascii').decode(slice);
    return /^[0-9A-F]{8,}$/.test(out) ? out : wamid;
  } catch {
    return wamid;
  }
}

// ─────────────────────────────────────────────────────────
// 消息正文归一化（跟 DOM / 备份两条路径的占位符保持一致）
// ─────────────────────────────────────────────────────────

function messageText(m: Record<string, any>): string {
  const type = String(m.type ?? '');
  switch (type) {
    case 'text':
      return String(m.text?.body ?? '').trim() || '[媒体]';
    case 'image':
      return String(m.image?.caption ?? '').trim() || '[图片]';
    case 'video':
      return String(m.video?.caption ?? '').trim() || '[媒体]';
    case 'document':
      return (
        String(m.document?.caption ?? m.document?.filename ?? '').trim() ||
        '[媒体]'
      );
    case 'audio':
      return '[语音]';
    case 'button':
      return String(m.button?.text ?? '').trim() || '[媒体]';
    case 'interactive':
      return (
        String(
          m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            '',
        ).trim() || '[媒体]'
      );
    case 'reaction':
      return String(m.reaction?.emoji ?? '').trim() || '[媒体]';
    case 'unsupported':
      return '[媒体]';
    default:
      return '[媒体]';
  }
}

interface ParsedMsg {
  phone: string;
  keyId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  sentAt: string;
  /** Click-to-WhatsApp 广告点击 id，只有广告来的第一条有 */
  ctwaClid: string | null;
  /** 广告创意 id */
  adId: string | null;
  /** WhatsApp 侧的显示名，用来给新建 contact 填 wa_name */
  waName: string | null;
  /** 我们自己的业务号（metadata.display_phone_number），缺失时为 null */
  businessPhone: string | null;
}

interface ParseContext {
  /** 本次载荷里出现的业务号 → Meta phone_number_id */
  numbers: Map<string, string | null>;
  /** 通讯录同步：销售存的备注名（按业务号区分，才知道写进哪个 org） */
  names: Array<{ business: string | null; phone: string; name: string }>;
  /** 历史回填里跳过的畸形消息数 */
  skipped?: number;
  /** 跳过的原始消息，存进 wa_webhook_failures 留着补录 */
  skippedRaw?: Array<{ business: string | null; message: unknown }>;
}

function tsToIso(t: unknown): string | null {
  const n = typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : typeof t === 'number' ? t : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Cloud API 给的是秒
  const date = new Date(n > 1e12 ? n : n * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 解析 'messages'（客户来信）和 'smb_message_echoes'（销售发出）两种载荷 */
function parseChange(
  field: string,
  value: Record<string, any>,
  out: ParsedMsg[],
  ctx: ParseContext,
): void {
  const business = normalizePhone(String(value.metadata?.display_phone_number ?? '')) || null;
  if (business) {
    const id = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;
    ctx.numbers.set(business, id ?? ctx.numbers.get(business) ?? null);
  }

  const nameByWaId = new Map<string, string>();
  for (const c of value.contacts ?? []) {
    if (c?.wa_id && c?.profile?.name) nameByWaId.set(String(c.wa_id), String(c.profile.name));
  }

  const push = (
    m: Record<string, any>,
    direction: 'inbound' | 'outbound',
    customer?: unknown,
  ) => {
    // inbound 用 from（客户号）；echo 用 to（客户号）——两边都要归到客户身上。
    // history 里我方发出的消息只有 from（=我们的号），没有 to，客户号在外层 thread.id，
    // 由调用方传进来；不传的话 180 天历史里所有出站消息都会被当成畸形拒收。
    const raw = customer ?? (direction === 'inbound' ? m.from : (m.to ?? m.recipient_id));
    const phone = normalizePhone(String(raw ?? ''));
    const sentAt = tsToIso(m.timestamp);
    if (!phone || !m.id || !sentAt) throw new Error('Malformed message: missing phone, id or timestamp');
    // 群聊 Cloud API 本来就不推，这里再挡一道
    if (String(raw ?? '').includes('-')) return;
    out.push({
      phone,
      keyId: wamidToKeyId(String(m.id)),
      direction,
      text: messageText(m),
      sentAt,
      ctwaClid: m.referral?.ctwa_clid ? String(m.referral.ctwa_clid) : null,
      adId: m.referral?.source_id ? String(m.referral.source_id) : null,
      waName: nameByWaId.get(String(raw ?? '')) ?? null,
      businessPhone: business,
    });
  };

  if (field === 'messages') {
    for (const m of value.messages ?? []) push(m, 'inbound');
    // statuses（已送达/已读回执）不入库——只关心消息本身
  } else if (field === 'smb_message_echoes') {
    for (const m of value.message_echoes ?? []) push(m, 'outbound');
  } else if (field === 'smb_app_state_sync') {
    // [{ type:'contact', action:'add'|'edit'|'remove', contact:{ full_name, first_name, phone_number } }]
    for (const item of value.state_sync ?? []) {
      if (item?.type !== 'contact' || item?.action === 'remove') continue;
      const phone = normalizePhone(String(item.contact?.phone_number ?? ''));
      const name = String(item.contact?.full_name ?? item.contact?.first_name ?? '').trim();
      if (phone && name) ctx.names.push({ business, phone, name });
    }
  } else if (field === 'history') {
    // 接入时的 180 天回填：history[].messages[]，每条自带 from/to，
    // 用 from == 本商户号 判方向；商户号在 value.metadata.display_phone_number
    const selfRaw = String(value.metadata?.display_phone_number ?? '');
    const self = normalizePhone(selfRaw);
    if (!self && (value.history ?? []).some((chunk: any) => chunk.threads?.length)) {
      throw new Error('History messages require business phone identity');
    }
    // 历史回填是尽力而为：一条畸形（系统消息、没 id/时间戳）只跳过，不能让整批 673 个会话 503 重试到死
    const tryPush = (m: Record<string, any>, direction: 'inbound' | 'outbound', customer?: unknown) => {
      try {
        push(m, direction, customer);
      } catch {
        ctx.skipped = (ctx.skipped ?? 0) + 1;
        (ctx.skippedRaw ??= []).push({ business, message: m });
      }
    };
    for (const chunk of value.history ?? []) {
      for (const thread of chunk.threads ?? []) {
        // 客户号优先取 context.wa_id（thread.id 可能是 Meta 的用户 id 而不是手机号）
        const customer = thread.context?.wa_id ?? thread.id;
        for (const m of thread.messages ?? []) {
          const from = normalizePhone(String(m.from ?? ''));
          tryPush(m, self && from === self ? 'outbound' : 'inbound', customer ?? m.from);
        }
      }
    }
    // 历史里我方发出的媒体消息 Meta 以 message_echoes 形式放在 history 字段下（自带 to）
    for (const m of value.message_echoes ?? []) tryPush(m, 'outbound');
    for (const m of value.messages ?? []) tryPush(m, 'inbound');
  }
}

// ─────────────────────────────────────────────────────────

async function recordStats(
  supabase: any,
  org: string,
  phone: string,
  c: { received: number; inserted: number; skipped: number; failed: number },
): Promise<void> {
  const { error } = await supabase.rpc('wa_record_stats', {
    p_org: org, p_phone: phone,
    p_received: c.received, p_inserted: c.inserted, p_skipped: c.skipped, p_failed: c.failed,
  });
  if (error) console.warn('[wa-webhook] 健康度计数失败', phone);
}

// ─────────────────────────────────────────────────────────
// 单个 org 的入库：通讯录补名 → 建客户 → 写消息 → 归属 → 广告归因
// ─────────────────────────────────────────────────────────

async function ingestForOrg(
  supabase: any,
  org: string,
  msgs: ParsedMsg[],
  names: ParseContext['names'],
  numberInfo: Map<string, { org: string; user: string | null }>,
): Promise<{ named: number; inserted: number; assigned: number; attributed: number }> {
  // ── 通讯录同步：只给已有、还没名字的客户补名，不新建客户 ──
  let named = 0;
  const nameOf = new Map(names.map((n) => [n.phone, n.name] as const));
  if (nameOf.size > 0) {
    const phones = Array.from(nameOf.keys());
    for (let i = 0; i < phones.length; i += CONTACT_LOOKUP_CHUNK) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, phone, name')
        .eq('org_id', org)
        .in('phone', phones.slice(i, i + CONTACT_LOOKUP_CHUNK));
      if (error) throw new Error('Contact lookup failed');
      for (const c of data ?? []) {
        if (c.name || !c.phone || !nameOf.has(c.phone)) continue;
        const { error: nameError } = await supabase
          .from('contacts')
          .update({ name: nameOf.get(c.phone) })
          .eq('org_id', org)
          .eq('id', c.id)
          .is('name', null);
        if (nameError) throw new Error('Contact name update failed');
        named++;
      }
    }
  }

  if (msgs.length === 0) return { named, inserted: 0, assigned: 0, attributed: 0 };

  // ── phone → contact_id，缺的批量建 ──
  const phones = Array.from(new Set(msgs.map((m) => m.phone)));
  const byPhone = new Map<string, string>();
  for (let i = 0; i < phones.length; i += CONTACT_LOOKUP_CHUNK) {
    const chunk = phones.slice(i, i + CONTACT_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', org)
      .in('phone', chunk);
    if (error) throw new Error('Contact lookup failed');
    for (const r of data ?? []) if (r.phone) byPhone.set(r.phone, r.id);
  }
  const missing = phones.filter((p) => !byPhone.has(p));
  if (missing.length > 0) {
    const waNameOf = new Map<string, string>();
    for (const m of msgs) if (m.waName && !waNameOf.has(m.phone)) waNameOf.set(m.phone, m.waName);
    const rows = missing.map((phone) => ({
      org_id: org,
      phone,
      wa_name: waNameOf.get(phone) ?? null,
      name: waNameOf.get(phone) ?? null,
    }));
    // ignoreDuplicates：extension 那边可能同时在建同一个 (org, phone)
    const { error: createError } = await supabase
      .from('contacts')
      .upsert(rows, { onConflict: 'org_id,phone', ignoreDuplicates: true });
    if (createError) throw new Error('Contact creation failed');
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', org)
      .in('phone', missing);
    if (error) throw new Error('Contact lookup failed');
    for (const r of data ?? []) if (r.phone) byPhone.set(r.phone, r.id);
  }

  // ── 写消息 ──
  const rows = msgs
    .map((m) => {
      const contactId = byPhone.get(m.phone);
      if (!contactId) throw new Error('Contact unresolved after creation');
      return {
        contact_id: contactId,
        wa_message_id: m.keyId,
        direction: m.direction,
        text: m.text,
        sent_at: m.sentAt,
        business_phone: m.businessPhone,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    // 按 contact 排序：messages 的统计触发器是 statement 级的，
    // 同一 statement 里聚集少数 contact 能少做重复重建
    .sort((a, b) => a.contact_id.localeCompare(b.contact_id));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += MESSAGE_UPSERT_CHUNK) {
    const { error, count } = await supabase
      .from('messages')
      .upsert(rows.slice(i, i + MESSAGE_UPSERT_CHUNK), {
        onConflict: 'contact_id,wa_message_id',
        ignoreDuplicates: true, // DOM / 备份路径先写的行胜出，ai_source 归因不被覆盖
        count: 'exact',
      });
    if (error) throw new Error('Message write failed');
    inserted += count ?? 0;
  }

  // ── 没有主理人的客户 → 归给这个业务号登记的业务员 ──
  // 只动「一个主理人都没有」的客户：已有人跟的、共享给多人的都不碰。
  let assigned = 0;
  {
    const ownerOf = new Map<string, string>();
    for (const [phone, info] of numberInfo) if (info.user) ownerOf.set(phone, info.user);

    // 每个客户取最早一条消息所在的业务号（同一批里跟两个号都聊过时，先聊的算）
    const wanted = new Map<string, string>();
    for (const m of [...msgs].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
      const contactId = byPhone.get(m.phone);
      const owner = m.businessPhone ? ownerOf.get(m.businessPhone) : undefined;
      if (contactId && owner && !wanted.has(contactId)) wanted.set(contactId, owner);
    }
    const ids = Array.from(wanted.keys());
    for (let i = 0; i < ids.length; i += CONTACT_LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + CONTACT_LOOKUP_CHUNK);
      const { data: existing, error: handlerError } = await supabase
        .from('contact_handlers')
        .select('contact_id')
        .in('contact_id', chunk);
      if (handlerError) throw new Error('Handler lookup failed');
      const owned = new Set((existing ?? []).map((h: { contact_id: string }) => h.contact_id));
      const rowsToAdd = chunk
        .filter((id) => !owned.has(id))
        .map((id) => ({ contact_id: id, user_id: wanted.get(id)! }));
      if (rowsToAdd.length === 0) continue;
      const { error: addError } = await supabase
        .from('contact_handlers')
        .upsert(rowsToAdd, { onConflict: 'contact_id,user_id', ignoreDuplicates: true });
      if (addError) throw new Error('Handler assignment failed');
      assigned += rowsToAdd.length;
    }
  }

  // ── 广告归因：把 ctwa_clid / fb_ad_id 落到 contact 上 ──
  // 这是接 coexistence 的头号动机：全库 9100 个客户这三个字段一直是 0，
  // 导致 Meta 只能拿「表单提交」当优化目标。
  let attributed = 0;
  for (const m of msgs) {
    if (!m.ctwaClid) continue;
    const contactId = byPhone.get(m.phone);
    if (!contactId) continue;
    // 事件按消息确定 ID；重试不重复写，且不能因 contact 已更新就漏掉事件。
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(`wa-ctwa:${contactId}:${m.keyId}`)));
    digest[6] = (digest[6]! & 0x0f) | 0x50;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
    const eventId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const { error: eventError } = await supabase.from('contact_events').upsert({
      id: eventId,
      contact_id: contactId,
      event_type: 'fb_lead_received',
      payload: { source: 'ctwa', ctwa_clid: m.ctwaClid, ad_id: m.adId },
      created_at: m.sentAt,
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (eventError) throw new Error('Attribution event write failed');
    const { error: attributionError } = await supabase
      .from('contacts')
      .update({ ctwa_clid: m.ctwaClid, fb_ad_id: m.adId })
      .eq('org_id', org)
      .eq('id', contactId)
      .is('ctwa_clid', null);
    if (attributionError) throw new Error('Attribution update failed');
    attributed++;
  }

  return { named, inserted, assigned, attributed };
}

serve(async (req) => {
  const url = new URL(req.url);

  // ── GET: 订阅验证握手 ──
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (VERIFY_TOKEN && mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Verification failed', { status: 403 });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();
  // 我们自己 App 的签名优先；验不过再看是不是 Dualhook 路径（密钥段 + 登记号码，下面再核）
  const signed = await verifySignature(rawBody, req.headers.get('x-hub-signature-256'));
  if (!signed && !pathSecretOk(url.pathname)) {
    console.warn('[wa-webhook] 签名校验失败');
    return new Response('Invalid signature', { status: 403 });
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return new Response('Invalid payload', { status: 400 });
  }
  if (payload.object !== 'whatsapp_business_account') {
    return new Response('OK', { status: 200 }); // 别的订阅，无害忽略
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey || !ORG_ID) {
    console.error('[wa-webhook] 缺 env vars');
    // 未入库不能确认接收；保留 Meta 的重试机会。
    return new Response('Receiver not configured', { status: 503 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // 放在 try 外面：失败分支也要知道是哪个号出的错，记健康度
  const msgs: ParsedMsg[] = [];
  const ctx: ParseContext = { numbers: new Map(), names: [] };
  const numberInfo = new Map<string, { org: string; user: string | null }>();
  const orgOf = (business: string | null) =>
    (business ? numberInfo.get(business)?.org : undefined) ?? ORG_ID;
  try {
    // ── 解析所有 change ──
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        try {
          parseChange(String(change.field ?? ''), change.value ?? {}, msgs, ctx);
        } catch {
          throw new Error(`Invalid change: ${String(change.field ?? '')}`);
        }
      }
    }

    // ── 业务号码登记：决定写进哪个 org、归哪个业务员 ──
    const seenNumbers = Array.from(ctx.numbers.keys());
    if (seenNumbers.length > 0) {
      const { data: registered, error: registryError } = await supabase
        .from('wa_business_numbers')
        .select('phone, org_id, user_id')
        .in('phone', seenNumbers);
      if (registryError) throw new Error('Business number lookup failed');
      for (const r of registered ?? []) {
        numberInfo.set(r.phone, { org: r.org_id ?? ORG_ID, user: r.user_id ?? null });
      }
    }
    // Dualhook 路径没有签名兜底：每条内容都必须来自已登记的业务号，否则整批拒收、不落任何数据
    if (!signed) {
      const unknown =
        msgs.some((m) => !m.businessPhone || !numberInfo.has(m.businessPhone)) ||
        ctx.names.some((n) => !n.business || !numberInfo.has(n.business)) ||
        seenNumbers.some((p) => !numberInfo.has(p));
      if (unknown) {
        console.warn('[wa-webhook] 密钥路径收到未登记号码，拒收', seenNumbers.join(','));
        return new Response('Unknown business number', { status: 403 });
      }
    }
    // ── 心跳：哪个号还活着。失败不影响消息入库，不返回 503 ──
    const now = new Date().toISOString();
    for (const [phone, phoneNumberId] of ctx.numbers) {
      const row: Record<string, unknown> = { org_id: orgOf(phone), phone, last_webhook_at: now };
      if (phoneNumberId) row.phone_number_id = phoneNumberId;
      const { error } = await supabase
        .from('wa_business_numbers')
        .upsert(row, { onConflict: 'org_id,phone' });
      if (error) console.warn('[wa-webhook] 心跳写入失败', phone);
    }

    // ── 按业务号分组入库（一个号只属于一个 org），顺便得到每个号的入库数 ──
    const phones = new Set<string | null>([
      ...msgs.map((m) => m.businessPhone),
      ...ctx.names.map((n) => n.business),
    ]);
    let named = 0;
    let inserted = 0;
    let assigned = 0;
    let attributed = 0;
    const insertedByPhone = new Map<string | null, number>();
    for (const phone of phones) {
      const r = await ingestForOrg(
        supabase,
        orgOf(phone),
        msgs.filter((m) => m.businessPhone === phone),
        ctx.names.filter((n) => n.business === phone),
        numberInfo,
      );
      named += r.named;
      inserted += r.inserted;
      assigned += r.assigned;
      attributed += r.attributed;
      insertedByPhone.set(phone, r.inserted);
    }

    // ── 健康度：计数 + 跳过的原文。都是尽力而为，失败不影响本次 200 ──
    for (const phone of new Set([...ctx.numbers.keys(), ...phones])) {
      if (!phone) continue;
      await recordStats(supabase, orgOf(phone), phone, {
        received: msgs.filter((m) => m.businessPhone === phone).length,
        inserted: insertedByPhone.get(phone) ?? 0,
        skipped: (ctx.skippedRaw ?? []).filter((x) => x.business === phone).length,
        failed: 0,
      });
    }
    if (ctx.skippedRaw?.length) {
      const { error } = await supabase.from('wa_webhook_failures').insert(
        ctx.skippedRaw.map((x) => ({
          org_id: orgOf(x.business),
          phone: x.business,
          kind: 'message_skipped',
          reason: 'missing phone, id or timestamp',
          payload: x.message,
        })),
      );
      if (error) console.warn('[wa-webhook] 跳过消息原文保存失败');
    }

    console.log(
      `[wa-webhook] 解析 ${msgs.length} 条，入库 ${inserted} 条，新归属 ${assigned} 个，` +
        `广告归因 ${attributed} 个，通讯录补名 ${named} 个` +
        (ctx.skipped ? `，历史跳过畸形 ${ctx.skipped} 条` : ''),
    );
    return new Response('OK', { status: 200 });
  } catch (error) {
    // 不记录完整载荷或客户聊天；成功落库前不返回 200。
    const reason = error instanceof Error ? error.message : 'unknown';
    console.error('[wa-webhook] Receive failed:', reason);
    // 失败也要看得见：整批原文留底（Meta 会重推，重推成功后这条只作记录），计数 + 卡片报错
    try {
      const failedPhones = Array.from(ctx.numbers.keys());
      await supabase.from('wa_webhook_failures').insert({
        org_id: orgOf(failedPhones[0] ?? null),
        phone: failedPhones[0] ?? null,
        kind: 'batch_failed',
        reason,
        payload,
      });
      const at = new Date().toISOString();
      for (const phone of failedPhones) {
        await recordStats(supabase, orgOf(phone), phone, { received: 0, inserted: 0, skipped: 0, failed: 1 });
        await supabase.from('wa_business_numbers')
          .update({ last_error: reason, last_error_at: at })
          .eq('org_id', orgOf(phone))
          .eq('phone', phone);
      }
    } catch {
      console.warn('[wa-webhook] 失败记录写入也失败了');
    }
    return new Response('Retry later', { status: 503 });
  }
});
