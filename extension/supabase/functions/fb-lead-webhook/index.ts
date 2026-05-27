// FB Lead Ads webhook receiver
// Meta 推送 leadgen 事件 → 这个函数：
//   1. GET: 响应 Meta 验证握手（hub.mode=subscribe + verify_token 匹配 → 返回 challenge）
//   2. POST: 接受 leadgen 事件
//      a) 校验 X-Hub-Signature-256（HMAC-SHA256 with App Secret）防伪造
//      b) 从 Graph API 拉完整 lead 数据（webhook 只推 lead_id）
//      c) upsert contact（按 phone 匹配现有客户或新建）
//      d) 立刻发 Lead 事件到 Conversions API（带 fb_lead_id 高精度匹配）
//      e) 写时间轴 fb_lead_received + fb_conversion_sent
//
// 部署：supabase functions deploy fb-lead-webhook --no-verify-jwt
//   （Meta 不带 JWT，必须公开访问。安全靠 verify_token + 签名校验）
//
// 必需 env vars:
//   FB_ACCESS_TOKEN   - System User token (with leads_retrieval)
//   FB_APP_SECRET     - App Settings → Basic 里的 App Secret
//   FB_VERIFY_TOKEN   - 任意字符串，跟 Meta 后台配 webhook 时填的对得上
//   FB_ORG_ID         - CRM org id，新 lead 归到哪个 org
//   FB_DATASET_ID     - default 710402162034322
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (自动注入)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const FB_API_VERSION = 'v25.0';
const FB_DATASET_ID = Deno.env.get('FB_DATASET_ID') ?? '710402162034322';
const FB_ACCESS_TOKEN = Deno.env.get('FB_ACCESS_TOKEN') ?? '';
const FB_APP_SECRET = Deno.env.get('FB_APP_SECRET') ?? '';
const FB_VERIFY_TOKEN = Deno.env.get('FB_VERIFY_TOKEN') ?? '';
const FB_ORG_ID = Deno.env.get('FB_ORG_ID') ?? '';

// ─────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** HMAC-SHA256 验证 webhook 签名，常时间比较防 timing attack */
async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !FB_APP_SECRET) return false;
  const expected = signatureHeader.replace(/^sha256=/, '');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(FB_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
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

/** "+86 135-5259-2187" → "+8613552592187" (E.164) */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return '';
  return '+' + digits;
}

// ─────────────────────────────────────────────────────────
// Graph API: 拉 lead 数据 + form 名字
// ─────────────────────────────────────────────────────────

interface LeadFieldData {
  name: string;
  values: string[];
}
interface LeadResponse {
  id: string;
  created_time: string;
  ad_id?: string;
  ad_name?: string;
  form_id: string;
  field_data: LeadFieldData[];
}

