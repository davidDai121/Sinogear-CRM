#!/usr/bin/env node
/**
 * 只读勘察：为「车源按上传人排序」功能做准备。
 *   1. 用 auth admin API 拿 wanglingcheng23@gmail.com / daimenglong@gmail.com 的 user_id
 *   2. 分页拉全部 vehicles（id, org_id, brand, model, created_by）
 *   3. 统计：created_by 已填 / 为空；名字（brand 或 model）以 "Grant" 开头的有多少
 *   4. 打样本，确认 "Grant" 前缀落在哪个字段
 *
 * 不写任何数据。用法：node scripts/inspect-vehicle-uploaders.mjs
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

const HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  'Content-Type': 'application/json',
};

const TARGET_EMAILS = ['wanglingcheng23@gmail.com', 'daimenglong@gmail.com'];

// ── 1. 拿 user_id ──────────────────────────────────────────
async function resolveUsers() {
  const byEmail = {};
  let page = 1;
  while (true) {
    const url = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`admin users failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const users = data.users ?? data;
    for (const u of users) {
      if (u.email) byEmail[u.email.toLowerCase()] = u.id;
    }
    if (!users.length || users.length < 1000) break;
    page++;
  }
  return byEmail;
}

// ── 2. 拉全部 vehicles ─────────────────────────────────────
async function fetchAllVehicles() {
  const PAGE = 1000;
  let from = 0;
  const out = [];
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/vehicles?select=id,org_id,brand,model,created_by&order=created_at.asc`;
    const res = await fetch(url, {
      headers: { ...HEADERS, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`fetch vehicles failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const startsWithGrant = (s) => (s ?? '').trim().toLowerCase().startsWith('grant');

const usersByEmail = await resolveUsers();
console.log('=== user_id 解析 ===');
for (const e of TARGET_EMAILS) {
  console.log(`  ${e.padEnd(30)} → ${usersByEmail[e] ?? '❌ 未找到'}`);
}

const vehicles = await fetchAllVehicles();
console.log(`\n=== vehicles 总览 ===`);
console.log(`  总数: ${vehicles.length}`);

// 按 org 分组
const byOrg = {};
for (const v of vehicles) byOrg[v.org_id] = (byOrg[v.org_id] || 0) + 1;
console.log(`  org 分布:`);
for (const [org, n] of Object.entries(byOrg)) console.log(`    ${org}: ${n}`);

const withCreator = vehicles.filter((v) => v.created_by).length;
console.log(`\n  created_by 已填: ${withCreator}`);
console.log(`  created_by 为空: ${vehicles.length - withCreator}`);

// "Grant" 前缀落在哪个字段
const grantBrand = vehicles.filter((v) => startsWithGrant(v.brand));
const grantModel = vehicles.filter((v) => startsWithGrant(v.model));
const grantEither = vehicles.filter((v) => startsWithGrant(v.brand) || startsWithGrant(v.model));
console.log(`\n=== "Grant" 前缀分布 ===`);
console.log(`  brand 以 Grant 开头: ${grantBrand.length}`);
console.log(`  model 以 Grant 开头: ${grantModel.length}`);
console.log(`  brand 或 model 命中: ${grantEither.length}`);
console.log(`  其余（归 daimenglong）: ${vehicles.length - grantEither.length}`);

console.log(`\n=== 样本：命中 Grant 的前 15 条 (brand | model) ===`);
for (const v of grantEither.slice(0, 15)) {
  console.log(`  ${JSON.stringify(v.brand)} | ${JSON.stringify(v.model)}  (created_by=${v.created_by ?? 'null'})`);
}

console.log(`\n=== 样本：未命中 Grant 的前 15 条 (brand | model) ===`);
const nonGrant = vehicles.filter((v) => !startsWithGrant(v.brand) && !startsWithGrant(v.model));
for (const v of nonGrant.slice(0, 15)) {
  console.log(`  ${JSON.stringify(v.brand)} | ${JSON.stringify(v.model)}  (created_by=${v.created_by ?? 'null'})`);
}
