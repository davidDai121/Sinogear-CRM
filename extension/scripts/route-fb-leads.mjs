#!/usr/bin/env node
/**
 * 广告线索按表单落到业务员头上。
 *
 * 为什么按表单而不是按国家（2026-08-21）：boss 说「一个表单只给一个业务员」。
 * 实测确认卢旺达同时有两个表单、归两个不同的人，按国家分必然分错。
 *
 * 归属怎么来的：Meta 不给读表单绑的 WhatsApp 号（试过 7 种 API 字段/端点、
 * 表单库 UI、表单预览、整页 DOM 搜索，全拿不到）。改成从事实反推——
 * 点过「Chat on WhatsApp」的客户被真实路由到某个业务员的号上，
 * 而每个业务员用自己的 WhatsApp 登录扩展，contact_handlers 自动登记。
 * 按表单统计主理人分布，取占比最高的那个。
 *
 * 用法：
 *   node scripts/route-fb-leads.mjs --detect        # 只看推断结果，不写
 *   node scripts/route-fb-leads.mjs --detect --apply # 把推断结果写成规则
 *   node scripts/route-fb-leads.mjs --assign         # 按现有规则给未分配的线索落主理人（dry-run）
 *   node scripts/route-fb-leads.mjs --assign --apply # 真写
 *
 * 新建广告表单之后，等它攒够几条「客户点了按钮」的线索，跑一次 --detect 就能
 * 推出归属；纯度低于 MIN_PURITY 或样本太少的会跳过，需要人工指定。
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url).pathname });

const URL_ = process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORG = process.env.ORG_ID;
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

const APPLY = process.argv.includes('--apply');
const DETECT = process.argv.includes('--detect');
const ASSIGN = process.argv.includes('--assign');
/** 样本太少推不准；纯度太低说明这个表单同时被多人在跟，要人工定 */
const MIN_SAMPLE = 3;
const MIN_PURITY = 0.7;

/**
 * 人工指定的归属（boss 2026-08-21 拍板）。
 * 这三个 PL 表单样本太少（2 条 / 1 条 / 0 条），自动推断够不着阈值，
 * 但方向明确：聊过的那几条全是 2064026258，且 boss 说「PL 那个给 2064026258」。
 * 写死在这里而不是只落库，是为了以后重建规则时不用再问一遍。
 */
const MANUAL_RULES = [
  { form: 'PL-B2B-songPLUS-form-v2-1-copy', email: '2064026258@qq.com' },
  { form: 'PL-B2B-songPLUS-form-v3', email: '2064026258@qq.com' },
  { form: 'PL-B2B-QINPLUS-form-v2', email: '2064026258@qq.com' },
];

