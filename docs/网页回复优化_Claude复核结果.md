# 网页回复优化 · Claude 定点只读复核结果（2026-09-18）

范围：按《网页回复优化_Claude复核.md》四点，只读当前工作区源码与既有测试；未改业务源码、未操作浏览器、未调用 GPT、未 build。回归复跑：test-gpt-language 14 / test-gpt-followup 21 / test-gpt-response-completion 15 / test-gpt-sales-workflow 5 / test-gpt-workflow-selection 15，全部通过。

## 结论

三个优先点（语言 fullTextRef、跟进去重来源、repair=null）**没有 P0/P1**。找到 **1 个 P2**（群聊续聊时客户备注的悬空引用）和几处 P3 观察。

## P2 · 群聊续聊：备注被替换成"见上文"，但上文没有备注

- 现象：`GPTReplySection.tsx:587` 与 `:743` 无条件传 `includedCustomerNotes: contact.notes`；`gpt-followup.ts:132-135` 只要备注 >240 字且与传入值全等，就把 `customer.notes` 换成 `[Full sales notes in customer context above]`。
- 但主 prompt 的续聊路径在群聊时不渲染客户档案：`gpt-prompt.ts:151`（`buildFollowUpMessage`：`if (opts.contact && !opts.isGroup)`）和 `buildDiscussionMessage` 续聊分支同样跳过 `buildSlimCustomerContext`；群聊首轮 `buildGroupContext` 才带 `[Sales notes about this group]`。
- 结果：群聊 + 备注 >240 字 + 续聊/续聊讨论 → 跟进块里只剩占位，上文也没有原文，模型看不到备注。个人客户不受影响（首轮 `buildIndividualContext`、续聊 `buildSlimCustomerContext` 都含 `Sales notes`）。
- 最小修法（Codex 文件，两处调用点各一行）：`includedCustomerNotes: contact.group_jid && conversation ? null : contact.notes`。或更稳：只在 prompt 构造函数确认渲染了备注时才回传，例如让 `buildFollowUpMessage/buildDiscussionMessage` 返回值附带 `renderedCustomerNotes`，避免两处状态推断。
- 补一条测试：群聊 + 长备注 + 续聊 → 跟进块含完整 notes。

## 语言 fullTextRef（gpt-prompt.ts）· 无缺陷

- 阈值两侧一致：`formatMessage:619` 对 >480 字入站加 `[source "message:<id>"]`；`buildReplyLanguageContext:466-468` 只在 >480 字**且**已在折叠后最近 50 条里（`id` 与 `text` 都全等）时才给 240 字摘录 + `fullTextRef`，否则全文。`collapseMediaRuns` 对非媒体消息原样透传，id/text 不变。
- 最近 50 条之外的长入站保留全文（测试 "never reduced to a dangling reference"）；末尾语言要求在 Chat History 里完整出现一次（测试 "including trailing preference"）；广告/出站/媒体过滤未变（`:440-443`）。
- 剩余风险只在模型行为：摘录 240 字后是否真的去读 `[source …]`。建议验收时挑一条末尾带 "please reply in Spanish" 之类的长消息实机看一次；若不遵守，最小调整是把摘录改成"前 160 字 + … + 末 80 字"，尾部指令直接可见，无需改契约。

## 跟进去重（gpt-followup.ts）· 无缺陷

- 老板指导只在 `contactId`/`scopeId`/`owner:<id>`/原文四项全等时才用 `fullTextRef`（`:124-130`）；引用目标 `[Saved Customer Work].salesHistory` 由 `renderSalesWorkMemory` **全量**输出（`sales-work-memory.ts:120,126`，instructions 不截断），不会悬空。
- 校验、`inputKey/stateKey`、保存都用原始 `ctx.evidence`（`:72-73`、`:164-168`）；从 60 字前缀或上文原文引用的子串都能通过。
- 后台复核 runner（`gpt-followup-runner.ts:42`）与报价整理轮（`GPTReplySection.tsx:507`）都走无参数的完整 `followupPrompt`，符合"独立跟进默认全文"。
- 备注去重要求全文相同（`:132-133`）✓；测试覆盖四种不匹配情形。
- 观察：客户/销售证据缩写会在文本末尾附 `…[full text in Chat History above]`，模型若把这段连标记一起当 quote 会校验失败 → 只是"未确认保存"警告，不丢草稿、不动任务。提示语已要求从全文引用，可不改。

## repair=null（gpt-followup-result.ts + GPTReplySection.tsx）· 无缺陷

- `completeFollowupResult:20-26`：无 `<crm_followup>` 且 `repair===null` → 抛"本轮未返回跟进判断，未追加GPT调用或改动已有任务" → 外层 catch 返回 **完整原文** + `[GPT跟进状态]` 警告，`save` 未被调用，任务不动。`GPTReplySection:522` 传 null，`:648/:797` 把 warning 挂到 done 状态显示。
- 块出现在客户正文/档案区仍抛错（`:14-16`）；块格式坏（有 marker 但解析失败）→ 只保留 marker 之前的正文 + 警告，不 save；合法块正常 `save`（`:27`）。既有测试 "interactive missing metadata returns the finished draft without another call or task write" 覆盖 null 路径与合法路径。
- `[GPT跟进状态]` / `[GPT跟进安排]` 在 `reply-sanitize.ts:41-42` 的头列表里，不会漏进客户正文。
- 观察（可接受）：块格式坏时 marker 之后的策略文字被丢弃，只影响内部策略段。

