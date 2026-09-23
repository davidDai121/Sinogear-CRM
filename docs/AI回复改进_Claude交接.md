# AI 回复改进 · 第一阶段 · Claude 负责部分交接

日期：2026-09-18 · 分支 main 工作区（未 commit，由 Codex 统一 build / 验收 / 提交）

> Codex 最终接收补记：以下是 Claude 当时的交接与审查快照。现已完成角色去重接线、No change 解析/档案回归、0041 偏好查询索引线上应用及 PostgREST/执行计划验证；同一 sourceEntry 不复活撤销，新指令可重新确认，已有测试覆盖。公共销售表达又按老板反馈补充，当前规程长度以《AI回复改进_协作与验收》为准。186项测试和构建通过，扩展本机重载完成，偏好保存/刷新/撤销及José隔离已实机验证。在线新生成被既有GPT任务占用，未中断其他任务；未commit或发布团队版。

范围（按分工）：`gpt-sales-workflow.ts`、`gpt-prompt.ts`、`gpt-followup.ts`、新建 `gpt-workflow-selection.ts` 及测试。未动 GPTReplySection、sales-work-memory、日志、parser、ClientRecordCard、quote/freight 校验、线上 GPT 与 skill、package.json。

## 改了什么

### 1. 运费 / 报价规程条件加载 — `src/lib/gpt-workflow-selection.ts`（新）+ `gpt-sales-workflow.ts`

- `selectGptWorkflows(input) → { freight, quote, reasons[] }`，纯函数。输入：`salesGuidance / discussionQuestion / messages / vehicleInterests / workMemory / contact.destination_port`。
- 触发依据（任一命中；`reasons` 逐条可读，便于验收对照）：
  - 销售指令或讨论问题明确涉及价格/报价（`QUOTE_REQUEST`，zh/en/es/fr/pt/ar 常见词）或运输/运费/箱型/港口（`FREIGHT_REQUEST`）；
  - 老板对报价阻塞的简短澄清（"就是dg" / "一台" / "美元" / "20gp"…）→ 两块都加载（兼容既有 test-gpt-sales-workflow）；
  - **最后一条销售出站之后**的客户消息在问价格/运输（= 未解决需求；已回复过、之后只道谢的不算）；
  - 客户在回答销售**为报价提出的问句**（"1"、"Negra"、港口名）→ 继续报价；单纯的 是/好/谢谢 不算；
  - 本 scope 最新 `quoteVersions` 草稿**没有可靠发送证据** → 报价规程（见下）；
  - 目的港 / 客户新提的数量 / 最新车型兴趣与最新报价输入不一致（含"草稿是 R08、客户问 Hilux CIF"）→ 两块；
  - 开放 CRM 任务标题含 报价/quote/CIF/FOB → 报价；含 运费/freight/flete → 运费。
- 耦合规则（按 Codex 审查修正）：要运费 ⇒ 一定加载报价规程；**要报价就同时带运费规程**（运费有效期 7 天、路线/柜型/动力一致等规则由 `FREIGHT_RESEARCH_WORKFLOW` 自己判断，这里**不再另造有效期**）；唯一例外是请求明确只要 FOB/出厂价且没有任何运输词。
- "已发送"只认强证据：真实出站 + 有时间戳且晚于草稿 `computedAt` + 正文以数字边界完整出现某方案的**主总价** `result[i].totalUsd`（带或不带千分位）。时间戳为空、早于核算、只出现保险分项、金额是更长数字的一部分 → 一律当未发送，继续加载（保守）。它只用来取消"草稿未发"这一个触发，不影响其它信号。
- `renderSalesWorkflow(selection)`：`SALES_WORKFLOW_CORE`（原前 8 段，2,956 字符）+ 按需 `FREIGHT_RESEARCH_WORKFLOW` / `QUOTE_WORKFLOW`；未加载时附一小段说明（沿用已核算/已批准金额、不输出 `<quote_input>`/`<freight_research>`、真需要新数字就在策略段说明缺口）。**没有 NEED_QUOTE 重跑协议**。
- `SALES_WORKFLOW` 常量仍导出且是完整版（旧调用方/显式需要时可用）。
- 体积：规程段 完整 17,219 → 仅报价（FOB-only）9,875 → 无模块 3,509 字符。

### 2. 三个 prompt 入口接入 — `gpt-prompt.ts`

