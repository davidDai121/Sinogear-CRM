// Meta Conversions API edge function
// POST /functions/v1/conversions-api  body: { contact_id, event_name, test_event_code? }
//
// 调用方：extension 在客户阶段变化时通过 supabase.functions.invoke 调用
// 行为：读 contact → SHA256 hash phone/name/lead_id → POST 到 Meta Graph API
//      → 把结果写一条 fb_conversion_sent 事件到 contact_events 时间轴
//
// 鉴权：靠 Supabase 默认 JWT 校验（verify_jwt=true，部署时不加 --no-verify-jwt）
//      读 contacts 时透传用户 JWT，RLS 自动保证只能读自己 org 的客户
//
// 必需的 env vars（Supabase secrets）：
//   FB_ACCESS_TOKEN  — System User access token（永不过期那种）
//   FB_DATASET_ID    — 数据集 ID，默认 710402162034322
// 函数运行时 Supabase 自动注入：SUPABASE_URL, SUPABASE_ANON_KEY

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const FB_API_VERSION = 'v25.0';
const FB_DATASET_ID = Deno.env.get('FB_DATASET_ID') ?? '710402162034322';
const FB_ACCESS_TOKEN = Deno.env.get('FB_ACCESS_TOKEN') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface RequestBody {
  contact_id: string;
  event_name: string;        // e.g. 'Lead' / 'Negotiating' / 'Quoted' / 'Purchase' / 'Lost'
  test_event_code?: string;  // 测试用，传了 Meta 会把事件路由到 Test Events 页面而不污染生产数据
  value?: number;            // 可选金额（USD），Purchase 事件用
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Meta 要求 phone 是 E.164 去掉前导 +，纯数字（含国家区号） */
function normalizePhone(raw: string): string {
  return raw.replace(/\D+/g, '');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405);
  }

  if (!FB_ACCESS_TOKEN) {
    return jsonResponse({ error: 'FB_ACCESS_TOKEN secret not configured' }, 500);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.contact_id || !body.event_name) {
    return jsonResponse({ error: 'contact_id and event_name required' }, 400);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }

  // 用用户的 JWT 创建 Supabase client → RLS 自动过滤跨 org 访问
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !supabaseAnon) {
    return jsonResponse({ error: 'Supabase env not configured' }, 500);
  }
  const supabase = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
  });

  // 读 contact（RLS 守护）
  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .select('id, phone, name, country, fb_lead_id')
    .eq('id', body.contact_id)
    .single();

  if (contactErr || !contact) {
    return jsonResponse(
      { error: contactErr?.message ?? 'Contact not found or no access' },
      404,
    );
  }

  // 构造 user_data —— Meta 需要至少一个 identifier，没有就拒发
  const userData: Record<string, unknown> = {};

  if (contact.phone) {
    const normalized = normalizePhone(contact.phone);
    if (normalized) userData.ph = [await sha256Hex(normalized)];
  }
  if (contact.name) {
    // Meta 要求 fn/ln 小写、去掉标点、再 hash
    const cleaned = contact.name.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts[0]) userData.fn = [await sha256Hex(parts[0])];
    if (parts.length > 1) userData.ln = [await sha256Hex(parts[parts.length - 1])];
  }
  if (contact.fb_lead_id) {
    // Meta 要求 lead_id 是 number 不是 string
    const asInt = Number(contact.fb_lead_id);
    if (Number.isFinite(asInt)) userData.lead_id = asInt;
  }

  if (Object.keys(userData).length === 0) {
    return jsonResponse(
      { error: 'No identifier (phone/name/lead_id) available — cannot match' },
      422,
    );
  }

  const eventTimeSec = Math.floor(Date.now() / 1000);
  // event_id 让 Meta 去重，防 retry 重复计数
  const fbEventId = `${body.contact_id}-${body.event_name}-${eventTimeSec}`;

  const eventData: Record<string, unknown> = {
    action_source: 'system_generated',
    event_name: body.event_name,
    event_time: eventTimeSec,
    event_id: fbEventId,
    custom_data: {
      event_source: 'crm',
      lead_event_source: 'Sino Gear CRM',
      ...(body.value !== undefined ? { value: body.value, currency: 'USD' } : {}),
    },
    user_data: userData,
  };

  const metaPayload: Record<string, unknown> = { data: [eventData] };
  if (body.test_event_code) {
    metaPayload.test_event_code = body.test_event_code;
  }

  // 发到 Meta
  const metaUrl = `https://graph.facebook.com/${FB_API_VERSION}/${FB_DATASET_ID}/events?access_token=${encodeURIComponent(FB_ACCESS_TOKEN)}`;
  let metaStatus = 0;
  let metaJson: unknown = null;
  let metaError: string | null = null;
  try {
    const metaResp = await fetch(metaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaPayload),
    });
    metaStatus = metaResp.status;
    metaJson = await metaResp.json().catch(() => null);
  } catch (err) {
    metaError = err instanceof Error ? err.message : String(err);
  }

  // 写时间轴（失败 / 成功都写，便于事后排查）
  // 注：用 service role 写入避免 Edge Function 拿不到完整 RLS 上下文。
  // 这里如果想严格按 RLS 走，可以保持用同一个 supabase client；下面也 OK
  void supabase
    .from('contact_events')
    .insert({
      contact_id: body.contact_id,
      event_type: 'fb_conversion_sent',
      payload: {
        event_name: body.event_name,
        fb_event_id: fbEventId,
        meta_status: metaStatus,
        meta_response: metaJson,
        meta_error: metaError,
        test: Boolean(body.test_event_code),
        identifiers: Object.keys(userData),
      },
    })
    .then(({ error }) => {
      if (error) console.warn('[conversions-api] event log insert failed:', error.message);
    });

  if (metaError) {
    return jsonResponse(
      { ok: false, error: `Meta fetch failed: ${metaError}` },
      502,
    );
  }

  return jsonResponse({
    ok: metaStatus >= 200 && metaStatus < 300,
    status: metaStatus,
    fb_event_id: fbEventId,
    meta: metaJson,
  });
});
