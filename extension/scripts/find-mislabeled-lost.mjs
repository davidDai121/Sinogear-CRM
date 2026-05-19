#!/usr/bin/env node
/**
 * 找出 customer_stage='lost' 但最近 30 天仍有消息的客户。
 *
 * 推荐 stage 规则（不会自动改，只输出建议）:
 *   - 有 quote 记录 / 销售平均 ≥ 250 字 / customer 平均 ≥ 100 字  → negotiating
 *   - 30 天内最近一次是 inbound（客户主动）+ turn ≥ 10        → stalled（值得再撩）
 *   - 30 天内最近一次是 outbound（我们发的没回）+ turn < 10   → 维持 lost（但提醒可以再 ping 一次）
 *   - 其他                                                    → stalled
 *
 * Usage:
 *   USER_ID=... node scripts/find-mislabeled-lost.mjs              # 列出
 *   USER_ID=... APPLY=1 node scripts/find-mislabeled-lost.mjs      # 真改 DB
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORG_ID } = process.env;
const USER_ID = process.env.USER_ID || null;
const APPLY = process.env.APPLY === '1';

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

// 拉 lost 客户（可选限定 user）
let q = sb
  .from('contacts')
  .select('id, phone, name, wa_name, country, customer_stage, quality, contact_handlers!inner(user_id)')
  .eq('org_id', ORG_ID)
  .eq('customer_stage', 'lost');
if (USER_ID) {
  q = q.eq('contact_handlers.user_id', USER_ID);
  console.log(`🔍 限定 handler = ${USER_ID}`);
}
const losts = await fetchAllPaged(q);
console.log(`lost 客户: ${losts.length}`);

// 拉所有 messages
const lostIds = new Set(losts.map((c) => c.id));
const messages = await fetchAllPaged(sb.from('messages').select('contact_id, direction, text, sent_at'));
const mine = messages.filter((m) => lostIds.has(m.contact_id));

// 拉 quotes — 分批查避免 URL 长度炸弹（574 个 UUID 进 .in() 会超 16KB header）
const lostIdsArr = [...lostIds];
const quotes = [];
const BATCH = 80;
for (let i = 0; i < lostIdsArr.length; i += BATCH) {
  const slice = lostIdsArr.slice(i, i + BATCH);
  const { data, error } = await sb.from('quotes').select('contact_id, status').in('contact_id', slice);
  if (error) throw error;
  if (data) quotes.push(...data);
}
const hasQuoteSet = new Set(quotes.map((q) => q.contact_id));

const NOW = Date.now();
const DAY = 86400000;

function isMediaPlaceholder(t) {
  if (!t) return true;
  const s = t.trim();
  if (!s) return true;
  if (/^(IMG|VID|AUD|DOC|PTT|STK|PHOTO|VIDEO|AUDIO)[-_\d]/i.test(s)) return true;
  if (/^\[(媒体|图片|视频|语音|文档|sticker|image|video|audio|document)\]/i.test(s)) return true;
  if (/\(文件附件\)$/.test(s)) return true;
  if (/^<.+>$/.test(s)) return true;
  return false;
}
function substantiveLen(t) {
  if (!t || isMediaPlaceholder(t)) return 0;
  return t.replace(/\s+/g, '').length;
}

// 按 contact 分组
const byContact = new Map();
for (const m of mine) {
  let s = byContact.get(m.contact_id);
  if (!s) {
    s = [];
    byContact.set(m.contact_id, s);
  }
  s.push(m);
}

const candidates = [];
for (const c of losts) {
  const msgs = byContact.get(c.id);
  if (!msgs || msgs.length === 0) continue;
  msgs.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  const last = msgs[msgs.length - 1];
  const lastTime = new Date(last.sent_at).getTime();
  const daysSinceLast = (NOW - lastTime) / DAY;
  if (daysSinceLast > 30) continue; // 只要 30 天内还在聊的

  let inbound = 0, outbound = 0;
  let inSubLenSum = 0, inSubCount = 0;
  let outSubLenSum = 0, outSubCount = 0;
  let turn = 0;
  let prev = null;
  for (const m of msgs) {
    const len = substantiveLen(m.text);
    if (m.direction === 'inbound') {
      inbound++;
      if (len > 0) { inSubLenSum += len; inSubCount++; }
    } else if (m.direction === 'outbound') {
      outbound++;
      if (len > 0) { outSubLenSum += len; outSubCount++; }
    }
    if (prev && prev !== m.direction) turn++;
    prev = m.direction;
  }

  if (inbound + outbound < 6) continue; // 太少不算

  const inAvg = inSubCount ? inSubLenSum / inSubCount : 0;
  const outAvg = outSubCount ? outSubLenSum / outSubCount : 0;
  const hasQuote = hasQuoteSet.has(c.id);

  // 推荐 stage
  let suggested;
  let reason;
  if (hasQuote) {
    suggested = 'quoted';
    reason = '已报过价';
  } else if (outAvg >= 250 || inAvg >= 100) {
    suggested = 'negotiating';
    reason = `投入大（销售${Math.round(outAvg)}字 / 客户${Math.round(inAvg)}字）`;
  } else if (last.direction === 'inbound' && turn >= 10) {
    suggested = 'stalled';
    reason = `客户最后还发了消息 + turn=${turn}`;
  } else if (last.direction === 'outbound') {
    suggested = 'lost-but-ping';
    reason = `最后是我们发，turn=${turn}（可再 ping 一次）`;
  } else {
    suggested = 'stalled';
    reason = `turn=${turn}，最近活跃`;
  }

  candidates.push({
    contact_id: c.id,
    name: c.name || c.wa_name || '(无名)',
    phone: c.phone,
    country: c.country,
    quality: c.quality,
    inbound, outbound, turn,
    inAvg: Math.round(inAvg),
    outAvg: Math.round(outAvg),
    lastDir: last.direction,
    daysSinceLast: Math.round(daysSinceLast),
    hasQuote,
    suggested,
    reason,
  });
}

candidates.sort((a, b) => {
  // 按 suggested 优先级 + turn 排序
  const order = { quoted: 0, negotiating: 1, stalled: 2, 'lost-but-ping': 3 };
  if (order[a.suggested] !== order[b.suggested]) return order[a.suggested] - order[b.suggested];
  return b.turn - a.turn;
});

console.log(`\n📊 lost 但 30 天内仍活跃的客户: ${candidates.length}\n`);

const byStage = {};
for (const c of candidates) byStage[c.suggested] = (byStage[c.suggested] || 0) + 1;
console.log('推荐新阶段分布:');
console.table(byStage);

console.log('\n═══ 详情 ═══');
console.log('客户名'.padEnd(30) + ' | 国家'.padEnd(20) + ' | turn | in/out  | 最后' + ' | 推荐→ | 理由');
console.log('-'.repeat(140));
for (const c of candidates) {
  console.log(
    `${c.name.slice(0, 28).padEnd(28)}` +
    ` | ${(c.country || '').padEnd(16)}` +
    ` | ${String(c.turn).padStart(4)} | ${(c.inbound + '/' + c.outbound).padEnd(7)}` +
    ` | ${String(c.daysSinceLast).padStart(2)}天前(${c.lastDir === 'inbound' ? '客' : '销'})` +
    ` | ${c.suggested.padEnd(15)} | ${c.reason}`,
  );
}

// 落盘
const outDir = resolve(__dirname, '..', 'analysis-output');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'mislabeled-lost.json');
writeFileSync(outPath, JSON.stringify(candidates, null, 2), 'utf8');
console.log(`\n📝 写入 ${outPath}`);

// APPLY: 真改 DB
if (APPLY) {
  console.log('\n⚠️ APPLY=1 → 真改 DB');
  const updates = {
    quoted: [], negotiating: [], stalled: [],
  };
  for (const c of candidates) {
    if (c.suggested === 'quoted' || c.suggested === 'negotiating' || c.suggested === 'stalled') {
      updates[c.suggested].push(c.contact_id);
    }
    // lost-but-ping 不动
  }
  for (const [stage, ids] of Object.entries(updates)) {
    if (ids.length === 0) continue;
    // 分批 50 个 update，避免 URL 长度问题
    const BATCH = 50;
    let okCount = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const { data, error } = await sb
        .from('contacts')
        .update({ customer_stage: stage })
        .in('id', slice)
        .select('id');
      if (error) {
        console.error(`改 ${stage} 失败 (batch ${i}):`, error.message);
      } else {
        okCount += (data || []).length;
      }
    }
    console.log(`  ✅ ${stage}: 改了 ${okCount} / ${ids.length} 个`);
  }
} else {
  console.log('\n💡 这是 dry-run。确认无误后用 APPLY=1 重跑：');
  console.log(`   USER_ID=${USER_ID} APPLY=1 node scripts/find-mislabeled-lost.mjs`);
}