`buildFirstMessage / buildFollowUpMessage / buildDiscussionMessage` 内部各自调 `selectGptWorkflows`，**调用签名不变**。讨论模式用 `question` 作为 discussionQuestion。续聊仍 50 条（未砍）。

### 3. 输出契约瘦身 — `OUTPUT_REMINDER`

三段头不变、顺序不变（解析器不改）。新增：`[Client Record]` 只写本轮有变化/新学到的字段，无变化写单行 `No change`，不再补 Unknown 占位；`[WhatsApp Reply]` 明确为主产物、按客户消息长度写；`[Full Translation & Strategy]` 完整中文译文在前、策略 ≤5 短行（skill 要求的子标题可保留但要短）、CRM 块照旧。

⚠️ **需要 Codex 核一眼**：`ClientRecordCard` / 档案应用逻辑对 `No change` 单行和缺字段的处理（CLAUDE.md 记的是"差异对比 + 手动应用 N 项"，缺字段应无 diff；`No change` 无冒号应被忽略）。核完再决定是否发版。

### 4. 跟进证据去重 — `gpt-followup.ts`

- `followupPrompt(ctx, opts?)`，`opts`：
  - `includedRenderedMessages?: { text: string; fromMe: boolean }[]` —— **推荐**。同文**且角色一致**（customer↔入站、sales↔出站）才缩写；客户入站和销售出站文本相同也不互相指代。
  - `includedEvidenceTexts?: string[]` —— 只按正文匹配的旧形式，不校验角色。
  - `includedEvidenceIds?: string[]` —— 按 ledger id 全等。
  - 默认什么都不传 = 与改前**逐字相同**（后台 runner、补块修复不受影响）。
- 缩写规则：只缩写 >80 字符的 customer/sales 证据为前 60 字 + `…[full text in Chat History above]`，**保留原 id / role / at**；owner 指令永不缩写；省下的字符不够抵附加说明就整体不缩写；无法证明同文 = 不去重。`extractFollowup` 校验一行未动（仍对照 `ctx.evidence` 完整正文；从缩写前缀或 Chat History 全文引用的子串都能通过）。
- 配套：`gpt-prompt.ts` 导出 `chatHistoryEvidence(messages) → {text, fromMe}[]` 和 `chatHistoryEvidenceTexts(messages) → string[]` = 主 prompt `[Chat History]` 实际渲染出的真实非媒体正文（折叠后最近 50 条，排除 `[Customer sent N photos]` 占位）。
- **不按 id 去重的原因**：`ChatMessage.id` 是 wa_message_id，followup evidence id 是 `message:<messages.id uuid>`，对不上；只能按内容。

**接线（Codex 侧，GPTReplySection.tsx 主 prompt 的两处 `followupPrompt(followupContext)`）：**
```ts
prompt += followupPrompt(followupContext, { includedRenderedMessages: chatHistoryEvidence(messages) });
```
`messages` 用传给 buildFirstMessage/buildFollowUpMessage 的同一数组。runner（`gpt-followup-runner.ts`）、报价核算整理轮和补块修复轮保持默认完整调用。

## 测试

`scripts/test-gpt-workflow-selection.mjs`（15 例）：无信号不加载 / "就是dg" 双加载 / 多语言问价 es-fr-en-ar / 已回复后道谢不算 / FOB-only 只加报价 + 提到 CIF 即带运费 / 新车型 CIF 询价 / 颜色·数量短答继续报价 + 无关短答不触发 / 强发送证据 + Si 不加载 / 四种弱证据全部保守加载 / 数量变化 / 港口变化 / 开放任务 / 三入口注入 + `SALES_WORKFLOW` 仍完整 / 输出契约 / followup 去重（默认完整、同文缩写、id/role/at 保留、owner 不缩写、省不下不缩写、无法证明不去重）。

未加进 `package.json` scripts（不在我分工内），跑法：`node --test scripts/test-gpt-workflow-selection.mjs`。

最后一轮跑过：`tsc -b --noEmit` 0 错（含 Codex 并行改动后的工作区）；新 15 例 + test-gpt-sales-workflow 5 / test-gpt-followup 19 / test-gpt-language 1 / test-gpt-knowledge 14 / test-gpt-paragraphs 15 全过。

## 剩余风险

