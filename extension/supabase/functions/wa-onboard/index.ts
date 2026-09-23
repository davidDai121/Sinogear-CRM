// WhatsApp coexistence 接入：Embedded Signup 完成后的服务端收尾
//
// 授权页（wa-onboard-page/index.html）跑完 FB.login，拿到 code + waba_id 后 POST 到这里。
// 我们要在 code 过期（30 秒）前换成 business token，然后：
//   1. 把 CRMDataSource app 订阅到这个 WABA —— 不订阅 wa-cloud-webhook 一条都收不到
//   2. 触发通讯录同步 + 历史同步（smb_app_data）—— Meta 规定接入后 24 小时内必须做，
//      过期要让业务员重新扫码接入
//   3. 把号码写进 wa_business_numbers（phone_number_id + 登记状态），token 存 wa_business_accounts
//
// 号码不需要 register：coexistence 的号已经在 Business App 上注册过（Meta 文档原话
// "skip the phone number registration step"）。
//
// 权限：只有 org owner 能调——接入会把一个号码的全部聊天灌进 CRM，不是业务员自己能开的开关。
//
// 部署：supabase functions deploy wa-onboard（要 JWT，不加 --no-verify-jwt）
// env：FB_APP_ID、FB_APP_SECRET（与 wa-cloud-webhook 共用）、FB_ORG_ID
//      SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 自动注入

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const GRAPH = 'https://graph.facebook.com/v25.0';
const FB_APP_ID = Deno.env.get('FB_APP_ID') ?? '';
const FB_APP_SECRET = Deno.env.get('FB_APP_SECRET') ?? '';
const ORG_ID = Deno.env.get('FB_ORG_ID') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  return digits ? '+' + digits : '';
}

async function graph(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  if (!FB_APP_ID || !FB_APP_SECRET || !ORG_ID) {
    return json({ ok: false, error: 'FB_APP_ID / FB_APP_SECRET / FB_ORG_ID 未配置' }, 500);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  // ── 只有 org owner 能接入号码 ──
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return json({ ok: false, error: '请先登录 CRM 账号' }, 401);
  const { data: member } = await admin
    .from('organization_members')
    .select('role')
    .eq('org_id', ORG_ID)
    .eq('user_id', user.id)
    .maybeSingle();
  if (member?.role !== 'owner') {
    return json({ ok: false, error: '只有团队 owner 能接入 WhatsApp 号码' }, 403);
  }

  let body: { code?: string; waba_id?: string; phone_number_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  const code = String(body.code ?? '');
  const wabaId = String(body.waba_id ?? '');
  if (!code || !/^\d+$/.test(wabaId)) {
    return json({ ok: false, error: '缺 code 或 waba_id' }, 400);
  }

  // ── 1. code → business token（code 只有 30 秒寿命，必须最先做）──
  const tokenUrl = new URL(`${GRAPH}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', FB_APP_ID);
  tokenUrl.searchParams.set('client_secret', FB_APP_SECRET);
  tokenUrl.searchParams.set('code', code);
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json().catch(() => ({}));
  const token = String(tokenData.access_token ?? '');
  if (!token) {
    console.error('[wa-onboard] token 交换失败', tokenData?.error?.message);
    return json({ ok: false, step: 'token', error: tokenData?.error?.message ?? '换 token 失败' }, 502);
  }

  // token 先落库：后面任何一步失败，都能拿它手动补救，不用让业务员重新扫码
  const { error: saveError } = await admin.from('wa_business_accounts').upsert({
    org_id: ORG_ID,
    waba_id: wabaId,
    access_token: token,
    onboarded_by: user.id,
    onboarded_at: new Date().toISOString(),
  }, { onConflict: 'org_id,waba_id' });
  if (saveError) console.error('[wa-onboard] token 存库失败', saveError.message);

  // ── 2. 订阅 app 到 WABA ──
  const sub = await graph(`${wabaId}/subscribed_apps`, token, { method: 'POST' });
  if (!sub.ok) {
    return json({ ok: false, step: 'subscribe', error: sub.data?.error?.message ?? `HTTP ${sub.status}` }, 502);
  }

  // ── 3. 找号码 ──
  const phones = await graph(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`, token);
  if (!phones.ok) {
    return json({ ok: false, step: 'phone_numbers', error: phones.data?.error?.message ?? `HTTP ${phones.status}` }, 502);
  }
  const numbers: Array<{ id: string; display_phone_number: string; verified_name?: string }> =
    (phones.data?.data ?? []).filter((p: any) =>
      !body.phone_number_id || String(p.id) === String(body.phone_number_id));
  if (numbers.length === 0) {
    return json({ ok: false, step: 'phone_numbers', error: '这个 WABA 下没有号码' }, 502);
  }

  // ── 4. 触发同步（先通讯录再历史，Meta 文档的顺序）──
  const results: Record<string, unknown> = {};
  for (const n of numbers) {
    const phone = normalizePhone(n.display_phone_number);
    const r: Record<string, unknown> = { phone, verified_name: n.verified_name ?? null };
    for (const syncType of ['smb_app_state_sync', 'history']) {
      const s = await graph(`${n.id}/smb_app_data`, token, {
        method: 'POST',
        body: { messaging_product: 'whatsapp', sync_type: syncType },
      });
      r[syncType] = s.ok ? (s.data ?? true) : { error: s.data?.error?.message ?? `HTTP ${s.status}` };
    }
    results[n.id] = r;

    // 号码登记：已登记的（可能在别的 org，如测试号）只补 phone_number_id，org / user_id 不动；
    // 新号码进默认 org，user_id 留空等人工指定。phone 全局唯一（0044）。
    const { data: existing } = await admin
      .from('wa_business_numbers')
      .select('org_id')
      .eq('phone', phone)
      .maybeSingle();
    const { error: numError } = existing
      ? await admin.from('wa_business_numbers')
        .update({ phone_number_id: n.id })
        .eq('org_id', existing.org_id)
        .eq('phone', phone)
      : await admin.from('wa_business_numbers')
        .insert({ org_id: ORG_ID, phone, phone_number_id: n.id });
    if (numError) console.error('[wa-onboard] 号码登记失败', phone, numError.message);
  }

  await admin.from('wa_business_accounts')
    .update({ sync_result: results })
    .eq('org_id', ORG_ID)
    .eq('waba_id', wabaId);

  const failed = Object.values(results).some((r: any) =>
    (r.smb_app_state_sync as any)?.error || (r.history as any)?.error);
  console.log('[wa-onboard] 完成', wabaId, JSON.stringify(results));
  return json({ ok: !failed, waba_id: wabaId, numbers: results }, failed ? 207 : 200);
});
