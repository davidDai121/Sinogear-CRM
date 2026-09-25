// 运费估算服务（物流巴巴 / Awice 开放平台 + 货代全包价校准）
// POST /functions/v1/freight-rate-lookup
//
//   { action: 'estimate', dest, dest_country?, quantity, cargo?|propulsion? }  业务员 JWT 或 service role(+org_id)
//       → 全包运费估算：每柜明细、总额、每台、可信度、依据。平台价超过 7 天会先现查一次（扣 1 积分）。
//   { action: 'refresh', org_id? }   只认 service role —— pg_cron 每周一跑，刷新所有启用航线
//   { action: 'search', pol, pod, pod_country? }  只认 service role —— 原始查询，排障用
//
// 为什么（2026-09-24）：GPT 写回复时现查网页、现挑运费，多米尼加一周报价偏差 −2,242 ~ +4,323，
// 两单低于成本已发出。现在按货代给的规则估：平台当前最高价 + 装箱每台 ¥2,000；有同周货代全包价
// 的航线用差额校准。海运价变化快（海纳 EMC 20GP 7–8 月 10,925 → 9/24 8,080），旧货代价不能直接用。
// 算法见 estimate.ts。
//
// 密钥 AWICE_APP_KEY / AWICE_APP_SECRET 只在 Supabase secrets。条款：数据只做内部使用，展示标注 SOURCE。
// 签名：HMAC-SHA256(AppSecret, METHOD\nPATH\nTimestamp\nNonce\nmd5(body))，body 签名和发送必须是同一个字符串。

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { crypto as stdCrypto } from 'https://deno.land/std@0.224.0/crypto/mod.ts';
import { encodeHex } from 'https://deno.land/std@0.224.0/encoding/hex.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { estimate, validRates, type Calibration, type Cargo, type RateRow } from './estimate.ts';

const APP_KEY = (Deno.env.get('AWICE_APP_KEY') ?? '').trim();
const APP_SECRET = (Deno.env.get('AWICE_APP_SECRET') ?? '').trim();
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BASE = 'https://www.5688.cn/api';
const PATH = '/openapi/v1/freight/fcl/search';
const SOURCE = 'Data from Awice Logistics';
const STALE_MS = 3 * 86400_000;   // 报价时平台价超过 3 天就现查（运价一周能变 10%，2026-09-25 从 7 天收紧）
const FX_MAX_AGE_MS = 24 * 3600_000;

// 扩展从 web.whatsapp.com 的 content script 调，浏览器会先发 OPTIONS 预检（同 ai-proxy / conversions-api）
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

function jwtRole(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const pad = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(pad + '==='.slice((pad.length + 3) % 4))).role ?? null;
  } catch {
    return null;
  }
}

async function awiceSearch(query: Record<string, unknown>) {
  if (!APP_KEY || !APP_SECRET) throw new Error('AWICE_APP_KEY / AWICE_APP_SECRET not configured');
  const enc = new TextEncoder();
  const body = JSON.stringify(query);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = encodeHex(crypto.getRandomValues(new Uint8Array(8)));
  const bodyMd5 = encodeHex(await stdCrypto.subtle.digest('MD5', enc.encode(body)));
  const key = await crypto.subtle.importKey('raw', enc.encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = encodeHex(await crypto.subtle.sign('HMAC', key, enc.encode(`POST\n${PATH}\n${ts}\n${nonce}\n${bodyMd5}`)));
  const res = await fetch(BASE + PATH, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Awice-AppKey': APP_KEY, 'X-Awice-Timestamp': ts, 'X-Awice-Nonce': nonce, 'X-Awice-Signature': sig },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.json().catch(() => null) as any;
  if (!res.ok || raw?.code !== 0) {
    throw new Error(`awice ${res.status} code=${raw?.code ?? '?'} ${raw?.msg ?? ''} request_id=${raw?.request_id ?? '?'}`);
  }
  return raw;
}

/** 当日 USD/CNY，带来源和时间；24 小时内复用 freight_settings 里存的。 */
async function usdCny(admin: SupabaseClient, orgId: string) {
  const { data: s } = await admin.from('freight_settings').select('cny_per_usd, fx_source, fx_at').eq('org_id', orgId).maybeSingle();
  if (s?.cny_per_usd && s.fx_at && Date.now() - Date.parse(s.fx_at) < FX_MAX_AGE_MS) {
    return { rate: Number(s.cny_per_usd), source: s.fx_source as string, at: s.fx_at as string };
  }
  let fx: { rate: number; source: string; at: string } | null = null;
  try {
    const r = await (await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) })).json();
    if (r?.result === 'success' && r.rates?.CNY) fx = { rate: r.rates.CNY, source: 'open.er-api.com', at: new Date(r.time_last_update_unix * 1000).toISOString() };
  } catch { /* 换下一个来源 */ }
  if (!fx) {
    try {
      const r = await (await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY', { signal: AbortSignal.timeout(8000) })).json();
      if (r?.rates?.CNY) fx = { rate: r.rates.CNY, source: 'frankfurter (ECB)', at: new Date(r.date).toISOString() };
    } catch { /* 都失败就用旧的 */ }
  }
  if (!fx) {
    if (s?.cny_per_usd) return { rate: Number(s.cny_per_usd), source: `${s.fx_source}（汇率接口失败，沿用旧值）`, at: s.fx_at as string };
    throw new Error('无法取得 USD/CNY 汇率');
  }
  await admin.from('freight_settings').update({ cny_per_usd: fx.rate, fx_source: fx.source, fx_at: fx.at, updated_at: new Date().toISOString() }).eq('org_id', orgId);
  return fx;
}