1. 条件加载的漏报：客户用未覆盖语言/措辞问价且工作记忆里没有报价草稿、也没有开放报价任务时，会走"无模块"——模型按说明把缺口写在策略段，老板下一轮加一句指令即可，不会自动编数字；验收案例 5 要看这条兜底文案是否被遵守。
2. 保守方向的代价：报价默认带运费规程，所以活跃报价客户的瘦身收益有限（约 -7k 只在 FOB-only 时出现）；第一阶段体感改善主要落在非报价轮（-13.7k/轮）和偏好继承上。
3. "已发送"判定只能说明"可能已发"；销售手改金额后再发 → 判为未发 → 多加载一次报价规程（保守，无功能损失）。
4. `[Client Record]` 改"仅变化"对线上 R08 skill 的 instructions 可能有措辞冲突（skill 若要求全字段），需在验收案例 1/3 里看实际输出；解析层因头不变不会报错。
5. 去重只对 DOM/DB 文本完全一致的消息生效（DOM 抓取经 stripTrailingMeta 后与 DB 一般一致，若有差异则不去重，安全方向）。
6. 未实机跑任何 GPT（分工约定），以上均为单测 + 类型级验证。

### 诊断纠正（Codex 实机证据，2026-09-18）

Didace（+221）对话里 "we are the manufacturer" **不是模型凭空猜的**：CRM 时间轴有老板原话"你跟他说，我们就是厂家，推荐汽油的……"（9/18 2:19:22，以及 2:03:35 柴油版同句），存在 `sales_instruction`。我之前只 grep 了模板批准知识 / src / skills / docs，漏了本单指令。结论改为：该客户本单身份口径已由老板明确，**不应拿首次回复套件里的 "authorized RELY dealer" 去覆盖，也不需要老板再解释本单**；首条与后续的不一致属于套件措辞与本单指令的差异，是否统一套件措辞由老板决定，不是 prompt 层的问题。

### 对 Codex 侧的审查意见（只读，未改其文件）

1. **`sales-preferences.ts` `loadSalesPreferences` 是全表扫描**：`contact_events` 上 `event_type=eq.ai_extracted` + `payload @> {schema,orgId,userId}`，**没有 `contact_id` 过滤**（personal 作用域跨客户，无法按客户查）。CLAUDE.md 2026-08-21 记过同款坑：contact_events 90 万行、event_type 无索引，直接过滤就是 8 秒 statement timeout。它在每次生成时调用、`loadActionContext` 里 `rememberSalesPreferences` 之后又整份重读一次，后台 runner 也调。**build 前必须用 PostgREST 实测一次耗时**；若超时，方案：customer/order 作用域按 `contact_id` 查，personal 作用域另存（每用户一行的独立表，或 Management API 建 `payload` 上带 `where event_type='ai_extracted'` 的 partial GIN 索引）。
2. `rememberSalesPreferences` 注释说"重复旧指令不复活已撤销的偏好"，代码只在 `previous.active && 同文` 时跳过——已撤销（inactive）同文会被再次存为 active。老板重新明确输入应该算新指令，我倾向代码是对的、注释要改；请二选一定下来。
3. 分类器的"商业事实跳过"正则含 `保险|保修|运费|定金|尾款`，纯措辞偏好如"以后别主动提保修细节"会被整句跳过。低优先级。
4. `loadActionContext` 每次生成读两遍个人记忆（remember 前后各一次）；让 `rememberSalesPreferences` 返回是否有新增、没有就不重读，可省一半查询。
5. 主 prompt 的两处 `followupPrompt(followupContext)` 尚未按上文接线（`includedRenderedMessages`）；核算整理轮与补块修复轮保持完整。
6. `sales-history-identity.ts` 对 José 的三条能正确隔离（"我有个委内瑞拉的客户…电话+58…" 命中显式介绍，thread 内后续两条随之隔离；当前客户被明确介绍时能解除），没发现实质问题。

---

## 补充 · GPT 后台标签"要手动点一下才完成" + 结果丢失（2026-09-18，Claude 负责 gpt-automation / gpt-response-wait / gpt-response-dom）

