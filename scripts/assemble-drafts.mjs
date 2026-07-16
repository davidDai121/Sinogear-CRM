#!/usr/bin/env node
// 把 分析导出/drafts_out/b00.md ... 按批次顺序合并成一份 客户再激活话术_全部.md
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
const DIR = new URL('../分析导出/drafts_out/', import.meta.url)
const files = readdirSync(DIR).filter((f) => /^b\d+\.md$/.test(f)).sort()
if (!files.length) { console.error('没有找到任何 drafts_out/b*.md'); process.exit(1) }

let drafted = 0, missing = []
const parts = []
// 期望 b00..b76 都在；缺的标出来
const expected = Array.from({ length: 77 }, (_, i) => `b${String(i).padStart(2, '0')}.md`)
for (const exp of expected) if (!files.includes(exp)) missing.push(exp)

for (const f of files) {
  const body = readFileSync(new URL(f, DIR), 'utf8').trim()
  drafted += (body.match(/^### /gm) || []).length
  parts.push(body)
}

const head = `# 客户再激活话术 — 全部（S+A 共 1067 个，按优先级排序，S 排最前）

> 每个客户一块：推荐车型 + FOB/CIF + 客户原意向（含聊天细节）+ 激活角度 + 发图建议 + 话术（客户语言）+ 中文说明。
> 价格口径：比亚迪现车 FOB=卖价；丰田系 FOB China 列。CIF 为粗估，运费假设见 客户再激活_总览.md。
> ⚠️ 发送前请自己过一眼把关价格/承诺。绝不自动群发。测试号 13552592187 已自动跳过。

共 ${files.length} 批，${drafted} 个客户话术${missing.length ? `\n⚠️ 缺失批次：${missing.join(', ')}（这些批可能没跑成，可单独补跑）` : ''}

---

`
writeFileSync(new URL('../客户再激活话术_全部.md', import.meta.url), head + parts.join('\n\n---\n\n'))
console.error(`合并完成：${files.length} 批，${drafted} 个客户话术 → 客户再激活话术_全部.md`)
if (missing.length) console.error('缺失批次:', missing.join(', '))
