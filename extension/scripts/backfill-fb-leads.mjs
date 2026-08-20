#!/usr/bin/env node
/**
 * 一次性回填：把 Meta 线索表单里的历史线索补进 CRM 并接上归因。
 *
 * 为什么需要（2026-08-20 实测）：fb-lead-webhook 今天才配通，它只处理**新**推送。
 * 表单里已经躺着 505 条线索（全部产生在 8/4–8/20，约 31 条/天），而 CRM 里
 * fb_lead_id 是 0 —— 归因链对这批人永远接不上。dry-run 显示 481 个唯一手机号里
 * 有 274 个（57%）从来没进过 CRM。
 *
 * 只做三件事，绝不越界：
 *   1. 匹配上的现有客户：只补 fb_lead_id / fb_ad_id，**不动**姓名/国家/阶段/备注
 *   2. 匹配不上的：新建 contact，stage='new'
 *   3. 每条写一个 fb_lead_received 事件
 * 不发 CAPI（历史线索回传没意义且污染时间序列）、不发任何消息、不改 customer_stage。
 *
 * 手机号匹配规则（故意收紧）：
 *   - 优先完全相同
 *   - 否则「后 9 位相同 + 长度差 ≤ 4（区号）」，且**全库只有一个候选**才算匹配
 *     多于一个候选 → 视为不确定，宁可新建也不错配
 *   放宽版本会把不同国家的同尾号错配，把 A 的 lead_id 写到 B 身上，很难事后发现。
 *
 * 用法：node scripts/backfill-fb-leads.mjs           # dry-run
 *       node scripts/backfill-fb-leads.mjs --apply   # 真写
 */
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url).pathname });

const APPLY = process.argv.includes('--apply');
const PAGE_ID = '1241950519005601';
const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ORG = process.env.ORG_ID;
const T = fs.readFileSync(process.env.TOKF, 'utf8').trim();

const CC = { '250':'Rwanda','48':'Poland','994':'Azerbaijan','86':'China','234':'Nigeria','233':'Ghana','237':'Cameroon','254':'Kenya','255':'Tanzania','256':'Uganda','260':'Zambia','263':'Zimbabwe','221':'Senegal','225':"Côte d'Ivoire",'226':'Burkina Faso','228':'Togo','229':'Benin','224':'Guinea','223':'Mali','227':'Niger','235':'Chad','243':'DR Congo','244':'Angola','258':'Mozambique','261':'Madagascar','266':'Lesotho','267':'Botswana','268':'Eswatini','20':'Egypt','212':'Morocco','213':'Algeria','216':'Tunisia','218':'Libya','966':'Saudi Arabia','971':'UAE','1':'United States','44':'United Kingdom','33':'France','49':'Germany','39':'Italy','7':'Russia','90':'Turkey','92':'Pakistan','91':'India','62':'Indonesia','60':'Malaysia','63':'Philippines','84':'Vietnam','66':'Thailand','61':'Australia','27':'South Africa','993':'Turkmenistan','998':'Uzbekistan','996':'Kyrgyzstan','992':'Tajikistan','995':'Georgia','374':'Armenia' };
Object.assign(CC, { '231':'Liberia','380':'Ukraine','211':'South Sudan','249':'Sudan','251':'Ethiopia','232':'Sierra Leone','967':'Yemen','55':'Brazil','252':'Somalia','257':'Burundi','265':'Malawi','264':'Namibia','241':'Gabon','242':'Congo','245':'Guinea-Bissau','220':'Gambia','222':'Mauritania','230':'Mauritius','239':'São Tomé','240':'Equatorial Guinea','248':'Seychelles','253':'Djibouti','269':'Comoros','291':'Eritrea' });
const countryOf = (d) => { for (const len of [3,2,1]) { const c = CC[d.slice(0,len)]; if (c) return c; } return null; };

// 表单名前缀 → 国家码。线索里有一批是本地格式（078xxx / 099xxx，没带国家码），
// 直接存成 +078... 是废号，永远匹配不上 WhatsApp 聊天。表单名自带国家，用它补。
const FORM_CC = { RW: '250', PL: '48', AZ: '994' };
function normalizePhone(d, formName) {
  const cc = FORM_CC[(formName || '').slice(0, 2).toUpperCase()];
  if (countryOf(d) && !(d.startsWith('0'))) return d;      // 已带可识别国家码
  if (!cc) return d;                                        // 没线索，原样
  const local = d.replace(/^0+/, '');                       // 去掉本地前导 0
  if (d.startsWith(cc)) return d;                           // 已经带了
  return cc + local;
}
const digits = (s) => String(s || '').replace(/\D/g, '');
const g = async (u, t = T) => (await fetch(u, { headers: { Authorization: 'Bearer ' + t } })).json();

// ── 1. 拉全部线索 ──
const pt = (await g(`https://graph.facebook.com/v25.0/me/accounts?fields=access_token`)).data[0].access_token;
const forms = (await g(`https://graph.facebook.com/v25.0/${PAGE_ID}/leadgen_forms?fields=id,name&limit=50`, pt)).data;
const leads = [];
for (const f of forms) {
  let url = `https://graph.facebook.com/v25.0/${f.id}/leads?fields=id,created_time,ad_id,adset_id,campaign_id,form_id,field_data&limit=100`;
  while (url) { const r = await g(url, pt); (r.data || []).forEach((L) => leads.push({ ...L, form_name: f.name })); url = r.paging?.next || null; }
}
console.log(`拉到线索 ${leads.length} 条 / ${forms.length} 个表单`);

