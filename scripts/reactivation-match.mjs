#!/usr/bin/env node
// 再激活匹配（只读）：拉全量 contacts + vehicle_interests + tags + quotes + messages(含正文)
// → 对每个有聊天的客户检测车型意向（结构化兴趣 + 聊天正文双重）→ 对号库存 → 打分分层
// 产出：分析导出/激活清单_全部.csv + 激活话术目标.json + 车型库存_规范化.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { INVENTORY, INV_BY_KEY, INTEREST_RULES, SEGMENT_RULES, freightFor } from './inventory.mjs'

const ENV = readFileSync(new URL('../extension/.env', import.meta.url), 'utf8')
const env = Object.fromEntries(ENV.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const URL_ = env.VITE_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY, ORG = env.ORG_ID
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const OUT = new URL('../分析导出/', import.meta.url); mkdirSync(OUT, { recursive: true })

async function fetchAll(table, { select = '*', filter = '', order = 'id' } = {}) {
  const PAGE = 1000; let from = 0; const out = []
  for (;;) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter}&order=${order}`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`)
    const rows = await res.json(); out.push(...rows)
    if (rows.length < PAGE) break; from += PAGE
  }
  return out
}
const now = Date.now(), DAY = 86400000
const daysAgo = (ts) => (ts ? Math.floor((now - new Date(ts).getTime()) / DAY) : null)

console.error('拉取 contacts...')
const contacts = await fetchAll('contacts', { select: 'id,phone,group_jid,wa_name,name,country,language,budget_usd,customer_stage,quality,destination_port,notes,created_at', filter: `&org_id=eq.${ORG}` })
const cid = new Set(contacts.map((c) => c.id))
const byId = new Map(contacts.map((c) => [c.id, c]))
console.error(`  ${contacts.length} contacts`)

console.error('拉取 vehicle_interests...')
const vi = (await fetchAll('vehicle_interests', { select: 'contact_id,model,year,condition,target_price_usd' })).filter((r) => cid.has(r.contact_id))
const viByC = new Map(); for (const r of vi) { if (!viByC.has(r.contact_id)) viByC.set(r.contact_id, []); viByC.get(r.contact_id).push(r) }

console.error('拉取 contact_tags...')
const tags = (await fetchAll('contact_tags', { select: 'contact_id,tag', order: 'contact_id' })).filter((r) => cid.has(r.contact_id))
const tagsByC = new Map(); for (const r of tags) { if (!tagsByC.has(r.contact_id)) tagsByC.set(r.contact_id, []); tagsByC.get(r.contact_id).push(r.tag) }

console.error('拉取 messages（含正文）...')
const msgByC = new Map() // contact_id -> {n,in,out,last,lastIn,lastDir, allText, recent:[{d,t,when}]}
{
  const PAGE = 1000; let from = 0
  for (;;) {
    const res = await fetch(`${URL_}/rest/v1/messages?select=contact_id,direction,text,sent_at,synced_at&order=contact_id,sent_at`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!res.ok) throw new Error(`messages ${res.status}`)
    const rows = await res.json()
    for (const m of rows) {
      if (!cid.has(m.contact_id)) continue
      let a = msgByC.get(m.contact_id); if (!a) { a = { n: 0, in: 0, out: 0, last: null, lastIn: null, lastDir: null, allText: [], recent: [] }; msgByC.set(m.contact_id, a) }
      a.n++
      const t = m.sent_at ? new Date(m.sent_at).getTime() : (m.synced_at ? new Date(m.synced_at).getTime() : null)
      if (m.direction === 'inbound') { a.in++; if (t && (!a.lastIn || t > a.lastIn)) a.lastIn = t } else a.out++
      if (t && (!a.last || t > a.last)) { a.last = t; a.lastDir = m.direction }
      const txt = (m.text || '').trim()
      if (txt && txt !== '[媒体]' && txt !== '[已删除]') {
        if (m.direction === 'inbound') a.allText.push(txt) // 只扫客户说的话找意向
        a.recent.push({ dir: m.direction, t: txt.slice(0, 280), when: t })
      }
    }
    if (rows.length < PAGE) break; from += PAGE
  }
}
console.error(`  ${[...msgByC.values()].reduce((s, a) => s + a.n, 0)} messages，${msgByC.size} 个客户有消息`)

