#!/usr/bin/env node
// 把 激活话术目标.json 清洗 + 排序 + 切成小批 JSON 文件，供工作流代理逐批读取
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
const SRC = new URL('../分析导出/激活话术目标.json', import.meta.url)
const DIR = new URL('../分析导出/draft_batches/', import.meta.url)
try { for (const f of readdirSync(DIR)) rmSync(new URL(f, DIR)) } catch { mkdirSync(DIR, { recursive: true }) }
mkdirSync(DIR, { recursive: true })

const t = JSON.parse(readFileSync(SRC, 'utf8'))

// 清洗聊天噪音：去掉行首误贴的"你"、尾部 CJK/英文时间戳 meta、Seen/已编辑/📥
const TIME_META = /\s*(?:Seen|已读|已送达)?\s*(?:凌晨|清晨|早上|上午|中午|下午|晚上)?\d{1,2}:\d{2}\s*$/
const clean = (s) => {
  let x = String(s || '')
  x = x.replace(/^你(?=[A-Za-z一-龥])/, '') // 行首误贴的"你"
  x = x.replace(/^[📥➡️⬇️\s]+/, '').replace(/Seen$/,'')
  for (let i = 0; i < 3; i++) x = x.replace(TIME_META, '').replace(/\s*已编辑\s*$/, '').trim()
  return x.trim()
}

// 排序：S 先，分数降序
const order = { S: 0, A: 1 }
t.sort((a, b) => (order[a.tier] - order[b.tier]) || (b.score - a.score))

const slim = t.map((x) => ({
  id: x.id, tier: x.tier, name: x.name, phone: x.phone, country: x.country, language: x.language,
  stage: x.stage, quality: x.quality, budget_usd: x.budget_usd, port: x.port,
  ball: x.ball, waitingDays: x.waitingDays, lastContactDays: x.lastContactDays,
  inbound: x.inbound, outbound: x.outbound,
  interests: x.interests.map((i) => ({ label: i.label, kind: i.kind, source: i.source })),
  recommend: x.recommend ? {
    name: x.recommend.name, seg: x.recommend.seg, fuel: x.recommend.fuel, stock: x.recommend.stock,
    fob: x.recommend.fob, cif: x.recommend.cif, matchKind: x.recommend.matchKind, sourceNote: x.recommend.sourceNote, note: x.recommend.note,
  } : null,
  alts: x.alts.filter((a) => a.name).map((a) => `${a.name} (${a.fob} FOB)`),
  tags: (x.tags || []).slice(0, 8),
  chat: x.recentChat.slice(-10).map((m) => ({ who: m.who === 'inbound' ? 'cust' : (m.who === 'me' ? 'me' : m.who), t: clean(m.text).slice(0, 200) })).filter((m) => m.t),
}))

const BATCH = 14
let n = 0
for (let i = 0; i < slim.length; i += BATCH) {
  const batch = slim.slice(i, i + BATCH)
  const id = String(n).padStart(2, '0')
  writeFileSync(new URL(`b${id}.json`, DIR), JSON.stringify(batch, null, 0))
  n++
}
console.error(`切出 ${n} 批（每批 ${BATCH}），共 ${slim.length} 个目标 → 分析导出/draft_batches/`)
console.error(`S=${t.filter(x=>x.tier==='S').length}  A=${t.filter(x=>x.tier==='A').length}`)
