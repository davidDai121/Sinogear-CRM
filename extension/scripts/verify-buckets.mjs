#!/usr/bin/env node
/**
 * 用 Supabase 数据验证新分组数字。
 * 注意：这个脚本算不出 needs_reply（依赖 WhatsApp Web 的 unread 状态，不在 Supabase）和 stalled/new
 * （依赖 chat.t 时间戳）。这两个分组要在扩展里实际看。
 *
 * 但能验证：
 *   - 谈判中: stage in (qualifying, negotiating, quoted)
 *   - 重点客户: 有 vehicle_interests / quality=big / budget>0 / contact_tags 含 "大客户/有潜力/VIP/重点"
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const sb = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const ORG_ID = process.env.ORG_ID;

// 读所有 contacts
const { data: contacts } = await sb
  .from('contacts')
  .select('id, phone, name, customer_stage, quality, budget_usd')
  .eq('org_id', ORG_ID);

// 读 vehicle_interests
const { data: vis } = await sb
  .from('vehicle_interests')
  .select('contact_id');
const hasVehicleInterest = new Set(vis.map((v) => v.contact_id));

// 读 contact_tags
const { data: tags } = await sb
  .from('contact_tags')
  .select('contact_id, tag, contacts!inner(org_id)')
  .eq('contacts.org_id', ORG_ID);
const tagsByContact = new Map();
for (const t of tags) {
  const arr = tagsByContact.get(t.contact_id) ?? [];
  arr.push(t.tag);
  tagsByContact.set(t.contact_id, arr);
}

// 算各分组
const NEG_STAGES = new Set(['qualifying', 'negotiating', 'quoted']);
const PRIORITY_TAG_RE = /(大客户|VIP|有潜力|重点|big|priority)/i;

let neg = 0;
let prio = 0;
const prioReasons = {
  '只 quality=big': 0,
  '只 budget>0': 0,
  '只 vehicle_interest': 0,
  '只 tag': 0,
  '多重原因': 0,
};

for (const c of contacts) {
  if (c.quality === 'spam') continue;

  if (NEG_STAGES.has(c.customer_stage)) neg++;

  const reasons = [];
  if (c.quality === 'big') reasons.push('quality=big');
  if (c.budget_usd && Number(c.budget_usd) > 0) reasons.push('budget>0');
  if (hasVehicleInterest.has(c.id)) reasons.push('vehicle_interest');
  const ts = tagsByContact.get(c.id) ?? [];
  if (ts.some((t) => PRIORITY_TAG_RE.test(t))) reasons.push('tag');

  if (reasons.length > 0) {
    prio++;
    if (reasons.length > 1) prioReasons['多重原因']++;
    else if (reasons[0] === 'quality=big') prioReasons['只 quality=big']++;
    else if (reasons[0] === 'budget>0') prioReasons['只 budget>0']++;
    else if (reasons[0] === 'vehicle_interest') prioReasons['只 vehicle_interest']++;
    else if (reasons[0] === 'tag') prioReasons['只 tag']++;
  }
}

console.log(`\n📊 客户总数: ${contacts.length}`);
console.log(`🔥 谈判中 (stage in qualifying/negotiating/quoted): ${neg}`);
console.log(`⭐ 重点客户: ${prio}`);
console.log('   组成:');
console.table(prioReasons);

// stage 分布
const byStage = {};
for (const c of contacts) {
  byStage[c.customer_stage] = (byStage[c.customer_stage] ?? 0) + 1;
}
console.log('\n阶段分布:');
console.table(byStage);