async function fetchLeadData(leadId: string): Promise<LeadResponse | null> {
  const url =
    `https://graph.facebook.com/${FB_API_VERSION}/${leadId}` +
    `?fields=id,created_time,ad_id,ad_name,form_id,field_data` +
    `&access_token=${encodeURIComponent(FB_ACCESS_TOKEN)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`Graph API ${resp.status} for lead ${leadId}: ${text.slice(0, 200)}`);
      return null;
    }
    return (await resp.json()) as LeadResponse;
  } catch (err) {
    console.warn(`Graph API fetch failed for ${leadId}:`, err);
    return null;
  }
}

async function fetchFormName(formId: string): Promise<string | null> {
  const url =
    `https://graph.facebook.com/${FB_API_VERSION}/${formId}` +
    `?fields=name&access_token=${encodeURIComponent(FB_ACCESS_TOKEN)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data?.name === 'string' ? data.name : null;
  } catch {
    return null;
  }
}

function extractLeadFields(fields: LeadFieldData[]) {
  const get = (name: string): string | undefined => {
    const f = fields.find(
      (x) => x.name?.toLowerCase() === name.toLowerCase(),
    );
    const v = f?.values?.[0];
    return typeof v === 'string' ? v.trim() : undefined;
  };

  const phone = get('phone_number') || get('phone');
  const fullName =
    get('full_name') ||
    [get('first_name'), get('last_name')].filter(Boolean).join(' ').trim() ||
    undefined;
  const email = get('email');
  const country = get('country') || get('country_code');

  return {
    phone: phone || undefined,
    fullName: fullName || undefined,
    email: email || undefined,
    country: country || undefined,
  };
}

// ─────────────────────────────────────────────────────────
// 直接发 Lead 事件给 Meta Conversions API（带 fb_lead_id 高精度）
// 不复用我们 conversions-api Edge Function 是因为它要求 user JWT，
// webhook 这边只有 service role
// ─────────────────────────────────────────────────────────

async function fireLeadEvent(args: {
  contactId: string;
  phone: string | null;
  fullName: string | null;
  email: string | null;
  fbLeadId: string;
}): Promise<{ status: number; response: unknown; fbEventId: string }> {
  const { contactId, phone, fullName, email, fbLeadId } = args;
  const userData: Record<string, unknown> = {};

  if (phone) {
    const cleaned = phone.replace(/\D+/g, '');
    if (cleaned) userData.ph = [await sha256Hex(cleaned)];
  }
  if (fullName) {
    const parts = fullName
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean);
    if (parts[0]) userData.fn = [await sha256Hex(parts[0])];
    if (parts.length > 1) userData.ln = [await sha256Hex(parts[parts.length - 1])];
  }
  if (email) userData.em = [await sha256Hex(email.trim().toLowerCase())];

  const leadIdNum = Number(fbLeadId);
  if (Number.isFinite(leadIdNum)) userData.lead_id = leadIdNum;

  const eventTime = Math.floor(Date.now() / 1000);
  const fbEventId = `${contactId}-Lead-${eventTime}`;

  const payload = {
    data: [
      {
        action_source: 'system_generated',
        event_name: 'Lead',
        event_time: eventTime,
        event_id: fbEventId,
        custom_data: {
          event_source: 'crm',
          lead_event_source: 'Sino Gear CRM',
        },
        user_data: userData,
      },
    ],
  };

  const url = `https://graph.facebook.com/${FB_API_VERSION}/${FB_DATASET_ID}/events?access_token=${encodeURIComponent(FB_ACCESS_TOKEN)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return {
      status: resp.status,
      response: await resp.json().catch(() => null),
      fbEventId,
    };
  } catch (err) {
    return {
      status: 0,
      response: { error: err instanceof Error ? err.message : String(err) },
      fbEventId,
    };
  }
}

// ─────────────────────────────────────────────────────────
// Webhook payload type
// ─────────────────────────────────────────────────────────

interface WebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    time: number;
    changes: Array<{
      field: string;
      value: {
        leadgen_id: string;
        page_id: string;
        form_id: string;
        ad_id?: string;
        adgroup_id?: string;
        created_time: number;
      };
    }>;
  }>;
}

// ─────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────

