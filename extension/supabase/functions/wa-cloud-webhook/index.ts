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
//   FB_ORG_ID          - 消息归到哪个 CRM org
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY（自动注入）

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const FB_APP_SECRET = Deno.env.get('FB_APP_SECRET') ?? '';
const VERIFY_TOKEN =
  Deno.env.get('WA_VERIFY_TOKEN') ?? Deno.env.get('FB_VERIFY_TOKEN') ?? '';
const ORG_ID = Deno.env.get('FB_ORG_ID') ?? '';

const MESSAGE_UPSERT_CHUNK = 500;
const CONTACT_LOOKUP_CHUNK = 100;

// ─────────────────────────────────────────────────────────
// 签名 / 手机号（与 fb-lead-webhook 同款，两个函数各自独立部署故不共享模块）
// ─────────────────────────────────────────────────────────

async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !FB_APP_SECRET) return false;
  const expected = signatureHeader.replace(/^sha256=/, '');
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
}

function tsToIso(t: unknown): string | null {
  const n = typeof t === 'string' ? parseInt(t, 10) : typeof t === 'number' ? t : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Cloud API 给的是秒
  return new Date((n > 1e12 ? n : n * 1000)).toISOString();
}

/** 解析 'messages'（客户来信）和 'smb_message_echoes'（销售发出）两种载荷 */
function parseChange(
  field: string,
  value: Record<string, any>,
  out: ParsedMsg[],
): void {
  const nameByWaId = new Map<string, string>();
  for (const c of value.contacts ?? []) {
    if (c?.wa_id && c?.profile?.name) nameByWaId.set(String(c.wa_id), String(c.profile.name));
  }

  const push = (m: Record<string, any>, direction: 'inbound' | 'outbound') => {
    // inbound 用 from（客户号）；echo 用 to（客户号）——两边都要归到客户身上
    const raw = direction === 'inbound' ? m.from : (m.to ?? m.recipient_id);
    const phone = normalizePhone(String(raw ?? ''));
    const sentAt = tsToIso(m.timestamp);
    if (!phone || !m.id || !sentAt) return;
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
    });
  };

  if (field === 'messages') {
    for (const m of value.messages ?? []) push(m, 'inbound');
    // statuses（已送达/已读回执）不入库——只关心消息本身
  } else if (field === 'smb_message_echoes') {
    for (const m of value.message_echoes ?? []) push(m, 'outbound');
  } else if (field === 'history') {
    // 接入时的 180 天回填：history[].messages[]，每条自带 from/to，
    // 用 from == 本商户号 判方向；商户号在 value.metadata.display_phone_number
    const selfRaw = String(value.metadata?.display_phone_number ?? '');
    const self = normalizePhone(selfRaw);
    for (const chunk of value.history ?? []) {
      for (const thread of chunk.threads ?? []) {
        for (const m of thread.messages ?? []) {
          const from = normalizePhone(String(m.from ?? ''));
          push(m, self && from === self ? 'outbound' : 'inbound');
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────

serve(async (req) => {
  const url = new URL(req.url);

  // ── GET: 订阅验证握手 ──
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Verification failed', { status: 403 });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();
  if (!(await verifySignature(rawBody, req.headers.get('x-hub-signature-256')))) {
    console.warn('[wa-webhook] 签名校验失败');
    return new Response('Invalid signature', { status: 403 });
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (payload.object !== 'whatsapp_business_account') {
    return new Response('OK', { status: 200 }); // 别的订阅，无害忽略
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey || !ORG_ID) {
    console.error('[wa-webhook] 缺 env vars');
    // 给 200——否则 Meta 会重推并最终禁用订阅，日志里已经记下了
    return new Response('OK', { status: 200 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // ── 解析所有 change ──
  const msgs: ParsedMsg[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      try {
        parseChange(String(change.field ?? ''), change.value ?? {}, msgs);
      } catch (err) {
        console.error('[wa-webhook] 解析 change 失败', change.field, err);
      }
    }
  }
  if (msgs.length === 0) return new Response('OK', { status: 200 });

  // ── phone → contact_id，缺的批量建 ──
  const phones = Array.from(new Set(msgs.map((m) => m.phone)));
  const byPhone = new Map<string, string>();
  for (let i = 0; i < phones.length; i += CONTACT_LOOKUP_CHUNK) {
    const chunk = phones.slice(i, i + CONTACT_LOOKUP_CHUNK);
    const { data } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', ORG_ID)
      .in('phone', chunk);
    for (const r of data ?? []) if (r.phone) byPhone.set(r.phone, r.id);
  }
  const missing = phones.filter((p) => !byPhone.has(p));
  if (missing.length > 0) {
    const nameOf = new Map<string, string>();
    for (const m of msgs) if (m.waName && !nameOf.has(m.phone)) nameOf.set(m.phone, m.waName);
    const rows = missing.map((phone) => ({
      org_id: ORG_ID,
      phone,
      wa_name: nameOf.get(phone) ?? null,
      name: nameOf.get(phone) ?? null,
    }));
    // ignoreDuplicates：extension 那边可能同时在建同一个 (org, phone)
    await supabase
      .from('contacts')
      .upsert(rows, { onConflict: 'org_id,phone', ignoreDuplicates: true });
    const { data } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', ORG_ID)
      .in('phone', missing);
    for (const r of data ?? []) if (r.phone) byPhone.set(r.phone, r.id);
  }

  // ── 写消息 ──
  const rows = msgs
    .map((m) => {
      const contactId = byPhone.get(m.phone);
      if (!contactId) return null;
      return {
        contact_id: contactId,
        wa_message_id: m.keyId,
        direction: m.direction,
        text: m.text,
        sent_at: m.sentAt,
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
    if (error) console.error('[wa-webhook] 写 messages 失败', error.message);
    else inserted += count ?? 0;
  }

  // ── 广告归因：把 ctwa_clid / fb_ad_id 落到 contact 上 ──
  // 这是接 coexistence 的头号动机：全库 9100 个客户这三个字段一直是 0，
  // 导致 Meta 只能拿「表单提交」当优化目标。
  let attributed = 0;
  for (const m of msgs) {
    if (!m.ctwaClid) continue;
    const contactId = byPhone.get(m.phone);
    if (!contactId) continue;
    const { data: c } = await supabase
      .from('contacts')
      .select('ctwa_clid')
      .eq('id', contactId)
      .maybeSingle();
    if (c && !c.ctwa_clid) {
      // 只在没值时写——最早那条广告点击才是真实归因起点
      await supabase
        .from('contacts')
        .update({ ctwa_clid: m.ctwaClid, fb_ad_id: m.adId })
        .eq('id', contactId);
      await supabase.from('contact_events').insert({
        contact_id: contactId,
        type: 'fb_lead_received',
        payload: { source: 'ctwa', ctwa_clid: m.ctwaClid, ad_id: m.adId },
      });
      attributed++;
    }
  }

  console.log(
    `[wa-webhook] 解析 ${msgs.length} 条，入库 ${inserted} 条，广告归因 ${attributed} 个`,
  );
  return new Response('OK', { status: 200 });
});
