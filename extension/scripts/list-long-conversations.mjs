#!/usr/bin/env node
/**
 * 按"聊得久" = (时间跨度 days × 总消息数) 排序找 top N 客户。
 * 不看 stage / quality — 纯看对话本身的厚度。
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORG_ID } = process.env;
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
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const [contacts, messages] = await Promise.all([
  fetchAllPaged(sb.from('contacts').select('id, phone, name, wa_name, country, customer_stage, group_jid').eq('org_id', ORG_ID)),
  fetchAllPaged(sb.from('messages').select('contact_id, direction, sent_at')),
]);

const contactById = new Map(contacts.map((c) => [c.id, c]));

const stats = new Map();
for (const m of messages) {
  if (!contactById.has(m.contact_id)) continue;
  let s = stats.get(m.contact_id);
  if (!s) {
    s = { inbound: 0, outbound: 0, first: Infinity, last: -Infinity };
    stats.set(m.contact_id, s);
  }
  if (m.direction === 'inbound') s.inbound++;
  else if (m.direction === 'outbound') s.outbound++;
  const ts = new Date(m.sent_at).getTime();
  if (ts < s.first) s.first = ts;
  if (ts > s.last) s.last = ts;
}

const THRESH = 5;
const DAY = 24 * 3600 * 1000;
const list = [];
for (const [cid, s] of stats) {
  if (s.inbound < THRESH || s.outbound < THRESH) continue;
  const days = Math.max(0.5, (s.last - s.first) / DAY);
  const total = s.inbound + s.outbound;
  list.push({ cid, ...s, days, total, score: days * total });
}

// 按总消息数（消息厚度）+ 时间跨度（持续时间）综合排序
list.sort((a, b) => b.total - a.total);

console.log(`合格 contact: ${list.length}\n`);
console.log('=== 按"总消息数"降序 top 30 ===');
console.log('rank | name (country, stage) | total | in/out | days | first → last');
for (let i = 0; i < Math.min(30, list.length); i++) {
  const q = list[i];
  const c = contactById.get(q.cid);
  const name = c?.name?.trim() || c?.wa_name?.trim() || '(unnamed)';
  const country = c?.country || '?';
  const stage = c?.customer_stage || '?';
  const fd = new Date(q.first).toISOString().slice(0, 10);
  const ld = new Date(q.last).toISOString().slice(0, 10);
  console.log(
    `#${String(i + 1).padStart(2)} | ${name.padEnd(28).slice(0, 28)} | ${country.padEnd(12).slice(0, 12)} | ${stage.padEnd(11).slice(0, 11)} | ${String(q.total).padStart(4)} | ${String(q.inbound).padStart(3)}/${String(q.outbound).padStart(3)} | ${q.days.toFixed(0).padStart(3)}d | ${fd} → ${ld}`,
  );
}

// 排除测试号
const TEST_PHONES = new Set(['8613552592187', '13552592187', '+8613552592187', '+13552592187']);
const filtered = list.filter((q) => {
  const c = contactById.get(q.cid);
  const p = (c?.phone || '').replace(/^\+/, '');
  return !TEST_PHONES.has(p) && !TEST_PHONES.has('+' + p);
});

console.log('\n=== 去除测试号后 top 30 ===');
for (let i = 0; i < Math.min(30, filtered.length); i++) {
  const q = filtered[i];
  const c = contactById.get(q.cid);
  const name = c?.name?.trim() || c?.wa_name?.trim() || '(unnamed)';
  const country = c?.country || '?';
  const phone = c?.phone || '(no phone)';
  const fd = new Date(q.first).toISOString().slice(0, 10);
  const ld = new Date(q.last).toISOString().slice(0, 10);
  console.log(
    `#${String(i + 1).padStart(2)} | ${name.padEnd(30).slice(0, 30)} | ${phone.padEnd(16).slice(0, 16)} | ${country.padEnd(12).slice(0, 12)} | total=${String(q.total).padStart(4)} | ${q.days.toFixed(0).padStart(3)}d`,
  );
}

// 按时间跨度排序看看（持续聊很久的）
console.log('\n=== 按"时间跨度 days"降序 top 20 (msg≥20, 去测试号) ===');
const byDays = filtered.filter((q) => q.total >= 20).sort((a, b) => b.days - a.days);
for (let i = 0; i < Math.min(20, byDays.length); i++) {
  const q = byDays[i];
  const c = contactById.get(q.cid);
  const name = c?.name?.trim() || c?.wa_name?.trim() || '(unnamed)';
  const country = c?.country || '?';
  console.log(
    `#${String(i + 1).padStart(2)} | ${name.padEnd(30).slice(0, 30)} | ${country.padEnd(12).slice(0, 12)} | total=${String(q.total).padStart(4)} | ${q.days.toFixed(0).padStart(3)}d`,
  );
}