// contact_handlers 是复合主键没有 id 列，排序列要能传
async function page(table, cols, filter, orderCol = 'id') {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const users = (await (await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=200`, {
  headers: { apikey: KEY, Authorization: 'Bearer ' + KEY },
})).json()).users || [];
const emailOf = Object.fromEntries(users.map((u) => [u.id, u.email]));
const shortOf = (id) => (emailOf[id] || id).split('@')[0];

const evs = await page('contact_events', 'contact_id, payload', (q) => q.eq('event_type', 'fb_lead_received'));
const handlers = await page('contact_handlers', 'contact_id, user_id, last_seen_at', null, 'contact_id');
// 一个 contact 可能有多个 handler；取最早接触的那个（最可能是被路由到的人）
const firstHandler = new Map();
for (const h of handlers) {
  const p = firstHandler.get(h.contact_id);
  if (!p || h.last_seen_at < p.last_seen_at) firstHandler.set(h.contact_id, h);
}
const msgCount = new Map();
const ids = evs.map((e) => e.contact_id);
for (let i = 0; i < ids.length; i += 200) {
  const { data } = await sb.from('contact_sales_signals').select('contact_id, message_count').in('contact_id', ids.slice(i, i + 200));
  (data || []).forEach((s) => msgCount.set(s.contact_id, s.message_count || 0));
}

if (DETECT) {
  const stat = {};
  for (const e of evs) {
    const f = e.payload?.form_name;
    if (!f) continue;
    stat[f] = stat[f] || { contacted: 0, who: {} };
    if ((msgCount.get(e.contact_id) || 0) === 0) continue;  // 只有聊过的才是路由证据
    const h = firstHandler.get(e.contact_id);
    if (!h) continue;
    stat[f].contacted++;
    stat[f].who[h.user_id] = (stat[f].who[h.user_id] || 0) + 1;
  }
  console.log('=== 按表单推断归属 ===');
  const rules = [];
  for (const [form, v] of Object.entries(stat).sort((a, b) => b[1].contacted - a[1].contacted)) {
    const ranked = Object.entries(v.who).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) { console.log(`  ${form}\n     样本 0，跳过`); continue; }
    const [uid, n] = ranked[0];
    const purity = n / v.contacted;
    const ok = v.contacted >= MIN_SAMPLE && purity >= MIN_PURITY;
    console.log(`  ${form}`);
    console.log(`     ${ranked.map(([u, c]) => `${shortOf(u)} ${c}`).join(' | ')}  → ${shortOf(uid)} ${Math.round(purity * 100)}% ${ok ? '✅' : '⚠️ 样本不足或纯度低，跳过'}`);
    if (ok) rules.push({ org_id: ORG, form_name: form, user_id: uid, auto_detected: true, confidence: Number(purity.toFixed(3)) });
  }
  const idOfEmail = Object.fromEntries(Object.entries(emailOf).map(([id, em]) => [em, id]));
  for (const m of MANUAL_RULES) {
    const uid = idOfEmail[m.email];
    if (!uid) { console.log(`  ⚠️ 人工规则找不到用户 ${m.email}`); continue; }
    if (rules.some((r) => r.form_name === m.form)) continue;   // 自动推断已覆盖就不重复
    console.log(`  ${m.form}\n     人工指定 → ${shortOf(uid)} ✍️`);
    rules.push({ org_id: ORG, form_name: m.form, user_id: uid, auto_detected: false, note: 'boss 2026-08-21 人工指定' });
  }
  if (APPLY && rules.length) {
    const { error } = await sb.from('lead_routing_rules').upsert(rules, { onConflict: 'org_id,form_name' });
    console.log(error ? `\n❌ 写入失败: ${error.message}` : `\n✅ 已写入 ${rules.length} 条规则`);
  } else if (!APPLY) {
    console.log('\n（dry-run，没写。加 --apply 落库）');
  }
}

if (ASSIGN) {
  const { data: rules, error } = await sb.from('lead_routing_rules').select('form_name, user_id').eq('org_id', ORG);
  if (error) { console.log('读规则失败:', error.message); process.exit(1); }
  const ruleOf = Object.fromEntries((rules || []).map((r) => [r.form_name, r.user_id]));
  console.log(`\n=== 按 ${rules?.length ?? 0} 条规则分配未认领的线索 ===`);
  const rows = []; let noRule = 0, already = 0;
  for (const e of evs) {
    if (firstHandler.has(e.contact_id)) { already++; continue; }   // 已经有人跟了，不动
    const uid = ruleOf[e.payload?.form_name];
    if (!uid) { noRule++; continue; }
    rows.push({ contact_id: e.contact_id, user_id: uid, last_seen_at: new Date().toISOString() });
  }
  const per = {};
  rows.forEach((r) => { per[shortOf(r.user_id)] = (per[shortOf(r.user_id)] || 0) + 1; });
  console.log('  已有主理人，跳过 :', already);
  console.log('  没有对应规则     :', noRule);
  console.log('  将要分配         :', rows.length);
  Object.entries(per).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${k}: ${v}`));
  if (APPLY && rows.length) {
    for (let i = 0; i < rows.length; i += 200) {
      const { error: e2 } = await sb.from('contact_handlers').upsert(rows.slice(i, i + 200), { onConflict: 'contact_id,user_id' });
      if (e2) console.log('  写入失败:', e2.message.slice(0, 80));
    }
    console.log('  ✅ 已写入 contact_handlers');
  } else if (!APPLY) {
    console.log('\n（dry-run，没写。加 --apply 落库）');
  }
}

if (!DETECT && !ASSIGN) console.log('用法见文件头注释：--detect / --assign，加 --apply 才真写');