// ---------- 意向检测 ----------
function detectInterests(c) {
  const found = new Map() // label -> {label, rec, kind, source, hits, fromText}
  const add = (rule, fromText) => {
    const ex = found.get(rule.label)
    if (ex) { ex.hits++; ex.fromText = ex.fromText || fromText; return }
    found.set(rule.label, { label: rule.label, rec: rule.rec, kind: rule.kind, source: rule.source || null, hits: 1, fromText })
  }
  // 1) 结构化 vehicle_interests（权重高）
  const viStr = (viByC.get(c.id) || []).map((r) => r.model || '').join(' || ')
  for (const rule of INTEREST_RULES) if (rule.re.test(viStr)) add(rule, false)
  // 2) 客户聊天正文里提到的车型
  const blob = (msgByC.get(c.id)?.allText || []).join(' \n ')
  if (blob) {
    for (const rule of INTEREST_RULES) if (rule.re.test(blob)) add(rule, true)
  }
  // 3) 标签里的车型（如 "Changan UNI-K"）
  const tagStr = (tagsByC.get(c.id) || []).join(' || ')
  if (tagStr) for (const rule of INTEREST_RULES) if (rule.re.test(tagStr)) add(rule, false)
  // 4) 都没具体车型 → 段位泛化兜底（只用聊天正文，避免噪音）
  if (found.size === 0 && blob) {
    for (const rule of SEGMENT_RULES) if (rule.re.test(blob)) { add(rule, true); break }
  }
  return [...found.values()]
}

const fmtUsd = (n) => '$' + Math.round(n).toLocaleString()
function priceLine(invKey) {
  const v = INV_BY_KEY[invKey]; if (!v) return ''
  return v.fobLow === v.fobHigh ? fmtUsd(v.fobLow) : `${fmtUsd(v.fobLow)}–${fmtUsd(v.fobHigh)}`
}
function cifBallpark(invKey, country) {
  const v = INV_BY_KEY[invKey]; if (!v) return ''
  const [, fr] = freightFor(country)
  const lo = Math.round((v.fobLow + fr + v.fobLow * 0.011) / 100) * 100
  return fmtUsd(lo)
}

// ---------- 对每个有聊天/有兴趣的客户算推荐 ----------
const stageScore = { quoted: 60, negotiating: 50, qualifying: 35, stalled: 20, new: 12, lost: 6, won: 0 }
const recencyDays = (a) => (a ? daysAgo(a.last) : null)

const rows = []
for (const c of contacts) {
  const a = msgByC.get(c.id)
  const hasChat = !!a && a.n > 0
  const hasInbound = !!a && a.in > 0
  const interests = detectInterests(c)
  // 只处理：有真实互动（客户回过）OR 有结构化车型兴趣。纯空壳/纯外发不进表。
  if (!hasInbound && interests.length === 0) continue
  if (c.quality === 'spam') continue

  // 主推：优先 exact 现车 > exact 报价 > substitute > source；同类里 hits 多的优先
  const kindRank = { exact: 0, substitute: 1, segment: 2, source: 3 }
  interests.sort((x, y) => (kindRank[x.kind] - kindRank[y.kind]) || (y.hits - x.hits))
  const primary = interests[0] || null
  let recKey = primary?.rec?.[0] || null
  // exact 类里若主推车型恰好是"现车(in)"则更优；否则在 rec 候选里挑一个 in-stock 的提上来
  if (primary) {
    const inStockCand = primary.rec.find((k) => INV_BY_KEY[k]?.stock === 'in')
    if (inStockCand && primary.kind !== 'exact') recKey = inStockCand
    else recKey = primary.rec[0]
  }
  const recV = recKey ? INV_BY_KEY[recKey] : null
  const altKeys = (primary?.rec || []).slice(1, 3)

  // ---------- 打分 ----------
  let score = 0
  if (c.quality === 'big') score += 120
  else if (c.quality === 'potential') score += 10
  else if (c.quality === 'normal') score -= 15
  score += stageScore[c.customer_stage] ?? 0
  if (a?.lastDir === 'inbound') score += 45 // 球在我方，客户在等
  // 意向质量
  if (primary?.kind === 'exact' && recV?.stock === 'in') score += 35 // 想要的我直接有现车
  else if (primary?.kind === 'exact') score += 22
  else if (primary?.kind === 'substitute') score += 18
  else if (primary?.kind === 'source') score += 12
  if (interests.some((i) => i.fromText)) score += 8 // 聊天里亲口提过车型
  // 预算
  const bud = Number(c.budget_usd) || 0
  if (bud > 1000 && bud < 200000) score += 12
  // 活跃度：太久没动衰减，但不至于归零（再激活就是要唤醒沉睡的）
  const d = recencyDays(a)
  if (d != null) { if (d <= 7) score += 18; else if (d <= 30) score += 12; else if (d <= 90) score += 4; else if (d <= 180) score -= 2; else score -= 10 }
  // 互动深度
  if (a) { if (a.in >= 8) score += 12; else if (a.in >= 3) score += 6 }

  rows.push({
    c, a, interests, primary, recKey, recV, altKeys,
    score, days: d, inbound: a?.in || 0, outbound: a?.out || 0,
    ball: a?.lastDir === 'inbound' ? 'me' : 'cust',
  })
}

