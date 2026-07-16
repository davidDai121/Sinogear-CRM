#!/usr/bin/env node
// 一次性客户分析脚本：分页拉全量 contacts + 关联表，内存里多维聚合
// 用 service_role key 绕 RLS，只读不写
import { readFileSync } from 'node:fs'

const ENV = readFileSync(new URL('../extension/.env', import.meta.url), 'utf8')
const env = Object.fromEntries(
  ENV.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  })
)
const URL_ = env.VITE_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ORG = env.ORG_ID
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function fetchAll(table, { select = '*', filter = '', order = 'id' } = {}) {
  const PAGE = 1000
  let from = 0
  const out = []
  for (;;) {
    const url = `${URL_}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter}&order=${order}`
    const res = await fetch(url, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

const now = Date.now()
const DAY = 86400000
const daysAgo = (ts) => (ts ? Math.floor((now - new Date(ts).getTime()) / DAY) : null)

console.error('拉取 contacts...')
const contacts = await fetchAll('contacts', {
  select:
    'id,phone,group_jid,wa_name,name,country,language,budget_usd,customer_stage,quality,destination_port,notes,created_at,updated_at,created_by,google_resource_name,fb_lead_id',
  filter: `&org_id=eq.${ORG}`,
})
const cid = new Set(contacts.map((c) => c.id))
console.error(`  ${contacts.length} contacts`)

console.error('拉取 vehicle_interests...')
const vi = (await fetchAll('vehicle_interests', { select: 'contact_id,model,year,condition,steering,target_price_usd' })).filter((r) => cid.has(r.contact_id))
console.error('拉取 contact_tags...')
const tags = (await fetchAll('contact_tags', { select: 'contact_id,tag', order: 'contact_id' })).filter((r) => cid.has(r.contact_id))
console.error('拉取 contact_handlers...')
const handlers = (await fetchAll('contact_handlers', { select: 'contact_id,user_id', order: 'contact_id' })).filter((r) => cid.has(r.contact_id))
console.error('拉取 quotes...')
const quotes = (await fetchAll('quotes', { select: 'contact_id,vehicle_model,price_usd,status,sent_at' })).filter((r) => cid.has(r.contact_id))

// messages: 聚合而非全存
console.error('拉取 messages（聚合）...')
const msgAgg = new Map() // contact_id -> {n,in,out,last,lastIn,lastOut,lastDir}
const aiSource = {}
{
  const PAGE = 1000
  let from = 0
  let total = 0
  for (;;) {
    const url = `${URL_}/rest/v1/messages?select=contact_id,direction,sent_at,ai_source&order=id`
    const res = await fetch(url, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
    if (!res.ok) throw new Error(`messages ${res.status}: ${await res.text()}`)
    const rows = await res.json()
    for (const m of rows) {
      if (!cid.has(m.contact_id)) continue
      total++
      let a = msgAgg.get(m.contact_id)
      if (!a) { a = { n: 0, in: 0, out: 0, last: null, lastIn: null, lastOut: null, lastDir: null }; msgAgg.set(m.contact_id, a) }
      a.n++
      const t = m.sent_at ? new Date(m.sent_at).getTime() : null
      if (m.direction === 'inbound') { a.in++; if (t && (!a.lastIn || t > a.lastIn)) a.lastIn = t }
      else { a.out++; if (t && (!a.lastOut || t > a.lastOut)) a.lastOut = t; if (m.ai_source) aiSource[m.ai_source] = (aiSource[m.ai_source] || 0) + 1; else aiSource['(manual/null)'] = (aiSource['(manual/null)'] || 0) + 1 }
      if (t && (!a.last || t > a.last)) { a.last = t; a.lastDir = m.direction }
    }
    if (rows.length < PAGE) break
    from += PAGE
  }
  console.error(`  ${total} messages（本 org）`)
}

// ---------- 聚合 ----------
const pct = (n, d = contacts.length) => `${((n / d) * 100).toFixed(1)}%`
const inc = (o, k) => { o[k] = (o[k] || 0) + 1 }
const sortEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])

const isGroup = (c) => !!c.group_jid
const groups = contacts.filter(isGroup)
const persons = contacts.filter((c) => !isGroup(c))

// stage / quality / country / language / budget
const stage = {}, quality = {}, country = {}, language = {}, port = {}
const createdMonth = {}, createdBy = {}
let hasBudget = 0, budgetSum = 0
let fromFb = 0, fromGoogle = 0
for (const c of contacts) {
  inc(stage, c.customer_stage || '(null)')
  inc(quality, c.quality || '(null)')
  inc(country, c.country || '(无国家)')
  inc(language, c.language || '(无语言)')
  if (c.destination_port) inc(port, c.destination_port)
  if (c.budget_usd != null && c.budget_usd > 0) { hasBudget++; budgetSum += Number(c.budget_usd) }
  if (c.fb_lead_id) fromFb++
  if (c.google_resource_name) fromGoogle++
  inc(createdMonth, (c.created_at || '').slice(0, 7) || '(unknown)')
  inc(createdBy, c.created_by || '(null)')
}

// vehicle interests: top models + brands
const viByContact = new Set(vi.map((r) => r.contact_id))
const modelCount = {}, brandCount = {}
const brandOf = (m) => {
  const s = (m || '').trim().toLowerCase()
  const brands = ['toyota','honda','nissan','mazda','mitsubishi','suzuki','lexus','hyundai','kia','changan','chery','geely','byd','great wall','haval','gac','trumpchi','mg','wuling','baic','jac','foton','dongfeng','faw','ford','chevrolet','volkswagen','vw','audi','bmw','mercedes','benz','land rover','range rover','jeep','peugeot','renault','isuzu','hino']
  for (const b of brands) if (s.includes(b)) return b
  return s.split(/\s+/)[0] || '(空)'
}
for (const r of vi) {
  const m = (r.model || '').trim()
  if (!m) continue
  inc(modelCount, m.toLowerCase())
  inc(brandCount, brandOf(m))
}

// tags
const tagCount = {}
const tagByContact = new Set(tags.map((r) => r.contact_id))
for (const r of tags) inc(tagCount, (r.tag || '').trim())

// handlers: 每个 user 多少客户 + 撞单
const byUser = {}
const handlersByContact = new Map()
for (const r of handlers) {
  inc(byUser, r.user_id)
  if (!handlersByContact.has(r.contact_id)) handlersByContact.set(r.contact_id, new Set())
  handlersByContact.get(r.contact_id).add(r.user_id)
}
let collisions = 0
for (const [, s] of handlersByContact) if (s.size >= 2) collisions++

// 活性 / 健康度
let withMsg = 0, withInbound = 0, outboundOnly = 0, noMsg = 0
let needReply = 0 // 最后一条是 inbound
const recency = { active: 0, warm: 0, cold: 0, dead: 0, never: 0 } // ≤30 / 31-90 / 91-180 / >180 / 无消息
let emptyShell = 0 // 无消息 + stage=new + 无 country/notes/tags/interests
for (const c of contacts) {
  const a = msgAgg.get(c.id)
  if (a && a.n > 0) {
    withMsg++
    if (a.in > 0) withInbound++
    else outboundOnly++
    if (a.lastDir === 'inbound') needReply++
    const d = daysAgo(a.last)
    if (d == null) recency.never++
    else if (d <= 30) recency.active++
    else if (d <= 90) recency.warm++
    else if (d <= 180) recency.cold++
    else recency.dead++
  } else {
    noMsg++
    recency.never++
    if ((c.customer_stage === 'new' || !c.customer_stage) && !c.country && !c.notes && !tagByContact.has(c.id) && !viByContact.has(c.id) && !c.group_jid) emptyShell++
  }
}

// 重点客户清单（big quality + 活跃/谈判中）
const bigCustomers = contacts.filter((c) => c.quality === 'big')
const negotiating = contacts.filter((c) => c.customer_stage === 'negotiating')
const quoted = contacts.filter((c) => c.customer_stage === 'quoted')
const won = contacts.filter((c) => c.customer_stage === 'won')
const lost = contacts.filter((c) => c.customer_stage === 'lost')
const stalled = contacts.filter((c) => c.customer_stage === 'stalled')

// 需要立刻回复的重点客户（big 或 negotiating/quoted 且最后一条 inbound）
const hotNeedReply = contacts
  .filter((c) => {
    const a = msgAgg.get(c.id)
    if (!a || a.lastDir !== 'inbound') return false
    return c.quality === 'big' || ['negotiating', 'quoted', 'qualifying'].includes(c.customer_stage)
  })
  .map((c) => ({ c, a: msgAgg.get(c.id) }))
  .sort((x, y) => (y.a.last || 0) - (x.a.last || 0))

const out = []
const W = (s = '') => out.push(s)
const bar = (n, max, width = 30) => '█'.repeat(Math.round((n / max) * width)).padEnd(width, '·')
const topList = (obj, k = 15, denom = contacts.length) => sortEntries(obj).slice(0, k).map(([name, n], i) => `  ${String(i + 1).padStart(2)}. ${String(name).slice(0, 28).padEnd(30)} ${String(n).padStart(5)}  ${pct(n, denom)}`).join('\n')

W('# Sino Gear CRM — 全量客户分析报告')
W('')
W(`> 数据源：Supabase（org ${ORG}）  生成时间：${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
W('')
W('## 一、总览')
W('')
W('| 指标 | 数值 |')
W('|---|---|')
W(`| 客户总数 | **${contacts.length}** |`)
W(`| ├ 个人客户 | ${persons.length}（${pct(persons.length)}）|`)
W(`| └ 群聊 | ${groups.length}（${pct(groups.length)}）|`)
W(`| 有消息记录的客户 | ${withMsg}（${pct(withMsg)}）|`)
W(`| ├ 有客户回复（真实互动） | ${withInbound}（${pct(withInbound)}）|`)
W(`| └ 只有我方外发、客户没回 | ${outboundOnly}（${pct(outboundOnly)}）|`)
W(`| 完全无消息 | ${noMsg}（${pct(noMsg)}）|`)
W(`| 疑似空壳（无消息+无任何资料） | ${emptyShell}（${pct(emptyShell)}）|`)
W(`| 来自 Facebook 广告 | ${fromFb} |`)
W(`| Google 通讯录同步 | ${fromGoogle} |`)
W(`| 消息总量 | ${[...msgAgg.values()].reduce((s, a) => s + a.n, 0)}（入站 ${[...msgAgg.values()].reduce((s, a) => s + a.in, 0)} / 出站 ${[...msgAgg.values()].reduce((s, a) => s + a.out, 0)}）|`)
W('')

W('## 二、销售漏斗（customer_stage）')
W('')
const stageOrder = ['new', 'qualifying', 'negotiating', 'stalled', 'quoted', 'won', 'lost', '(null)']
const stageLabel = { new: '🆕 新客户', qualifying: '🔍 资格确认', negotiating: '💬 谈判中', stalled: '💤 停滞', quoted: '📋 已报价', won: '✅ 成交', lost: '❌ 流失', '(null)': '(未分类)' }
const smax = Math.max(...Object.values(stage))
W('```')
for (const s of stageOrder) {
  if (!(s in stage)) continue
  W(`${(stageLabel[s] || s).padEnd(12)} ${bar(stage[s], smax)} ${String(stage[s]).padStart(5)}  ${pct(stage[s])}`)
}
W('```')
const engaged = withInbound || 1
// 真实漏斗：只看有客户回复（真实互动）的客户，stage 才有意义
const engagedStage = {}
let lostNoMsg = 0
for (const c of contacts) {
  const a = msgAgg.get(c.id)
  if (a && a.in > 0) inc(engagedStage, c.customer_stage || '(null)')
  if (c.customer_stage === 'lost' && !(a && a.in > 0)) lostNoMsg++
}
W('')
W(`> ⚠️ 上面的漏斗含大量**从无真实互动**的客户：\`lost\` 的 ${lost.length} 里有 ${lostNoMsg} 个根本没收到过客户消息（批量导入后被分类器自动判 lost）。下面按"有客户回复"重算才是真实漏斗。`)
W('')
W(`**真实漏斗（仅 ${withInbound} 个有客户回复的客户）：**`)
W('```')
const esmax = Math.max(...Object.values(engagedStage), 1)
for (const s of stageOrder) {
  if (!(s in engagedStage)) continue
  W(`${(stageLabel[s] || s).padEnd(12)} ${bar(engagedStage[s], esmax)} ${String(engagedStage[s]).padStart(5)}  ${pct(engagedStage[s], engaged)}`)
}
W('```')
W('')
W(`**转化观察**：${withInbound} 个真实互动客户中 —— 谈判中 ${engagedStage['negotiating'] || 0}、已报价 ${engagedStage['quoted'] || 0}、成交 ${engagedStage['won'] || 0}。`)
W(`系统内**成交仅 ${won.length} 单** —— 但 quotes 报价表只有 1 条、成交也几乎没录系统，**真实成交大概率没在 CRM 里登记**。这个数字反映的是"系统录入习惯"，不是真实业绩。`)
W('')

W('## 三、客户质量分级（quality）')
W('')
const qLabel = { big: '⭐⭐⭐ 大客户', potential: '⭐⭐ 有潜力', normal: '⭐ 普通', spam: '🗑 垃圾', '(null)': '(未分级)' }
const qmax = Math.max(...Object.values(quality))
W('```')
for (const [q, n] of sortEntries(quality)) W(`${(qLabel[q] || q).padEnd(14)} ${bar(n, qmax)} ${String(n).padStart(5)}  ${pct(n)}`)
W('```')
W('')

W('## 四、地理分布（Top 20 国家）')
W('')
W('```')
W(topList(country, 20))
W('```')
W('')

W('## 五、语言分布（Top 12）')
W('')
W('```')
W(topList(language, 12))
W('```')
W('')

W('## 六、车型兴趣')
W('')
W(`有车型兴趣记录的客户：${viByContact.size}（${pct(viByContact.size)}），共 ${vi.length} 条兴趣。`)
W('')
W('**Top 15 品牌：**')
W('```')
W(topList(brandCount, 15, vi.length || 1))
W('```')
W('**Top 20 具体车型：**')
W('```')
W(topList(modelCount, 20, vi.length || 1))
W('```')
W('')

W('## 七、预算分布')
W('')
const GARBAGE = 200000 // 二手车出口，预算 > $20万 基本是 AI 抽取的拼接脏数据
const budgetBuckets = { '未填': 0, '<5k': 0, '5k-10k': 0, '10k-15k': 0, '15k-25k': 0, '25k-50k': 0, '50k-200k': 0, '>200k(疑脏数据)': 0 }
const cleanBudgets = []
for (const c of contacts) {
  const b = Number(c.budget_usd) || 0
  if (!b) budgetBuckets['未填']++
  else if (b < 5000) budgetBuckets['<5k']++
  else if (b < 10000) budgetBuckets['5k-10k']++
  else if (b < 15000) budgetBuckets['10k-15k']++
  else if (b < 25000) budgetBuckets['15k-25k']++
  else if (b < 50000) budgetBuckets['25k-50k']++
  else if (b < GARBAGE) budgetBuckets['50k-200k']++
  else { budgetBuckets['>200k(疑脏数据)']++; continue }
  if (b > 0) cleanBudgets.push(b)
}
cleanBudgets.sort((a, b) => a - b)
const median = cleanBudgets.length ? cleanBudgets[Math.floor(cleanBudgets.length / 2)] : 0
const cleanAvg = cleanBudgets.length ? Math.round(cleanBudgets.reduce((s, b) => s + b, 0) / cleanBudgets.length) : 0
const bmax = Math.max(...Object.values(budgetBuckets))
W('```')
for (const [k, n] of Object.entries(budgetBuckets)) W(`${k.padEnd(16)} ${bar(n, bmax)} ${String(n).padStart(5)}  ${pct(n)}`)
W('```')
W(`填写了预算的 ${hasBudget} 个客户。**剔除 ${budgetBuckets['>200k(疑脏数据)']} 个脏数据后**：中位数 $${median.toLocaleString()}，均值 $${cleanAvg.toLocaleString()}。`)
W(`> ⚠️ \`budget_usd\` 被 AI 抽取的**拼接错误**污染：出现 \`3,700,040,000\`（37 亿）、\`2,600,028,500\` 这类两数粘连值（疑似 "26000"+"28500"）。建议清洗这 ${budgetBuckets['>200k(疑脏数据)']} 行。`)
W('')

W('## 八、活跃度 / 健康度（按最后一条消息时间）')
W('')
const rLabel = { active: '🟢 活跃 ≤30 天', warm: '🟡 温 31-90 天', cold: '🟠 冷 91-180 天', dead: '🔴 沉睡 >180 天', never: '⚫ 从无消息' }
const rmax = Math.max(...Object.values(recency))
W('```')
for (const k of ['active', 'warm', 'cold', 'dead', 'never']) W(`${rLabel[k].padEnd(16)} ${bar(recency[k], rmax)} ${String(recency[k]).padStart(5)}  ${pct(recency[k])}`)
W('```')
W('')
W(`**⚠️ 待回复（最后一条是客户发来的）：${needReply} 个客户** —— 这些是球在我方、客户在等回复的。`)
W('')

W('## 九、标签 Top 20')
W('')
W(`有标签的客户：${tagByContact.size}，共 ${tags.length} 个标签。`)
W('```')
W(topList(tagCount, 20, tags.length || 1))
W('```')
W('')

W('## 十、团队 / 主理人分布')
W('')
W(`登记了主理人的客户：${handlersByContact.size}，撞单（2+ 主理人）：${collisions}。`)
W('```')
W(sortEntries(byUser).map(([u, n], i) => `  ${i + 1}. ${u.slice(0, 8)}…  ${String(n).padStart(5)} 客户`).join('\n'))
W('```')
W('')

W('## 十一、AI 回复使用情况（出站消息归因）')
W('')
W('```')
W(sortEntries(aiSource).map(([s, n]) => `  ${s.padEnd(16)} ${String(n).padStart(6)}`).join('\n'))
W('```')
W('')

W('## 十二、新增客户趋势（按月，近 18 个月）')
W('')
const months = sortEntries(createdMonth).filter(([m]) => m !== '(unknown)').sort((a, b) => a[0].localeCompare(b[0])).slice(-18)
const mmax = Math.max(...months.map(([, n]) => n), 1)
W('```')
for (const [m, n] of months) W(`${m}  ${bar(n, mmax, 24)} ${String(n).padStart(5)}`)
W('```')
W('')

W('## 十三、🔥 重点行动清单')
W('')
W(`### A. 大客户（⭐⭐⭐ big，共 ${bigCustomers.length} 个）`)
W('')
const bigSorted = bigCustomers.map((c) => ({ c, a: msgAgg.get(c.id) })).sort((x, y) => (y.a?.last || 0) - (x.a?.last || 0))
W('| 客户 | 国家 | 阶段 | 车型兴趣 | 预算 | 最后联系 | 球在谁 |')
W('|---|---|---|---|---|---|---|')
for (const { c, a } of bigSorted.slice(0, 40)) {
  const name = (c.name || c.wa_name || c.phone || '?').slice(0, 18)
  const viList = vi.filter((r) => r.contact_id === c.id).map((r) => r.model).filter(Boolean).slice(0, 2).join(', ').slice(0, 24)
  const d = a?.last ? `${daysAgo(a.last)}天前` : '无消息'
  const ball = a?.lastDir === 'inbound' ? '⚠️ 我方' : a ? '客户' : '—'
  W(`| ${name} | ${(c.country || '?').slice(0, 8)} | ${stageLabel[c.customer_stage] || c.customer_stage || '?'} | ${viList || '—'} | ${c.budget_usd ? '$' + Number(c.budget_usd).toLocaleString() : '—'} | ${d} | ${ball} |`)
}
W('')
W(`### B. 待回复的热门客户（big / 谈判 / 报价 / 资格确认，且客户在等回复，共 ${hotNeedReply.length} 个，列最近 30）`)
W('')
W('| 客户 | 国家 | 阶段 | 质量 | 等了多久 |')
W('|---|---|---|---|---|')
for (const { c, a } of hotNeedReply.slice(0, 30)) {
  const name = (c.name || c.wa_name || c.phone || '?').slice(0, 18)
  W(`| ${name} | ${(c.country || '?').slice(0, 8)} | ${stageLabel[c.customer_stage] || c.customer_stage} | ${qLabel[c.quality] || c.quality || '?'} | ${a.lastIn ? daysAgo(a.lastIn) + '天' : '?'} |`)
}
W('')
W(`### C. 谈判中 / 已报价但停滞（${negotiating.length + quoted.length} 个谈判+报价中，注意别凉）`)
W('')
const hotStale = [...negotiating, ...quoted].map((c) => ({ c, a: msgAgg.get(c.id) })).filter(({ a }) => a && daysAgo(a.last) > 14).sort((x, y) => (x.a.last || 0) - (y.a.last || 0))
W(`其中超过 14 天没动静的：**${hotStale.length} 个**（最久的排前面，列 25）`)
W('')
W('| 客户 | 国家 | 阶段 | 多久没动 |')
W('|---|---|---|---|')
for (const { c, a } of hotStale.slice(0, 25)) {
  const name = (c.name || c.wa_name || c.phone || '?').slice(0, 18)
  W(`| ${name} | ${(c.country || '?').slice(0, 8)} | ${stageLabel[c.customer_stage]} | ${daysAgo(a.last)}天 |`)
}
W('')

W('## 十四、数据质量提示')
W('')
W(`- **${noMsg} 个客户（${pct(noMsg)}）完全没有消息记录**，其中 ${emptyShell} 个是疑似空壳（建议清理或归档）。`)
W(`- **${country['(无国家)'] || 0} 个客户没有国家信息**，影响地理分析与 AI 报价。`)
W(`- **${budgetBuckets['未填']} 个客户（${pct(budgetBuckets['未填'])}）没填预算**。`)
W(`- 只有 **${viByContact.size} 个客户（${pct(viByContact.size)}）登记了车型兴趣** —— 多数客户的购车意向未结构化录入。`)
W(`- quotes 报价表只有 ${quotes.length} 条记录 —— 报价基本没走系统录入。`)
W('')

const report = out.join('\n')
process.stdout.write(report)
import('node:fs').then((fs) => fs.writeFileSync(new URL('../客户分析报告.md', import.meta.url), report))
console.error('\n\n✅ 已写入 客户分析报告.md')
