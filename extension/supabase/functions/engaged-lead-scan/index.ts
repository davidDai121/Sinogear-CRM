// EngagedLead 定时扫描
// POST /functions/v1/engaged-lead-scan   body: { limit?: number, dry_run?: boolean }
//
// 干什么：找出「主动聊过 ≥3 句」的广告线索，给每人回传一条 EngagedLead 事件。
//
// 为什么需要（2026-08-25 实测）：Meta 的合格线索优化要每周约 50 条同类事件才出得了
// 学习期。人工判定四天只点了 18 个、其中合格 1 个 —— 差 28 倍，靠人点永远攒不够。
// 这条自动信号不如销售的判断准（聊三句不等于会买），但它不用人动手、量够，
// 先把 Meta 教起来。等人工判定攒够 50/周，优化目标要换回 QualifiedLead，
// 这个降级成参考信号。**它是垫的砖，不是地基。**
//
// 候选人的三条硬规则写在 SQL 里（0039_engaged_lead_candidates.sql），不在这里：
//   只发带广告标识的 / 排除表单自动首句 / 人工判定过的一律不发（人优先于机器）
//
// 鉴权：只认 service role key。pg_cron + pg_net 每小时调一次。
// 实际发事件复用 conversions-api，不重复实现 user_data 那套哈希逻辑。

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// 一次最多发多少条。edge function 有执行时长上限，而每条要等 conversions-api
// 往 Meta 打一个来回（~300ms）。40 条约 15 秒，留足余量。
// 存量补发靠 pg_cron 每小时跑一次慢慢排空，不要为了一次跑完把超时风险拉满。
const DEFAULT_LIMIT = 40;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'Supabase env not configured' }, 500);
  }

  // 只认 service role —— anon key 也能过 verify_jwt，所以必须在这里再挡一道。
  // 比对 JWT 里的 role 而不是整串相等：网关会重签/规范化 Authorization，
  // 字符串全等在真实调用里过不了（2026-08-26 实测第一版就是这么挂的）。
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const role = (() => {
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const pad = payload.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(pad + '==='.slice((pad.length + 3) % 4))).role ?? null;
    } catch {
      return null;
    }
  })();
  if (role !== 'service_role') {
    return json({ error: 'service role key required' }, 401);
  }

  // 往下游转发调用方的凭证，不要用 SUPABASE_SERVICE_ROLE_KEY ——
  // 2026-08-26 实测：edge runtime 注入的那个是新版 sb_secret_ 格式，不是 JWT，
  // conversions-api 拿它去建 supabase client 会直接报「Expected 3 parts in JWT」。
  // 转发调用方的 Authorization 既能用，语义也更对（谁调的就用谁的权限）。
  const callerAuth = req.headers.get('Authorization') ?? '';
  const callerApiKey = req.headers.get('apikey') ?? callerAuth.replace(/^Bearer\s+/i, '');

  let body: { limit?: number; dry_run?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // 空 body 也允许 —— pg_cron 调用时不带参数
  }
  const limit = Math.min(Math.max(body.limit ?? DEFAULT_LIMIT, 1), 200);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data: candidates, error } = await supabase.rpc(
    'engaged_lead_candidates',
    { max_rows: limit },
  );
  if (error) return json({ error: error.message }, 500);

  const rows = (candidates ?? []) as Array<{
    contact_id: string;
    inbound_count: number;
  }>;
  if (body.dry_run) {
    return json({ dry_run: true, candidates: rows.length, rows });
  }

  let sent = 0;
  const failures: Array<{ contact_id: string; reason: string }> = [];

  for (const row of rows) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/conversions-api`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: callerAuth,
          apikey: callerApiKey,
        },
        body: JSON.stringify({
          contact_id: row.contact_id,
          event_name: 'EngagedLead',
        }),
      });
      if (resp.ok) {
        sent++;
      } else {
        failures.push({
          contact_id: row.contact_id,
          reason: `conversions-api ${resp.status}: ${(await resp.text()).slice(0, 160)}`,
        });
      }
    } catch (err) {
      failures.push({
        contact_id: row.contact_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({ ok: true, candidates: rows.length, sent, failures });
});