async function refreshRoute(admin: SupabaseClient, route: any) {
  const q: Record<string, unknown> = { pol: route.origin, pod: route.dest_query, pod_country: route.dest_country, limit: 50 };
  try {
    const raw = await awiceSearch(q);
    const list: any[] = raw.data?.list ?? [];
    const pod = raw.data?.resolved?.pod;
    const fetchedAt = new Date().toISOString();
    if (list.length) {
      const rows = list.map(r => ({
        org_id: route.org_id, route_id: route.id,
        origin_code: raw.data?.resolved?.pol?.code ?? route.origin,
        pol_code: r.pol?.code ?? null, dest_code: r.pod?.code ?? pod?.code ?? route.dest_query,
        carrier: r.carrier?.code ?? r.carrier?.name ?? '?',
        price_20gp: r.prices?.['20GP'] ?? null, price_40gp: r.prices?.['40GP'] ?? null, price_40hq: r.prices?.['40HQ'] ?? null,
        currency: r.prices?.currency ?? 'USD', surcharges: r.surcharges ?? [],
        valid_until: r.valid_until || null, departure_date: r.schedule?.departure_date || null,
        transit_days: r.transit?.days ?? null, transshipment: r.transit?.port_en || r.transit?.port || null,
        awice_rate_id: r.id ?? null, fetched_at: fetchedAt,
      }));
      const { error } = await admin.from('freight_rate_snapshots').insert(rows);
      if (error) throw new Error(`保存快照失败：${error.message}`);
    }
    await admin.from('freight_routes').update({
      dest_code: pod?.code ?? route.dest_code, dest_name: pod?.name ?? route.dest_name,
      last_refreshed_at: fetchedAt, last_error: list.length ? null : '平台没有这条航线的运价',
    }).eq('id', route.id);
    return { route: route.dest_query, dest_code: pod?.code ?? null, rates: list.length, credit_balance: raw.credit_balance };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from('freight_routes').update({ last_error: msg.slice(0, 500), last_refreshed_at: new Date().toISOString() }).eq('id', route.id);
    return { route: route.dest_query, error: msg };
  }
}

/** 最近一批快照（同一次刷新写入的所有船公司）。 */
async function latestBatch(admin: SupabaseClient, orgId: string, destCode: string) {
  const { data: last } = await admin.from('freight_rate_snapshots').select('fetched_at')
    .eq('org_id', orgId).eq('dest_code', destCode).order('fetched_at', { ascending: false }).limit(1).maybeSingle();
  if (!last) return { rows: [] as RateRow[], fetchedAt: null as string | null };
  const since = new Date(Date.parse(last.fetched_at) - 3600_000).toISOString();
  const { data } = await admin.from('freight_rate_snapshots')
    .select('carrier, pol_code, price_20gp, price_40hq, surcharges, valid_until, departure_date, transit_days, transshipment, fetched_at')
    .eq('org_id', orgId).eq('dest_code', destCode).gte('fetched_at', since);
  return { rows: (data ?? []) as RateRow[], fetchedAt: last.fetched_at as string };
}

/**
 * 货代全包价没填同周平台价的，用报价日期 ±7 天内最近那一批快照的「最高」有效价补上
 * （和估算用的货代规则同一口径）。海运价一周能变 10%（布埃纳文图拉 9/8→9/14 跌 11%），超过一周不配对。
 */