rows.sort((x, y) => y.score - x.score)
console.error(`  纳入 ${rows.length} 个客户（有真实互动或有车型兴趣，非垃圾）`)

// ---------- 分层 ----------
const stageLabel = { new: '新客户', qualifying: '资格确认', negotiating: '谈判中', stalled: '停滞', quoted: '已报价', won: '成交', lost: '流失' }
const qLabel = { big: '⭐⭐⭐大客户', potential: '⭐⭐有潜力', normal: '⭐普通', spam: '🗑垃圾' }
const nameOf = (c) => c.name || c.wa_name || (c.group_jid ? '(群聊)' : c.phone) || '?'
const waLink = (c) => (c.phone ? `https://wa.me/${String(c.phone).replace(/[^0-9]/g, '')}` : '')

function tierOf(r) {
  const big = r.c.quality === 'big'
  const hotStage = ['negotiating', 'quoted', 'qualifying'].includes(r.c.customer_stage)
  const waiting = r.ball === 'me'
  const inStockWant = r.primary?.kind === 'exact' && r.recV?.stock === 'in'
  if (big || (hotStage && (waiting || r.days <= 30))) return 'S' // 必做：大客户 / 热阶段且新鲜或在等
  if (waiting && r.days != null && r.days <= 120 && r.primary) return 'A' // 客户在等 + 有意向
  if (r.primary && (inStockWant || hotStage) && r.days != null && r.days <= 180) return 'B' // 有意向且可激活
  return 'C'
}
for (const r of rows) r.tier = tierOf(r)
const tierCount = rows.reduce((o, r) => ((o[r.tier] = (o[r.tier] || 0) + 1), o), {})
console.error('  分层:', tierCount)

