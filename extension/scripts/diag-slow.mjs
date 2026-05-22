#!/usr/bin/env node
/**
 * 一次性诊断：测各表行数 + last_message_direction_per_contact RPC 实际耗时
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

async function countRows(table, filter) {
  const t0 = Date.now();
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  const ms = Date.now() - t0;
  return { count, ms, error: error?.message };
}

async function timeRpc(name, args) {
  const t0 = Date.now();
  const { data, error } = await sb.rpc(name, args);
  const ms = Date.now() - t0;
  return { rows: data?.length, ms, error: error?.message };
}

async function timeQuery(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  return { label, ms, ...result };
}

console.log('orgId:', ORG_ID);
console.log('---- 表行数 ----');

const tables = [
  ['contacts', (q) => q.eq('org_id', ORG_ID)],
  ['vehicle_interests', null],
  ['contact_tags', null],
  ['contact_handlers', null],
  ['messages', null],
  ['vehicles', (q) => q.eq('org_id', ORG_ID)],
  ['vehicle_media', null],
  ['contact_events', null],
];
for (const [t, filter] of tables) {
  const r = await countRows(t, filter);
  console.log(`  ${t.padEnd(20)} ${(r.count ?? '?').toString().padStart(8)} 行 (${r.ms}ms)${r.error ? ' ERR=' + r.error : ''}`);
}

console.log('\n---- 关键 RPC 耗时 ----');
const r1 = await timeRpc('last_message_direction_per_contact', { p_org_id: ORG_ID });
console.log(`  last_message_direction_per_contact:  ${r1.ms}ms (${r1.rows} 行)${r1.error ? ' ERR=' + r1.error : ''}`);

// 跑第二次看缓存效果
const r1b = await timeRpc('last_message_direction_per_contact', { p_org_id: ORG_ID });
console.log(`    (第二次):                          ${r1b.ms}ms`);

console.log('\n---- 客户端"分页拉全部"模拟 ----');
const q1 = await timeQuery('fetchAllContacts (slim)', async () => {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb
      .from('contacts')
      .select('id, phone, group_jid, wa_name, name, country, language, budget_usd, customer_stage, quality, destination_port')
      .eq('org_id', ORG_ID)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out.length };
});
console.log(`  ${q1.label.padEnd(30)} ${q1.ms}ms (${q1.rows} 行)`);

const q2 = await timeQuery('fetchAllVehicleInterests', async () => {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb
      .from('vehicle_interests')
      .select('*, contacts!inner(org_id)')
      .eq('contacts.org_id', ORG_ID)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out.length };
});
console.log(`  ${q2.label.padEnd(30)} ${q2.ms}ms (${q2.rows} 行)`);

const q3 = await timeQuery('fetchAllContactTags', async () => {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb
      .from('contact_tags')
      .select('*, contacts!inner(org_id)')
      .eq('contacts.org_id', ORG_ID)
      .order('contact_id', { ascending: true })
      .order('tag', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out.length };
});
console.log(`  ${q3.label.padEnd(30)} ${q3.ms}ms (${q3.rows} 行)`);

const q4 = await timeQuery('fetchHandlersForOrg', async () => {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb
      .from('contact_handlers')
      .select('*, contacts!inner(org_id)')
      .eq('contacts.org_id', ORG_ID)
      .order('contact_id', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out.length };
});
console.log(`  ${q4.label.padEnd(30)} ${q4.ms}ms (${q4.rows} 行)`);

console.log('\n---- 索引检查 ----');
const idxQ = await sb.rpc('exec_sql', { sql: `select indexname, indexdef from pg_indexes where tablename = 'messages'` }).catch(() => null);
if (idxQ?.data) {
  for (const r of idxQ.data) console.log(`  messages: ${r.indexname} = ${r.indexdef}`);
} else {
  console.log('  (无法读 pg_indexes — exec_sql RPC 不存在，跳过)');
}