async function fillCalibrationBases(admin: SupabaseClient, orgId: string, cals: any[], cny: number) {
  for (const c of cals) {
    if (c.platform_base_usd != null || !c.quoted_on || !c.quoted_on_known) continue;
    const day = Date.parse(c.quoted_on);
    const from = new Date(day - 7 * 86400_000).toISOString(), to = new Date(day + 8 * 86400_000).toISOString();
    const { data } = await admin.from('freight_rate_snapshots')
      .select('carrier, price_20gp, price_40hq, surcharges, fetched_at, valid_until')
      .eq('org_id', orgId).eq('dest_code', c.dest_code).gte('fetched_at', from).lte('fetched_at', to);
    if (!data?.length) continue;
    const nearest = data.reduce((a: any, b: any) => Math.abs(Date.parse(b.fetched_at) - day) < Math.abs(Date.parse(a.fetched_at) - day) ? b : a);
    const batch = data.filter((r: any) => Math.abs(Date.parse(r.fetched_at) - Date.parse(nearest.fetched_at)) < 3600_000);
    const r = validRates(batch as RateRow[], c.container, cny, c.quoted_on);
    if (!r) continue;
    c.platform_base_usd = r.max;
    await admin.from('freight_calibrations').update({ platform_base_usd: r.max }).eq('id', c.id);
  }
}

