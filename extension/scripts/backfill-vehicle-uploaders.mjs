#!/usr/bin/env node
/**
 * 一次性回填 vehicles.created_by（历史车源没记上传人，全是 NULL）。
 *
 * 归属规则（boss 2026-05-29 确认）：
 *   - brand 以 "Grant" 开头  → wanglincheng23@gmail.com (f06ce7c8…，团队成员 Grant)
 *   - 其余                    → daimenglong@gmail.com   (ecca2247…，boss 本人)
 *
 * 安全：只更新 created_by IS NULL 的行（幂等，重跑不会覆盖以后真实写入的上传人）。
 * 只动 Miles org（8932849e…）。
 *
 * 用法：
 *   node scripts/backfill-vehicle-uploaders.mjs            # dry-run（默认，不写）
 *   node scripts/backfill-vehicle-uploaders.mjs --apply    # 真的写
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

const ORG = '8932849e-b2c6-4d25-9978-b381a5186255'; // Miles
const GRANT_USER = 'f06ce7c8-9433-467f-91d4-85f8059290e5'; // wanglincheng23
const BOSS_USER = 'ecca2247-1490-41e1-b52b-8ac962df25b7'; // daimenglong

const APPLY = process.argv.includes('--apply');

const HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  'Content-Type': 'application/json',
};

const startsWithGrant = (s) => (s ?? '').trim().toLowerCase().startsWith('grant');

async function fetchNullVehicles() {
  const url =
    `${SUPABASE_URL}/rest/v1/vehicles` +
    `?org_id=eq.${ORG}&created_by=is.null&select=id,brand,model,created_by`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateCreatedBy(id, userId) {
  // 双重保险：filter 也带 created_by=is.null，杜绝并发下覆盖已填行
  const url = `${SUPABASE_URL}/rest/v1/vehicles?id=eq.${id}&created_by=is.null`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({ created_by: userId }),
  });
  if (!res.ok) throw new Error(`update ${id} failed: ${res.status} ${await res.text()}`);
}

console.log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (no writes)'}`);

const rows = await fetchNullVehicles();
console.log(`Found ${rows.length} vehicles with created_by = NULL in Miles org\n`);

const plan = rows.map((v) => ({
  ...v,
  target: startsWithGrant(v.brand) ? GRANT_USER : BOSS_USER,
  label: startsWithGrant(v.brand) ? 'Grant (wanglincheng23)' : 'boss (daimenglong)',
}));

const grant = plan.filter((p) => p.target === GRANT_USER);
const boss = plan.filter((p) => p.target === BOSS_USER);
console.log(`→ Grant (wanglincheng23): ${grant.length} 条`);
console.log(`→ boss  (daimenglong):    ${boss.length} 条\n`);

console.log('=== Grant 名下 ===');
for (const p of grant) console.log(`  ${JSON.stringify(p.brand)} | ${JSON.stringify(p.model)}`);
console.log('\n=== boss 名下（前 40） ===');
for (const p of boss.slice(0, 40)) console.log(`  ${JSON.stringify(p.brand)} | ${JSON.stringify(p.model)}`);

if (!APPLY) {
  console.log('\n[DRY-RUN] 没写任何数据。确认无误后加 --apply 执行。');
  process.exit(0);
}

console.log('\n=== APPLYING ===');
let done = 0;
let failed = 0;
for (const p of plan) {
  try {
    await updateCreatedBy(p.id, p.target);
    done++;
  } catch (e) {
    failed++;
    console.error('  ' + e.message);
  }
}
console.log(`\nDone. updated=${done}, failed=${failed}`);