// ---------- CSV：全部 ----------
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const recName = (r) => r.recV ? r.recV.name : ''
const recPrice = (r) => r.recKey ? `${priceLine(r.recKey)} FOB / ~${cifBallpark(r.recKey, r.c.country)} CIF` : ''
const matchKindCn = { exact: '现成可报', substitute: '转推现车', segment: '按需求', source: '可订货' }
const recReason = (r) => {
  if (!r.primary) return ''
  if (r.primary.kind === 'source') return `客户原想 ${r.primary.label}（${r.primary.source}）→ 转推现车 ${r.recV?.name || ''}`
  if (r.recV?.stock === 'in') return `客户要 ${r.primary.label} → 我有现车`
  return `客户要 ${r.primary.label} → 现成报价`
}
const header = ['优先级', '分数', '客户', '手机号', '国家', '语言', '阶段', '质量', '球在谁', '客户等待天数', '最后互动天数', '收/发', '客户原意向', '推荐车型', 'FOB/CIF', '匹配类型', '理由', '预算USD', 'WhatsApp']
const body = rows.map((r) => [
  r.tier, r.score, nameOf(r.c), r.c.phone || '', r.c.country || '', r.c.language || '',
  stageLabel[r.c.customer_stage] || r.c.customer_stage, qLabel[r.c.quality] || r.c.quality,
  r.ball === 'me' ? '我方(客户在等)' : '客户', r.ball === 'me' && r.a?.lastIn ? daysAgo(r.a.lastIn) : '',
  r.days ?? '', `${r.inbound}/${r.outbound}`,
  r.interests.map((i) => i.label).slice(0, 3).join(' / '),
  recName(r), recPrice(r), matchKindCn[r.primary?.kind] || '', recReason(r),
  r.c.budget_usd || '', waLink(r.c),
])
writeFileSync(new URL('激活清单_全部.csv', OUT), '﻿' + [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n'))
console.error(`  写出 激活清单_全部.csv（${body.length} 行）`)

// ---------- JSON：高价值话术目标（S + A）含聊天摘录 ----------
const draftTiers = new Set(['S', 'A'])
const targets = rows.filter((r) => draftTiers.has(r.tier)).map((r) => {
  const recent = (r.a?.recent || []).slice(-14).map((m) => ({
    who: m.dir === 'inbound' ? 'customer' : 'me', text: m.t,
    days: m.when ? daysAgo(m.when) : null,
  }))
  return {
    id: r.c.id, tier: r.tier, score: r.score,
    name: nameOf(r.c), phone: r.c.phone || null, country: r.c.country || null, language: r.c.language || null,
    stage: r.c.customer_stage, quality: r.c.quality, budget_usd: r.c.budget_usd || null,
    port: r.c.destination_port || null, notes: r.c.notes || null,
    ball: r.ball, waitingDays: r.ball === 'me' && r.a?.lastIn ? daysAgo(r.a.lastIn) : null,
    lastContactDays: r.days, inbound: r.inbound, outbound: r.outbound,
    interests: r.interests.map((i) => ({ label: i.label, kind: i.kind, source: i.source, fromText: i.fromText })),
    recommend: r.recKey ? {
      key: r.recKey, name: r.recV.name, seg: r.recV.seg, fuel: r.recV.fuel, stock: r.recV.stock,
      fob: priceLine(r.recKey), cif: cifBallpark(r.recKey, r.c.country), note: r.recV.note,
      matchKind: r.primary?.kind, sourceNote: r.primary?.source || null,
    } : null,
    alts: r.altKeys.map((k) => ({ key: k, name: INV_BY_KEY[k]?.name, fob: priceLine(k) })),
    tags: tagsByC.get(r.c.id) || [],
    recentChat: recent,
  }
})
writeFileSync(new URL('激活话术目标.json', OUT), JSON.stringify(targets, null, 1))
console.error(`  写出 激活话术目标.json（${targets.length} 个高价值目标，含聊天摘录）`)

// ---------- 车型库存规范化 MD ----------
const segCn = { sedan: '轿车', 'suv-small': '小型SUV', 'suv-compact': '紧凑SUV', 'suv-mid': '中型SUV', 'suv-large': '大型SUV', offroad: '硬派越野', pickup: '皮卡', mpv: 'MPV', luxury: '豪华' }
const stockCn = { in: '🟢现车', price: '🟡现成报价(可订)', source: '⚪可订货' }
const md = ['# 规范化车型库（基于你 2026-06-23 提供的三个报价表）', '', '> 价格为 FOB China，USD。🟢 现车=比亚迪库存6月21号那批真实在库（最强激活钩子）；🟡 丰田/现代/起亚=按年份现成报价可订。', '',
  '| 车型 | 段位 | 动力 | FOB(USD) | 库存 | 备注 |', '|---|---|---|---|---|---|',
  ...INVENTORY.map((v) => `| ${v.name} | ${segCn[v.seg] || v.seg} | ${v.fuel} | ${v.fobLow === v.fobHigh ? fmtUsd(v.fobLow) : fmtUsd(v.fobLow) + '–' + fmtUsd(v.fobHigh)} | ${stockCn[v.stock]} | ${v.note} |`),
  '', '## 表外热门（客户想要但报价表没列，按"都能卖"可订货 + 转推现车替代）', '',
  '| 客户想要 | 可订货 | 转推现车替代 |', '|---|---|---|',
  '| 长安 UNI-K (432人) | ✅ | 宋L / 唐 / 护卫舰05 |',
  '| 捷途 T2 旅行者 (385人) | ✅ | 豹5 / 护卫舰05 |',
  '| 长安 CS75 Plus (366人) | ✅ | 宋Plus / 宋L |',
  '| 奇瑞 Rely R08 / 瑞虎 (153人) | ✅ | 唐 / 宋L |',
  '| 丰田 Hilux 皮卡 (55人) | ✅ | 豹5 / 豹8 |',
].join('\n')
writeFileSync(new URL('../车型库存_规范化.md', OUT), md)
console.error('  写出 车型库存_规范化.md')

// ---------- 控制台速览 ----------
const inStockDemand = {}
for (const r of rows) if (r.primary?.kind === 'exact' && r.recV?.stock === 'in') inStockDemand[r.recV.name] = (inStockDemand[r.recV.name] || 0) + 1
const sourceDemand = {}
for (const r of rows) if (r.primary?.kind === 'source') sourceDemand[r.primary.label] = (sourceDemand[r.primary.label] || 0) + 1
const top = (o, n = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${v}\t${k}`).join('\n')
console.error('\n===== 速览 =====')
console.error(`分层: S=${tierCount.S || 0}  A=${tierCount.A || 0}  B=${tierCount.B || 0}  C=${tierCount.C || 0}（S+A 出话术）`)
console.error('\n🟢 想要"我有现车"的客户数（直接推现车，最易成）:\n' + top(inStockDemand))
console.error('\n⚪ 想要"表外车(可订货)"的客户数（转推现车 or 订货）:\n' + top(sourceDemand))
console.error('\n✅ 完成')