## 第 4 点 · 规程/记忆/知识头部精简

- `SALES_WORKFLOW_CORE` 改写后仍保留：内部核查（"你确定吗"→ NO_REPLY 本轮内部核查）、简短澄清续接、账本重算规则、一次意向问题、草稿≠发送/保存、一台/多台方案；新增的正面表达（先答购买问题、成熟意向直接推 PI/定金、DG 只是运输处理类别、末尾集中列待核项）与老板要求一致。既有 5 例 workflow 测试通过。
- P3：例句含具体承诺——"The agreed price stays the same. I'll confirm the insurance cover before issuing the PI."。文中已写"examples, not approvals"，但对没有已议定价格/没有保险话题的订单仍有被套用风险。最小修法：把例句改成占位式（"[agreed price] stays the same…"）或加一句 "use only when that fact is true for this order"。
- P3：`renderSalesWorkMemory` 的 `recentFreightLookups` 只保留最后一条（`sales-work-memory.ts:122`）。同一需求先后查过两种箱型/航线（如 Sergio 的 40HQ 与 20GP）时，旧的一条不在 prompt 里；规程要求按"路线/柜型/动力一致"复用运费记录，缺对照时模型会重新研究（保守方向，不产生错价）。可接受，记录以备后续调整为"最近 2 条"。
- 批准知识头部（`gpt-prompt.ts` `appendApprovedKnowledge`）精简后保留了作用域限定、订单特例优先、客户声称≠批准、清空快照语义，无遗漏。
- 未见"客户话变成格式腔"的新诱因；相反 OUTPUT_REMINDER 与 CORE 都把客户正文放在主位。实机 18:42 那两句自我解释属于模型倾向，Codex 新增的"待核项末尾集中、不逐句免责"是对症的；是否奏效只能下次实机看。

## 后台复核 runner（更正：不是待确认项）

- 我第一版把 `service-worker.ts:770-783` 的 `installFollowupSchedule(reviewFollowups)` 列为"需确认意图"，看漏了门控。核实 `gpt-followup-schedule.ts`：`isFollowupReviewEnabled` 要求 `chrome.storage.local` 里 `gptFollowupAutoReviewEnabled === true`（字符串 `'true'` 也不算）；`ensureFollowupAlarm` 未开启时**清掉旧 alarm**；`installFollowupSchedule` 的 startup / alarm / storage 变更三个入口都先查开关再 `review()`。默认 OFF，注册 handler ≠ 开着。专项测试 `test-gpt-followup-schedule.mjs` 覆盖"默认关、清旧 alarm、`'true'` 不算开、无关 alarm 不触发、开启后才跑、关闭后再清"，通过。**撤回该确认项。**

## 汇总

| 级别 | 位置 | 处理 |
|---|---|---|
| P2 | GPTReplySection.tsx:587/743 + gpt-followup.ts:132 | 群聊续聊不传 `includedCustomerNotes`，或由 prompt 构造函数回传"是否已渲染备注" |
| P3 | gpt-sales-workflow.ts 例句 | 例句占位化或加"仅当本单事实成立时使用" |
| P3 | sales-work-memory.ts:122 | 观察；必要时 freight 保留最近 2 条 |
| P3 | gpt-prompt.ts 语言摘录 | 实机验证一次尾部语言指令；不遵守则改"前 160 + 末 80" |

---

## 二次复核（修订核实，2026-09-18）

**P2 群聊续聊备注 · 已修，通过。** `GPTReplySection.tsx:587` 与 `:743` 均改为 `includedCustomerNotes: contact.group_jid && conversation ? null : contact.notes`，与主 prompt 的渲染条件（群聊续聊不渲染客户档案；群聊首轮由 `buildGroupContext` 带备注；个人首轮/续聊都带）一一对应。组件回归 `test-gpt-template-routing-integration.mjs:538` 起用 `synthetic@g.us` + 30 段长备注覆盖群聊续聊；Codex 报告生成/讨论 × 群聊续聊/个人续聊四项通过。

**P3 例句 · 已修，通过。** `gpt-sales-workflow.ts:15` 在两句例句后加 "Use an example only when its facts are true for this order."，`test-gpt-sales-workflow` 5 例通过。

**事实库 provenance 合并（`sales-facts.ts:112-128`）· 通过，一条观察。** 合并键 = `{scope, product_key, source.ref, observed_at, valid_until}` 五项全等才共用一个 `p<n>` 引用；每条 fact 仍单独输出 `id / key / category / statement / value / provenanceRef`，没有汇总或省略；`unavailable` 截到 8 条但保留 `unavailableCount`（原有行为）。`test-sales-facts.mjs:61` 逐条对照原始行的 id/statement/value 与还原后的 source 五字段，通过（13 例）。
观察：0042 迁移要求 `source` 必含 `ref` 和 `quote`，但渲染只带 `source.ref`，老板原话 `quote` 与 `kind` 不进 prompt。模型拿到的是规范化 `statement`，对回复足够；若将来要模型引用老板原文措辞（如保修口径的西语参考句），需要在渲染里按需附 `quote`。不是缺陷，记录即可。

回归复跑：test-gpt-followup-schedule 1（含 6 段断言）/ test-sales-facts 13 / test-gpt-sales-workflow 5，全部通过。未改业务源码、未 build、未操作浏览器。
