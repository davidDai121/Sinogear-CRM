#!/usr/bin/env node
/**
 * 一次性修复 messages 表里 sent_at = NULL 的行（1349 条，主要是纯媒体 bubble
 * 的占位 — WA Web 媒体 bubble 没 data-pre-plain-text → getMessageTimestamp
 * 解析不到 → 写 DB 时 sent_at = NULL）。
 *
 * 策略：用 synced_at（DB 写入时间）作为 sent_at 的近似。
 *   - 近期 sync 的（同一次 generate 期间 DOM 抓到）：误差 < 10 分钟，OK
 *   - 老 sync 的（几天/几周前 sync 过）：误差小时到天级，但仍比"按 timestamp=0
 *     排到最前面"靠谱（按 timestamp=0 排 + formatTimestamp(null) 兜底为当前时刻
 *     是已知的 Samuel "05-26 15:26 凭空冒出 2 photos+1 doc" bug 的根因）
 *
 * 真实信息（DOM 抓时丢的 timestamp）已经无法恢复，这是最稳的近似方案。
 * Dry-run（planB 邻居推断）已经证明：sent_at NULLS FIRST 排序下，
 * 邻居推断方向系统性错（NULL 都甩到 array 最前，推断永远是"早于第一条真消息"）。
 *
 * 用法：
 *   node scripts/backfill-null-sent-at.mjs --dry-run     # 看影响不写
 *   node scripts/backfill-null-sent-at.mjs --apply       # 真的写
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = args.includes('--dry-run') || !APPLY;

if (!APPLY && !args.includes('--dry-run')) {
  console.log('No mode specified, defaulting to --dry-run. Use --apply to actually write.');
}

const HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  'Content-Type': 'application/json',
};

async function fetchAllNullRows() {
  const PAGE = 1000;
  let from = 0;
  const out = [];
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/messages?sent_at=is.null&select=id,contact_id,wa_message_id,direction,text,sent_at,synced_at&order=synced_at.asc.nullsfirst`;
    const res = await fetch(url, {
      headers: { ...HEADERS, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`fetch ${from}- failed: ${res.status} ${t}`);
    }
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function updateRow(id, sentAt) {
  const url = `${SUPABASE_URL}/rest/v1/messages?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({ sent_at: sentAt }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`update ${id} failed: ${res.status} ${t}`);
  }
}

console.log(`Mode: ${APPLY ? 'APPLY (will write to DB)' : 'DRY-RUN (no writes)'}`);
console.log('Fetching all messages with sent_at IS NULL ...');

const rows = await fetchAllNullRows();
console.log(`Found ${rows.length} rows with sent_at = NULL`);

// 统计：按 text 类型 + 按 synced_at 是否 NULL
const stats = {
  totalRows: rows.length,
  syncedAtNull: 0,
  syncedAtPresent: 0,
  byText: {},
  byContact: {},
};
for (const r of rows) {
  if (!r.synced_at) stats.syncedAtNull++;
  else stats.syncedAtPresent++;
  stats.byText[r.text] = (stats.byText[r.text] || 0) + 1;
  stats.byContact[r.contact_id] = (stats.byContact[r.contact_id] || 0) + 1;
}

console.log('\n=== Stats ===');
console.log(`  synced_at NULL too (无救): ${stats.syncedAtNull}`);
console.log(`  synced_at present (可填):  ${stats.syncedAtPresent}`);
console.log(`  涉及 contact 数:            ${Object.keys(stats.byContact).length}`);
console.log('\nTop 15 text:');
const topText = Object.entries(stats.byText).sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [text, n] of topText) {
  const short = text.length > 60 ? text.slice(0, 57) + '...' : text;
  console.log(`  ${n.toString().padStart(5)} ${JSON.stringify(short)}`);
}

// Sample 10 rows for visual check
console.log('\n=== Sample 10 rows (will update sent_at = synced_at) ===');
for (const r of rows.slice(0, 10)) {
  const shortText = r.text.length > 40 ? r.text.slice(0, 37) + '...' : r.text;
  console.log(
    `  contact=${r.contact_id.slice(0, 8)} ${r.direction.padEnd(8)} text=${JSON.stringify(shortText).padEnd(45)} synced_at=${r.synced_at ?? 'NULL'}`,
  );
}

if (DRY_RUN) {
  console.log('\n[DRY-RUN] No changes written. Re-run with --apply to commit.');
  process.exit(0);
}

// APPLY mode
console.log('\n=== APPLYING ===');
const toUpdate = rows.filter((r) => r.synced_at != null);
console.log(`Updating ${toUpdate.length} rows (skipping ${stats.syncedAtNull} with synced_at NULL too)...`);

let done = 0;
let failed = 0;
const errs = [];
const CONCURRENCY = 10;
const queue = [...toUpdate];

async function worker() {
  while (queue.length > 0) {
    const row = queue.shift();
    if (!row) break;
    try {
      await updateRow(row.id, row.synced_at);
      done++;
    } catch (e) {
      failed++;
      if (errs.length < 5) errs.push(`${row.id}: ${e.message}`);
    }
    if ((done + failed) % 100 === 0) {
      console.log(`  progress: ${done + failed}/${toUpdate.length} (${failed} failed)`);
    }
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);

console.log(`\nDone. updated=${done}, failed=${failed}`);
if (errs.length > 0) {
  console.log('\nFirst few errors:');
  for (const e of errs) console.log('  ' + e);
}
