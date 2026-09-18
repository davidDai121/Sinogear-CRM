#!/usr/bin/env node
/**
 * 回滚 backfill-null-sent-at.mjs 的错误改动。
 *
 * 之前 backfill 用 sent_at = synced_at 是错的策略：
 *   - synced_at = DB 写入时间（销售首次打开 WA Web 看这条消息的时刻）
 *   - 真实 sent_at = 客户/销售点发送的时刻
 *   - 两者可能差几分钟到几天（用户隔几天才打开 WA）
 *
 * 真实案例（Samuel 那个 PDF）：
 *   - 客户 5-21 下午 2:11 发的 PDF
 *   - 销售 5-26 15:26 才打开聊天 → syncMessages 写 sent_at=NULL, synced_at=5-26
 *   - backfill 用 sent_at = synced_at → 错标成 5-26 发送（实际 5-21）
 *
 * 识别 backfill 行：sent_at = synced_at 精确相等。
 *   - 真实 WA sent_at 精度只到 minute（00 秒结尾），不会等于 microsecond 级 synced_at
 *   - backfill 行精度跟 synced_at 一致（microsecond）
 *
 * 用法：
 *   node scripts/rollback-null-sent-at-backfill.mjs --dry-run
 *   node scripts/rollback-null-sent-at-backfill.mjs --apply
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('missing env');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  'Content-Type': 'application/json',
};

async function fetchPage(from, pageSize) {
  // 用 sent_at 非 null 排除真实有时间戳的，只查可能是 backfill 的
  const url = `${SUPABASE_URL}/rest/v1/messages?sent_at=not.is.null&select=id,contact_id,text,sent_at,synced_at&order=synced_at.asc`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' },
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function fetchAllBackfilled() {
  // 拉所有 sent_at 不是 null 的，本地 filter sent_at === synced_at 的
  const PAGE = 1000;
  let from = 0;
  const out = [];
  while (true) {
    const rows = await fetchPage(from, PAGE);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.sent_at && r.synced_at && r.sent_at === r.synced_at) {
        out.push(r);
      }
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function clearSentAt(id) {
  const url = `${SUPABASE_URL}/rest/v1/messages?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({ sent_at: null }),
  });
  if (!res.ok) throw new Error(`update ${id} failed: ${res.status} ${await res.text()}`);
}

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log('Scanning messages with sent_at = synced_at (= backfill signature)...');

const rows = await fetchAllBackfilled();
console.log(`\nFound ${rows.length} rows where sent_at == synced_at (backfilled)`);

// Sanity check: 看一下识别的 row 是不是真的都是之前 NULL 的 media 占位
const stats = {};
for (const r of rows) {
  stats[r.text] = (stats[r.text] || 0) + 1;
}
console.log('\nBy text:');
const top = Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [text, n] of top) {
  const short = text.length > 70 ? text.slice(0, 67) + '...' : text;
  console.log(`  ${n.toString().padStart(5)}  ${JSON.stringify(short)}`);
}

console.log('\nSample 10 rows that will be rolled back to NULL:');
for (const r of rows.slice(0, 10)) {
  const short = r.text.length > 40 ? r.text.slice(0, 37) + '...' : r.text;
  console.log(`  contact=${r.contact_id.slice(0, 8)} sent_at=${r.sent_at} text=${JSON.stringify(short)}`);
}

if (!APPLY) {
  console.log('\n[DRY-RUN] No changes. Re-run with --apply to rollback.');
  process.exit(0);
}

console.log('\n=== ROLLBACK ===');
let done = 0;
let failed = 0;
const queue = [...rows];
const CONCURRENCY = 10;

async function worker() {
  while (queue.length > 0) {
    const r = queue.shift();
    if (!r) break;
    try {
      await clearSentAt(r.id);
      done++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.error('  failed:', r.id, e.message);
    }
    if ((done + failed) % 100 === 0) {
      console.log(`  progress: ${done + failed}/${rows.length} (${failed} failed)`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`\nDone. rolled_back=${done}, failed=${failed}`);