serve(async (req) => {
  const url = new URL(req.url);

  // ── GET: webhook 订阅验证握手 ──
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === FB_VERIFY_TOKEN && challenge) {
      console.log('Webhook verified successfully');
      return new Response(challenge, { status: 200 });
    }
    console.warn(`Webhook verification failed: mode=${mode}, token match=${token === FB_VERIFY_TOKEN}`);
    return new Response('Verification failed', { status: 403 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // ── POST: 真的 leadgen 事件 ──
  const rawBody = await req.text();

  // 必须用 raw body 算签名，不能 JSON.parse 后再 stringify
  const signature = req.headers.get('x-hub-signature-256');
  if (!(await verifySignature(rawBody, signature))) {
    console.warn('Signature verification failed');
    return new Response('Invalid signature', { status: 403 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (payload.object !== 'page' || !Array.isArray(payload.entry)) {
    // 非 leadgen 事件，无害忽略
    return new Response('OK', { status: 200 });
  }

  // 环境检查
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !supabaseServiceKey || !FB_ORG_ID || !FB_ACCESS_TOKEN) {
    console.error('Missing env vars', {
      hasUrl: !!supabaseUrl,
      hasKey: !!supabaseServiceKey,
      hasOrgId: !!FB_ORG_ID,
      hasToken: !!FB_ACCESS_TOKEN,
    });
    // 给 Meta 200 防止重试，错误日志在 SW logs 里看
    return new Response('Server misconfigured', { status: 200 });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const results: Array<{ leadId: string; ok: boolean; reason?: string }> = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const leadId = change.value?.leadgen_id;
      if (!leadId) continue;

      // ── 去重：已经处理过这个 lead_id 就 skip ──
      const { data: dup } = await supabase
        .from('contacts')
        .select('id')
        .eq('org_id', FB_ORG_ID)
        .eq('fb_lead_id', leadId)
        .maybeSingle();
      if (dup) {
        results.push({ leadId, ok: true, reason: 'duplicate, already processed' });
        continue;
      }

      // ── 拉完整 lead 数据 ──
      const lead = await fetchLeadData(leadId);
      if (!lead) {
        results.push({ leadId, ok: false, reason: 'Graph API fetch failed (token / permission?)' });
        continue;
      }

      const { phone, fullName, email, country } = extractLeadFields(lead.field_data);
      if (!phone && !email) {
        results.push({ leadId, ok: false, reason: 'lead form has no phone or email' });
        continue;
      }

      const normalizedPhone = phone ? normalizePhone(phone) : null;

      // ── 按 phone 找现有客户 ──
      let contactId: string | null = null;
      if (normalizedPhone) {
        const { data: existing } = await supabase
          .from('contacts')
          .select('id, fb_lead_id')
          .eq('org_id', FB_ORG_ID)
          .eq('phone', normalizedPhone)
          .maybeSingle();

        if (existing) {
          contactId = existing.id;
          // 只在没设过 fb_lead_id 时填，不覆盖（最早的 lead 是真实归因起点）
          if (!existing.fb_lead_id) {
            await supabase
              .from('contacts')
              .update({
                fb_lead_id: leadId,
                fb_ad_id: lead.ad_id ?? null,
              })
              .eq('id', existing.id);
          }
        }
      }

      // ── 没找到现有客户 → 新建 ──
      if (!contactId) {
        const { data: created, error: createErr } = await supabase
          .from('contacts')
          .insert({
            org_id: FB_ORG_ID,
            phone: normalizedPhone,
            name: fullName ?? null,
            country: country ?? null,
            customer_stage: 'qualifying', // FB lead 至少是 qualified（填了表）
            quality: 'potential',
            fb_lead_id: leadId,
            fb_ad_id: lead.ad_id ?? null,
          })
          .select('id')
          .single();

        if (createErr || !created) {
          console.error(`Failed to create contact for lead ${leadId}:`, createErr);
          results.push({ leadId, ok: false, reason: createErr?.message ?? 'insert failed' });
          continue;
        }
        contactId = created.id;

        // 'created' 事件
        void supabase.from('contact_events').insert({
          contact_id: contactId,
          event_type: 'created',
          payload: {
            phone: normalizedPhone,
            source: 'fb_lead_ads',
            fb_lead_id: leadId,
          },
        });
      }

      // ── 拉 form 名字（用于时间轴展示）──
      const formName = await fetchFormName(lead.form_id);

      // ── fb_lead_received 事件 ──
      void supabase.from('contact_events').insert({
        contact_id: contactId,
        event_type: 'fb_lead_received',
        payload: {
          fb_lead_id: leadId,
          form_id: lead.form_id,
          form_name: formName,
          ad_id: lead.ad_id ?? null,
          ad_name: lead.ad_name ?? null,
          page_id: change.value.page_id,
          field_data: lead.field_data, // 留底，万一以后要回溯
        },
      });

      // ── 立刻发 Lead 事件到 Conversions API（带 lead_id 高精度归因）──
      const fireRes = await fireLeadEvent({
        contactId,
        phone: normalizedPhone,
        fullName: fullName ?? null,
        email: email ?? null,
        fbLeadId: leadId,
      });

      void supabase.from('contact_events').insert({
        contact_id: contactId,
        event_type: 'fb_conversion_sent',
        payload: {
          event_name: 'Lead',
          fb_event_id: fireRes.fbEventId,
          meta_status: fireRes.status,
          meta_response: fireRes.response,
          source: 'fb_lead_webhook',
          identifiers: ['lead_id', ...(normalizedPhone ? ['ph'] : []), ...(email ? ['em'] : [])],
        },
      });

      results.push({ leadId, ok: true });
    }
  }

  console.log(`fb-lead-webhook processed ${results.length}:`, results);

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
