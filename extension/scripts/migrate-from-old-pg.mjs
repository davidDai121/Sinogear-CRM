#!/usr/bin/env node
/**
 * 旧 PostgreSQL → Supabase 迁移脚本
 *
 * 把旧 NestJS backend (sino_gear_crm DB) 的数据迁到新 Supabase：
 *   - contacts (3000+) → contacts（保留 phone, name, country 等核心字段）
 *   - contact_tags + tags → contact_tags（join 拿 tag name）
 *   - messages (8000+) → messages（用 external_message_id 当 wa_message_id）
 *
 * 跳过：
 *   - conversations 表（新架构没有，直接关联 contact）
 *   - timeline_events（新事件类型不一样）
 *   - ai_*_suggestions（已废弃）
 *   - attachments / reactions（暂时不迁）
 *   - vehicles / quotes / tasks（旧 DB 全是 0 行）
 *
 * 用法：
 *   1. 在 extension/.env 加：
 *        SUPABASE_SERVICE_ROLE_KEY=eyJ...   （Supabase Dashboard → Settings → API → service_role secret）
 *        ORG_ID=xxx-xxx-xxx                  （在 Supabase organizations 表查你的 id）
 *        OLD_DATABASE_URL=postgresql://...   （可选，默认 localhost:5432/sino_gear_crm）
 *
 *   2. cd extension && npm run migrate-old-pg -- --dry-run    # 预览
 *      cd extension && npm run migrate-old-pg                  # 实际跑
 *
 *   选项：
 *     --dry-run               预览，不写入
 *     --limit=100             每张表最多迁 N 行（测试用）
 *     --skip-messages         不迁消息
 *     --skip-tags             不迁标签
 *     --skip-contacts         不迁客户（已迁过，只迁标签/消息时用）
 */

import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const {
  OLD_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/sino_gear_crm',
  VITE_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ORG_ID,
} = process.env;

// ── CLI flags ──
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipContacts = argv.includes('--skip-contacts');
const skipTags = argv.includes('--skip-tags');
const skipMessages = argv.includes('--skip-messages');
const limitArg = argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// ── 验证 env ──
if (!VITE_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '❌ 缺少 VITE_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY\n' +
      '   去 Supabase Dashboard → Settings → API → 复制 service_role 密钥\n' +
      '   加到 extension/.env：SUPABASE_SERVICE_ROLE_KEY=eyJ...',
  );
  process.exit(1);
}
if (!ORG_ID) {
  console.error(
    '❌ 缺少 ORG_ID\n' +
      '   去 Supabase Dashboard → SQL Editor 跑：\n' +
      '       select id, name from organizations;\n' +
      '   把你的 org id 加到 extension/.env：ORG_ID=xxx-xxx-xxx',
  );
  process.exit(1);
}

const STAGE_MAP = {
  new_lead: 'new',
  new: 'new',
  inquiring: 'qualifying',
  qualifying: 'qualifying',
  negotiating: 'negotiating',
  quoted: 'quoted',
  won: 'won',
  closed: 'won',
  closed_won: 'won',
  lost: 'lost',
  closed_lost: 'lost',
};