**机制**：GPT 标签用 `tabs.create({active:false})` 开在后台、从未前台显示。Chrome 对这类标签隐藏约 5 分钟后冻结/强节流页面定时器（ChatGPT 流式渲染和 Stop/Copy 按钮状态停在半路），Memory Saver 还可能丢弃它；而完成判定要求「Stop 消失 + 本轮 Copy 按钮 + 正文 6 秒不变」，全靠页面自己刷 DOM——老板一点标签页面瞬间追平，几秒内"完成"。"输出完成也拿不到"另有两条路：Copy 按钮在写作块/画布布局里不在本轮容器 → 等到 20 分钟超时；SW/消息通道在长等待里死掉，`tabs.remove` 前结果没有任何落地。

**改动**：
- `gpt-automation.ts`：创建后 `tabs.update({autoDiscardable:false})`；停滞检测 → 有限唤醒（`createWakePlanner`：每次运行最多 2 次、间隔 ≥60s）。默认 `wake:'window'`：第一次把标签 `windows.create({tabId, focused:false, 520×420})` 挪进不抢焦点的小窗口（页面变可见、不节流，用户焦点不动）；仍停滞或挪窗失败 → 激活该标签 4 秒后切回原来的活动标签/窗口。`active:true`（前台调试）时不唤醒。"等开始回复"阶段 45s 无迹象先唤醒一次，总等待 90s→150s。
- 结果保留：`finishRun` 先 `beforeClose(result)` 再关标签；交付失败抛 `GptResultUnsavedError`（`.result` 带完整结果与 `tabId`），标签保留。新增 `resumeGptRun({tabId, baseline, url, skill?, ...})`：SW 重启后回到还开着的标签继续等/读，不重发，完成判定同 runGpt（只认 baseline 之后的新 turn，旧回复不会当新结果）。
- `gpt-response-wait.ts`：`waitForCompletedGptResponse` 新增 `stalledAfterMs / onStalled`（正文+生成中+复制按钮三者组合无变化才算停滞，每个停滞窗口回调一次）；原完成语义不变。
- `gpt-response-dom.ts`：完成信号从"本轮 Copy 按钮"放宽到本轮动作条任一按钮（copy / thumbs / good-response / regenerate，含中文 aria）；仍限定在本轮容器内。

**跨文件接口（Codex 接线）**：
```ts
runGpt({ ...原有, onProgress?, beforeClose?, wake?: 'window'|'activate'|'none' }) → { responseText, chatUrl, messageId?, tabId }
onProgress 事件：tab_created{tabId} / sent{tabId,baseline} / woken{tabId,method,attempt,reason} / completed{tabId,chatUrl}
resumeGptRun({ tabId, baseline, url, skill?, responseTimeoutMs?, onProgress?, beforeClose?, wake? })
GptResultUnsavedError.result  // 交付失败时的完整结果
```
建议 SW：① `sent` 事件时把 `{runId, tabId, baseline, url, skillId}` 写 `chrome.storage.session`；② `beforeClose` 里先把结果写 `chrome.storage.session`（或 local）再 resolve；③ SW 启动时若发现未完成的 run 记录且标签还在 → `resumeGptRun`，UI 侧按 runId 轮询/读回结果而不是只靠一次 `sendMessage` 的响应；④ 收到 `GptResultUnsavedError` 时把 `error.result` 直接当成功结果交给 UI，再提示"标签已保留"。

**测试**：`scripts/test-gpt-automation-wake.mjs`（7 例，假 chrome + 注入时钟）：停滞回调每窗口一次 / 持续流式不算停滞 / 唤醒上限与间隔 / 停滞挪窗一次且不抢焦点、先交付再关标签、进度事件 / 交付失败保留标签+错误带结果 / activate 模式激活后切回原标签 / 恢复时旧回复不当新结果。`test-gpt-response-completion` 14 例、`test-observed-browser-defects` 12 例回归通过；tsc 0 错。未 build、未实机。

**剩余风险**：① `windows.create({focused:false})` 在 macOS 上通常不抢焦点，但会在桌面上多出一个小窗口（运行结束随标签关闭）；若老板反感，`wake:'activate'` 是备选。② 冻结是否真是主因只能实机确认——若唤醒后仍要手动点，说明是 ChatGPT 自身在 `document.hidden` 下暂停渲染，那时应把默认改为"发送成功后立刻挪窗"（改一行：`WakeContext` 在 `sent` 后主动 `wake`）。③ 动作条选择器放宽后，若 ChatGPT 在流式中也渲染 thumbs 按钮，仍有 Stop 消失 + 6 秒稳定两道闸，不会拿到半截。