// ── 2. 按手机号去重（保留最新一条）──
const byPhone = new Map(); let noPhone = 0, fixedCC = 0;
for (const L of leads.sort((a, b) => a.created_time < b.created_time ? -1 : 1)) {
  const ph = (L.field_data || []).find((x) => /phone/i.test(x.name))?.values?.[0];
  let d = digits(ph);
  if (!d || d.length < 8) { noPhone++; continue; }
  const raw = d;
  d = normalizePhone(d, L.form_name);
  if (d !== raw) fixedCC++;
  const prev = byPhone.get(d);
  byPhone.set(d, prev ? { ...L, also: [...(prev.also || []), prev.id] } : L);
}
console.log(`唯一手机号 ${byPhone.size} 个（无手机号/太短 ${noPhone} 条，按表单国家补了区号 ${fixedCC} 条）`);

// ── 3. CRM 全量索引（分页，避开 1000 行陷阱）──
const exact = new Map(); const bySuffix = new Map();
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from('contacts').select('id, phone, fb_lead_id').eq('org_id', ORG).order('id').range(from, from + 999);
  if (!data?.length) break;
  for (const c of data) { const d = digits(c.phone); if (!d) continue;
    exact.set(d, c);
    if (d.length >= 9) { const s = d.slice(-9); if (!bySuffix.has(s)) bySuffix.set(s, []); bySuffix.get(s).push({ ...c, d }); } }
  if (data.length < 1000) break;
}
console.log(`CRM 有手机号客户 ${exact.size} 个\n`);

// ── 4. 分类 ──
const toUpdate = [], toCreate = []; let ambiguous = 0, alreadyHas = 0;
for (const [d, L] of byPhone) {
  let hit = exact.get(d) || null;
  if (!hit && d.length >= 9) {
    const cands = (bySuffix.get(d.slice(-9)) || []).filter((c) => Math.abs(c.d.length - d.length) <= 4);
    if (cands.length === 1) hit = cands[0];
    else if (cands.length > 1) { ambiguous++; }
  }
  if (hit) { if (hit.fb_lead_id) { alreadyHas++; continue; } toUpdate.push({ c: hit, L, d }); }
  else toCreate.push({ L, d });
}
console.log('=== 计划 ===');
console.log('  补 fb_lead_id 到现有客户 :', toUpdate.length);
console.log('  新建客户                 :', toCreate.length);
console.log('  多候选→保守新建（含在上行）:', ambiguous);
console.log('  已有 fb_lead_id 跳过     :', alreadyHas);
const unmapped = new Set(); toCreate.forEach(({ d }) => { if (!countryOf(d)) unmapped.add(d.slice(0, 3)); });
if (unmapped.size) console.log('  ⚠️ 认不出国家的区号     :', [...unmapped].join(', '));

if (!APPLY) { console.log('\n（dry-run，没有写任何东西。加 --apply 真跑）'); process.exit(0); }

// ── 5. 执行 ──
console.log('\n=== 执行中 ===');
const evRows = [];
let updated = 0;
for (const { c, L } of toUpdate) {
  const { error } = await sb.from('contacts').update({ fb_lead_id: L.id, fb_ad_id: L.ad_id ?? null }).eq('id', c.id);
  if (error) { console.log('  更新失败', c.id, error.message.slice(0, 60)); continue; }
  updated++;
  evRows.push({ contact_id: c.id, event_type: 'fb_lead_received', payload: { fb_lead_id: L.id, form_id: L.form_id, form_name: L.form_name, ad_id: L.ad_id ?? null, created_time: L.created_time, backfilled: true, matched_existing: true, field_data: L.field_data } });
}
console.log('  已补 fb_lead_id:', updated);

let created = 0;
for (const { L, d } of toCreate) {
  const name = (L.field_data || []).find((x) => /full_name|^name$/i.test(x.name))?.values?.[0] ?? null;
  const { data, error } = await sb.from('contacts').insert({
    org_id: ORG, phone: '+' + d, name: name || null, country: countryOf(d),
    customer_stage: 'new', quality: 'potential', fb_lead_id: L.id, fb_ad_id: L.ad_id ?? null,
  }).select('id').single();
  if (error) { console.log('  新建失败', d, error.message.slice(0, 70)); continue; }
  created++;
  evRows.push({ contact_id: data.id, event_type: 'fb_lead_received', payload: { fb_lead_id: L.id, form_id: L.form_id, form_name: L.form_name, ad_id: L.ad_id ?? null, created_time: L.created_time, backfilled: true, matched_existing: false, field_data: L.field_data } });
}
console.log('  已新建客户:', created);

for (let i = 0; i < evRows.length; i += 200) {
  const { error } = await sb.from('contact_events').insert(evRows.slice(i, i + 200));
  if (error) console.log('  事件写入失败', error.message.slice(0, 80));
}
console.log('  已写时间轴事件:', evRows.length);