async function handleEstimate(admin: SupabaseClient, orgId: string, body: any) {
  const dest = typeof body.dest === 'string' ? body.dest.trim() : '';
  const destCountry = typeof body.dest_country === 'string' ? body.dest_country.trim().toUpperCase() : '';
  const quantity = Number(body.quantity ?? 1);
  const propulsion = String(body.propulsion ?? '').toLowerCase();
  const cargo: Cargo = body.cargo === 'dg' || propulsion === 'bev' || propulsion === 'phev' ? 'dg' : 'general';
  if (!dest) return json({ ok: false, reason: 'dest is required' }, 400);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) return json({ ok: false, reason: 'quantity must be 1-200' }, 400);

  // 找航线：港口代码 / 查询名 / 中文名，去掉重音和「port of / puerto / 港」这类前后缀再比；
  // 给了国家时只在该国里找（Manzanillo 巴拿马 vs 墨西哥）。都找不到且有国家就新建，之后按需刷新。
  const { data: routes } = await admin.from('freight_routes').select('*').eq('org_id', orgId);
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(port of|puerto de|puerto|port|porto)\b|港口?$|,.*$/g, '').replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
  const key = norm(dest);
  const inCountry = (r: any) => !destCountry || r.dest_country === destCountry;
  const pool = (routes ?? []).filter(inCountry);
  let route = pool.find((r: any) => [r.dest_code, r.dest_query, r.dest_name].some((v: string | null) => v && norm(v) === key))
    ?? pool.find((r: any) => key.length >= 4 && [r.dest_query, r.dest_name].some((v: string | null) => v && (norm(v).includes(key) || key.includes(norm(v)))));
  if (!route) {
    if (!/^[A-Z]{2}$/.test(destCountry)) return json({ ok: false, reason: `没有「${dest}」这条航线，新航线要带 dest_country（两位国家代码）` }, 400);
    const { data: created, error } = await admin.from('freight_routes')
      .insert({ org_id: orgId, dest_query: dest, dest_country: destCountry }).select('*').single();
    if (error) return json({ ok: false, reason: `建航线失败：${error.message}` }, 500);
    route = created;
  }
  // 记录最近报价时间：按需刷新的航线靠它判断「最近有人在报」
  await admin.from('freight_routes').update({ last_quoted_at: new Date().toISOString() }).eq('id', route.id);

  const fx = await usdCny(admin, orgId);
  let batch = route.dest_code ? await latestBatch(admin, orgId, route.dest_code) : { rows: [], fetchedAt: null };
  let refreshed: unknown = null;
  const today = new Date().toISOString().slice(0, 10);
  const anyValid = batch.rows.some(r => !r.valid_until || r.valid_until >= today);
  // 超过 7 天，或这批平台价全部过了有效期，都现查一次。
  if (!batch.fetchedAt || !anyValid || Date.now() - Date.parse(batch.fetchedAt) > STALE_MS) {
    refreshed = await refreshRoute(admin, route);
    const { data: r2 } = await admin.from('freight_routes').select('*').eq('id', route.id).single();
    route = r2 ?? route;
    if (route.dest_code) batch = await latestBatch(admin, orgId, route.dest_code);
  }
  if (!route.dest_code || !batch.rows.length) {
    return json({ ok: false, reason: route.last_error ?? '平台没有这条航线的运价', route: route.dest_query, refreshed });
  }

  const [{ data: cals }, { data: settings }] = await Promise.all([
    admin.from('freight_calibrations').select('*').eq('org_id', orgId).eq('dest_code', route.dest_code),
    admin.from('freight_settings').select('*').eq('org_id', orgId).single(),
  ]);
  await fillCalibrationBases(admin, orgId, cals ?? [], fx.rate);
  const result = estimate({ quantity, cargo, rows: batch.rows, calibrations: (cals ?? []) as Calibration[], settings: settings!, cnyPerUsd: fx.rate, today });

  // 对客口径（0051）：保险每台固定；加价按「客户」国家分档，没有就用目的港国家，再没有用默认。
  // 只给 CRM 算 CIF 总价用，不单列给客户。
  let pricing: unknown = null;
  if (result.ok) {
    const customerCountry = typeof body.customer_country === 'string' ? body.customer_country.trim() : '';
    const { data: markups } = await admin.from('freight_country_markup').select('country, iso2, tier, markup_usd_per_car').eq('org_id', orgId);
    const byName = (markups ?? []).find((m: any) => customerCountry && m.country.toLowerCase() === customerCountry.toLowerCase());
    const byIso = (markups ?? []).find((m: any) => customerCountry && m.iso2 === customerCountry.toUpperCase());
    const byPort = (markups ?? []).find((m: any) => m.iso2 === route.dest_country);
    const hit = byName ?? byIso ?? byPort ?? null;
    const markupPerCar = Number(hit?.markup_usd_per_car ?? settings!.default_markup_usd_per_car ?? 500);
    const insurancePerCar = Number(settings!.insurance_usd_per_car ?? 100);
    const validUntil = result.containers.map(c => c.valid_until).filter(Boolean).sort()[0] ?? null;
    pricing = {
      markup_per_vehicle: markupPerCar, insurance_per_vehicle: insurancePerCar,
      markup_basis: hit ? `${hit.country}（${hit.tier}）${byName || byIso ? '客户国家' : '目的港国家'}` : '默认',
      customer_freight_total: Math.round(result.total_usd + markupPerCar * quantity),
      insurance_total: insurancePerCar * quantity,
      valid_until: validUntil,
    };
  }
  return json({
    ...result, pricing, source: SOURCE,
    route: { dest_code: route.dest_code, dest_name: route.dest_name, dest_country: route.dest_country, origin: route.origin },
    rates_fetched_at: batch.fetchedAt, fx, refreshed,
  }, result.ok ? 200 : 422);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'Supabase env not configured' }, 500);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const isService = jwtRole(token) === 'service_role';
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const action = body.action ?? (body.pol && body.pod ? 'search' : 'estimate');

  try {
    if (action === 'search' || action === 'refresh') {
      if (!isService) return json({ error: 'service role key required' }, 401);
      if (action === 'search') {
        const q: Record<string, unknown> = { pol: body.pol, pod: body.pod, limit: 50 };
        if (body.pod_country) q.pod_country = body.pod_country;
        return json({ source: SOURCE, ...(await awiceSearch(q)) });
      }
      // 默认只刷 weekly 档（pg_cron 每周一）；tier='all' 全刷；unresolved_only 只查还没解析出港口代码的新航线；
      // route_ids 指定航线。on_demand 档平时不花积分，有人报价时才现查。
      let q = admin.from('freight_routes').select('*').eq('active', true);
      if (body.org_id) q = q.eq('org_id', body.org_id);
      if (Array.isArray(body.route_ids) && body.route_ids.length) q = q.in('id', body.route_ids);
      else if (body.unresolved_only) q = q.is('dest_code', null).is('last_refreshed_at', null);
      else if (body.tier !== 'all') q = q.eq('refresh_tier', 'weekly');
      const { data: routes, error } = await q;
      if (error) return json({ error: error.message }, 500);
      const orgs = [...new Set((routes ?? []).map((r: any) => r.org_id))];
      for (const org of orgs) await usdCny(admin, org as string);
      const results = [];
      for (const r of routes ?? []) results.push(await refreshRoute(admin, r)); // 串行：平台有 QPS 限制
      return json({ source: SOURCE, refreshed: results.length, results });
    }

    if (action === 'estimate') {
      let orgId: string | null = null;
      if (isService) orgId = typeof body.org_id === 'string' ? body.org_id : null;
      else {
        const { data: u } = await admin.auth.getUser(token);
        if (!u?.user) return json({ error: 'invalid user token' }, 401);
        // 一个人可能在多个 org（老板同时在测试 org）：传了 org_id 就核对成员身份，没传取第一个。
        let mq = admin.from('organization_members').select('org_id').eq('user_id', u.user.id);
        if (typeof body.org_id === 'string') mq = mq.eq('org_id', body.org_id);
        const { data: m } = await mq.limit(1).maybeSingle();
        orgId = m?.org_id ?? null;
      }
      if (!orgId) return json({ error: 'org not resolved' }, 403);
      return await handleEstimate(admin, orgId, body);
    }
    return json({ error: `unknown action ${action}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
