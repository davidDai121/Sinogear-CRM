#!/usr/bin/env node
/**
 * 找出"回得好 / 聊得来"的客户。
 *
 * 不是单纯比消息条数——重点是：
 *  - 销售的回复有实质内容（不是 OK / Yes / 单 emoji）
 *  - 双向 turn-taking（真的在聊，不是销售单方面群发）
 *  - 时间跨度合理（不是 5 分钟 burst）
 *  - 客户也写有内容的消息（不只是发图）
 *
 * 综合打分：
 *  base       = log10(in + 1) * log10(out + 1) * 10
 *  balance    = (min/max) * 8                       — 平衡度（防止 1:50 这种单方面）
 *  turn       = 方向切换次数 * 0.3                  — 真 turn-taking
 *  长内容奖励  = 销售侧平均长度 ≥ 30 字符 +5 / ≥ 60 字符 +5
 *  客户内容   = 客户侧平均长度 ≥ 15 +3 / ≥ 30 +3
 *  时间跨度   = log10(days+1) * 3                   — 越长越好
 *  阶段奖励   = won/quoted +10, negotiating +6, stalled +1, lost 0, new +2
 *  最近活跃   = 30 天内有 message +5
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORG_ID } = process.env;
if (!VITE_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ORG_ID) {
  console.error('需要 .env: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ORG_ID');
  process.exit(1);
}

const sb = createClient(VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
async function fetchAllPaged(query) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// 可选 USER_ID 过滤：只看这个 user 作为 handler 的 contacts
const FILTER_USER_ID = process.env.USER_ID || null;

console.log('拉取本 org 全部 contacts...');
let contactsQuery = sb
  .from('contacts')
  .select('id, phone, name, wa_name, country, language, budget_usd, customer_stage, quality, group_jid, notes, destination_port, contact_handlers!inner(user_id)')
  .eq('org_id', ORG_ID);
if (FILTER_USER_ID) {
  contactsQuery = contactsQuery.eq('contact_handlers.user_id', FILTER_USER_ID);
  console.log(`  🔍 过滤 handler user_id = ${FILTER_USER_ID}`);
}
const contacts = await fetchAllPaged(contactsQuery);
console.log(`  ${contacts.length} contacts`);
const contactById = new Map(contacts.map((c) => [c.id, c]));
const contactIds = new Set(contactById.keys());

console.log('拉取本 org 全部 messages...');
const messages = await fetchAllPaged(
  sb.from('messages').select('contact_id, direction, text, sent_at'),
);
const ownMsgs = messages.filter((m) => contactIds.has(m.contact_id));
console.log(`  本 org messages: ${ownMsgs.length}`);

// 媒体占位识别（手机端导入的附件行）
function isMediaPlaceholder(t) {
  if (!t) return true;
  const s = t.trim();
  if (!s) return true;
  if (/^(IMG|VID|AUD|DOC|PTT|STK|PHOTO|VIDEO|AUDIO)[-_\d]/i.test(s)) return true;
  if (/^\[(媒体|图片|视频|语音|文档|sticker|image|video|audio|document)\]/i.test(s)) return true;
  if (/\(文件附件\)$/.test(s)) return true;
  if (/^<.+>$/.test(s)) return true; // <省略影音内容>
  return false;
}

// 实质字符长度（去 emoji / 标点后）
function substantiveLen(t) {
  if (!t || isMediaPlaceholder(t)) return 0;
  return t.replace(/\s+/g, '').length;
}

// 按 contact_id 分组
const grouped = new Map();
for (const m of ownMsgs) {
  let s = grouped.get(m.contact_id);
  if (!s) {
    s = { msgs: [] };
    grouped.set(m.contact_id, s);
  }
  s.msgs.push(m);
}

const stats = [];
const NOW = Date.now();
const DAY = 86400000;

for (const [cid, { msgs }] of grouped) {
  msgs.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  let inbound = 0, outbound = 0;
  let inSubLenSum = 0, inSubCount = 0;
  let outSubLenSum = 0, outSubCount = 0;
  let turn = 0;
  let prevDir = null;
  let inboundOnlyMediaCount = 0; // 客户只发图占比
  for (const m of msgs) {
    const len = substantiveLen(m.text);
    if (m.direction === 'inbound') {
      inbound++;
      if (len > 0) {
        inSubLenSum += len;
        inSubCount++;
      } else {
        inboundOnlyMediaCount++;
      }
    } else if (m.direction === 'outbound') {
      outbound++;
      if (len > 0) {
        outSubLenSum += len;
        outSubCount++;
      }
    }
    if (prevDir && prevDir !== m.direction) turn++;
    prevDir = m.direction;
  }
  // 时间跨度
  const first = new Date(msgs[0].sent_at).getTime();
  const last = new Date(msgs[msgs.length - 1].sent_at).getTime();
  const spanDays = (last - first) / DAY;
  const daysSinceLast = (NOW - last) / DAY;

  const inAvg = inSubCount ? inSubLenSum / inSubCount : 0;
  const outAvg = outSubCount ? outSubLenSum / outSubCount : 0;

  stats.push({
    cid, inbound, outbound, turn,
    inAvg, outAvg, inSubCount, outSubCount,
    inboundOnlyMediaCount,
    spanDays, daysSinceLast,
    total: inbound + outbound,
  });
}

// 基础门槛：销售和客户至少各发 4 条 + 至少 4 次 turn + 双方都有"有内容"消息
const passed = stats.filter(
  (s) =>
    s.inbound >= 4 &&
    s.outbound >= 4 &&
    s.turn >= 4 &&
    s.inSubCount >= 2 &&
    s.outSubCount >= 2,
);

// 打分
function scoreOf(s, c) {
  let score = 0;
  score += Math.log10(s.inbound + 1) * Math.log10(s.outbound + 1) * 10;
  const balance = Math.min(s.inbound, s.outbound) / Math.max(s.inbound, s.outbound);
  score += balance * 8;
  score += Math.min(s.turn, 50) * 0.3;
  if (s.outAvg >= 30) score += 5;
  if (s.outAvg >= 60) score += 5;
  if (s.inAvg >= 15) score += 3;
  if (s.inAvg >= 30) score += 3;
  score += Math.log10(Math.max(s.spanDays, 0) + 1) * 3;
  const stage = c?.customer_stage;
  if (stage === 'won') score += 10;
  else if (stage === 'quoted') score += 10;
  else if (stage === 'negotiating') score += 6;
  else if (stage === 'stalled') score += 1;
  else if (stage === 'new') score += 2;
  if (s.daysSinceLast <= 30) score += 5;
  // 客户只发图占比太高扣分
  const mediaRatio = s.inboundOnlyMediaCount / Math.max(s.inbound, 1);
  if (mediaRatio > 0.6) score -= 5;
  // 跳过群聊（不算"聊得来"）
  if (c?.group_jid) score -= 50;
  return score;
}

const scored = passed
  .map((s) => ({ ...s, contact: contactById.get(s.cid), score: scoreOf(s, contactById.get(s.cid)) }))
  .filter((s) => !s.contact?.group_jid)
  .sort((a, b) => b.score - a.score);

console.log(`\n通过门槛的对话: ${scored.length} / 总 ${grouped.size} 个有消息的客户`);

// 阶段分布
const stageDist = {};
for (const s of scored) {
  const k = s.contact?.customer_stage || '(空)';
  stageDist[k] = (stageDist[k] || 0) + 1;
}
console.log('\n阶段分布（通过门槛）:');
console.table(stageDist);

// 输出 top 80
const TOP = 80;
console.log(`\n🏆 综合得分 Top ${TOP}（"回得好 / 聊得来"）:\n`);
console.log(
  '排名 | 客户名'.padEnd(40) +
  ' | 国家'.padEnd(20) +
  ' | 阶段'.padEnd(14) +
  ' | in/out'.padEnd(12) +
  ' | turn'.padEnd(8) +
  ' | 销售平均'.padEnd(10) +
  ' | 客户平均'.padEnd(10) +
  ' | 跨度天'.padEnd(10) +
  ' | 上次'.padEnd(8) +
  ' | 得分',
);
console.log('-'.repeat(180));

const rows = [];
for (let i = 0; i < Math.min(TOP, scored.length); i++) {
  const s = scored[i];
  const c = s.contact;
  const name = (c?.name || c?.wa_name || '(无名)').slice(0, 28);
  const country = (c?.country || '').slice(0, 16);
  const stage = c?.customer_stage || '';
  const line =
    `${String(i + 1).padStart(3)} | ${name.padEnd(28)}` +
    ` | ${country.padEnd(16)}` +
    ` | ${stage.padEnd(12)}` +
    ` | ${(s.inbound + '/' + s.outbound).padEnd(10)}` +
    ` | ${String(s.turn).padEnd(6)}` +
    ` | ${s.outAvg.toFixed(0).padEnd(8)}` +
    ` | ${s.inAvg.toFixed(0).padEnd(8)}` +
    ` | ${s.spanDays.toFixed(0).padEnd(8)}` +
    ` | ${s.daysSinceLast.toFixed(0).padEnd(6)}` +
    ` | ${s.score.toFixed(1)}`;
  console.log(line);
  rows.push({
    rank: i + 1,
    contact_id: s.cid,
    name: c?.name || c?.wa_name || null,
    phone: c?.phone,
    country: c?.country,
    language: c?.language,
    customer_stage: c?.customer_stage,
    quality: c?.quality,
    budget_usd: c?.budget_usd,
    destination_port: c?.destination_port,
    notes: c?.notes,
    inbound: s.inbound,
    outbound: s.outbound,
    turn: s.turn,
    inboundAvgLen: Math.round(s.inAvg),
    outboundAvgLen: Math.round(s.outAvg),
    spanDays: Math.round(s.spanDays),
    daysSinceLast: Math.round(s.daysSinceLast),
    score: Math.round(s.score * 10) / 10,
  });
}

// 全量 JSON 落盘
const outDir = resolve(__dirname, '..', 'analysis-output');
mkdirSync(outDir, { recursive: true });
const suffix = FILTER_USER_ID ? `-user-${FILTER_USER_ID.slice(0, 8)}` : '';
const outPath = resolve(outDir, `good-replies${suffix}.json`);
writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf8');
console.log(`\n📝 Top ${TOP} 已写入 ${outPath}`);

// 同时输出全部 passed 的精简 CSV
const csvPath = resolve(outDir, `good-replies-all${suffix}.csv`);
const header = 'rank,contact_id,name,phone,country,stage,inbound,outbound,turn,out_avg,in_avg,span_days,days_since,score';
const csvLines = [header];
for (let i = 0; i < scored.length; i++) {
  const s = scored[i];
  const c = s.contact;
  const esc = (v) => (v == null ? '' : String(v).replace(/[",\n]/g, ' '));
  csvLines.push(
    [
      i + 1,
      s.cid,
      esc(c?.name || c?.wa_name),
      esc(c?.phone),
      esc(c?.country),
      esc(c?.customer_stage),
      s.inbound,
      s.outbound,
      s.turn,
      Math.round(s.outAvg),
      Math.round(s.inAvg),
      Math.round(s.spanDays),
      Math.round(s.daysSinceLast),
      Math.round(s.score * 10) / 10,
    ].join(','),
  );
}
writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
console.log(`📝 全部 ${scored.length} 条已写入 ${csvPath}`);

console.log('\n✅ 完成');
