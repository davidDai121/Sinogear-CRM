#!/usr/bin/env node
/**
 * 修回填时按「表单填的号码」匹配造成的重复客户。
 *
 * 错在哪（2026-08-21 boss 实测发现）：客户在 Facebook 表单里填的号码，跟他实际
 * 用来发 WhatsApp 的号**经常不是同一个**——填座机、填旧号、手滑打错（实测有一对
 * 是 +250728304062 vs +250788403062，只差两位）。回填时按表单号匹配 CRM，匹配
 * 不到就新建，结果给早就在聊的客户造了个重复记录，而且把 fb_lead_id 挂在了那个
 * 从没说过话的号上——真实对话反而显示「没有广告标识、判定不回传 Meta」。
 *
 * 正确的匹配信号：客户点「Chat on WhatsApp」后发来的那条自动消息，正文里带着
 * 他填的表单内容（含表单号码和邮箱）。**发出这条消息的 contact 才是真人。**
 *
 * 用法：node scripts/fix-fb-lead-duplicates.mjs [--apply]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url).pathname });

const APPLY = process.argv.includes('--apply');
const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const digits = (s) => String(s || '').replace(/\D/g, '');

async function page(table, cols, orderCol, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// Meta 预填文案有 "filled in" / "filled out" 两种变体，实测 out 占 1,174 条、
// in 占 609 条。只认一种会漏掉三分之二。用 "your form" 兜住，再靠下面的
// 号码/邮箱正则筛出真正的表单消息。
const msgs = await page('messages', 'contact_id, text', 'id', (q) => q.ilike('text', '%your form%'));
console.log(`自动消息 ${msgs.length} 条`);

const byFormPhone = new Map();
const byEmail = new Map();
for (const m of msgs) {
  const t = m.text || '';
  const ph = /phone\s*number\s*:?\s*\n?\s*(\+?[\d][\d\s\-()]{6,})/i.exec(t);
  const em = /e-?mail\s*:?\s*\n?\s*([\w.+-]+@[\w-]+\.[\w.]+)/i.exec(t);
  if (ph) {
    const d = digits(ph[1]);
    if (d.length >= 8 && !byFormPhone.has(d)) byFormPhone.set(d, m.contact_id);
  }
  if (em) {
    const e = em[1].toLowerCase();
    if (!byEmail.has(e)) byEmail.set(e, m.contact_id);
  }
}
console.log(`抠出表单号码 ${byFormPhone.size} 个 · 邮箱 ${byEmail.size} 个`);

const evs = await page('contact_events', 'id, contact_id, payload', 'id', (q) => q.eq('event_type', 'fb_lead_received'));
const createdEv = evs.filter((e) => e.payload?.matched_existing === false);
const ids = createdEv.map((e) => e.contact_id);
const cmap = new Map();
for (let i = 0; i < ids.length; i += 200) {
  const { data } = await sb.from('contacts').select('id, phone, name, fb_lead_id, fb_ad_id').in('id', ids.slice(i, i + 200));
  (data || []).forEach((c) => cmap.set(c.id, c));
}

const fixes = [];
for (const ev of createdEv) {
  const dup = cmap.get(ev.contact_id);
  if (!dup) continue;
  const fields = {};
  for (const f of ev.payload?.field_data ?? []) if (f?.name) fields[f.name] = (f.values ?? []).join(', ');
  const email = (fields.email || '').toLowerCase();
  const real = byFormPhone.get(digits(dup.phone)) ?? (email ? byEmail.get(email) : undefined);
  if (!real || real === dup.id) continue;
  fixes.push({ ev, dup, realId: real });
}
console.log(`\n需要修复: ${fixes.length} / ${createdEv.length}`);

const realIds = [...new Set(fixes.map((f) => f.realId))];
const rmap = new Map();
for (let i = 0; i < realIds.length; i += 200) {
  const { data } = await sb.from('contacts').select('id, phone, name, fb_lead_id').in('id', realIds.slice(i, i + 200));
  (data || []).forEach((c) => rmap.set(c.id, c));
}
for (const f of fixes.slice(0, 12)) {
  const r = rmap.get(f.realId);
  console.log(`  ${(f.dup.name || '?').slice(0, 20).padEnd(22)} ${String(f.dup.phone).padEnd(16)} → ${r?.phone}${r?.fb_lead_id ? '  ⚠️ 真人已有归因' : ''}`);
}
if (fixes.length > 12) console.log(`  …还有 ${fixes.length - 12} 个`);
const conflict = fixes.filter((f) => rmap.get(f.realId)?.fb_lead_id).length;
console.log(`\n真人已有 fb_lead_id（只删重复、不覆盖）: ${conflict}`);

if (!APPLY) { console.log('\n（dry-run，没动任何数据。加 --apply 执行）'); process.exit(0); }

console.log('\n=== 执行 ===');
let moved = 0, deleted = 0;
for (const f of fixes) {
  const real = rmap.get(f.realId);
  if (!real) continue;
  await sb.from('contacts').update({ fb_lead_id: null, fb_ad_id: null }).eq('id', f.dup.id);
  if (!real.fb_lead_id) {
    const { error } = await sb.from('contacts')
      .update({ fb_lead_id: f.dup.fb_lead_id, fb_ad_id: f.dup.fb_ad_id })
      .eq('id', f.realId);
    if (error) { console.log('  搬归因失败', f.dup.phone, error.message.slice(0, 60)); continue; }
    await sb.from('contact_events').insert({
      contact_id: f.realId,
      event_type: 'fb_lead_received',
      payload: { ...f.ev.payload, repaired_from_phone: f.dup.phone, repaired_at: new Date().toISOString() },
    });
    moved++;
  }
  const { error: delErr } = await sb.from('contacts').delete().eq('id', f.dup.id);
  if (delErr) console.log('  删除失败', f.dup.phone, delErr.message.slice(0, 60));
  else deleted++;
}
console.log(`  归因搬到真人: ${moved}`);
console.log(`  重复记录删除: ${deleted}`);
