#!/usr/bin/env node
// 行动清单 CSV 导出 + 加纳市场 / 长安 UNI-K 客户画像深挖（只读）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const ENV = readFileSync(new URL('../extension/.env', import.meta.url), 'utf8')
const env = Object.fromEntries(ENV.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const URL_ = env.VITE_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY, ORG = env.ORG_ID
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const OUT = new URL('../分析导出/', import.meta.url)
mkdirSync(OUT, { recursive: true })

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
const contacts = await fetchAll('contacts', { select: 'id,phone,group_jid,wa_name,name,country,language,budget_usd,customer_stage,quality,destination_port,created_at', filter: `&org_id=eq.${ORG}` })
const cid = new Set(contacts.map((c) => c.id))
const byId = new Map(contacts.map((c) => [c.id, c]))
console.error(`  ${contacts.length} contacts`)

console.error('拉取 vehicle_interests...')
const vi = (await fetchAll('vehicle_interests', { select: 'contact_id,model,year,condition,target_price_usd' })).filter((r) => cid.has(r.contact_id))
const viByContact = new Map()
for (const r of vi) { if (!viByContact.has(r.contact_id)) viByContact.set(r.contact_id, []); viByContact.get(r.contact_id).push(r) }

console.error('拉取 messages（聚合）...')
const msgAgg = new Map()
{
  const PAGE = 1000; let from = 0
  for (;;) {
    const res = await fetch(`${URL_}/rest/v1/messages?select=contact_id,direction,sent_at&order=id`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!res.ok) throw new Error(`messages ${res.status}`)
    const rows = await res.json()
    for (const m of rows) {
      if (!cid.has(m.contact_id)) continue
      let a = msgAgg.get(m.contact_id); if (!a) { a = { n: 0, in: 0, out: 0, last: null, lastIn: null, lastDir: null }; msgAgg.set(m.contact_id, a) }
      a.n++; const t = m.sent_at ? new Date(m.sent_at).getTime() : null
      if (m.direction === 'inbound') { a.in++; if (t && (!a.lastIn || t > a.lastIn)) a.lastIn = t } else a.out++
      if (t && (!a.last || t > a.last)) { a.last = t; a.lastDir = m.direction }
    }
    if (rows.length < PAGE) break; from += PAGE
  }
}

// ---------- CSV helpers ----------
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const writeCsv = (name, header, rows) => {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
  writeFileSync(new URL(name, OUT), '﻿' + body) // BOM for Excel UTF-8
  console.error(`  写出 ${name}（${rows.length} 行）`)
}
const nameOf = (c) => c.name || c.wa_name || c.phone || '?'
const viText = (id) => (viByContact.get(id) || []).map((r) => r.model).filter(Boolean).join(' / ')
const waLink = (c) => (c.phone ? `https://wa.me/${String(c.phone).replace(/[^0-9]/g, '')}` : '')
const stageLabel = { new: '新客户', qualifying: '资格确认', negotiating: '谈判中', stalled: '停滞', quoted: '已报价', won: '成交', lost: '流失' }
const qLabel = { big: '大客户', potential: '有潜力', normal: '普通', spam: '垃圾' }

console.error('导出 CSV...')

// 1) 待回复热门客户（big / negotiating / quoted / qualifying，最后一条是客户发来的）
const hotNeedReply = contacts
  .filter((c) => { const a = msgAgg.get(c.id); return a && a.lastDir === 'inbound' && (c.quality === 'big' || ['negotiating', 'quoted', 'qualifying'].includes(c.customer_stage)) })
  .map((c) => ({ c, a: msgAgg.get(c.id) })).sort((x, y) => (x.a.lastIn || 0) - (y.a.lastIn || 0)) // 等最久的排前
writeCsv('1_待回复热门客户.csv',
  ['客户名', '手机号', '国家', '阶段', '质量', '客户等待天数', '车型兴趣', '消息数(收/发)', 'WhatsApp链接'],
  hotNeedReply.map(({ c, a }) => [nameOf(c), c.phone || '', c.country || '', stageLabel[c.customer_stage] || c.customer_stage, qLabel[c.quality] || c.quality, daysAgo(a.lastIn) ?? '', viText(c.id), `${a.in}/${a.out}`, waLink(c)]))

// 2) 停滞谈判（negotiating / quoted，超 14 天没动静）
const stalledDeals = [...contacts.filter((c) => ['negotiating', 'quoted'].includes(c.customer_stage))]
  .map((c) => ({ c, a: msgAgg.get(c.id) })).filter(({ a }) => a && daysAgo(a.last) > 14).sort((x, y) => (x.a.last || 0) - (y.a.last || 0))
writeCsv('2_停滞谈判_超14天.csv',
  ['客户名', '手机号', '国家', '阶段', '质量', '停滞天数', '球在谁', '车型兴趣', 'WhatsApp链接'],
  stalledDeals.map(({ c, a }) => [nameOf(c), c.phone || '', c.country || '', stageLabel[c.customer_stage], qLabel[c.quality] || c.quality, daysAgo(a.last), a.lastDir === 'inbound' ? '我方(客户在等)' : '客户', viText(c.id), waLink(c)]))

// 3) 大客户清单（quality=big）
const bigs = contacts.filter((c) => c.quality === 'big').map((c) => ({ c, a: msgAgg.get(c.id) })).sort((x, y) => (y.a?.last || 0) - (x.a?.last || 0))
writeCsv('3_大客户清单.csv',
  ['客户名', '手机号', '国家', '阶段', '车型兴趣', '预算USD', '最后联系天数', '球在谁', 'WhatsApp链接'],
  bigs.map(({ c, a }) => [nameOf(c), c.phone || '', c.country || '', stageLabel[c.customer_stage] || c.customer_stage, viText(c.id), c.budget_usd || '', a?.last ? daysAgo(a.last) : '无消息', a?.lastDir === 'inbound' ? '我方(客户在等)' : a ? '客户' : '—', waLink(c)]))

// 4) 全部待回复（最后一条是客户发来的，任何阶段）— 给销售扫一遍
const allNeedReply = contacts.filter((c) => { const a = msgAgg.get(c.id); return a && a.lastDir === 'inbound' }).map((c) => ({ c, a: msgAgg.get(c.id) })).sort((x, y) => (x.a.lastIn || 0) - (y.a.lastIn || 0))
writeCsv('4_全部待回复客户.csv',
  ['客户名', '手机号', '国家', '阶段', '质量', '客户等待天数', '车型兴趣', 'WhatsApp链接'],
  allNeedReply.map(({ c, a }) => [nameOf(c), c.phone || '', c.country || '', stageLabel[c.customer_stage] || c.customer_stage, qLabel[c.quality] || c.quality, daysAgo(a.lastIn) ?? '', viText(c.id), waLink(c)]))

// ---------- 深挖画像 ----------
const inc = (o, k) => { o[k] = (o[k] || 0) + 1 }
const sortE = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`

function profile(title, subset, extra = '') {
  const L = []
  const W = (s = '') => L.push(s)
  const N = subset.length || 1
  const stage = {}, quality = {}, lang = {}, port = {}, model = {}
  const recency = { active: 0, warm: 0, cold: 0, dead: 0, never: 0 }
  let needReply = 0, withInbound = 0, budgetSum = 0, budgetN = 0
  for (const c of subset) {
    inc(stage, c.customer_stage || '(null)'); inc(quality, c.quality || '(null)')
    inc(lang, c.language || '(无)'); if (c.destination_port) inc(port, c.destination_port)
    for (const r of (viByContact.get(c.id) || [])) if (r.model) inc(model, r.model.trim().toLowerCase())
    const b = Number(c.budget_usd) || 0; if (b > 0 && b < 200000) { budgetSum += b; budgetN++ }
    const a = msgAgg.get(c.id)
    if (a && a.in > 0) withInbound++
    if (a && a.lastDir === 'inbound') needReply++
    const d = a ? daysAgo(a.last) : null
    if (d == null) recency.never++; else if (d <= 30) recency.active++; else if (d <= 90) recency.warm++; else if (d <= 180) recency.cold++; else recency.dead++
  }
  W(`## ${title}`); W('')
  W(`**客户数 ${subset.length}** ｜ 有真实互动 ${withInbound}（${pct(withInbound, N)}）｜ ⚠️ 待回复 ${needReply} ｜ 平均预算 $${budgetN ? Math.round(budgetSum / budgetN).toLocaleString() : '—'}（${budgetN} 人填）`)
  if (extra) W(`\n${extra}`)
  W('')
  W('**阶段分布：** ' + ['new', 'qualifying', 'negotiating', 'stalled', 'quoted', 'won', 'lost'].filter((s) => stage[s]).map((s) => `${stageLabel[s]} ${stage[s]}`).join(' ｜ '))
  W('')
  W('**活跃度：** ' + `🟢活跃 ${recency.active} ｜ 🟡温 ${recency.warm} ｜ 🟠冷 ${recency.cold} ｜ 🔴沉睡 ${recency.dead} ｜ ⚫无消息 ${recency.never}`)
  W('')
  W('**Top 10 车型兴趣：**')
  W(sortE(model).slice(0, 10).map(([m, n], i) => `${i + 1}. ${m}（${n}）`).join('  ｜  ') || '（无）')
  W('')
  const langTop = sortE(lang).slice(0, 4).map(([l, n]) => `${l} ${n}`).join(' ｜ ')
  const portTop = sortE(port).slice(0, 5).map(([p, n]) => `${p} ${n}`).join(' ｜ ')
  W(`**语言：** ${langTop}`)
  if (portTop) W(`\n**目的港：** ${portTop}`)
  W('')
  return L.join('\n')
}

const ghana = contacts.filter((c) => c.country === 'Ghana')
const unikIds = new Set(vi.filter((r) => /uni[\s-]?k/i.test(r.model || '')).map((r) => r.contact_id))
const unik = contacts.filter((c) => unikIds.has(c.id))
// UNI-K 客户的国家分布
const unikCountry = {}
for (const c of unik) inc(unikCountry, c.country || '(无国家)')
const unikCountryStr = '**国家分布：** ' + sortE(unikCountry).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(' ｜ ')

const deep = [
  '# 客户画像深挖：加纳市场 & 长安 UNI-K',
  '',
  `> 生成时间：${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  profile('一、🇬🇭 加纳市场（最大单一市场）', ghana),
  '---',
  '',
  profile('二、🚙 长安 UNI-K 意向客户（最热车型）', unik, unikCountryStr),
].join('\n')
writeFileSync(new URL('../客户画像_加纳与UNIK.md', import.meta.url), deep)
console.error('  写出 客户画像_加纳与UNIK.md')
process.stdout.write(deep)
console.error('\n✅ 完成')
