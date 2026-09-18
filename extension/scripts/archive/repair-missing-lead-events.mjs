#!/usr/bin/env node
/**
 * 补 fb-lead-webhook 丢掉的 fb_lead_received 事件。
 *
 * 根因（2026-08-21 实测）：webhook 里写事件用的是 `void supabase...insert(...)`，
 * 没有 await。Edge Function 跑在 Deno Deploy 上，handler 一返回 Response，
 * 未完成的 promise 就被杀掉——contact 建出来了、fb_lead_id / fb_ad_id 也写了，
 * 但事件一条没落库。而线索分配页和 apply_lead_routing 都靠 payload->>'form_name'
 * 找线索，没事件 = 这条线索永远分不出去、客户卡上也看不到表单作答。
 *
 * 代码已经改成 await，但**要等函数重新部署才生效**。这个脚本负责补历史。
 *
 * 怎么补：contacts.fb_lead_id 活下来了，直接拿它回 Graph API 取原始线索——
 * 能拿到准确的 form_id 和完整表单作答（要几台 / 多久买 / 用途），
 * 比按 ad_id 反推可靠（实测有 2 条广告先后指向过两个表单，反推会有歧义）。
 *
 * 用法：FB_TOKEN=xxx node scripts/repair-missing-lead-events.mjs [--apply]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url).pathname });

const APPLY = process.argv.includes('--apply');
const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ORG = process.env.ORG_ID;

async function page(table, cols, orderCol, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const leads = await page('contacts', 'id, phone, name, fb_lead_id, fb_ad_id, created_at', 'id',
  (q) => q.eq('org_id', ORG).not('fb_lead_id', 'is', null));
const ids = leads.map((c) => c.id);

const withEvent = new Set();
for (let i = 0; i < ids.length; i += 200) {
  const { data } = await sb.from('contact_events').select('contact_id')
    .in('contact_id', ids.slice(i, i + 200)).eq('event_type', 'fb_lead_received');
  (data ?? []).forEach((e) => withEvent.add(e.contact_id));
}
const missing = leads.filter((c) => !withEvent.has(c.id));
console.log(`广告线索客户 ${leads.length} 个，缺事件的 ${missing.length} 个`);

const T = process.env.FB_TOKEN;
if (!T) { console.log('\n需要 FB_TOKEN 环境变量（system user token）'); process.exit(1); }
const g = async (u, tok = T) => (await fetch(u, { headers: { Authorization: 'Bearer ' + tok } })).json();

// form_id → form_name（Page 上的表单目录）
const pt = (await g('https://graph.facebook.com/v25.0/me/accounts?fields=access_token')).data?.[0]?.access_token;
const forms = (await g(`https://graph.facebook.com/v25.0/1241950519005601/leadgen_forms?fields=id,name&limit=50`, pt)).data ?? [];
const formName = Object.fromEntries(forms.map((f) => [f.id, f.name]));

const rows = [];
let failed = 0;
for (const c of missing) {
  const lead = await g(`https://graph.facebook.com/v25.0/${c.fb_lead_id}?fields=id,created_time,ad_id,form_id,field_data`);
  if (lead.error) { console.log(`  ✗ ${c.phone} ${lead.error.message.slice(0, 50)}`); failed++; continue; }
  const fn = formName[lead.form_id] ?? '(未知表单)';
  console.log(`  ${String(c.phone).padEnd(16)} ${(c.name || '?').slice(0, 18).padEnd(20)} → ${fn}`);
  rows.push({
    contact_id: c.id,
    event_type: 'fb_lead_received',
    payload: {
      fb_lead_id: c.fb_lead_id,
      form_id: lead.form_id,
      form_name: fn,
      ad_id: lead.ad_id ?? c.fb_ad_id ?? null,
      created_time: lead.created_time,
      field_data: lead.field_data,
      recovered: true,
      recovered_at: new Date().toISOString(),
      note: 'webhook 未 await 导致原事件丢失，按 lead_id 回 Graph API 补回',
    },
  });
}
console.log(`\n可补 ${rows.length} 条${failed ? ` · Graph API 取不到 ${failed} 条` : ''}`);

if (!APPLY) { console.log('\n（dry-run，没写。加 --apply 执行）'); process.exit(0); }
for (let i = 0; i < rows.length; i += 200) {
  const { error } = await sb.from('contact_events').insert(rows.slice(i, i + 200));
  if (error) console.log('写入失败:', error.message.slice(0, 80));
}
console.log(`\n✅ 已补 ${rows.length} 条 fb_lead_received`);
