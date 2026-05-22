#!/usr/bin/env node
/**
 * 一次性诊断：contact_events 92 万行的分布
 *   - 每种 event_type 多少行
 *   - 最老 / 最新一条
 *   - 单 contact 最多多少条事件（找疯写源）
 *   - 同一 contact + event_type + 同一天 重复数（识别 flip-flop 残留）
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

console.log('---- 总量 + 时间范围 ----');
const t0 = Date.now();
// exact count 在 92 万行上超时，用 estimated（从 pg_class.reltuples 拿）
const { count: total } = await sb
  .from('contact_events')
  .select('*', { count: 'estimated', head: true });
console.log(`  total (estimated): ${total} 行 (${Date.now() - t0}ms)`);

const { data: oldest } = await sb
  .from('contact_events')
  .select('created_at, event_type')
  .order('created_at', { ascending: true })
  .limit(1);
const { data: newest } = await sb
  .from('contact_events')
  .select('created_at, event_type')
  .order('created_at', { ascending: false })
  .limit(1);
console.log(`  最老: ${oldest?.[0]?.created_at} (${oldest?.[0]?.event_type})`);
console.log(`  最新: ${newest?.[0]?.created_at} (${newest?.[0]?.event_type})`);

console.log('\n---- 抽样 10 万条按 event_type 分桶（估算总分布）----');
// 取最新 10 万条作为样本，按 type group by，按比例换算到总数
const SAMPLE = 100_000;
const sampleByType = new Map();
let sampleCount = 0;
const PAGE = 1000;
for (let from = 0; from < SAMPLE; from += PAGE) {
  const { data, error } = await sb
    .from('contact_events')
    .select('event_type')
    .order('created_at', { ascending: false })
    .range(from, from + PAGE - 1);
  if (error || !data || data.length === 0) break;
  for (const r of data) {
    sampleByType.set(r.event_type, (sampleByType.get(r.event_type) ?? 0) + 1);
    sampleCount++;
  }
  if (data.length < PAGE) break;
}
console.log(`  样本: ${sampleCount} 条 (最新)`);
const sortedTypes = Array.from(sampleByType.entries()).sort((a, b) => b[1] - a[1]);
for (const [t, c] of sortedTypes) {
  const pct = ((100 * c) / sampleCount).toFixed(1);
  const est = Math.round((c / sampleCount) * total);
  console.log(`  ${t.padEnd(16)} ${String(c).padStart(7)} (${pct.padStart(5)}%) → 全表估 ~${est}`);
}

console.log('\n---- 按时间段（estimated count via head + filter）----');
const ranges = [
  ['过去 7 天', 7],
  ['过去 30 天', 30],
  ['过去 90 天', 90],
  ['过去 180 天', 180],
];
for (const [label, days] of ranges) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { count } = await sb
    .from('contact_events')
    .select('*', { count: 'estimated', head: true })
    .gte('created_at', since);
  console.log(`  ${label.padEnd(12)} ~${String(count ?? '?').padStart(8)}`);
}

console.log('\n---- TOP 10 写事件最多的 contact（找疯写源） ----');
// 按 contact_id group by 在 PostgREST 没法直接做，用 RPC 临时跑
// 退而求其次：拉前几千条扫一下 contact_id 频率
const { data: sample } = await sb
  .from('contact_events')
  .select('contact_id, event_type')
  .order('created_at', { ascending: false })
  .limit(50000);
const byContact = new Map();
const byContactType = new Map();
for (const r of sample ?? []) {
  byContact.set(r.contact_id, (byContact.get(r.contact_id) ?? 0) + 1);
  const k = `${r.contact_id}|${r.event_type}`;
  byContactType.set(k, (byContactType.get(k) ?? 0) + 1);
}
const sorted = Array.from(byContact.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
console.log(`  (基于最近 5 万条样本)`);
for (const [cid, cnt] of sorted) {
  // 找这个 contact 的 top event_type
  const types = Array.from(byContactType.entries())
    .filter(([k]) => k.startsWith(cid + '|'))
    .map(([k, c]) => [k.split('|')[1], c])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  console.log(
    `  ${cid}: ${cnt} 条, top: ${types.map(([t, c]) => `${t}=${c}`).join(', ')}`,
  );
}

console.log('\n---- 抽样最近 50 条 stage_changed 看 flip-flop ----');
const { data: stageEvents } = await sb
  .from('contact_events')
  .select('contact_id, payload, created_at')
  .eq('event_type', 'stage_changed')
  .order('created_at', { ascending: false })
  .limit(50);
for (const e of stageEvents ?? []) {
  const p = e.payload ?? {};
  console.log(`  ${e.created_at} ${e.contact_id.slice(0, 8)} ${p.from} → ${p.to}`);
}
