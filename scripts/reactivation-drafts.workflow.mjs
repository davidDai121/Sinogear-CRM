export const meta = {
  name: 'reactivation-drafts',
  description: '为高价值停滞客户逐人写 WhatsApp 再激活话术（读真实聊天 + 对抗性校验合规）',
  phases: [
    { title: 'Draft', detail: '每批代理读客户聊天 + 推荐车型，写客户语言话术 + 中文说明，写出 md' },
    { title: 'Verify', detail: '对抗性校验：语言/不承诺颜色VIN/FOB+CIF/软钩子/长度，就地修正' },
  ],
}

const DIR = '/Users/david/Sino Gear CRM/分析导出/draft_batches'
const OUT = '/Users/david/Sino Gear CRM/分析导出/drafts_out'

const SPEC = `
你是 Sino Gear（中国汽车出口公司）的销售 Miles，第一人称给停滞/在等回复的客户写一条 WhatsApp「再激活」消息。
这些客户之前聊过但凉了或在等我回复。目标：用一个**具体的回来理由**唤醒他，引导他回复。

## 库存口径（只能推这些，绝不编造没有的车）
🟢 比亚迪现车（最强钩子，"我现在就有现车"）：
  秦PLUS EV $12.8k / 秦L DM-i $12.8k / 秦L EV $15.3k（轿车）
  汉 DM-i $19.4–20.7k / 汉 EV $24k / 汉L EV $28.8–29.2k（中大型轿车）
  海豹06 DM $15.3k / 海狮06 $17.4–20k（轿车）
  元UP $12.7k / 元PLUS(Atto3) $15.8–16.2k / 海狮05 $14.7–15.5k / 宋Pro $12.4k / 宋PLUS $16–16.4k（紧凑SUV）
  宋L $16.7–23.9k / 护卫舰05 $15.6k / 阿维塔 $23.3k / 深蓝 $17.9k（中型SUV）
  唐(7座) $16.8–20.7k / 唐L $28.3–34.6k（大型SUV）
  豹5 $28.3–33k / 豹8 $48.7–50k（硬派越野） / 钛3 $21.2k（方盒子小SUV）
  夏 $33.7k（MPV） / 腾势 $40.9–45.6k / 仰望U7 $78.8k（豪华）
🟡 丰田/现代/起亚 混动（现成报价可订，非现车）：卡罗拉 $10.7–14.6k / 卡罗拉Cross $12.8–16.2k / Frontlander $13.2–17.2k / RAV4 $17.8–30.6k / 凯美瑞 $16.4–26.5k / 伊兰特 $8.3–12.9k / 起亚Sportage $12.2–18.8k
⚪ 表外（长安UNI-K/CS75、捷途T2、奇瑞、丰田Hilux/Prado 等）：能订货但没现成报价。策略=承认能搞到那台，同时**主推一台尺寸/价位接近的比亚迪现车**做钩子（现车能马上发、马上报价）。

每条记录里 recommend 已经算好主推车型 + FOB + 粗略CIF。**以它为起点**，但你读完聊天后可以微调：如果客户聊天里明确要别的（且我库存有/能订），就换成更贴的。绝不推库存清单里没有的具体车。

## 价格口径
- 报 recommend.fob 的 FOB China + 一句话 recommend.cif 的"大概 CIF 落地到他港口"。CIF 是粗估，话术里用 "around / roughly"，不报死。
- 绝不出现人民币价、成本价、底价。只给 USD FOB + 粗略 CIF。

## 硬规则（违反=废稿）
1. 语言：用客户自己聊天里用的语言写。English/Spanish/French/Arabic/Portuguese 等照客户来。language 字段为空就从聊天内容 + 国家判断（西非英语国家→English；科特迪瓦/多哥/几内亚/喀麦隆等法语区→French；拉美→Spanish；伊拉克→Arabic）。
2. 绝不承诺具体颜色/具体车架号/"我有一台白色的"。客户问颜色 → "common colors like white/black available, I'll confirm exact stock for you"。
3. 不问客户"你想要什么颜色"。
4. 软钩子，不硬推。先一句温暖重连（提一下他之前看的车/聊的事），再给现车+价格这个回来理由，最后一个轻 CTA（要不要我发实拍图/完整报价）。
5. 短！WhatsApp 风格，2–5 短句，可换行。不写长篇。
6. 名字：有 name 就用（去掉 emoji）。像真人 Miles，不像群发模板。
7. 聊天摘录可能有噪音（残留时间戳、误贴的"你"+我方文字）——抓客户真实意图，别被噪音带偏。

## 输出：把整批写成一个 markdown，每个客户一块，格式严格如下
### [{tier}] {name} — {country} — {phone}
- 推荐: {主推车型} | {FOB} FOB / ~{CIF} CIF 落地{port或国家}
- 客户原意向: {interests 的可读总结，含从聊天读到的关键细节，如 RHD/预算/用途/问过的具体车}
- 激活角度: {一句话为什么这么写，结合停滞{lastContactDays}天/在等{waitingDays}天}
- 📷 建议发图: {该车型实拍 / 或"先发宋L实拍探口风"}
**话术（{语言}）：**
> {可直接复制粘贴的消息，保留换行用 > 续行}
**中文说明：** {一句话告诉销售这条说了啥 + 注意点}

每块之间空一行。只输出这个 markdown，不要额外解释。
`

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'count', 'flagged'],
  properties: {
    file: { type: 'string' },
    count: { type: 'integer' },
    flagged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'note'], properties: { name: { type: 'string' }, note: { type: 'string' } } } },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'issuesFound', 'fixed', 'notes'],
  properties: {
    file: { type: 'string' },
    issuesFound: { type: 'integer' },
    fixed: { type: 'integer' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

let batches = args
if (typeof batches === 'string') { try { batches = JSON.parse(batches) } catch { batches = batches.split(/[,\s]+/).filter(Boolean) } }
if (!Array.isArray(batches) || !batches.length) batches = ['b00.json']
log(`再激活话术：处理 ${batches.length} 批 → ${batches[0]} … ${batches[batches.length - 1]}`)

const results = await pipeline(
  batches,
  // 阶段1：起草
  (file) => agent(
    `${SPEC}

读取批次文件：${DIR}/${file}（一个 JSON 数组，每元素一个客户，字段含 name/country/language/stage/quality/budget_usd/port/ball/waitingDays/lastContactDays/inbound/outbound/interests/recommend/alts/tags/chat）。
chat 数组是最近聊天，who='cust' 是客户，'me' 是我（Miles）。

为这批每个客户写一块再激活话术，按 SPEC 的 markdown 格式。
把整批 markdown 写入文件：${OUT}/${file.replace('.json', '.md')}（用 Write 工具，目录已存在；文件顶部加一行 \`## 批次 ${file}\`）。
返回 JSON：{file, count（写了几个）, flagged:[{name, note}]（哪些客户聊天太少/意向不清/你拿不准推哪台，简短说明）}。`,
    { label: `draft:${file}`, phase: 'Draft', schema: DRAFT_SCHEMA, effort: 'high' },
  ),
  // 阶段2：对抗性校验 + 就地修正
  (draftRes, file) => agent(
    `你是合规校验员，审查并就地修正一批客户再激活话术。

读取：${OUT}/${file.replace('.json', '.md')}
逐条对照硬规则检查（默认怀疑，发现就改）：
1. 语言是否匹配该客户（法语区客户却写了英文 = 错，改成法语）。
2. 是否承诺了具体颜色/车架号/"我有一台白色的"（违规，改成 "white/black available, I'll confirm exact stock"）。
3. 是否问了客户想要什么颜色（违规，删掉）。
4. 是否出现人民币/成本价/底价（违规，删）。
5. 是否有 FOB + 粗略 CIF（缺了补上，CIF 用 around/roughly）。
6. 是否太长/太硬推（>6 句或像群发模板 → 改短、加一句结合他情况的个性化重连）。
7. 推荐车型是否在库存清单内（推了清单外的具体车 → 换成最接近的现车）。
参考库存口径：${SPEC.slice(SPEC.indexOf('## 库存口径'), SPEC.indexOf('## 价格口径'))}

用 Edit/Write 就地修正该 md 文件（保持格式）。
返回 JSON：{file, issuesFound, fixed, notes:[最多5条systemic问题简述]}。`,
    { label: `verify:${file}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'medium' },
  ),
)

const ok = results.filter(Boolean)
return {
  batches: batches.length,
  done: ok.length,
  results: ok,
}
