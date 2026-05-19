#!/usr/bin/env node
/**
 * 找出"有来有回"的对话：outbound>=5 且 inbound>=5 的 contact。
 * 先统计分布，再决定要不要全部 dump。
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORG_ID } = process.env;
if (!VITE_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ORG_ID) {
  console.error('需要 .env 配置 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ORG_ID');
  process.exit(1);
}

const sb = createClient(VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;

async function fetchAllPaged(query) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

console.log('拉取本 org 全部 contacts...');
const contacts = await fetchAllPaged(
  sb
    .from('contacts')
    .select('id, phone, name, wa_name, country, language, budget_usd, customer_stage, quality, group_jid')
    .eq('org_id', ORG_ID),
);
console.log(`  ${contacts.length} contacts`);

const contactById = new Map(contacts.map((c) => [c.id, c]));
const contactIds = new Set(contactById.keys());

console.log('拉取本 org 全部 messages...');
// messages 表没有 org_id，要么 join contacts，要么先拉 contact_ids
// 直接 select 全表然后 JS 过滤——messages 表跨 org 行数应该不大
const messages = await fetchAllPaged(
  sb
    .from('messages')
    .select('contact_id, direction, text, sent_at'),
);
console.log(`  总 messages: ${messages.length}`);

const ownMsgs = messages.filter((m) => contactIds.has(m.contact_id));
console.log(`  本 org messages: ${ownMsgs.length}`);

// 按 contact_id 分组 + count inbound/outbound
const stats = new Map(); // contact_id → { inbound, outbound, msgs }
for (const m of ownMsgs) {
  let s = stats.get(m.contact_id);
  if (!s) {
    s = { inbound: 0, outbound: 0, msgs: [] };
    stats.set(m.contact_id, s);
  }
  if (m.direction === 'inbound') s.inbound++;
  else if (m.direction === 'outbound') s.outbound++;
  s.msgs.push(m);
}

console.log(`\n有 messages 的 contacts: ${stats.size}`);

// 筛"有来有回"的 contact
const THRESHOLD = 5;
const qualified = [];
for (const [cid, s] of stats) {
  if (s.inbound >= THRESHOLD && s.outbound >= THRESHOLD) {
    qualified.push({ cid, ...s });
  }
}
console.log(`\n✅ outbound>=${THRESHOLD} && inbound>=${THRESHOLD} 的 contacts: ${qualified.length}`);

// 国家分布
const byCountry = {};
for (const q of qualified) {
  const c = contactById.get(q.cid);
  const k = c?.country || '(空)';
  byCountry[k] = (byCountry[k] || 0) + 1;
}
console.log('\n国家分布 (qualifying contacts):');
console.table(Object.fromEntries(Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 15)));

// 语言分布
const byLang = {};
for (const q of qualified) {
  const c = contactById.get(q.cid);
  const k = c?.language || '(空)';
  byLang[k] = (byLang[k] || 0) + 1;
}
console.log('\n语言分布:');
console.table(byLang);

// 阶段分布
const byStage = {};
for (const q of qualified) {
  const c = contactById.get(q.cid);
  const k = c?.customer_stage || '(空)';
  byStage[k] = (byStage[k] || 0) + 1;
}
console.log('\n阶段分布:');
console.table(byStage);

// 消息总数分布
const buckets = { '5-10': 0, '11-20': 0, '21-50': 0, '51-100': 0, '100+': 0 };
for (const q of qualified) {
  const total = q.inbound + q.outbound;
  if (total <= 10) buckets['5-10']++;
  else if (total <= 20) buckets['11-20']++;
  else if (total <= 50) buckets['21-50']++;
  else if (total <= 100) buckets['51-100']++;
  else buckets['100+']++;
}
console.log('\n消息总数分布:');
console.table(buckets);

// 群聊 vs 个人
const isGroup = qualified.filter((q) => contactById.get(q.cid)?.group_jid).length;
console.log(`\n群聊 contacts: ${isGroup} / ${qualified.length}`);

// 顶部 30
console.log('\n消息最多的 top 30:');
qualified.sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound));
for (const q of qualified.slice(0, 30)) {
  const c = contactById.get(q.cid);
  const name = c?.name?.trim() || c?.wa_name?.trim() || '(无名)';
  const country = c?.country || '(空国家)';
  const lang = c?.language || '(空)';
  const stage = c?.customer_stage || '(空)';
  console.log(
    `  ${name.padEnd(20)} | ${country.padEnd(15)} | ${lang.padEnd(10)} | ${stage.padEnd(12)} | in=${q.inbound} out=${q.outbound}`,
  );
}

console.log('\n✅ 统计完成');
