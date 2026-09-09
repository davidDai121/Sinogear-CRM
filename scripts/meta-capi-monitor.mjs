// Meta CAPI 回传监控
// 用法: node scripts/meta-capi-monitor.mjs
//
// 干什么:按周统计回传 Meta 的各类事件(成功/失败)、人工判定节奏、
// EngagedLead 周增量 vs 50/周 门槛(Meta 出学习期的要求)。
// 报告写到 分析导出/Meta回传监控_YYYY-MM-DD.md,同时打印到终端。
//
// 背景(2026-08-26):人工合格判定 ~5/周 远不够 50/周,先用 EngagedLead
// (消息>3 的广告线索,engaged-lead-scan 每小时自动发)垫量教 Meta。
// 存量 175 条已在 8/26 灌完,之后看周增量能不能稳在 50 上下——
// 稳得住才能把广告组优化目标切到 EngagedLead;掉到 40 以下要先查
// 消息同步覆盖(销售在手机聊、插件没抓到,信号就断)。
// 只读脚本,不写库。

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = Object.fromEntries(
  readFileSync(join(ROOT, 'extension/.env'), 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
)
const URL_ = env.VITE_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ORG = env.ORG_ID
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function fetchAll(table, { select = '*', filter = '', order = 'id' } = {}) {
  const PAGE = 1000; let from = 0; const out = []
  for (;;) {
    let rows
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(
        `${URL_}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter}&order=${order}`,
        { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } })
      rows = await res.json()
      if (Array.isArray(rows)) break
      // 57014 = statement timeout,跨境链路上偶发,退避重试
      if (attempt >= 3) { console.error('查询失败:', table, rows); process.exit(1) }
      console.error(`  ${table} 第${attempt}次超时,${attempt * 3}s 后重试…`)
      await new Promise(r => setTimeout(r, attempt * 3000))
    }
    out.push(...rows)
    if (rows.length < PAGE) return out
    from += PAGE
  }
}

const weekOf = d => {
  const t = new Date(d); const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10)
}

// ---- 1. 回传事件(只拉需要的 3 个字段,不拉肥 payload 全文) ----
const sent = await fetchAll('contact_events', {
  select: 'created_at,name:payload->>event_name,status:payload->>meta_status',
  filter: '&event_type=eq.fb_conversion_sent',
  order: 'id',
})

// ---- 2. 人工判定 ----
const judged = await fetchAll('contact_events', {
  select: 'created_at,qualified:payload->>qualified',
  filter: '&event_type=eq.lead_qualified',
  order: 'id',
})

// ---- 3. 新广告线索(算分母用) ----
const adLeads = await fetchAll('contacts', {
  select: 'created_at',
  filter: `&org_id=eq.${ORG}&or=(fb_lead_id.not.is.null,ctwa_clid.not.is.null,fb_ad_id.not.is.null)`,
  order: 'id',
})

// ---- 聚合 ----
const weeks = new Set()
const evAgg = {}   // week -> event_name -> {ok, fail}
for (const r of sent) {
  const w = weekOf(r.created_at); weeks.add(w)
  const slot = ((evAgg[w] ??= {})[r.name ?? '?'] ??= { ok: 0, fail: 0 })
  slot[r.status === '200' ? 'ok' : 'fail']++
}
const jAgg = {}    // week -> {t, f}
for (const r of judged) {
  const w = weekOf(r.created_at); weeks.add(w)
  const slot = (jAgg[w] ??= { t: 0, f: 0 })
  slot[r.qualified === 'true' ? 't' : 'f']++
}
const leadAgg = {}
for (const r of adLeads) {
  const w = weekOf(r.created_at)
  leadAgg[w] = (leadAgg[w] || 0) + 1
}

const recent = [...weeks].sort().slice(-8)
const today = new Date().toISOString().slice(0, 10)
const thisWeek = weekOf(today)

const lines = []
const P = s => { lines.push(s); console.log(s) }

P(`# Meta 回传监控 ${today}`)
P('')
P(`> 每周(周一起始)回传 Meta 的事件量。关键指标:**EngagedLead 周增量 vs 50/周**(Meta 出学习期门槛)。`)
P(`> 8/26 的 175 条是存量一次性灌入,不代表周节奏;从 8/31 那周开始看真实增量。`)
P('')
P('## 各周回传明细(成功/失败)')
P('')
const names = ['EngagedLead', 'QualifiedLead', 'DisqualifiedLead', 'Lead', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase']
P(`| 周 | 新广告线索 | ${names.join(' | ')} | 其他 | 人工判定(合格/不合格) |`)
P(`|---|---|${names.map(() => '---').join('|')}|---|---|`)
for (const w of recent) {
  const ev = evAgg[w] ?? {}
  const fmt = n => {
    const s = ev[n]; if (!s) return '-'
    return s.fail ? `${s.ok} / ❌${s.fail}` : `${s.ok}`
  }
  const otherNames = Object.keys(ev).filter(n => !names.includes(n))
  const other = otherNames.length
    ? otherNames.map(n => `${n}:${ev[n].ok}${ev[n].fail ? `/❌${ev[n].fail}` : ''}`).join(' ')
    : '-'
  const j = jAgg[w]
  const js = j ? `${j.t} / ${j.f}` : '-'
  const mark = w === thisWeek ? '(本周,未完)' : ''
  P(`| ${w}${mark} | ${leadAgg[w] ?? 0} | ${names.map(fmt).join(' | ')} | ${other} | ${js} |`)
}
P('')

// ---- 健康度结论 ----
P('## 结论')
P('')
const wk = evAgg[thisWeek] ?? {}
const eg = wk.EngagedLead ?? { ok: 0, fail: 0 }
const allFail = recent.reduce((s, w) => s + Object.values(evAgg[w] ?? {}).reduce((a, v) => a + v.fail, 0), 0)
// 通道健康看最近 7 天(整周窗口会把已修复的历史故障期算进来误报)
const cutoff7 = new Date(Date.now() - 7 * 86400e3).toISOString()
const fail7 = sent.filter(r => r.created_at >= cutoff7 && r.status !== '200').length
P(`- 本周(${thisWeek})EngagedLead 已回传 **${eg.ok}** 条${eg.fail ? `,失败 ${eg.fail} 条 ⚠️` : ''};门槛 50/周。`)
P(`- 人工判定本周: 合格 ${(jAgg[thisWeek] ?? {}).t ?? 0} / 不合格 ${(jAgg[thisWeek] ?? {}).f ?? 0}。`)
if (fail7 > 0) {
  const lastFail = sent.filter(r => r.status !== '200').map(r => r.created_at).sort().at(-1)?.slice(0, 10)
  P(`- ⚠️ 最近 7 天有 ${fail7} 条回传失败,最后一次失败在 ${lastFail}。若在 8/20 换 token 之前是旧账;若是最近一两天,查 token 是否又失效(错误码 190,CAPI 和 lead webhook 会同时静默失效)。`)
} else {
  P(`- 最近 7 天回传 0 失败,通道健康。(历史累计失败 ${allFail} 条,主要是 7/13-8/17 的 token 故障期)`)
}
P('')
P('*数据口径:周=周一起始(UTC);"新广告线索"=当周创建且带 fb_lead_id/ctwa_clid/fb_ad_id 的 contact;失败=meta_status≠200。*')

// ---- 写报告 ----
const outDir = join(ROOT, '分析导出')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `Meta回传监控_${today}.md`)
writeFileSync(outPath, lines.join('\n') + '\n')
console.log(`\n报告已写入: ${outPath}`)