console.log('━'.repeat(60));
console.log(dryRun ? '🟡 DRY RUN — 不会写入新 DB' : '🟢 LIVE — 数据会写入 Supabase');
console.log(`旧 DB: ${OLD_DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
console.log(`新 Supabase: ${VITE_SUPABASE_URL}`);
console.log(`ORG_ID: ${ORG_ID}`);
if (limit) console.log(`LIMIT: ${limit}/表`);
console.log('━'.repeat(60));

const oldDb = new pg.Client({ connectionString: OLD_DATABASE_URL });
await oldDb.connect();

const supabase = createClient(VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ────────────────────────────────────────────────────────────
// Step 1: contacts
// ────────────────────────────────────────────────────────────
let oldContacts = [];
if (!skipContacts) {
  console.log('\n📇 [1/3] contacts');
  const result = await oldDb.query(`
    select id, name, phone, country, language, budget, wa_name, status,
           notes_summary, created_at, updated_at
    from contacts
    where deleted_at is null and phone is not null and phone != ''
    order by created_at
    ${limit ? `limit ${limit}` : ''}
  `);
  oldContacts = result.rows;
  console.log(`   旧 DB 读出 ${oldContacts.length} 行`);

  // 旧系统经常把手机号填进 name 字段（"+216 55 579 100" 这种），
  // 迁到新 DB 时把这种 phone-like 的 name 设为 null，让 wa_name 接管显示
  const looksLikePhone = (s) => /^[+\d\s\-().._]+$/.test(s);

  const rawRows = oldContacts.map((r) => {
    // 旧 phone 可能含空格/括号/各种格式，归一化成 "+digits"
    const digits = String(r.phone).replace(/[^\d]/g, '');
    const phone = digits ? `+${digits}` : null;
    const rawName = r.name?.trim();
    const cleanName = rawName && !looksLikePhone(rawName) ? rawName : null;
    // budget=0 视为未知（旧系统默认 0）
    const budget =
      r.budget != null && Number(r.budget) > 0 ? Number(r.budget) : null;
    return {
      org_id: ORG_ID,
      phone,
      name: cleanName,
      wa_name: r.wa_name?.trim() || null,
      country: r.country?.trim() || null,
      language: r.language?.trim() || null,
      budget_usd: budget,
      customer_stage: STAGE_MAP[r.status] ?? 'new',
      quality: 'potential',
      notes: r.notes_summary?.trim() || null,
      created_at: r.created_at?.toISOString?.() ?? null,
      updated_at: r.updated_at?.toISOString?.() ?? null,
      _oldId: r.id, // 临时保留，去重后丢弃
    };
  });

  // 批内去重：同 phone 多行 → 保留 updated_at 最新的一条
  const phoneMap = new Map();
  for (const row of rawRows) {
    if (!row.phone) continue;
    const existing = phoneMap.get(row.phone);
    if (!existing) {
      phoneMap.set(row.phone, row);
    } else {
      const a = row.updated_at ?? row.created_at ?? '';
      const b = existing.updated_at ?? existing.created_at ?? '';
      if (a > b) phoneMap.set(row.phone, row);
    }
  }
  const dropped = rawRows.length - phoneMap.size;
  if (dropped > 0) {
    console.log(
      `   去重 ${dropped} 个重复 phone（旧 DB 同号多行，保留 updated_at 最新）`,
    );
  }
  const rows = Array.from(phoneMap.values()).map(({ _oldId, ...rest }) => rest);

  if (dryRun) {
    console.log(`   [DRY] 将 upsert ${rows.length} 行`);
    console.log('   示例:', JSON.stringify(rows[0], null, 2));
  } else {
    await batchUpsert('contacts', rows, 'org_id,phone', false);
  }
} else {
  console.log('\n📇 [1/3] contacts — SKIPPED');
  // 还是要读旧 contacts 拿 id↔phone 映射
  const result = await oldDb.query(
    `select id, phone from contacts where deleted_at is null and phone is not null`,
  );
  oldContacts = result.rows;
}

// ── 建立 phone → new_id 映射（必需，因为新 DB 的 contact id 跟旧不一样）──
console.log('\n🔗 建立旧 contact_id → 新 contact_id 映射…');

const oldIdToPhone = new Map();
for (const r of oldContacts) {
  // 跟 contacts 阶段同样的归一化：digits-only，"+" 前缀
  const digits = String(r.phone).replace(/[^\d]/g, '');
  if (!digits) continue;
  oldIdToPhone.set(r.id, `+${digits}`);
}

const phoneToNewId = new Map();
{
  let cursor = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', ORG_ID)
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const c of data) phoneToNewId.set(c.phone, c.id);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
}
console.log(`   新 DB 现有 ${phoneToNewId.size} 个客户`);

const matched = [...oldIdToPhone.values()].filter((p) => phoneToNewId.has(p))
  .length;
console.log(`   旧/新匹配上的: ${matched}/${oldIdToPhone.size}`);

// ────────────────────────────────────────────────────────────
// Step 2: contact_tags
// ────────────────────────────────────────────────────────────
if (!skipTags) {
  console.log('\n🏷️  [2/3] contact_tags');
  const result = await oldDb.query(`
    select ct.contact_id, t.name as tag_name
    from contact_tags ct
    join tags t on t.id = ct.tag_id
    where t.is_active = true
  `);
  console.log(`   旧 DB 读出 ${result.rows.length} 个关联`);

  const seen = new Set();
  const rows = [];
  for (const r of result.rows) {
    const phone = oldIdToPhone.get(r.contact_id);
    if (!phone) continue;
    const newId = phoneToNewId.get(phone);
    if (!newId) continue;
    const tag = (r.tag_name || '').trim();
    if (!tag) continue;
    const key = `${newId}:${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ contact_id: newId, tag });
  }
  console.log(`   可迁 ${rows.length} 行（去重后）`);

  if (dryRun) {
    console.log(`   [DRY] 将 upsert ${rows.length} 行`);
    if (rows.length) console.log('   示例:', rows[0]);
  } else {
    await batchUpsert('contact_tags', rows, 'contact_id,tag', true);
  }
} else {
  console.log('\n🏷️  [2/3] contact_tags — SKIPPED');
}

// ────────────────────────────────────────────────────────────
// Step 3: messages
// ────────────────────────────────────────────────────────────
if (!skipMessages) {
  console.log('\n💬 [3/3] messages');
  const result = await oldDb.query(`
    select id, contact_id, direction, content, external_message_id,
           sent_at, created_at
    from messages
    where contact_id is not null and content is not null and content != ''
    order by created_at
    ${limit ? `limit ${limit}` : ''}
  `);
  console.log(`   旧 DB 读出 ${result.rows.length} 行`);

  const seen = new Set();
  const rows = [];
  for (const r of result.rows) {
    const phone = oldIdToPhone.get(r.contact_id);
    if (!phone) continue;
    const newId = phoneToNewId.get(phone);
    if (!newId) continue;
    const wa_message_id = r.external_message_id || `legacy:${r.id}`;
    const key = `${newId}:${wa_message_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      contact_id: newId,
      wa_message_id,
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
      text: r.content,
      sent_at:
        r.sent_at?.toISOString?.() ?? r.created_at?.toISOString?.() ?? null,
    });
  }
  console.log(`   可迁 ${rows.length} 行（去重后）`);

  if (dryRun) {
    console.log(`   [DRY] 将 upsert ${rows.length} 行`);
    if (rows.length) console.log('   示例:', rows[0]);
  } else {
    await batchUpsert('messages', rows, 'contact_id,wa_message_id', true);
  }
} else {
  console.log('\n💬 [3/3] messages — SKIPPED');
}

await oldDb.end();
console.log('\n━'.repeat(60));
console.log(dryRun ? '✅ DRY RUN 完成' : '✅ 迁移完成');
console.log('━'.repeat(60));

// ── helper ──
async function batchUpsert(table, rows, onConflict, ignoreDuplicates) {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates });
    if (error) {
      console.error(`   ❌ 批次 ${i}-${i + batch.length} 失败:`, error.message);
      throw error;
    }
    const done = Math.min(i + BATCH, rows.length);
    process.stdout.write(`\r   ✓ 已 upsert ${done}/${rows.length}`);
  }
  process.stdout.write('\n');
}
