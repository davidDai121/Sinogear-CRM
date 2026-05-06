#!/usr/bin/env node
/**
 * 探查 Supabase 客户数据，看分布特征，决定分组怎么设计。
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

// 分页读取所有 contacts
async function readAllContacts() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('contacts')
      .select('id, phone, name, wa_name, country, language, budget_usd, customer_stage, quality, destination_port, reminder_disabled, reminder_ack_at, created_at, updated_at')
      .eq('org_id', ORG_ID)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const contacts = await readAllContacts();
console.log(`\n📊 客户总数: ${contacts.length}\n`);

// ── 按 quality 分布 ──
const byQuality = {};
for (const c of contacts) {
  const q = c.quality || 'unknown';
  byQuality[q] = (byQuality[q] || 0) + 1;
}
console.log('🌟 客户质量 quality 分布:');
console.table(byQuality);

// ── 按 customer_stage 分布 ──
const byStage = {};
for (const c of contacts) {
  const s = c.customer_stage || 'unknown';
  byStage[s] = (byStage[s] || 0) + 1;
}
console.log('\n🎯 客户阶段 stage 分布:');
console.table(byStage);

// ── 按 country 分布 (top 15) ──
const byCountry = {};
for (const c of contacts) {
  const k = c.country || '(空)';
  byCountry[k] = (byCountry[k] || 0) + 1;
}
const topCountries = Object.entries(byCountry)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);
console.log('\n🌍 国家 top 15:');
console.table(Object.fromEntries(topCountries));

// ── 按 language 分布 ──
const byLang = {};
for (const c of contacts) {
  const k = c.language || '(空)';
  byLang[k] = (byLang[k] || 0) + 1;
}
console.log('\n🗣️ 语言分布:');
console.table(byLang);

// ── 按预算分档 ──
const budgetBuckets = {
  '0/null': 0,
  '< $5k': 0,
  '$5-10k': 0,
  '$10-20k': 0,
  '$20-40k': 0,
  '$40-100k': 0,
  '> $100k': 0,
};
for (const c of contacts) {
  const b = c.budget_usd ? Number(c.budget_usd) : 0;
  if (!b) budgetBuckets['0/null']++;
  else if (b < 5000) budgetBuckets['< $5k']++;
  else if (b < 10000) budgetBuckets['$5-10k']++;
  else if (b < 20000) budgetBuckets['$10-20k']++;
  else if (b < 40000) budgetBuckets['$20-40k']++;
  else if (b < 100000) budgetBuckets['$40-100k']++;
  else budgetBuckets['> $100k']++;
}
console.log('\n💰 预算分档:');
console.table(budgetBuckets);

// ── 名字补全状态 ──
const nameStat = {
  '有 name': 0,
  '只有 wa_name': 0,
  '都没有': 0,
};
for (const c of contacts) {
  if (c.name?.trim()) nameStat['有 name']++;
  else if (c.wa_name?.trim()) nameStat['只有 wa_name']++;
  else nameStat['都没有']++;
}
console.log('\n👤 客户名字补全:');
console.table(nameStat);

// ── 国家+语言 一起空的（=未识别）──
const noCountryNoLang = contacts.filter((c) => !c.country && !c.language).length;
const noCountry = contacts.filter((c) => !c.country).length;
console.log(`\n❓ 没识别国家: ${noCountry}`);
console.log(`❓ 既没国家也没语言: ${noCountryNoLang}`);

// ── reminder 状态 ──
const reminderStat = {
  disabled: 0,
  acked: 0,
  active: 0,
};
for (const c of contacts) {
  if (c.reminder_disabled) reminderStat.disabled++;
  else if (c.reminder_ack_at) reminderStat.acked++;
  else reminderStat.active++;
}
console.log('\n🔔 跟进提醒状态:');
console.table(reminderStat);

// ── 报价 / 车辆兴趣 / 任务 关联状态 ──
const [vi, qts, tks, evts, msgs, tags] = await Promise.all([
  sb.from('vehicle_interests').select('contact_id', { count: 'exact', head: true }),
  sb.from('quotes').select('contact_id', { count: 'exact', head: true }),
  sb.from('tasks').select('contact_id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
  sb.from('contact_events').select('id', { count: 'exact', head: true }),
  sb.from('messages').select('id', { count: 'exact', head: true }),
  sb.from('contact_tags').select('contact_id', { count: 'exact', head: true }),
]);

console.log('\n📦 关联表数据量:');
console.table({
  vehicle_interests: vi.count ?? 0,
  quotes: qts.count ?? 0,
  tasks: tks.count ?? 0,
  contact_events: evts.count ?? 0,
  messages: msgs.count ?? 0,
  contact_tags: tags.count ?? 0,
});

// ── 标签分布 ──
const { data: tagRows } = await sb.from('contact_tags').select('tag, contact_id');
const tagCount = {};
const contactsWithTags = new Set();
for (const r of tagRows ?? []) {
  tagCount[r.tag] = (tagCount[r.tag] || 0) + 1;
  contactsWithTags.add(r.contact_id);
}
console.log(`\n🏷️ 有标签的客户: ${contactsWithTags.size} / ${contacts.length}`);
console.log('   标签分布:');
console.table(tagCount);

// ── 最近聊过 vs 老客户 ──
const now = Date.now();
const DAY = 24 * 3600 * 1000;
const activityBuckets = {
  '今天': 0,
  '本周内': 0,
  '本月内': 0,
  '1-3 月': 0,
  '3-6 月': 0,
  '6+ 月': 0,
};

// 用 messages.sent_at 看最近活跃
const { data: latestMsgs } = await sb
  .from('messages')
  .select('contact_id, sent_at')
  .order('sent_at', { ascending: false });

const latestByContact = new Map();
for (const m of latestMsgs ?? []) {
  if (!latestByContact.has(m.contact_id)) {
    latestByContact.set(m.contact_id, m.sent_at);
  }
}
console.log(`\n💬 有消息记录的客户: ${latestByContact.size} / ${contacts.length}`);

for (const c of contacts) {
  const last = latestByContact.get(c.id);
  if (!last) continue;
  const ageDays = (now - new Date(last).getTime()) / DAY;
  if (ageDays < 1) activityBuckets['今天']++;
  else if (ageDays < 7) activityBuckets['本周内']++;
  else if (ageDays < 30) activityBuckets['本月内']++;
  else if (ageDays < 90) activityBuckets['1-3 月']++;
  else if (ageDays < 180) activityBuckets['3-6 月']++;
  else activityBuckets['6+ 月']++;
}
console.log('\n⏱️  最近一条消息距今 (基于 messages 表):');
console.table(activityBuckets);

// ── 销售 vs 客户 谁说最后一句 ──
console.log('\n👥 抽查 30 个有消息客户的"最后一句话方向":');
const sample = Array.from(latestByContact.keys()).slice(0, 30);
const dirCount = { customer_last: 0, sales_last: 0 };
for (const cid of sample) {
  const { data: last } = await sb
    .from('messages')
    .select('direction')
    .eq('contact_id', cid)
    .order('sent_at', { ascending: false })
    .limit(1);
  if (last?.[0]?.direction === 'inbound') dirCount.customer_last++;
  else if (last?.[0]?.direction === 'outbound') dirCount.sales_last++;
}
console.table(dirCount);

console.log('\n✅ 分析完成');
