## 2026-09-22 拆除 Jev 自动选模型与页面切模型

用户决定整体删除（ChatGPT 菜单切换反复失败）。删掉 src/lib/jev-client.ts、jev-model-routing.ts、crm-model-routing.ts、gpt-model-selection.ts、jev-preview-bridge.ts、popup/JevSettings.tsx、scripts/test-jev-crm.mjs；gpt-automation 不再有 modelRouting/modelSelection/route 切换，只保留 preparing(loading/sending) 进度；gpt-run-delivery、service-worker（JEV_* 消息、GptRunRequest.modelRouting）、GPTReplySection（处理模型下拉、Jev 状态、实际模型展示）同步清理；manifest 去掉 api.typesafe.ai 权限；storage-housekeeping 启动时删 jev.credentials.v1 / gptModelMode。GPT 模板照旧用页面自带模型（Custom GPT 自身设置 / ?model= 参数）。相关 113 项测试通过，typecheck/build 通过，已打包发版（见 dist-zips 最新 zip），required_version 已推。docs/Jev模型自动选择_2026-09-21.md 仅作历史记录。

## 2026-09-22 模型切换失败兜底：「不切换 · 用页面当前模型」+ 真实错误上报

发版 0.1.0-20260922 后用户报「未确认模型切换，尚未发送本轮内容」，手动快速/深入也失败（手动只是跳过 Jev，页面切换核对照跑）。本机 Claude in Chrome 无响应，未能实地看 ChatGPT 菜单。两处改动：(1) selectGptModelInPage 不再抛异常（executeScript 会吞掉注入函数的异常，面板只剩泛化提示），改为返回 {verified:false,error}，错误里带页面实际可见的菜单项/「You are using …」文案，applyGptModel 原样抛出；模型名正则兼容 5.6 这种带点的版本号。(2) 客户卡「处理模型」新增 page 档（不切换，用页面当前模型），选它时 modelRouting 传 undefined、跳过切换与 deep 兜底；选择存 chrome.storage.local gptModelMode。test-jev-crm 新增 1 项、改 2 项，全部通过；已打包发版 dist-zips/sino-gear-crm-v0.1.0-20260922-1221.zip，required_version 已推。待用户装新版后回传新错误文案，再定是菜单文案还是模型名变了。

## 2026-09-22 chrome.storage.local 撞 10 MB 配额（"Resource::kQuotaBytes quota exceeded"）

报错来自扩展本地存储配额，与 Jev API 无关（jev.credentials.v1 只有 167 字节）。解析 Chrome Profile 2 的 LevelDB：401 个 key 共 10.48 MB，其中 aiReplyLog:* 141 条占 9.36 MB（GPT 一条含完整 prompt 60–125 KB），gpt.pendingAction/archivedAction 单条 100–170 KB。原淘汰只按条数（800）永远触发不了，且写完才 evict。改为写前按字节预算淘汰（LOG_BUDGET_BYTES 3 MB，另给其它 key 留 1.5 MB headroom），新增 src/lib/storage-housekeeping.ts 在 service worker 启动时清 7 天前的 gpt.archivedAction 并执行日志预算；不碰 pendingAction/delivery/设置。scripts/test-ai-reply-log.mjs 4 项 + 现有交付/Jev 测试通过，typecheck/build 通过，已打包发版 dist-zips/sino-gear-crm-v0.1.0-20260922.zip，required_version 已推 0.1.0-20260922，全员需换新版。Jev 自动选模型保留，下拉本来就有快速/深入手动档。

## 2026-09-21 CRM 正式接入 Jev 模型选择

客户卡 GPT 回复/讨论新增自动选择、快速（GPT-5.6 Sol / Instant）、深入（GPT-6 Pro / Pro）。后台直接调用 TypeSafe 官方接口，key 只由扩展设置验证并存本机，不再依赖 localhost 试用页。模型列表实际返回 jev-latest/jev-preview 别名，不能用固定推理版本号验证列表。手动优先、报价/运费/过长上下文保留深入档，Jev 异常回退；发送前核验实际模型，失败停止。保留模板/账号/客户会话路由、模型交付恢复、后台复核开关。普通 ChatGPT 与技能入口不纳入本轮自动切换。139项相关测试/build通过，获准测试号快速前台与深入后台续聊均已真实回传。用户已成功保存 key，正式自动模式已取得 Jev 判断并应用 GPT-6 Pro，09:32 成功回传。仅本轮测试产生的事件/任务/映射已清理，客户及相关表核对恢复原快照；见 docs/Jev模型自动选择_2026-09-21.md。不承诺自动模式一定提速，未团队打包发版。

## 2026-09-21 Yang / Menglong 独立 GPT 与浏览器入口

Yang 新私有 Miles V2（g-6ab1300e9b388191a66063f01e306d56）已保存，Menglong 原 Miles V2 保留；CRM 两套 Miles/R08 模板明确标姓名，默认仍为 Menglong。新增本浏览器常用/R08 配置，按组织+CRM用户存 chrome.storage.local，路由、讨论、手动选择及后台复核遵守账号组；缺失入口报错不跨账号兜底，旧会话不删除。本机已构建并原生 Reloaded，Yang 浏览器已通过模板 UI 保存两项 Yang 入口并刷新回读，客户 GPT 下拉实见仅两个 Yang 模板；验收见 docs/Miles双浏览器入口_2026-09-21.md。103项相关离线测试通过。Yang 独立模拟能自然唤回两个月未联系客户，非CRM全链路验收；原GPT两份历史库存附件未复制，新副本明示依赖当前CRM资料。未改团队版本/后台开关。

## 2026-09-21 长期客户主动跟进纠正

用户指出两个月未联系客户仍被劝阻推进。CRM共享销售提示与crm_followup提示现要求结合实际联系间隔重判，旧“到时联系你”不得永久冻结；有需求/关系基础且无当前拒绝、未到约定或人工暂停时，长期唤回通常应给出具体自然的联系稿，不以新优惠/新消息为前提。实际发送才算跟进次数；后台复核次数不等于催过客户。跟进skill同源文件已同步，后台开关不变；43项回归/build通过，本机Reloaded/WA刷新，未改线上GPT本体或对真实客户做生成/发送评测。细节附于docs/任务与GPT回复改进_2026-09-21.md。

## 2026-09-21 任务分类与 GPT 回复交付

任务页/客户卡新增等待与内部复核分组；人工改动的任务不由旧判断隐藏。新 GPT 可声明 send_reply，消息成功同步后按完整正文、时间、消息 ID 与账号/需求/任务状态核对，完成仅靠这条发送即可兑现的任务；旧任务提供发送证据人工核对入口，未批量关闭。历史开放任务标题不再触发完整报价/运费规程，普通跟进少误载 13,710 字符；报价/查运费当前触发与授权保留。NO_REPLY 不可填客户；正文先于辅助保存展示，保存失败保留已计算内容与固定记录 ID，取回不重跑已完成 GPT；填入前再验聊天身份。231 项离线测试及 build 通过，本机 Chrome Reloaded/WA 刷新实见 60 待处理、6 等待、1 待复核。自动完成未以真实客户发送做在线验收；真实速度待后续日志计时。Heavy、后台复核关闭、团队版本保持。详见 docs/任务与GPT回复改进_2026-09-21.md。

## 2026-09-20 Menglong R08 独立GPT与404修复

旧R08链接在Menglong账号实见404。已新建私有Sino Gear R08 Miles（g-6aaff2e20f848191a17b81f6786cdebe），页面作者Menglong Dai，完整K01–K11内置知识及最新首回复/费用规则已保存并模拟验收。其R08专用模板仅替换URL；Miles V2默认、其他模板、Yang原GPT和技能不变。路由增加新GPT ID，旧会话按GPT身份隔离、不删除；79项测试/build通过，本机扩展Reloaded且WA已刷新。上传受限未增加知识附件，不声称真实CRM新生成全链路验收或团队发版。详见docs/Menglong_R08_GPT副本_2026-09-20.md。

## 2026-09-20 Menglong GPT 生成后刷新卡住

实查 Menglong Chrome：Issa 的原 GPT 已完成且存在 `gpt.delivery`，但页面刷新丢失 requestId，只剩 generating 标志，CRM 无法取回。GPTReplySection 现于发送前按组织/客户持久化请求及交付上下文；刷新可手动“取回生成结果”，校验账号/本单/模板，不重复发送原 prompt。原接收端与取回端用 Web Locks 串行交付，完成后清等待；明确失败解锁，异常可保留原记录解除等待，不声称取消远端任务。

本机 extension/dist 已构建并在 Menglong 原生 Chrome 点击 Reload（观察到 Reloaded）、刷新 WhatsApp。旧任务缺少新版恢复元数据：核对原会话内客户 ID 后，通过 DevTools Extension storage 恢复该客户本机草稿（正文保留，机器跟进标签去除），实见英文稿/中文策略和可用生成按钮。旧单未补建 CRM 会话映射、工作记忆、AI 日志或跟进任务；页面明确提示跟进未补建。未重新调用 GPT、未填入或发送客户消息、未全员发版。49 项相关离线测试及构建通过；新版请求刷新取回流程为离线覆盖，不冒充新在线全链路测试。细节见 docs/GPT刷新取回修复_2026-09-20.md。

## 2026-09-20 Menglong Dai 的 R08 首回复与技能入口

Miles V2本体已追加三类起价首回复规则并发布，独立模拟测试通过。Menglong账号原先没有skill，现已导入完整私有R08技能，ID `6aafbaf4f53c8191a8d6ff2bf5d9812a`，显示名`sino gear r08 miles`，配置和成本附件保留。CRM其名下Miles V2、R08专用、R08技能试点三模板已同步首回复，技能试点绑定新ID；两份旧R08知识用9月18日已批准费用/保险覆盖旧冲突条款。三场景Work实测通过，未发送客户消息、未做真实CRM生成链路验收。当前需手动选「R08 技能试点 · Miles」，自动R08识别仍未识别新ID；默认、旧Miles本体及Yang Hu技能副本本轮未改。完整备份和证据在分析导出/Miles与团队技能核查_2026-09-20/已实施与使用说明.md。不要混淆不同ChatGPT账号的技能权限，也不要声称副本自动同步。

## 2026-09-20 销售 skill 与后台复核更新

用户五条用于研究和核查，不作为通用清单写进skill。正式review/follow-up/R08及CRM共享提示采纳采购背景、决定点、真实合作价值、信息节奏；正常报价不以背景问卷为前提。R08线上私人同ID已保存并完整回读；报价授权保持，重复运费规程合并。普通模式固定六类画像及多段心理分析已移除。

用户再次反映未点生成时GPT自行启动。本机任务页现已确认后台复核关闭，不据此断言历史原因。runner增加真正调用前的实时开关与占用检查，关闭中途不新启动，任务保留。相关回归/build通过，extension/dist已更新；原生Chrome窗口控制不可用，本轮未成功重载，不能声称代码已实机生效。未全员发布。细节见docs/R08技能迁移试点.md及分析导出/技能复盘_2026-09-20/已实施与验证.md。

## 项目背景

### 2026-09-18 AI 回复第一阶段：桌面 Claude 与 Codex 协作

老板随后要求关闭频繁的“GPT 正在处理上一个客户”占用：后台跟进复核原来无条件每分钟唤醒，现在默认关闭，清理旧alarm；任务页“本机后台 GPT 跟进复核”可显式开启。新设置`gptFollowupAutoReviewEnabled`仅严格true启用，startup/onInstalled/旧alarm均遵守开关；手动生成、已有任务与必要串行保护保留。关闭不再启动新复核，已经发送到ChatGPT的请求不宣称被远端取消。20项调度/跟进测试通过。不得恢复为无条件后台调用。

按文件分工完成并互审：报价/运费规程条件加载，保留原7天有效性规则；三段输出保留而Client Record改为增量，No change不覆盖档案；跟进证据只在同角色同文时去重。公共提示加入自信自然、成熟意向直接推进PI/定金的销售表达。

新增`sales-preferences.ts`个人/客户/订单偏好，清晰表达习惯从当前销售指令确定性提取，保留原话，支持撤销/恢复/改范围，不自动把价格/临时命令长期化。独立`contact_events` schema；0041偏好查询部分索引已在线应用，JSON文本等值谓词走owner索引，不能改回无索引全表JSON包含扫描。José另一个客户的3条历史指导读取时隔离，原文可查看且未删除；Didace manufacturer由老板原话授权，不应误判成模型编造。

186项相关测试及构建通过。原生Chrome已确认加载本项目dist并Reloaded、刷新WhatsApp；José隔离提示及测试联系人偏好实际显示。测试在线生成遇到已有GPT任务占用，未打断，不能声称新线上回复全链路验收通过。日志增加真实请求次数及输入输出字符，不冒充token或成交指标。未向客户发送，未package/改required_version/全员发版；保留原wa-cloud-webhook未提交改动。完整细节与限制见`docs/AI回复改进_协作与验收.md`。

### 2026-09-18 Miles V2 混动误拦截与单轮报价

实读Carlos的Miles V2对话6aaa5aa2-1578-83ea-96fb-b9cd77881a44：老板已补充“就是dg”，模型输入保留phev、运费11000含DG、地面已含，仍被计算器无条件PHEV拒绝；自动输入纠正再次调用GPT且变更标签/来源，最终客户稿仍为空。正常报价原来也强制“先空稿提取、再组织正文”，形成固定两轮。

改为完整稿/中文译文/报价输入/跟进判断同次生成；用公开USD金额占位符，由本地计算后立即替换，保留输入版本与费用校验。旧空稿及无效草稿仍允许补全，跟进元数据缺失仍可触发纠正，不能承诺任何情况都只调用一次。PHEV本单DG已确认且费用已含、地面已覆盖时正常算，保持phev，绝不重复加BEV费用；缺真实必要条件仍阻止。老板短句补充缺项延续原报价要求，不自动当作NO_REPLY。

验证：121项相关离线检查通过，包含生成/讨论两入口仅1个GPT_RUN、实际报价版本保存、118400计算、多方案金额映射、无效内部字段及未替换占位符不可对客。TypeScript/Vite构建通过。独立线上Miles V2测试 https://chatgpt.com/g/g-6a2f7081d85c8191babfad41e1131be6-sino-gear-miles-v2/c/6aad2b5b-7b84-83ea-91a4-c15e331c8287 单次输出完整西语稿/中文译文和合法quote_input。该测试是简化报价协议及获批测试数据，不是原Carlos全历史或CRM端到端新生成；未重新核验实际运价，未向客户发送或保存客户数据。没有修改GPT Heavy设置。

本机构建已更新extension/dist；原生Chrome控制停在扩展页菜单，Cancel/键盘等操作不改变状态且截图不可用，浏览器API无法接管chrome://。已请老板手动重载并刷新，尚未确认加载本次修复。此次未更新团队required_version、未全员发布、未改线上GPT本体/私人技能；公共CRM提示会在加载新版后的请求注入。

### 2026-09-18 CIF默认费用授权

老板确认：此前油车CNY2000/台、电车CNY3000/台就是所讨论港杂/装箱地面及附加费的合并预算，不要缺逐项承运报价就停报或再叠加同范围费用。保险问清后的最终答复是“总运费x1.1”：CIF参考总额＝批准FOB车辆总额＋去重总运输费用×1.1，10%为保险预算，不另加最初提及的CNY1000，不乘车辆价值。总运输费用含海运、适用BEV DG及未含在FOB/供应商价格中的附加费预算，换汇需来源。目的港税费清关未包；未来本单明确特批优先。

规则已同步本地freight/quote/R08技能与线上私人R08技能，线上重新加载全文12358字符核对一致。extension/src/lib/quote-calculation.ts支持insurance={basis:'freight_10_percent',source}，同时保留本单固定保险覆盖和旧版未含保险输入；新CIF提示默认选择公式。51项相关测试/构建通过，扩展已重载、WA已reload；未全员发布，未向真实客户生成或发送新报价。详见docs/R08技能迁移试点.md。

### 2026-09-17老板后续收敛范围：GPT判断跟进

老板确认Claude可以删除，Gemini的共同记忆/跟进功能以后上线，当前以GPT日常使用为主。GPT判断是否跟进、跟进内容及何时复核；客户约定与老板改期优先，没有指定日期也可作有业务依据的AI复核安排，不机械套固定天数。到期先重读最新聊天再决定动作；计划不等于已发消息，本指令未授权自动发送WhatsApp。

Claude回复入口、后台调用和claude.ai主机权限已移除，旧claude模式偏好迁到GPT；GPT依赖的ClientRecordCard已独立提取，保留共享解析器及历史数据。GPT跟进现已接入生成/讨论、现有任务/日历及Chrome到期复核，96项相关回归和构建通过；已自行重载本机extension/dist。真实测试号完成历史场景回放→唯一任务保存→刷新保留→到期GPT复核→原任务停止。人工改期后两次保存仍保留人工状态。11条测试事件和1个测试任务已按ID清理，原25事件/会话保留。详见docs/GPT跟进实现与验收.md。仅当前登录用户已建立的GPT任务参与后台复核，依赖Chrome运行和已同步消息，不自动发送WhatsApp；Gemini仍未接入。老板随后明确要求发布，正式安装包与服务器 required_version 已核验为 0.1.0-20260917；发布前扩展回归 135 项通过。

### 2026-09-17销售工作入口要求

老板最终确认：仅在客户询价或本轮指令需要运费时检查，同条件实际查价未满7天且未过来源截止日可复用，到期再自行重查；复用不重置原查价日期，失败不延长旧价。没有后台定时查价，误建的automation id=7保持PAUSED。默认上海出运，本单明确其他港口则覆盖；纯电集装箱DG附加费按USD 1000/柜估算，供应商报价已含DG则不重加，不按车辆台数重复收费，不套给滚装或燃油。操作规范见skills/sino-gear-freight/references/refresh.md；不发客户消息、不改已发报价。

查运费通过现有对话/销售指令直接执行：从聊天、本单记忆和车型资料提取条件，不新增运费填写页面，不让老板提供固定货代才能继续。自行搜索3–5家公开来源，统一航线/运输方式/柜型数量/币种/费用范围后取最高可比价作保守估算，记录来源日期；过期和错港价排除。港杂/地面油车2000、电车3000人民币/台是同一费用项，已含不重加。未知保险和当地税费不按零，不把估算叫完整CIF。研究记录与老板批准、实际发送分开保存。

Sino Gear CRM 在 `/Users/david/Sino Gear CRM/`，一家中国汽车出口公司的 CRM。**用户是销售经理**，每天 50-100 个 WhatsApp 客户，需要在 WhatsApp Web 旁同时管理客户资料、车辆兴趣、任务、AI 销售助手。

## 架构

```
Chrome 扩展（Manifest V3, Vite + React + TypeScript）
  ├── 注入 web.whatsapp.com
  ├── 顶部 6 tab：看板 / 聊天 / 客户 / 车源 / 任务 / 标签
  ├── 聊天 tab：左 FilterSidebar + 中筛选结果 + 右当前客户卡
  ├── 其他 tab：全屏覆盖 WhatsApp Web，列表 / 详情 / 模态
  ├── Content script 读 WhatsApp Web DOM + IndexedDB（chats / labels）
  └── chrome.tabs + chrome.scripting 自动化 Gemini Gem（已完成）

Supabase（托管 Postgres + Auth）
  ├── 多租户：organizations + organization_members + RLS
  ├── 表：contacts / contact_tags / vehicle_interests / vehicles
  │       vehicle_tags / vehicle_media / tasks / quotes / messages
  │       contact_events / contact_handlers / gem_templates / gem_conversations
  ├── chrome.storage 持久化 session
  ├── pg_cron 心跳防免费层 7 日自动暂停（0012_keepalive）
  ├── 团队多用户视图：contact_handlers 主理人表 + 撞单检测（0014）
  └── Google 联系人同步（chrome.identity OAuth + People API）

外部服务
  ├── AI 字段抽取（OpenAI 兼容 API，可换）— 智谱 GLM
  │   ├── 当前：glm-4-flash（智谱 BigModel 免费档，稳定不限频）
  │   ├── 端点 + 模型从 .env 配置（VITE_AI_BASE_URL / VITE_AI_MODEL）
  │   ├── 历史：2026-05 之前用阿里云 Qwen，跑光免费额度切到 GLM
  │   └── 备选：DeepSeek / Kimi / 千问 / 其他 OpenAI 兼容端点，改 .env 即可
  ├── 翻译：Google Translate gtx（免费、无 key、无配额）
  │   ├── translate.googleapis.com — Chrome 自带翻译同 endpoint
  │   └── 失败 fallback 到 GLM
  ├── Gemini Gem AI 回复：网页端自动化（非 API，免费）
  │   ├── chrome.tabs 后台打开 gemini.google.com Gem URL
  │   ├── chrome.scripting 注入脚本切换 Pro 模型 + 填 prompt + 读响应
  │   └── 用户在 Gem Builder 自建 Gem，URL 存进 gem_templates 表
  ├── Cloudinary 媒体存储（unsigned upload preset，无后端签名）
  │   ├── 车源图片 / 视频 / 配置表（PDF/Excel/Word）全走它
  │   ├── 聊天暂存 → 分配车型时上传，URL + public_id 写 vehicle_media
  │   └── WA Web CSP 屏蔽 res.cloudinary.com，CloudinaryImg 用 fetch + blob URL 绕过
  └── Google People API — 联系人双向同步
```

**关键决策：** 销售经理不想维护服务器；Supabase 免费额度够用；WhatsApp Web 直接做聊天界面；多销售可共享一个 org 的客户数据。AI 字段抽取用智谱 GLM（国内稳定 + 免费档不限频，2026-05 从 Qwen 切过来因为千问免费额度跑光）；翻译用 Google Translate gtx（免费 + 无配额 + 比 LLM 快）；AI 回复用 Gemini Gem 网页端自动化（用户偏好 Gem，免费 + 上下文持久）。

## 目录结构

```
/Users/david/Sino Gear CRM/
├── extension/                          ← 新代码全在这里
│   ├── manifest.json                   MV3 + key（固定 ID）+ oauth2
│   ├── vite.config.ts                  @crxjs + react + @ 别名
│   ├── tsconfig.json
│   ├── package.json
│   ├── README.md                       Supabase + Google + GLM 配置步骤
│   ├── .env                            Supabase URL/key + Google + GLM（不入 git）
│   ├── public/icons/                   占位绿色图标
│   ├── src/
│   │   ├── background/
│   │   │   └── service-worker.ts       PING + GET/CLEAR_GOOGLE_TOKEN +
│   │   │                               EXTRACT_FIELDS / EXTRACT_TAGS /
│   │   │                               EXTRACT_TASKS / TRANSLATE_TEXT (Google → GLM fallback) +
│   │   │                               GEM_RUN / GEM_BUSY (Gem 自动化) +
│   │   │                               BULK_CAPTURE_ARM/DISARM (拦 chrome.downloads
│   │   │                               转发回 content 给 chat-media-capture)
│   │   ├── content/
│   │   │   ├── main.tsx                Content script 入口，挂 AppShell + initChatMediaCapture
│   │   │   ├── whatsapp-dom.ts         testid + span[title] + 多重 fallback
│   │   │   ├── whatsapp-messages.ts    读当前聊天 + waitForChatMessages 轮询
│   │   │   ├── whatsapp-compose.ts     把文本 paste 入聊天输入框（Gem reply 一键填入）+
│   │   │   │                            pasteFilesToWhatsApp（车源媒体一键发图/视频/PDF）
│   │   │   ├── auto-translate.ts       消息气泡自动翻译：观察器 + 顺序队列
│   │   │   │                            + 每条消息悬停 🌐 手动按钮 (200ms 间隔)
│   │   │   └── chat-media-capture.ts   Phase C 媒体捕获（1085 行）：
│   │   │                                单图/视频/相册 hover 📥 + lightbox 浮动按钮 +
│   │   │                                多选 toolbar "📥 加入车源"（含 PDF/Excel/Word）+
│   │   │                                走 WA 自带"下载"按钮，SW 拦截转发回来 fetch blob
│   │   ├── popup/                      扩展弹窗（登录 + 打开 WhatsApp）
│   │   ├── panel/
│   │   │   ├── AppShell.tsx            顶层组件，路由 6 个 tab + body class 切换
│   │   │   ├── styles.css              所有面板样式
│   │   │   ├── contexts/
│   │   │   │   └── ScopeContext.tsx    "只看我的 / 全部"视图 + handlers/members
│   │   │   │                            maps + 30s 轮询 + 一次性孤儿认领
│   │   │   ├── components/
│   │   │   │   ├── TopNav.tsx          顶部 6 tab + 翻译开关 + 重译按钮 +
│   │   │   │   │                       🤖 Gem 模板 + 👥 团队成员 + ScopePicker
│   │   │   │   ├── ScopePicker.tsx     "👤 只看我的 / 🏢 全部"下拉 + 数量徽标
│   │   │   │   ├── LoginForm.tsx       注册/登录
│   │   │   │   ├── OrgSetup.tsx        首次创建团队
│   │   │   │   ├── TeamMembersModal.tsx 成员列表 + 邀请 / 改角色 / 移除
│   │   │   │   ├── ContactEditForm.tsx 客户编辑表单（聊天卡 + drawer 共用）
│   │   │   │   │                       姓名/国家/语言/预算/目的港/质量/阶段/备注
│   │   │   │   ├── ContactCard.tsx     聊天 tab 右侧 tab 容器：客户资料 / AI 回复 / 历史消息
│   │   │   │   ├── ContactDetailDrawer.tsx  客户 tab drawer：同样三 tab
│   │   │   │   ├── TagsSection.tsx     标签 CRUD + 🤖 AI 建议
│   │   │   │   ├── VehicleInterestsSection.tsx  车型兴趣
│   │   │   │   ├── QuotesSection.tsx   报价历史 (车型 datalist 联动)
│   │   │   │   ├── ContactTasksSection.tsx      任务 + 🤖 AI 建议
│   │   │   │   ├── TimelineSection.tsx 客户事件时间线（图标 + 相对时间）
│   │   │   │   ├── MessagesHistorySection.tsx  聊天历史入口 +
│   │   │   │   │                                  useMessageSync 自动 upsert 当前可见消息
│   │   │   │   ├── MessagesHistoryModal.tsx    分页加载 messages 表（最近 500 条）
│   │   │   │   ├── ImportChatModal.tsx 客户 tab 顶部「📥 导入手机聊天」：
│   │   │   │   │                       选 .txt → 预览发件人/条数 → 写 messages 表（幂等）
│   │   │   │   ├── AIReplyTab.tsx      AI 回复 tab：顶部 dropdown 切换"翻译"/"Gem"
│   │   │   │   │                       + 上方常驻 VehicleRecommendations
│   │   │   │   ├── TranslateReplyPanel.tsx  直翻模式：中文 → 客户语言 → 一键填入
│   │   │   │   ├── GemReplySection.tsx Gem AI 回复：模板选择 + 前后台开关 +
│   │   │   │   │                       reply/translation/clientRecord 三段卡 +
│   │   │   │   │                       💬 填入聊天框 + "应用 N 项到客户资料" + 续聊输入框 +
│   │   │   │   │                       常驻指令 textarea（按 contact 持久化到 chrome.storage）
│   │   │   │   ├── GemTemplatesModal.tsx Gem 模板 CRUD（org 共享，is_default 标记）
│   │   │   │   ├── VehicleRecommendations.tsx  AI 回复 tab 顶部"相关车源"（527 行）：
│   │   │   │   │                                按 vehicle_interests 推荐 + 拼图册 +
│   │   │   │   │                                "💬 一键发图/视频/PDF 到 WhatsApp"
│   │   │   │   ├── VehicleModal.tsx    车源创建/编辑（含 pricing_tiers 阶梯价 + media manager）
│   │   │   │   ├── VehicleMediaManager.tsx     图片/视频/配置表 三 section 上传 (Cloudinary)
│   │   │   │   ├── CloudinaryImg.tsx   绕过 WA CSP：fetch → blob URL → <img>
│   │   │   │   ├── MediaStagingTray.tsx        屏幕右下浮动暂存盘（Portal）：
│   │   │   │   │                                显示已捕获媒体 + "📤 保存到车型" 按钮
│   │   │   │   ├── AssignMediaToVehicleModal.tsx 暂存 → 选车型/新建车型 → 上传 Cloudinary +
│   │   │   │   │                                 写 vehicle_media（仅当前 tab 内有效）
│   │   │   │   ├── TaskModal.tsx       任务创建/编辑
│   │   │   │   ├── GoogleSyncDialog.tsx  Google 联系人同步对话框
│   │   │   │   ├── FilterSidebar.tsx   左侧多维筛选编排（451 行，主件）
│   │   │   │   ├── FilterPrimitives.tsx   共享 CollapsibleSection / Chip
│   │   │   │   ├── FilterMaintenancePanel.tsx  sync/extract/cleanup/repair 工具栏
│   │   │   │   ├── FilterTodoList.tsx     今日待办 5 buckets
│   │   │   │   └── FilteredChatList.tsx   筛选结果列表
│   │   │   ├── pages/
│   │   │   │   ├── DashboardPage.tsx   看板 tab：周/月切换 + 6 KPI 卡 +
│   │   │   │   │                       阶段漏斗 + 热门车型 Top 5
│   │   │   │   ├── ChatPage.tsx        聊天 tab：FilterSidebar + 结果 + 右卡
│   │   │   │   ├── ContactsPage.tsx    客户 tab：列表 + 💬 跳转 WhatsApp 按钮
│   │   │   │   ├── VehiclesPage.tsx    车源 tab：卡片网格 + 筛选 + 模态
│   │   │   │   ├── TasksPage.tsx       任务 tab：KPI 4 卡 + 日历常驻（每天写
│   │   │   │   │                       客户名）+ 选中日详情列表
│   │   │   │   └── TagsPage.tsx        标签 tab：列表 + 改名/合并/删除（内联确认）
│   │   │   └── hooks/
│   │   │       ├── useAuth.ts          Supabase auth 状态
│   │   │       ├── useOrg.ts           当前用户的 org
│   │   │       ├── useCurrentChat.ts   监听 WhatsApp Web 当前聊天 + 初始读
│   │   │       ├── useContact.ts       按手机号查/建客户（写 created/stage_changed 事件）
│   │   │       ├── useCrmData.ts       中心 CRM 数据 + WhatsApp IDB 合并 +
│   │   │       │                       20s 轮询 + fire-and-forget syncAutoStages
│   │   │       ├── useAutoExtract.ts   自动 AI 字段抽取 + 写 ai_extracted/vehicle_added 事件
│   │   │       ├── useMessageSync.ts   按 contactId 自动 sync 当前可见消息 → messages 表 +
│   │   │       │                       顺便 bumpHandler（登记当前用户为该客户主理人）
│   │   │       └── useOrgMembers.ts    list_org_members RPC + email→shortName 工具
│   │   └── lib/
│   │       ├── supabase.ts             Supabase client（chrome.storage 适配器）
│   │       ├── contact-handlers.ts     主理人表读写：fetchHandlersForOrg / buildHandlerMaps
│   │       │                           / batchBumpHandlers / bumpHandler / getOtherHandlers
│   │       ├── database.types.ts       完整数据库类型（含 quotes/contact_events/
│   │       │                            messages/vehicle_media/PricingTier）
│   │       ├── errors.ts               错误格式化（"扩展刚更新，请刷新" 友好提示）
│   │       ├── google-people.ts        Google People API 客户端
│   │       ├── whatsapp-idb.ts         读 WhatsApp Web IndexedDB（chats/labels/contacts）
│   │       ├── chat-classifier.ts      聊天自动分类（new / active / stalled / lost）
│   │       ├── stage-sync.ts           autoStage 写回 contacts.customer_stage
│   │       │                           (active→negotiating; sticky: quoted/won)
│   │       ├── events-log.ts           logContactEvent fire-and-forget 写时间轴
│   │       ├── filters.ts              筛选逻辑 + brandOf + 序列化（持久化）
│   │       ├── regions.ts              国家 → 13 大区映射
│   │       ├── phone-countries.ts      手机号区号 → 国家（150+ 国家）
│   │       ├── field-suggestions.ts    AI prompt + 校验（fields/vehicles/tags/tasks 4 类）
│   │       ├── bulk-extract.ts         批量 AI 抽取 + 限频 + 跳转失败兜底
│   │       ├── bulk-sync.ts            批量同步 WhatsApp 聊天到 CRM
│   │       ├── label-sync.ts           WhatsApp 标签 → quality/stage/country/vehicle/tag
│   │       ├── jump-to-chat.ts         搜索框 + Enter 键跳转
│   │       ├── vehicle-aliases.ts      车型规范化（剥噪音 + 60+ 规则）
│   │       ├── vehicle-cleanup.ts      重命名 + 去重 + 删噪音
│   │       ├── brand-overrides.ts      用户右键改品牌分组（chrome.storage）
│   │       ├── gem-prompt.ts           Gem prompt 格式化（formatNewCustomer/Update/Guidance）
│   │       │                            含 collapseMediaRuns（连续附件 → 1 行 summary）
│   │       ├── gem-automation.ts       Gem 网页端自动化（chrome.tabs + executeScript
│   │       │                            + 模型选择 + 等响应停止生成按钮 + busy 串行）
│   │       ├── gem-parser.ts           解析 Gem 响应：[Client Record] / [WhatsApp Reply] /
│   │       │                            [Translation]，无标签时按 CJK 比例 fallback 拆分
│   │       ├── cloudinary.ts           unsigned upload preset 直传 + thumbnailUrl 缩略
│   │       ├── media-tray-store.ts     聊天媒体捕获暂存（内存 Map + subscribe，不持久化）
│   │       ├── message-sync.ts         syncMessages upsert + countMessages +
│   │       │                            loadMessages（DESC + reverse 取最近 N 条）
│   │       ├── import-chat-parser.ts   解析手机端 WhatsApp 导出 .txt：
│   │       │                            双时间格式 + 多行延续 + 系统行过滤 +
│   │       │                            自动识别 me/customer + phoneFromFilename
│   │       ├── chat-import.ts          ParsedChat → upsert messages 表：
│   │       │                            wa_message_id='import:<sha16>' 幂等 + 自动建 contact
│   │       └── repair-extraction.ts    扫描国家 / 区号不匹配的客户 + 重置字段 + 删错抽车型
│   └── supabase/migrations/
│       ├── 0001_init.sql               表 + RLS 策略
│       ├── 0002_create_org_rpc.sql     create_organization RPC
│       ├── 0003_vehicles.sql           vehicles + vehicle_tags + 枚举
│       ├── 0004_google_sync.sql        contacts.google_resource_name
│       ├── 0005_stage_stalled_and_filters.sql
│       │                                + stalled 阶段 + quality + reminder
│       │                                + vehicle_interests.target_price_usd
│       ├── 0006_quotes.sql             quotes 表（draft/sent/accepted/rejected）
│       ├── 0007_contact_events.sql     contact_events 时间轴（append-only）
│       ├── 0008_gem_templates_and_conversations.sql
│       │                                gem_templates（org Gem URL 库）+
│       │                                gem_conversations（contact+template → chat URL）
│       ├── 0009_backfill_contact_events.sql
│       │                                给历史 contacts 补 'created' 事件（幂等）
│       ├── 0010_org_member_management.sql
│       │                                invite/list/remove/update_role RPC
│       ├── 0011_messages.sql            messages 表（contact+wa_message_id 唯一）
│       │                                + 'inbound'/'outbound' 方向枚举
│       ├── 0012_keepalive.sql           pg_cron 每日心跳（防 Supabase 免费层
│       │                                7 日无活动自动暂停，跟 SW 无关）
│       ├── 0013_vehicle_media_and_pricing.sql
│       │                                vehicle_media (img/video/spec) + 定价扩展
│       ├── 0014_handlers_and_per_user_gem.sql
│       │                                contact_handlers (per-user 主理人) +
│       │                                gem_templates RLS 改 created_by=auth.uid()
│       ├── 0015_cascade_handlers_on_member_removal.sql
│       │                                org 成员被移除时，trigger 级联清掉他在该 org
│       │                                所有 contact 上的 handler 行（防孤儿撞单）
│       ├── 0016_groups.sql              支持 WA 群聊作为 contact：加 group_jid 列 +
│       │                                partial unique 索引 + check 约束 +
│       │                                放宽 phone NOT NULL
│       ├── 0017_app_config.sql          app_config(key,value) + required_version
│       │                                公开可读、写入 service_role only（强制版本闸门）
│       ├── 0018_fix_group_jid_unique.sql 0016 的 partial unique INDEX 换成普通
│       │                                UNIQUE CONSTRAINT（避免 onConflict 报 42P10）
│       ├── 0019_last_message_direction.sql last_message_direction_per_contact RPC
│       │                                给每个 contact 算最后入站/出站消息时间
│       ├── 0020_claude_conversations.sql claude_conversations(contact_id, chat_url)
│       │                                Codex.ai per-contact chat URL 缓存（无 template）
│       ├── 0021_contact_pins.sql        contact_pins (contact_id, user_id) per-user 置顶
│       ├── 0022_message_counts_for_classifier.sql 0019 RPC 扩展回 inbound_count/
│       │                                outbound_count（chat-classifier 有历史保护用）
│       ├── 0023_gpt_conversations.sql   gpt_conversations(contact_id, chat_url)
│       │                                ChatGPT per-contact chat URL 缓存（无 template）
│       ├── 0024_message_ai_source.sql   messages 加 ai_source 列：Codex/gem/gem_auto/gpt
│       │                                标记出站消息的 AI 归因来源（NULL = manual）
│       ├── 0025_enable_realtime.sql     启用 contacts/vehicle_interests/contact_tags/
│       │                                contact_handlers Realtime；REPLICA IDENTITY FULL
│       │                                让 DELETE/UPDATE payload.old 含完整旧行
│       ├── 0026_gpt_templates.sql       gpt_templates（per-user Custom GPT 模板，对齐
│       │                                gem_templates）+ 重建 gpt_conversations 改 PK 为
│       │                                (contact_id, template_id)；per-user RLS
│       ├── 0027_contacts_org_id_id_idx.sql contacts (org_id, id) 复合索引：分页 range
│       │                                scan 免 sort（国内访问新加坡每页 7s → ~100ms）
│       ├── 0028_vehicle_media_file_name.sql vehicle_media 加 file_name 列（保留原文件名，
│       │                                发 WA 时显示更专业；老数据 NULL 回退 brand_model）
│       ├── 0029_fb_integration.sql      contacts 加 fb_lead_id/ctwa_clid/fb_ad_id（Meta
│       │                                CAPI 归因）+ org+fb_lead_id UNIQUE + 事件类型
│       │                                fb_conversion_sent
│       ├── 0030_fb_lead_received_event.sql contact_event_type 加 fb_lead_received
│       │                                （fb-lead-webhook 收到 Lead 表单时写时间轴）
│       └── 0031_weekly_reports.sql      weekly_reports(org_id, period, week_of, summary
│                                        jsonb, html) 周报/月报；service_role 写 + org
│                                        成员 RLS 只读；前端「📊周报」tab 读 period=snapshot
└── （仅此一个目录；旧 backend/ frontend/ docs/ 已删）
```

## Supabase Schema

```
organizations           id, name, created_at
organization_members    org_id, user_id, role(owner/admin/member)
contacts                id, org_id, phone (unique per org), wa_name, name,
                        country, language, budget_usd,
                        customer_stage(new/qualifying/negotiating/stalled/
                                       quoted/won/lost),
                        quality(big/potential/normal/spam),
                        reminder_ack_at, reminder_disabled,
                        destination_port, notes,
                        google_resource_name, google_synced_at,
                        fb_lead_id, ctwa_clid, fb_ad_id,
                        created_by, *_at
contact_tags            contact_id, tag
vehicle_interests       id, contact_id, model, year, condition, steering,
                        target_price_usd, notes
vehicles                id, org_id, brand, model, year, version,
                        vehicle_condition, fuel_type(gas/diesel/hybrid/ev),
                        steering, base_price, currency, logistics_cost,
                        sale_status(available/paused/expired), short_spec,
                        pricing_tiers jsonb([{label, price_usd}]), *_at
vehicle_tags            vehicle_id, tag
vehicle_media           id, vehicle_id, media_type(image/video/spec),
                        url, public_id, caption, mime_type, file_size_bytes,
                        file_name, sort_order, created_by, created_at
tasks                   id, org_id, contact_id, title, due_at,
                        status(open/done/cancelled), created_by, created_at
quotes                  id, contact_id, vehicle_model, price_usd,
                        sent_at, status(draft/sent/accepted/rejected),
                        notes, created_at, updated_at
contact_events          id, contact_id, event_type, payload jsonb, created_at
                        event_type: created/stage_changed/tag_added/
                                    vehicle_added/quote_created/
                                    task_created/ai_extracted
contact_handlers        contact_id, user_id, last_seen_at
                        PRIMARY KEY (contact_id, user_id)
                        创建客户时 trigger 自动注册创建者；进入聊天 useMessageSync
                        心跳 upsert；同 contact 出现 2+ user_id → 撞单
gem_templates           id, org_id, name, gem_url, description, is_default,
                        created_by, *_at
                        ⚠️ 0014 起 RLS 改 per-user：只能读写 created_by=auth.uid()
                           的模板；is_default 含义从 "org 默认" 变为 "我的默认"
gem_conversations       id, contact_id, template_id, gem_chat_url,
                        last_used_at, created_at
                        UNIQUE(contact_id, template_id)
claude_conversations    contact_id (PK), chat_url, last_used_at, created_at
                        Codex.ai per-contact chat URL（单一 Miles persona，无 template）
gpt_templates           id, org_id, name, gpt_url, description, is_default,
                        created_by, *_at
                        per-user RLS（同 gem_templates）：只读写 created_by=auth.uid()
gpt_conversations       id, contact_id, template_id, chat_url,
                        last_used_at, created_at
                        UNIQUE(contact_id, template_id)
                        0026 起改 per-(contact, template)，对齐 gem_conversations
messages                id, contact_id, wa_message_id, direction(inbound/outbound),
                        text, sent_at, synced_at, ai_source
                        UNIQUE(contact_id, wa_message_id)
                        ai_source: Codex/gem/gem_auto/gpt（出站消息 AI 归因，NULL=manual）
contact_pins            contact_id, user_id (PK 复合) — per-user 置顶客户
weekly_reports          id, org_id, period(week/month/snapshot), week_of,
                        summary jsonb, html, created_at
                        UNIQUE(org_id, period, week_of)
                        service_role 写（绕 RLS）；org 成员 RLS 只读；
                        前端「📊周报」tab 读 period='snapshot' 那行
app_config              key (PK), value — required_version 公开可读，写入 service_role only
_keepalive              singleton (id=1, last_ping) — pg_cron 每日心跳
                        防 Supabase 免费层 7 日无活动自动暂停
```

**RLS：** 所有表的 SELECT/INSERT/UPDATE/DELETE 都要求 `auth.uid()` 是 `org_id` 成员（通过 `is_org_member(org_id)` SECURITY DEFINER 函数）。
- quotes / contact_events / gem_conversations / claude_conversations / gpt_conversations / messages / contact_handlers 通过 contact 反查 org_id（无 org_id 列）
- vehicle_media 通过 vehicle 反查 org_id
- contact_events 只有 SELECT/INSERT policy（append-only）
- contact_handlers：读取要求同 org，写入只能 user_id=auth.uid()
- gem_templates / gpt_templates：per-user，只能 created_by=auth.uid()（gem 0014 起，gpt 0026 起）
- weekly_reports：service_role 写入（绕 RLS），org 成员只读自己 org 的报告
- _keepalive 全部 deny，仅 pg_cron 内部 postgres role 可写

**Helpers：**
- `create_organization(name)` RPC — 原子建 org + 把 caller 加 owner
- `is_org_member(org_id)` — RLS 用
- `touch_updated_at()` trigger — contacts/vehicles/quotes/gem_templates 自动更新 updated_at

**所有 31 个 migration（0001–0031）都已应用到生产 Supabase。**

## 启动

```bash
# Supabase 项目地址（singapore region）
#   URL: https://hgkjmmvotpakcetcwpoy.supabase.co
#   key 在 extension/.env

cd extension

# 开发模式（HMR）
npm run dev

# 生产构建
npm run build
# chrome://extensions/ → 加载 extension/dist 文件夹
# 改了代码后 → 点扩展卡片上的 ↻ 重新加载 → web.whatsapp.com 刷新

# 给团队打 zip（dist-zips/sino-gear-crm-vX.Y.Z-YYYYMMDD.zip）
npm run package
```

**扩展 ID 已用 manifest.json 的 key 字段固定为 `mjleiklkaailpmmclejegahkfnjhjkpj`**——这样 Google OAuth 配置不用每次重装扩展都改。

**.env 需要的变量：**
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — 必填
- `VITE_GOOGLE_CLIENT_ID` — Google 联系人同步用
- `VITE_DASHSCOPE_API_KEY` — AI key（变量名仍叫 DASHSCOPE 是历史遗留；当前装的是智谱 GLM 的 key，去 https://bigmodel.cn/usercenter/proj-mgmt/apikeys 拿）
- `VITE_AI_BASE_URL` — 当前 `https://open.bigmodel.cn/api/paas/v4`（智谱 BigModel）
- `VITE_AI_MODEL` — 当前 `glm-4-flash`（智谱免费档，稳定不限频；不要用 `glm-4.7-flash`，新模型 429 严重）
  - 备选：`deepseek-v3.2` / `kimi-k2.6` / `qwen-flash`（百炼，国内端点 `dashscope.aliyuncs.com/compatible-mode/v1`，免费额度跑光后会 401）
  - 切提供商只需改这两个变量 + key，调用代码全是 OpenAI 兼容协议
  - **⚠️ 安全：VITE_* 变量会被打包进 dist 包内**，扩展安装后 key 在用户机器上可读。打 zip 前确认要给销售装的是哪个 key（boss 的还是给销售单独申请的）。长期方案：放 Supabase Edge Function 做代理
- `VITE_CLOUDINARY_CLOUD_NAME` / `VITE_CLOUDINARY_UPLOAD_PRESET` — 车源媒体上传
  - preset 必须在 Cloudinary 后台 Settings → Upload → Upload presets 设为 **Unsigned**
  - 一个免费账号 25 GB 流量 / 月，对几百车型够用
- `SUPABASE_SERVICE_ROLE_KEY` / `ORG_ID` — 仅 `npm run migrate-old-pg` 需要

## 测试规则（重要）

- **只能用测试号 13552592187 测试 WhatsApp 功能**，绝不能在真实客户聊天上操作
- WhatsApp Web 的 DOM 经常变。`whatsapp-dom.ts` 已经用 testid + span[title] + dir=auto 三重 fallback；`whatsapp-idb.ts` 直接读 IndexedDB 更稳定
- 修改 UI 后要在真实 WhatsApp Web 上观察行为，不能只看 API 返回
- 验证 UI 用 Chrome MCP（Codex-in-chrome），扩展只能在用户已登录的 Chrome 里测，MCP tab 共享同一 profile

## 已完成功能

### 基础设施
- [x] Chrome 扩展骨架（MV3 + Vite + React + TS，@crxjs/vite-plugin 2.4 正式版）
- [x] Supabase 多租户 schema + RLS（**25 个 migration 全部上线**）
- [x] **Supabase Realtime**（migration 0025）：useCrmData / ScopeContext 改 Realtime + 30min 兜底 refetch，替代 20s 轮询，省 egress（详见 2026-05-20 节）
- [x] 邮箱密码登录（chrome.storage 持久 session）+ 创建团队
- [x] **团队成员管理 UI**（顶栏 👥 团队）：list / invite / 改角色 / 移除（仅 owner/admin）
- [x] **Supabase 免费层防自动暂停**：0012 `pg_cron` 每日 03:00 UTC 写心跳到 `_keepalive` 表
- [x] WhatsApp Web 内嵌顶部 **6 tab**（看板 / 聊天 / 客户 / 车源 / 任务 / 标签）+ 自动 shrink

### WhatsApp 集成
- [x] **聊天检测**：testid + 手机号 parse + IndexedDB 直读 + **保存的联系人 name 缓存**
- [x] **WhatsApp Web IndexedDB 直读**：chats、labels、label-association、contact（@lid → @c.us 映射）
- [x] **WhatsApp 标签 → CRM 字段智能同步**：标签自动归类到 quality / stage / country / vehicle / tag
- [x] **批量同步**：把 WhatsApp 所有聊天导入 contacts（含 @lid 业务号）
- [x] **跳转聊天**：搜索框输入手机号 + 按 **Enter** 键打开

### 客户管理
- [x] **共享 ContactEditForm**：聊天 tab 卡片 + 客户 tab drawer **完全一致**（姓名/国家/语言/预算/目的港/⭐⭐⭐质量/完整 7 阶段/备注）
- [x] **聊天 tab 右侧面板**：tab 容器（客户资料 / AI 回复 / 历史消息），资料 tab 内含全 sections（标签/车辆/报价/任务/时间轴）
- [x] **客户 tab**：列表 + 搜索/阶段筛选 + 每行 **💬 聊天按钮**（一键切到聊天 tab + WhatsApp 跳转）
- [x] **任务 tab 看板化**：4 KPI 卡（今日/本周/累计待跟进/总数）+ 日历常驻（每天写客户名 + "+N" 溢出）+ 选中日详情列表
- [x] **车源库（Phase A 升级）**：vehicles 表 + 卡片网格 + 创建/编辑模态 + 筛选 + **阶梯价 (`pricing_tiers` JSONB)** + **Cloudinary 媒体管理（图片/视频/配置表）**
- [x] **消息历史持久化**（"📜 历史消息"）：useMessageSync 自动 upsert 当前可见消息到 messages 表，wa_message_id 唯一去重，modal 加载最近 500 条
- [x] **标签 tab**：列表 + 改名/合并/删除（内联确认替代 native confirm）
- [x] **看板 tab**：周/月切换 + 6 KPI 卡 + 阶段漏斗 + 热门车型 Top 5

### 多维筛选系统
- [x] **左侧 240px FilterSidebar**：5 维度（阶段 / 质量 / 区域 / 车型 / 预算）+ 今日待办（拆为 4 个文件：主件 + Primitives + MaintenancePanel + TodoList）
- [x] **筛选条件持久化** + **不自动关闭** + **品牌可折叠**
- [x] **车型规范化**：60+ 别名规则 + 噪音剥离 + 一键合并去重
- [x] **品牌自动识别**：30+ 主流品牌 + 首词 fallback + 用户右键改组
- [x] **国家区域映射**：手机号区号 → 国家 → 13 大区
- [x] **预算分档**：新车 / 二手切换 + 5 档

### AI（GLM 全套，4 种 prompt）
- [x] **AI 字段提取**（`useAutoExtract` 单聊 + `bulk-extract.ts` 批量）：name / country / language / budget / port + vehicles[]
- [x] **AI 标签建议**（TagsSection "🤖 AI 建议"）：销售特征标签（支付方式/紧急度/决策阶段/反对信号），跳过国家/语言/车型等已抽取字段
- [x] **AI 任务建议**（ContactTasksSection "🤖 AI 建议"）：销售下一步动作（动词开头 12 字内 + due_in_days），跳过"等客户回复"
- [x] **自动翻译**（顶栏 "🌐 翻译" 开关 + "🔁 重译" + 每条消息悬停 🌐 按钮）：observer + 顺序队列 + 200ms 间隔 + 缓存，CJK > 30% 自动跳过；**主 Google Translate gtx（免费、无 key、无配额）**，失败 fallback 到 GLM
- [x] **公共 callQwen helper**：3 次指数退避（3s/8s/15s）+ JSON mode + temperature 0.1（函数名仍叫 callQwen 是历史遗留，实际打的是 .env 配的任何 OpenAI 兼容端点，当前是 GLM）

### 销售工作流
- [x] **报价记录**（QuotesSection）：car/price/status(draft/sent/accepted/rejected)/sent_at/notes，车型 datalist 联动 vehicle_interests
- [x] **客户时间轴**（TimelineSection）：append-only contact_events，事件源遍布所有写入点（stage/tag/vehicle/quote/task/ai_extracted/created），垂直时间线 + 图标 + 相对时间
- [x] **阶段自动写回**（stage-sync.ts）：autoStage → DB customer_stage，映射 active→negotiating；sticky stages: quoted/won；并发保护用 `.eq('customer_stage', expected)`

### Gem AI 回复（Phase 4 完整闭环）
- [x] **Gem 模板管理**（GemTemplatesModal）：用户在 gemini.google.com 自建的 Gem URL 录入，is_default 默认模板，CRUD + 顶栏 🤖 Gem 按钮 / 客户卡 "管理模板" 都能进
- [x] **新客户 vs 老客户对话路由**：第一次发送用 template.gem_url 开新对话，Gem 返回的 chat URL 存到 gem_conversations，下次同一 (contact, template) 直接打开那个 URL 续聊（保留 Gem 上下文）
- [x] **chrome.tabs 自动化**（gem-automation.ts）：后台/前台开关 → 创建 tab 加载 Gem URL → 等 ready → 注入脚本切换 Pro 模型（适配中文界面"快速/思考/Pro/Ultra"）→ 填 prompt + 点发送 → 等"停止生成"按钮消失（240s timeout）→ 取最终 chat URL → 关 tab；busy 单 flag 串行
- [x] **响应解析**（gem-parser.ts）：拆 [Client Record] / [WhatsApp Reply] / [Translation] 三段，无标签时按 CJK 比例兜底；`[WhatsApp Reply]` prompt 强制 2-4 段、段间空行
- [x] **Reply card + 一键填入**（GemReplySection + whatsapp-compose.ts）：reply 显示成绿边卡，💬 按钮 paste 到 WhatsApp 输入框（保留换行：paste 事件优先，fallback 按行 execCommand），不自动发送，不在当前聊天则先 jumpToChat
- [x] **[Client Record] 应用到客户资料**：差异化对比 + "应用 N 项" 按钮 → update contacts (country/language/budget_usd/destination_port/customer_stage/name) + upsert contact_tags + 写 ai_extracted 时间轴事件
- [x] **续聊对话框**：done 状态下常驻 textarea，Cmd/Ctrl+Enter 发送，输入啥发啥（不加 [Sales Guidance] 前缀，自由对话），保留 Gem 上下文
- [x] **指令草稿持久化**：每个 contact 有自己的指令 textarea，输入立即保存到 chrome.storage.local（按 contact_id 隔离），下次切回该客户自动恢复；非空时注入 prompt 顶部 `TOP PRIORITY` 段

### 车源媒体库（Phase A）
- [x] **Cloudinary 直传**（cloudinary.ts）：unsigned upload preset 无需后端签名；image / video / raw（PDF/Excel/Word）三种 resource_type，PDF/Excel 走 `/raw/upload/`
- [x] **VehicleMediaManager**（车源 modal 内）：图片 / 视频 / 配置表 三 section，drag-drop 上传 → Cloudinary → 写 vehicle_media；删除按钮一并删 Cloudinary public_id（如有）
- [x] **CloudinaryImg**（绕 WA CSP）：`<img src="res.cloudinary.com/...">` 在 web.whatsapp.com 被 CSP 拦；改 fetch → blob URL → object URL，WA 默认放行 blob: 协议；in-memory cache + inflight dedupe
- [x] **阶梯价**（pricing_tiers JSONB 数组）：VehicleModal 编辑 + VehicleRecommendations 展示

### AI 推荐车源（聊天 AI 回复 tab 顶部）
- [x] **VehicleRecommendations**：根据当前客户的 vehicle_interests 模糊匹配 org 库存（canonicalizeModel）+ 卡片展示（含图册/视频/配置表预览）+ 阶梯价
- [x] **一键发图/视频/PDF 到 WhatsApp**：从 Cloudinary fetch → File → pasteFilesToWhatsApp 注入到 WA 输入框，比手动找文件快得多
- [x] **状态持久化**：选中车型 + 折叠态分别按 chrome.storage.local 存

### 聊天媒体捕获 + 车源暂存盘（Phase C）
- [x] **chat-media-capture.ts**（content script，1085 行）：MutationObserver + 轮询扫 message bubbles，给图片 / 视频 / 相册 / lightbox 注入 hover 📥 按钮
- [x] **多选 toolbar "📥 加入车源"**：用户在 WA 多选 N 条消息（图片 / 视频 / PDF / Excel），点按钮 → SW 拦截 chrome.downloads（BULK_CAPTURE_ARM）→ 模拟点 WA 自带"下载" → 收 download URL/filename/mime → content fetch blob → 按 mime 自动归 image / video / spec
- [x] **绕过 WA MediaSource 限制**：直接 `fetch(blob: video src)` 得 0 字节，所以视频走 WA 自带下载（真解码下载）而非 MediaRecorder
- [x] **MediaStagingTray**（屏幕右下浮动暂存盘 Portal）：显示已捕获缩略图 + "📤 保存到车型"
- [x] **AssignMediaToVehicleModal**：选已有车型 / 创建新车型（仅填 brand+model）→ 上传 Cloudinary + 批量插入 vehicle_media + 清空暂存
- [x] **不持久化**：File 对象不能 serialize，blob URL 跨页面无效——刷新即清空（设计取舍）

### 团队多用户视图（2026-05-08，migration 0014）
- [x] **contact_handlers 主理人表**：(contact_id, user_id) 复合主键，记录"谁打开/聊过这个客户"
  - 创建客户时 trigger 自动注册 created_by 为 handler
  - 进入 WA 聊天时 useMessageSync 心跳 upsert（顺便 bumpHandler）
  - 一次性"孤儿认领"：ScopeContext 启动时把没有任何 handler 的老客户全部归到当前用户
- [x] **ScopeContext + ScopePicker**：顶栏下拉切"👤 只看我的 / 🏢 全部"，按 chrome.storage 持久化；默认 owner/admin → 全部，member → 只看我的
- [x] **scope=mine 视图过滤**：聊天列表 / 客户 tab / 任务 tab / 看板 tab 全部支持，过滤都走服务端 join `contact_handlers!inner(user_id)`，**不要用 `.in('id', myIds)` 否则几百个 UUID 进 URL 触发 Failed to fetch**
- [x] **撞单检测**：同 contact 出现 2+ user_id 时，列表项右侧显示其他主理人 short name（email @ 前段）；ChatPage / ContactsPage / FilteredChatList 都展示
- [x] **Gem 模板改 per-user**：0014 RLS 改 created_by=auth.uid()，每个销售只看到自己 Google 账号下建的 Gem（别人的 URL 自己也打不开）；is_default 含义变为"我的默认"

### 其他
- [x] **客户质量分级**：⭐⭐⭐ 大客户 / ⭐⭐ 有潜力（默认）/ ⭐ 普通 / 🗑 垃圾
- [x] **跟进提醒**：`stalled` 阶段 + `reminder_ack_at` + `reminder_disabled`
- [x] **Google 联系人双向同步**（People API + chrome.identity OAuth）
- [x] **数据自动刷新**：useCrmData Realtime + 30min 兜底 refetch + 自动 syncAutoStages

## 待完成功能

> Phase 1-4 全部完成。原列表中所有事项已完成（见下方"近期补完"）。

### 近期补完（2026-05-07）

- [x] **WhatsApp 消息历史持久化**（migration `0011_messages.sql` + `lib/message-sync.ts` + `MessagesHistorySection`/`MessagesHistoryModal` + `useMessageSync` hook）
- [x] **团队成员管理 UI**（migration `0010_org_member_management.sql` 提供 `invite_user_to_org` / `list_org_members` / `remove_org_member` / `update_org_member_role` RPC，UI 在 `TeamMembersModal.tsx`，顶栏 "👥 团队"）
- [x] **旧 PostgreSQL 迁移脚本**（`extension/scripts/migrate-from-old-pg.mjs`，配 `npm run migrate-old-pg`）
- [x] **contact_events 老客户回填**（migration `0009_backfill_contact_events.sql`，幂等 `NOT EXISTS`）
- [x] **@crxjs/vite-plugin 升级**（`^2.0.0-beta.27` → `^2.4.0` 正式版）
- [x] **FilterSidebar 拆子组件**（811 → 451 行，分出 `FilterPrimitives` / `FilterMaintenancePanel` / `FilterTodoList`）

### 近期补完（2026-05-08）

- [x] **团队多用户视图**（migration `0014_handlers_and_per_user_gem.sql` + `lib/contact-handlers.ts` + `panel/contexts/ScopeContext.tsx` + `panel/components/ScopePicker.tsx` + `panel/hooks/useOrgMembers.ts`）：scope=mine/all 切换 + 撞单 tag + per-user Gem 模板
- [x] **DashboardPage / TasksPage 服务端 join 过滤**：用 `contact_handlers!inner(user_id)` 替代 `.in('id', myIds)`，避免几百个 UUID 把 URL 撑爆
- [x] **今日待办加 "📋 所有客户" 一档**（filters.ts TodoBucket + matchTodoBucket + todoCounts）
- [x] **维护工具折叠**（FilterMaintenancePanel 用 chrome.storage 记展开状态，默认收起到 "🔧 维护工具 ▸"）
- [x] **打包脚本**（`extension/scripts/package.mjs` + `npm run package`）：build + 自动产 dated zip 到 `dist-zips/`
- [x] **团队使用手册.md**：发给销售员工的中文操作指南（scope / 撞单 / per-user Gem / FAQ）
- [x] **垃圾客户清理**：一次性 SQL DELETE 把"完全空壳 + 无消息"的 ~2900 个历史 contact 删了（cascade 一并清 contact_tags / vehicle_interests / quotes / tasks / contact_handlers / messages）
- [x] **手机端 .txt 聊天记录导入**（`lib/import-chat-parser.ts` + `lib/chat-import.ts` + `panel/components/ImportChatModal.tsx`）：客户 tab 顶部「📥 导入手机聊天」→ 解析 WhatsApp 手机端导出 → 写 messages 表
  - 支持两种时间格式：`2026/5/7 08:46`（24h）和 `2026/4/6 下午1:54`（中文 AM/PM 凌晨/早上/上午/中午/下午/晚上）
  - 多行延续（form-fill key:value、多段消息）合并为同一条消息的 text
  - 自动识别"我"vs"客户"：手机号格式发件人 = 客户，最高频非手机号 = 我（多销售也能正确归类）
  - `wa_message_id = 'import:' + sha256(ts|direction|text).slice(0,16)`，重复导入幂等
  - 没找到 contact 自动按 phone+org_id 创建（country 按区号推）
- [x] **Gem 回复 fallback 到 messages 表**（`GemReplySection.tsx` generate()）：DOM 读不到消息时自动 `loadMessages(50)` 走数据库——配合上面的导入，手机端独有的聊天也能让 Gem 接着写
  - UI 上显示来源："📜 用导入的历史记录（N 条）"
  - 完全没历史时报错文案直接告诉用户去导入
- [x] **Gem prompt 媒体附件合并**（`gem-prompt.ts` collapseMediaRuns）：同一发件人连续 N 条纯附件（`IMG-...jpg (文件附件)` / `[媒体]` / 空文本）→ `<sent N media items in a row>` 一行；同时把 slice(-20) 提到 slice(-50)
  - 之前 Gem 看到的最近 20 条里大半是图片占位，真实对话被挤出去；现在 224 客户聊天 prompt 总长 8.6k 字符，完整保留销售脉络
- [x] **loadMessages 修 ASC bug**（`lib/message-sync.ts`）：之前 `order ASC + limit N` 拿的是最老 N 条，导大量历史后 Gem fallback 看到的是开头不是最近——改 DESC + reverse，调用方拿到正序但内容是最近 N 条；MessagesHistoryModal 也跟着对齐

### 近期补完（2026-05-09）— 撞单清理 + OrgSetup 防呆

- [x] **`contact_handlers` ghost user 清理**：一个孤立 auth user (`3190696498@qq.com`) 短暂加入过 Miles org，被移除后 contact_handlers 残留 512 行，导致 459 个客户长期显示"撞单"。手工 SQL DELETE 清掉 + 删 auth user
- [x] **migration `0015_cascade_handlers_on_member_removal.sql`**：`AFTER DELETE on organization_members` trigger，自动清掉被移除成员在该 org 所有 contact 上的 handler 行（防 ghost user 复发）
- [x] **dengrongc6 双 org 合并**：dengrongc6 自建过 "Sino gear" org（147 contacts，独立隔离），又被邀请进 Miles。10 个手机号冲突 contact 的子数据合并到 Miles，137 个无冲突的本应迁移但⚠️**踩 1000-行陷阱后误被 cascade 删除**——dengrongc6 重新 WhatsApp 同步可恢复通讯录主体，少量消息/事件/兴趣丢失（手动操作不要重复，已记录教训见"已知问题"）
- [x] **OrgSetup 防呆**（`OrgSetup.tsx` 重写）：3 步式确认——guidance（默认显示，强烈警告员工别建团队 + 显示当前邮箱 + "换个账号登录"）→ confirm（再次确认隔离风险）→ form。员工误注册的常见路径全部加了护栏
- [x] **真·空壳 contact 清理**：严格筛选（stage=new + 无 notes/country + 非 Google 同步 + 无 tags/interests/quotes/tasks/messages/gem_conversations），删 186 个；候选集 1066 里大部分（880）有消息历史只是没分类，保留
- [x] **Cloudinary 用量监控**（`lib/cloudinary-usage.ts` + `panel/components/CloudinaryUsageBadge.tsx`）：车源 tab 顶部小徽章 sum(`vehicle_media.file_size_bytes`) / 25 GB；70%+ 黄、90%+ 红 + 接近上限提示。不调 Cloudinary Admin API（避开 secret 泄漏），SQL 即可估算
- [x] **WA Web DOM 漂移自检**（`lib/dom-health.ts` + `panel/components/DomHealthBadge.tsx`）：每 60s 跑一组关键 selector 检查（侧边栏、主面板、聊天 title、消息 data-id、搜索框）；检出失效后顶栏冒红徽章 "🔴 DOM N"，点开 modal 列详情。skipped ≠ broken（避免没开聊天时误报）

### 近期补完（2026-05-10）— 群聊支持 Phase 1

- [x] **群聊作为 contact**（migration `0016_groups.sql` + `whatsapp-dom.ts` + `useContact` + `ContactCard` / `ContactDetailDrawer` / `ContactEditForm` + `useAutoExtract` + `bulk-extract` + `GoogleSyncDialog` + `useCrmData` + `ContactsPage` / `TaskModal` 等）：
  - DB schema：contacts 加 `group_jid TEXT` 列 + partial unique `(org_id, group_jid) WHERE group_jid IS NOT NULL` + check constraint `phone IS NOT NULL OR group_jid IS NOT NULL` + 放宽 phone NOT NULL
  - 群 JID 来源：WhatsApp 新版 data-id **不再含 JID**（只放 32-char 消息哈希），改走 IDB `chat.id` cache。`refreshChatNameCache` 启动 + 每 30s 把 IDB chats 按 "header name → {phone | groupJid, jid}" 建索引；readCurrentChat 用 header 显示名查缓存
  - 群聊 contact 复用所有现有子表：tags / vehicle_interests / quotes / tasks / messages / contact_handlers / contact_events / gem_conversations 全部零改动可用
  - 群聊关闭：自动 AI 字段抽取（多人发言 country/language/budget 语义崩坏）+ Google 联系人同步（无手机号）+ bulk-extract（同自动抽取）
  - UI：群聊 ContactEditForm 隐藏 country/language/budget/destination_port 四栏，姓名字段标 "群名"；客户列表 / 任务选项里群聊带 👥 前缀
  - `gem-prompt.ts` `normalizePhone` 兜底：null phone 显示 "(group chat)"
  - 暂未做（Phase 2）：群成员名单展示 / 一次性批量同步所有群进 CRM / 筛选维度"个人 vs 群组" / 群聊专用 Gem prompt

### 近期补完（2026-05-10）— 群聊支持 Phase 2

- [x] **群成员名单展示**（`panel/components/GroupMembersSection.tsx`）：客户卡 + drawer 里挂一个 section，从 IDB `groupMetadata.participants` 拉成员 JID，按 `wa.contacts` 解析 name/phone，每人有"💬 跳转 1 对 1"按钮。展示前 6 个，可展开剩余
- [x] **批量同步含群聊**（`bulk-sync.ts`）：原本只把个人 chat 同步进 contacts，现在 @g.us 的 chat 也建成 group contact（`group_jid` 走 unique 索引去重）。结果对象新加 `addedGroups` 字段，FilterMaintenancePanel 同步结果文案多显示 "+ N 个群聊"
- [x] **客户列表"个人 / 群组"筛选**（`ContactsPage.tsx`）：toolbar 加一个 select，"全部类型 / 👤 个人 / 👥 群聊"
- [x] **群聊专用 Gem prompt**（`gem-prompt.ts`）：检测 `contact.group_jid` 自动切到 `formatNewGroup` 路径，prompt 头部 `[WhatsApp Group Chat]` + 群名 + 成员名单 + 显式说明"这是多人群聊不是单一客户"+ "跳过 [Client Record]"。`formatMessage` 接收 `isGroup` 标志，群里非自己的消息标记成 `Member (Aca)` 而不是 `Customer`。`formatUpdate` 也带 `isGroup` 参数
- [x] **ChatMessage 加 sender 字段**（`whatsapp-messages.ts`）：从 `data-pre-plain-text` 末尾的 "[time, date] SenderName: " 解析，"You" / 手机号格式不算。个人聊天恒为 null。collapseMediaRuns / GemReplySection 的 DB fallback 路径也都跟着加了 sender
- [x] **WAChat 加 participants 字段**（`whatsapp-idb.ts`）：从 `chat.groupMetadata.participants` 解析成员 JID 列表，处理三种格式（string / object.id / object.id._serialized）。个人聊天为 []
- [x] **强制版本闸门**（migration `0017_app_config.sql` + `lib/build-version.ts` + `lib/version-check.ts` + `panel/components/VersionGate.tsx` + `scripts/package.mjs` 重写）：
  - DB schema：`app_config` 表（key/value），`required_version` 行公开可读（RLS `using (true)`），写入只服务端
  - 客户端 `BUILD_VERSION` 在 `build-version.ts`（默认 'dev'，`npm run package` 时被自动覆写为 `0.1.0-YYYYMMDD`，构建完再还原回 'dev' 保持 git 干净）
  - `VersionGate` 包在 AppShell 最外层（甚至先于 LoginForm）：每 5 分钟拉 required_version + 跟 BUILD_VERSION 严格 ===  比对，不一致 / 拉不到且无缓存 → 弹强制更新弹窗，没有 bypass。网络故障兜底用 chrome.storage 缓存（一周新鲜期）
  - `npm run package` 现在是一条命令的流水线：写版本 → build → zip → 用 service_role upsert 到 `app_config.required_version` → 还原 build-version.ts。boss 这台机器是权威，每次打包 = 强制全员升级
  - `BUILD_VERSION === 'dev'` 永远放行（boss `npm run dev` 不被自己拦住）

### 近期补完（2026-05-11）

- [x] **migration `0018_fix_group_jid_unique.sql`**：把 0016 加的 partial unique INDEX `contacts_org_group_jid_key` 换成普通 UNIQUE CONSTRAINT。原因：`supabase-js` 的 `.upsert({ onConflict: 'org_id,group_jid' })` 不支持指定 index predicate，partial index 让 bulk-sync 群聊报 42P10 ON CONFLICT 错。普通 UNIQUE 在 PG 里 NULL/NULL 不冲突，所以个人 contact 还能照样多个 group_jid=NULL 共存
- [x] **"我该回"判定简化**（`chat-classifier.ts`）：移除 `reminder_disabled` / `reminder_ack_at` 拦截，**只看 chat.unreadCount > 0 + 未归档**——客户每次发新消息都进 bucket，不再被"已处理"标记隐藏
- [x] **今日待办 bucket 时间标签 + 补全两个时间档**（`filters.ts` + `FilterTodoList.tsx`）：现在 8 个 bucket：📋 所有 / ⚠️ 我该回 / 🔥 谈判中 / ⭐ 重点 / 🆕 新客户(1天内) / 🔄 进行中(1-3天) / 💤 长期未联系(3-7天) / 🪦 已流失(>7天)
- [x] **@lid 业务号 jid→phone 持久缓存**（`lib/jid-phone-cache.ts` + `whatsapp-dom.ts` 写入 + `useCrmData.ts` 读取）：新版 WA Web `data-id` 全是 hex 哈希、IDB `jidToPhoneJid` 也常缺 @lid 映射 → 业务号客户在左边列表消失。修法：用户每次打开聊天时 `readCurrentChat` 把 (rawJid, phone) 持久化到 chrome.storage.local；下次 `useCrmData` 全量扫聊天时优先查这个缓存。原始数据来源：DOM header 文字（"+591 69820483"）的 `extractPhoneFromText`
- [x] **再修 1000 行陷阱**（`useCrmData.ts` + `ContactsPage.tsx`）：本来都用 `.from('xxx').select('*').eq('org_id', orgId)` 单次查，超过 1000 行被静默截断。改成 fetchAll-pattern 分页（跟 `fetchHandlersForOrg` 一样写法）。**这次踩坑导致 712/1733 个客户在客户管理 tab 消失，且 +591 业务号客户因为 contact 没在前 1000 里、被第二个 loop 当成 contact=null 的孤儿塞进 merged → scope=mine 过滤掉**
- [x] **客户活性体检工具**（`lib/contact-vitality.ts` + `panel/components/ContactVitalityModal.tsx` + 维护工具入口 "🩺 客户活性体检"）：
  - 秒级分析：根据 IDB chat.t + DB messages 给每个客户打标签（🟢 ≤30天 / 🟡 30-180天 / 🟠 >180天 / 🔴 完全无 WA 痕迹）
  - "🔍 实测验证号码"按钮：按需对当前档位逐个跑 `jumpToChat`，区分"能开聊天"vs"死号"。约 3 秒/个，1700 个全跑要 80 分钟，建议先跑 🔴+🟠 这两档
  - 批量操作：勾选后一键"标 spam"或"删除"
  - 取消按钮用 `useRef` 而不是 `useState`——React state 在 for 循环闭包里被快照，setState 改不动循环里的判断变量，必须用 mutable ref

### 近期补完（2026-05-12）— "WA Web 搜不到"全套修复 + 真相确认

**起点**：客户活性体检里 1000+ 客户被标 "⚠ 搜不到"（实例 David Eze `+2347035834920`）。客户管理点 💬 跳不进去、Gem AI 抽不出建议、bulk-extract 跳过这些客户。

**深夜实测** — 用 Chrome MCP 在独立 WA Web tab 跑了 4 个实验，确认：

1. **`history.pushState` + `popstate` 路由 → 完全无效**：URL 变了，但 WA Web SPA 不响应 popstate，`div#main` 不出现。SPA 内部路由这条路不通。
2. **`location.href = '/send?phone=X'` 触发 reload → 注册号能进 chat**：但需要 **≥14 秒**等待。8 秒/10 秒的检查都会误判为失败（David Eze 之前实测验证 fail 的根因）。
3. **死号 → WA Web 弹 dialog "电话号码 X 没有注册 WhatsApp"**。可识别 + dismiss。
4. **关键死结**：`/send?phone=` 只 in-memory 打开 chat，**不写 IDB chat 表**——25 秒后查 IDB 还是 519 条，测试号没进去。**任何"批量激活"想让 WA Web 缓存这些号的方案物理上不可行**。WA Web 只缓存"产生过消息级交互"的 chat，这是它的设计哲学。

**做了**：

- [x] **`jumpToChat` 加 `allowDeepLink` 选项**（`lib/jump-to-chat.ts`）：搜索失败 → fallback navigate 到 `/send?phone=`，让 WA Web reload 一次进 chat。**所有用户主动点击的入口**都传 `{ allowDeepLink: true }`：ContactsPage 行点击 / 💬 / TasksPage 💬 / GroupMembersSection 💬 / FilteredChatList 行点击 / TranslateReplyPanel fill / GemReplySection fillReply
- [x] **AI 建议路径加 DB messages fallback**（`TagsSection` / `ContactTasksSection` / `GemReplySection.generate`）：jumpToChat 失败不再抛错，自动 `loadMessages(contactId, 50)` 走导入的历史。**不开 deep-link**——reload 会中断 AI 调用，DB fallback 比 reload 体验好。
- [x] **bulk-extract 加 DB fallback**（`lib/bulk-extract.ts`）：之前 jumpToChat 失败就跳过（只用 phone-code 推 country），现在 fallback 到 messages 表 → 那 1000+ "搜不到但已导入"的客户也能批量 AI 抽取
- [x] **活性体检拆 5 档**（`lib/contact-vitality.ts` + `ContactVitalityModal.tsx`）：4 档 → 5 档，新增 **🔵 已导入·WA Web 无缓存**（`inIdb=false + hasMsgsInDb=true`）。之前这种被并到 🟠 cold 误以为可疑，现在独立成档，文案明确告诉"是真客户，绝对不要删，点 💬 走 deep link"。**🔴 orphan 才是真清理候选**（既没缓存也没历史）
- [x] **活性体检 "实测验证" 文案软化**：失败 "✗ 死号"（红）→ "⚠ 搜不到"（橙）+ hover tooltip 解释；删除时如果选中含 hasMessagesInDb=true 的多一道警告
- [x] **每个 tab 加 hint 卡片 + tooltip**：体检 modal 里每档下方常驻一行说明（borderLeft 加颜色），鼠标 hover tab 也有 title 提示

**拒绝了**：用户提出"给每个客户发'1'再删除让 WA Web 写 IDB"——拒绝。理由：
- WA 反 spam 系统典型 spam 模式（1000 个 outbound 新会话 + 短间隔）→ 封号高风险
- 客户手机会收到 push 通知，撤回也来不及→ 销售形象受损
- AGENTS.md "绝不能在真实客户聊天上操作" 红线
- **任何"让 WA Web 自动学会更多客户"的需求都要走"导入聊天 .txt"路径**（合法+不打扰客户）

**未做的可选项**（用户决定要不要）：
- 写"批量验证"工具（4 小时跑 1000 次 reload 区分真活/真死号）—— 不解决搜索问题，只能给死号打标签便于清理。当前 🔴 orphan 那档已经是清理候选，**不值得再花 4 小时**。

### 近期补完（2026-05-13 ~ 2026-05-20）— 多 AI 整合 + Realtime + 自动回复 + AI 归因

**AI 回复三足鼎立：Gem / Codex / GPT 同 UI 共存**
- [x] **Codex AI 回复**（`lib/Codex-automation.ts` + `lib/Codex-prompt.ts` + `panel/components/ClaudeReplySection.tsx`）：
  - 网页端自动化 Codex.ai（chrome.tabs + 注入脚本）；首次开新对话拿 chat URL → `claude_conversations` 表 per-contact 缓存；下次续聊
  - **prompt 体系升级**（`Codex-prompt.ts`）：ROLE_PROMPT（Miles 第一人称 + 6 类买家自适应）+ VEHICLE_KNOWLEDGE（全场景注入，所有 SKU + EXW 价 + 卖点 + 目标买家）+ GHANA_MARKET_PLAYBOOK（isGhanaContext 命中时注入：CIF 价格 / 关税 / Stallion vs Zonda 竞品 / 6 节点漏斗）+ Color Stock Rule（hard rule，绝不问颜色）
  - **5 种 mode**：reply（默认，只出 reply + translation，可选 Customer Read / Client Record）/ analyze（深度分析 5 段）/ variants（3 个不同语气）/ quote（quote draft + 报价回复）/ discuss（自由对话）
  - **客户信号注入**（`lib/customer-signals.ts`）：英语水平 + 情绪 + 沉默天数 + Pricing Math 段 — 在 chat history 之前注入到 prompt
  - **Pricing Math 段去重**（`Codex-prompt.ts` 1 次注入 + signals 不重复）
- [x] **GPT-5 Thinking 回复**（`lib/gpt-automation.ts` + `lib/gpt-prompt.ts` + `panel/components/GPTReplySection.tsx` + migration `0023`）：
  - 网页端自动化 chatgpt.com；首次开新对话拿 chat URL → `gpt_conversations` 表 per-contact 缓存
  - **故意精简 prompt**：GPT-5 Thinking 自己联网查 + 推理报价效果更好，prompt 不喂 Vehicle Knowledge / Ghana playbook（Codex 那边保留，因为 Codex 默认不联网）
  - 输出格式跟 Codex 一致（[WhatsApp Reply] + [Translation] + 可选 [Client Record]），共用 parser
- [x] **AIReplyTab dropdown 切三档**：`🤖 Gem` / `🧠 GPT-5 Thinking` / `✨ Codex`，按钮选择持久化 chrome.storage

**AI source attribution（出站消息 AI 归因）**
- [x] **`lib/ai-reply-attribution.ts`**（183 行）：fillReply 时存 5 分钟 pending fill 窗口（chrome.storage.local），syncMessages 写出站消息时按 contactId + 时间窗口 + 文本相似度（公共前缀比例 ≥ 0.6）匹配，命中后写 `messages.ai_source`
- [x] **migration `0024_message_ai_source.sql`**：messages 加 ai_source 列（Codex/gem/gem_auto/gpt/null）
- [x] **MessagesHistoryModal 来源 chip**：每条出站消息显示来源标签（✨Codex / 🤖Gem / ⚡自动 / 🧠GPT / 🌐翻译 / ⌨️手打）+ 顶部统计行"出站 N 条：Codex × N，gem × M，manual × K"
- [x] **AIReplyLogModal 加 GPT 分类**：source 枚举扩展支持 gpt
- [x] **设计取舍**：相似度 60% 阈值容忍"改了 1-2 个字"，宽松匹配会误判 manual 为 AI；销售改太多就归 null 是预期行为

**Supabase Realtime（替代 20s 轮询，省 egress）**
- [x] **migration `0025_enable_realtime.sql`**：contacts / vehicle_interests / contact_tags / contact_handlers 加入 `supabase_realtime` publication；**REPLICA IDENTITY FULL** 让 DELETE/UPDATE payload.old 包含完整旧行（关联表前端 reducer 需要 contact_id 定位归属）
- [x] **`useCrmData` 改 Realtime 架构**（752 行重写）：
  - 初次加载 + 30min 兜底 refetch + 5min msg_directions 单独刷新 + visibilitychange throttled refetch（5min 节流防狂切 tab 烧 egress）
  - Realtime 订阅 contacts/vehicle_interests/contact_tags，事件 reducer 增量更新本地 state map
  - WA IDB 数据保持 30s 轮询（本地读，零 egress）
  - **slim select**：`CONTACT_LIST_COLS = 'id, phone, group_jid, wa_name, name, country, language, budget_usd, customer_stage, quality, destination_port'` — 不再 select *（notes / google_* 等大字段在 useContact 详情卡才拉）
  - **乐观置顶**（`setPinned`）：本地 state 立刻翻转 → DB 后台写 → 失败回滚
- [x] **`ScopeContext` 改 Realtime**（293 行）：contact_handlers 表 Realtime 订阅，事件按 (contact_id|user_id) 复合 key 增删，无需重建整个 map；30min 兜底 refetch + visibility 节流；首次启动孤儿认领分页拉全集 contact ID（突破 1000 行限制）
- [x] **egress 模型**：每销售每天 ~20-30 MB（初次 1.4MB + Realtime 几 KB/事件 + msg_directions 5min RPC ~50KB × 72 + 30min 兜底 ~1.4MB × 12）→ 月度 3 销售 25 天 ≈ 1.5GB，远低于 Supabase 免费 5GB
- [x] **migration `0019` + `0022`** 提供 `last_message_direction_per_contact` RPC：给"我该回"判定回填客户最后入站/出站时间 + 计数（5 分钟刷新）

**Facebook lead 自动回复链路（无人值守）**
- [x] **`content/auto-reply.ts`**：完整 orchestrator —— 收到 SW 的 AUTO_REPLY_FIRE → jumpToChat → 跑 Gem（active=true）→ parseGemResponse → 有 vehicleId 就走"发图（pasteFilesToWhatsApp + 预览发送键）+ 文字 reply"两步，无车走纯文字 → upsert gem_conversation → 写 ai_extracted 时间轴 + ai_reply_logs（source=gem_auto, wasFilled=true）
- [x] **`lib/auto-reply-state.ts`**：state machine（scheduled/firing/gem_running/sending_images/reply_filled/done/error），chrome.storage 持久化；用户在 banner 点"中止"删 state，下一个 await 之间 wasCancelled 检测到就 return
- [x] **SW 端 chrome.alarms 调度**：SCHEDULE_AUTO_REPLY 创建 alarm（SW 休眠也能唤醒）→ 到点找 WA Web tab 发 AUTO_REPLY_FIRE；recoverStuckSchedules 在用户重开 WA 时扫一遍 scheduled 状态，延误了立即触发
- [x] **续聊路径**：客户回了新消息后 1 分钟触发，formatUpdate 仅带最近几条消息，gem_chat_url 沿用首轮的，纯文字（不发图，除非客户问图）
- [x] **`lib/reply-sanitize.ts`** P0 安全：auto-send 前必须 sanitize（自动发=没人 review，泄漏 RMB 价 / floor 是灾难）
- [x] **per-contact 开关**：默认关闭，用户在 banner 上明确启用（`isContactAutoReplyEnabled`），不全局自动跑
- [x] **isPhotoRequest 关键词识别**：续聊里客户要图（"more photos / 再发几张 / 多发图"等）→ 本轮再发一次图

**其他**
- [x] **`lib/contact-pins.ts` + per-user 置顶**（migration `0021`）：(contact_id, user_id) PK，乐观更新写 DB
- [x] **`lib/ai-reply-log.ts` 改 chrome.storage.local 存储**（早期考虑过建 ai_reply_logs 表入库，对应 migration 未纳入仓库，最终改本地存）：FIFO LRU，800 条上限，AIReplyLogModal 列表 + markdown 导出给 Codex review 质量
- [x] **`MessagesHistoryModal` 加完整出站统计**：source × count 标签，让 boss 一眼看哪个 AI 用得多
- [x] **强制版本闸门 → 0017 已上线**（前文 2026-05-10 已记，沿用至今）
- [x] **`useCrmData` 分页全面铺开**：`fetchAllContacts` / `fetchAllVehicleInterests` / `fetchAllContactTags` 全走 PAGE=1000 分页，**`.order(...)` 必须加**（PostgREST 不保证 range 跨页稳定，并发写入时同行可能跨页重复）

### 近期补完（2026-05-22）— WA Web DOM 漂移：客户 inbound 全部丢失

- [x] **`findDataId` 改用 closest + testid，不再固定 N 层父链爬**（`content/whatsapp-messages.ts:65-86`）

**症状**：销售用 AI 续聊（Gem / Codex / GPT 三个都一样），prompt 里 `[New Messages Since Last Reply]` 段只剩销售自己发的 photo 占位（`[Sales sent 1 photo to customer]`），**客户最近发的所有文字 inbound（"9,000 Ghana / ??? / And location"）完全消失**；`messages` 表也只有销售 outbound 占位，客户文字 0 条入库（=> useMessageSync 跑过但每次都漏 inbound）。

**根因**：WA Web 这一版把消息 `data-id` 挪到了 `.message-in / .message-out` 的 **3 层祖父之上**（L11 = `[data-testid^="conv-msg-"]` wrapper）。`readChatMessages` → `findDataId` 之前 `for (i=0; i<3; i++)` 只看 L8/L9/L10，L11 永远查不到 → 所有 inbound bubble `id=null` 被 `continue` 静默跳过 → DOM 输出全空 → DB 同样空（useMessageSync 同链路）→ mergeDomWithDbMessages 也兜不住。

**修复**：`findDataId` 改用 `el.closest('[data-testid^="conv-msg-"]')` 顺祖先链找消息级 wrapper，不限层数；兜底层数从 3 放回 6 + 加 `id.length >= 16` 长度过滤防 FB 广告 / 会话级共享 wrapper 误抓。`conv-msg-` 是消息级独有的 testid，不会撞会话级。

**诊断方法**：DevTools console 跑 `document.querySelector('div#main')?.querySelectorAll('.message-in, .message-out').length` 看 bubble 数；再找客户文字（如 "9,000 Ghana"）反查它的 closest `[data-testid]` —— 这次抓到的是 `conv-msg-AC0FE7C196C0022A03512CB28F2D1DF3`，wrapper data-id 是 30 字符 hex。

**教训**：whatsapp-messages.ts 之前两次修过这个上限（6 → 3 → 现在 closest）。任何固定 N 层父链爬都会因 DOM 漂移坏掉。**新加 DOM 解析逻辑一律用 `closest(testid-prefix)` 或 fiber 路径，不要写 `for i < N`**。

### 近期补完（2026-05-26 ~ 2026-05-27）— 时间戳大修 + AI 回复 UI 持久化 + 防跨聊天污染 + Meta CAPI

**起点**：用户报告 Samuel chat 的 prompt 顶部出现 `[05-26 15:26] Sales sent 2 photos / Customer sent 1 document`——他 5-21 之后没跟 Samuel 聊过，"为什么凭空冒出 5-26 的消息"。深入挖出一整串相关 bug：纯媒体 bubble 没 timestamp / 中文时段 12 小时偏移 / done card stale 持久化 / 跨聊天污染等。3 天迭代 13 个 task，最终 commit `aca0365` + `c8a3c61` push 完。

#### AI 回复 prompt / 时间戳大修

- [x] **parsePrePlainText 加中文时段解析**（`whatsapp-messages.ts`）：long-standing bug 一直没察觉。WA Web 中文界面 `data-pre-plain-text="[下午5:18, 2026年5月18日]..."` 用中文时段标记，之前正则只匹配 `(AM|PM)?` → "下午5:18" parse 成 hour=5（应该 17）。所有 PM 时间偏 12 小时，相对顺序对所以没被发现。新增中文时段（凌晨/清晨/早上/上午/中午/下午/晚上）+12 转换
- [x] **formatTimestamp(null) → `??-?? ??:??`**（三个 prompt 文件）：纯媒体 bubble 无 caption 时没 `data-pre-plain-text`，timestamp=null → 之前 `new Date()` 兜底显示当下时刻。Samuel "5-21 凭空冒出 5-26 媒体"就是这个 bug。返回 `??-?? ??:??`，prompt 顶部加注释说明"位置非按时序"
- [x] **readChatMessages 重写 + currentDate 追踪**：按 DOM 顺序合并 bubble + date header span 遍历，date header（"2026年5月18日" / "星期四" / "今天" / "昨天"）出现时更新 currentDate。纯媒体 bubble 从内 `<span>下午2:11</span>` + currentDate 合成准确 sent_at
- [x] **stripTrailingMeta 剥末尾噪音**：之前 `getMessageText` innerText 把 bubble 底部 "下午2:32" / "已编辑" 一起带进 text → prompt 里每条消息后跟着冗余中文时间。出口剥一遍。**英文保守**：必须带 AM/PM 才剥（防误伤客户写"meet at 5:00"）
- [x] **删除占位识别 + DB 覆盖**：DOM "你已删除这条消息" → text 改 `[已删除]`，`syncMessages` 用 onConflict 覆盖之前抓过的原文（用户后来在 WA 端撤回的）

#### AI 回复 UI 持久化 + 续聊上下文

- [x] **`usePersistedReplyStatus` hook**（`panel/hooks/usePersistedReplyStatus.ts`）：done 状态按 `(source, contactId)` 持久化到 chrome.storage，切走客户回来能恢复回复 UI。**race fix**：async get 完成时用 functional setState 判定 `current.kind === initial.kind` 才用 stale 恢复，避免覆盖用户已触发的 generate。**自动盖 generatedAt 戳**
- [x] **`GeneratedAtBadge` 组件**：done card 上方显示生成时间 + "X 分钟前"，> 10 分钟橙色警告"可能不含最新消息，请重新生成"。让 stale 状态一眼可见（用户曾切回客户看到 1 小时前的 prompt 误以为是当下，抱怨"时间错 + 缺消息"）
- [x] **`buildFollowUpMessage` / `formatUpdate` 注入精简客户档案**（三个 prompt 文件）：续聊也带 `[Customer Context]` block + Vehicle Interests，防 thread 长后 AI 忘客户 anchor。Section 标题改成 `[Recent Chat History — last 50, may overlap...]` 不再骗 AI 说是新增消息

#### 防跨聊天污染（jumpToChat 严格身份校验）

- [x] **`jumpToChat` 加 RequireMatch + `verifyHeaderMatches`**（`lib/jump-to-chat.ts`）：之前 `headerChangedFrom` 弱兜底"只要 header 变了就算成功"会导致跨聊天污染（搜索过程中 WA 临时切到错 chat，DOM 读到别人消息，`syncMessages` 写错位到目标 contact）。新增严格判定（phone digits 或 name 命中 header）。AI 自动化路径必须传 `requireMatch`；用户主动跳转路径保持旧宽松行为
- [x] **三个 ReplySection 全路径加 verify**：`loadChatMessages` / `loadAiMessages` / `loadDiscussMessages` 都加 jumpToChat requireMatch + 写 DB 前 sanity check（防 race：generate 期间用户手动切 WA chat）。needsJump=false 路径也加 verify

#### Emoji 客户名 hotfix — 防跨聊天污染的副作用

- [x] **`verifyHeaderMatches` 比对前两侧剥 emoji**（`lib/jump-to-chat.ts:92-130`）：
  - 起点：销售在 K-lonchito（Peruvian 客户，wa_name = `"K-lonchito 🥰🥰🥰"`）点 Gem 生成回复，报"当前聊天没有可读消息，且数据库里也没历史记录"——但 WA Web 上明显有消息
  - 根因：旧逻辑 `headerLower.includes(c.toLowerCase())` 整串比对，candidate `"K-lonchito 🥰🥰🥰"` 不在 header `"K-lonchito待二次跟进 异日必约"` 里（header 不带 emoji）→ verifyHeaderMatches 返 false → DOM 跳过 → DB messages 也 0 条 → 抛 cold-start 错
  - 影响面（service_role 全 org audit）：**120 / 4437 contact (2.7%) name/wa_name 带 emoji**。其中 **58 个硬挂**（emoji + DB 空，AI 完全废）+ **62 个隐性失效**（DOM 路径被卡 → syncMessages 永远不写新消息进 DB → DB 历史冻结在某老快照，AI 看不到客户最近消息但销售察觉不到，只会觉得 AI 智商不行）
  - 硬挂 stage 分布：lost 34 + negotiating 8 + stalled 8 + new 8 → **24 个活跃漏斗里的客户 AI 完全用不了**
  - 修法：新增 `stripEmojiAndNormalize` helper（`\p{Extended_Pictographic}` + `\p{Emoji_Modifier}` + VS16 `️` + ZWJ `‍`，**不要用 `\p{Emoji}`** —— 它把 `# * 0-9` 等基础字符也算 emoji-candidate，会误剥客户名里的数字），candidate 和 header 都先 strip 再 includes。剥完后为空（纯 emoji 名）自动被 `length >= 2` 过滤
  - 测试：20 条 case 全 PASS（11 真实 worst-case 含 K-lonchito / Zouhour / 😇Pee 含前后包夹和 ZWJ 组合 emoji；5 边缘 / 4 regression 防误剥数字/连字符/撇号/#）

#### 自动 backfill NULL sent_at + 一次性 backfill 失败教训

- [x] **`syncMessages` 加 `backfillNullSentAt`**：DOM 新拿到准确 timestamp 时反向 UPDATE DB 里 sent_at IS NULL 的老行。`sent_at=is.null` filter 保证不覆盖已有时间（幂等安全）。配合 readChatMessages 修源头，老 NULL row 在用户重新打开聊天时自动填上真实 sent_at
- [x] **历史 1362 行 NULL sent_at 一次性 backfill + **立即回滚****：scripts/backfill-null-sent-at.mjs 用 `sent_at = synced_at` 近似 backfill。用户实测发现 Samuel 那 PDF 实际 5-21 14:11 客户发的被错标成 5-26 15:26（synced_at 是销售首次打开 WA sync 进 DB 的时刻，跟实际发送时间可能差几天）。立刻 rollback-null-sent-at-backfill.mjs 用 `sent_at = synced_at` 精确相等作签名识别 backfill 行（真实 WA sent_at 精度只到 minute，不会等于 microsecond 级 synced_at），1362 行全部回滚成 NULL。**教训**：DB 数据 backfill 不能凭"看起来差不多对"的近似，最稳还是修源头 + 用户重新打开自动填

#### Meta Conversions API + AI 自动推断 customer_stage（业务功能）

- [x] **`fb-conversions.ts` Meta CAPI 客户端**：`mapStageToFbEvent` 把 customer_stage 映射到 Meta 标准事件（qualifying→Lead / negotiating→InitiateCheckout / quoted→AddPaymentInfo / won→Purchase / lost→Lost；new/stalled 跳过）；fire-and-forget 调 `conversions-api` Edge Function 不阻塞 UI
- [x] **`stage-inference.ts` + `useAutoFbStage` hook**：LLM 看聊天判断 5 个 stage 输出 confidence + reasoning。守护规则：每 contact 1h 内最多 1 次 AI 推断；消息 < 5 条 / 最后入站 > 30 天 / 24h 内有 manual 改 stage / won 锁 / lost 半锁 / confidence < 0.8 → skip
- [x] **service-worker 加 `INFER_STAGE` handler** 调 callQwen
- [x] **events-log 钩入 `triggerFbConversion`**：`logContactEvent('stage_changed')` 自动触发 Meta 转发；contact_events 加 fb_conversion_sent / fb_lead_received 事件类型
- [x] **migrations 0028-0030**：contacts 加 `fb_lead_id` / `ctwa_clid` / `fb_ad_id`；vehicle_media 加 `file_name`；contact_events 加 fb_conversion_sent / fb_lead_received 事件
- [x] **functions/conversions-api + fb-lead-webhook**：Meta 转发 + FB lead form 接收 Edge Functions
- [x] **TimelineSection 显示 AI stage 推断的 confidence + reasoning + FB 事件 icon**
- [x] **ContactCard 接入 `useAutoFbStage`**（跳过群聊）

#### 其他

- [x] **vehicle-matcher 重构 `scoreVehiclesByText`**：substring 二元匹配 → 打分式（精度更高）；`vehicle-aliases.ts` 加 GAC Trumpchi（Emkoo / GS8 / GS4）中英别名
- [x] **VehicleRecommendations 用新 scoreVehiclesByText**
- [x] **auto-reply 用 vehicle_media.file_name 真实文件名** 发图，替代之前生成的占位名
- [x] **bulk-extract 顺手 `syncMessages`**：批量抽取时把 DOM 抓到的消息持久化进 messages 表

### 近期补完（2026-05-27）— FB ad-reply pair DOM 漂移：客户首句丢失

**起点**：销售给 +226 客户（Burkina Faso，从 FB Ad 跳进 WA 的 lead）发了 17 张 Changan UNI-K 图让 GPT 续聊，GPT prompt 里 chat history 完全没出现客户的 "Hi, I'm interested in the Changan UNI-K."，也没有销售那条 ad reply card 的正文 "...UNI-K Global - 15% more power..."，只剩"Facebook 广告"4 个字 + "[Sales sent 17 photos to customer]" 占位。GPT 不知道车型，只能空泛问"SUV / 轿车 / 皮卡"。

**根因 1（findDataId 误判 dup）**：WA Web 给 FB ad-reply pair **各自建独立的 conv-msg- wrapper**（兄弟节点不嵌套），但 **data-id 完全一样**（销售 ad card outbound + 客户对 ad 的 reply inbound 共享同一个 32 字符 hex）。`findDataId` 用 `closest('[data-testid^="conv-msg-"]')` 后两条 bubble 拿到不同 wrapper element 但 data-id 相同 → `seen.has(id)` 把客户 inbound 当 dup 跳过 → AI 永远看不到客户首句话。Chrome MCP 实测确认：`bubbles[0].closest(...) !== bubbles[1].closest(...)` (sameWrapElement: false) 但 `data-id` 相同 (sameDataId: true)。

**根因 2（.selectable-text 已弃用）**：新版 WA Web 完全放弃 `.selectable-text` class，bubble 文本直接挂在 `.copyable-text` 自身的 textContent 上。`getMessageText` 三条 fallback 全部依赖 `.selectable-text` 找最长 → 全空 → 走最后兜底"任意 `.copyable-text`"拿到**第一个**（FB 卡片 header "Facebook 广告"）→ 正文丢。

- [x] **`findDataId` 加方向后缀 disambiguator**（`whatsapp-messages.ts`）：检测同 data-id 是否被 ≥2 个 conv-msg- wrapper 共享，是的话加 `::out` / `::in` 方向后缀（FB pair 必然一外一内）；单 wrapper 仍返回原 wrapId 不带后缀（**~99.5% 历史消息 wa_message_id 不变，不会大批量 DB dup**）
- [x] **`getMessageText` 加"最长 .copyable-text textContent"兜底**：放在 `.copyable-text .selectable-text` 之后，新 WA Web 没 `.selectable-text` 时挑最长 `.copyable-text` 自身文本——FB ad card 卡片标题"Facebook 广告"短、正文长，取最长不会错

**Chrome MCP 实测验证**：修复后 readChatMessages 三条全过：(out, `..::out`, "Hi, check out the UNI-K Global - 15% more power and a panoramic roof for $11,000+ less than the Toyota RAV4!")、(in, `..::in`, "Hi, I'm interested in the Changan UNI-K.")、(out, album-id, 空→detectMediaKind→[图片])。

**教训**：closest + testid 也不够 — 同 data-id 多 wrapper 是 WA Web 的真实行为（at least 在 FB ad-reply pair 场景），不能假设"closest 到同 wrapper = 同消息"。Lead-from-FB-ad 场景特别多，每个被踩到的客户**第一句话 inbound 永远丢**——而这通常是客户唯一明确说出"想买什么车"的那句话，AI 全瞎猜。

### 近期补完（2026-05-29）— 车源按上传人排序（自己的优先）+ created_by 回填

**起点**：用户看 AI 回复 tab 的车源**选择器**下拉，提需求"哪个业务员上传的车源，能优先看自己的，然后在看到别人的"。澄清后确定：(1) 选择器 + 车源 tab 网格都要自己的排前面；(2) 历史车源回填上传人——brand 以「Grant」开头的归 wanglincheng23，其余归 boss；(3) 卡片/列表显示上传人。

**前提缺失（不是 bug 是从没做）**：`vehicles.created_by` 列一直存在（FK → auth.users, ON DELETE SET NULL），但**插入代码从没写过它**——org Miles 46 条车源全是 NULL，"按上传人排序"的前提数据整体缺失。

**修法**：
- **回填**（`scripts/backfill-vehicle-uploaders.mjs`，service_role REST + 分页 + `--apply`）：规则 `brand.trim().toLowerCase().startsWith('grant')` → wanglincheng23 (`f06ce7c8`)，其余 → boss daimenglong (`ecca2247`)。PATCH filter 带 `created_by=is.null` 双保险（幂等，再跑不改已填行）。结果 36 boss / 10 Grant / 0 NULL
- **新建写入**（`VehicleModal.tsx` create-insert 分支）：`supabase.auth.getUser()` 拿当前用户写 `created_by`
- **排序**（`VehicleRecommendations.tsx` 的 VehiclePicker + `VehiclesPage.tsx` 的 `filtered`）：own-first 分区——mine 在前 others 在后，`mine.length > 0` 才重排否则保持原序。⚠️ VehicleRecommendations 的**自动匹配推荐 chip 仍按相关度 score 排序没动**，只有手动**选择器**是 own-first
- **徽标**（新建共享 `panel/components/UploaderBadge.tsx`）：自己绿色「👤 我上传」/ 别人 shortName。复用 `ScopeContext` 的 `myUserId` + `membersById`，**不额外发 RPC**
- **样式**（`styles.css`）：`.sgc-uploader-badge` 加 `align-self: flex-start` 防 column-flex 下 inline-block 被 blockify 拉满整行

**验证**：`npm run typecheck` + `npm run build` 通过。⚠️ **线上 UI 未在浏览器实测**（无 Chrome MCP 连接 + dev server 未跑），靠 boss 装新包后肉眼确认排序 + 徽标。

**教训**：`created_by` 这种"FK 早建好但插入代码从没写"的列很坑——做依赖它的排序/过滤功能前先 SQL 确认列**真有数据**，别假设 FK 存在 = 有值。email→user_id 走 GoTrue admin API（`GET /auth/v1/admin/users?page=&per_page=`），注意拼写：用户给的 `wanglingcheng23` 实际是 `wanglincheng23`（少一个 g），差一字母查空，要跟现有 org members 交叉核对再下手。

### 近期补完（2026-06-08）— WA Web 删 .message-in/.message-out：翻译全挂 + 消息方向判反 + Gemini 选模型

**起点**：用户报"现在翻译开也不翻译了"，要修；同时要 Gemini 加"可以选模型，自动选 3.5 Flash"。修完后用户又报"明明我发的图片，你非得说客户发给我的，你把我发的消息都识别成客户给我发的了"（消息历史 modal 里出站图片+回复全标成 inbound）。

**根因（Chrome MCP 实测）**：新版 WhatsApp Web（2026-06）**彻底删掉了 `.message-in` / `.message-out` class**——`document.querySelector('div#main').querySelectorAll('.message-in,.message-out').length === 0`。`.selectable-text` 也早已弃用（正文直接挂 `.copyable-text` 自身 textContent）。消息级元素现在只剩 `[data-testid^="conv-msg-"]` wrapper（class 是混淆的 `x1n2onr6 xscbp6u`，无语义方向）。连环挂三处：
1. `auto-translate.ts` 全部查 `.message-in,.message-out` → 找到 0 个气泡 → 翻译开关开着也永不翻译、不注入 🌐 按钮（翻译无 DB 兜底所以彻底瞎）
2. `readChatMessages` 的 `fromMe = el.classList.contains('message-out')` → 永远 false → **所有消息当成入站**（commit 32ca5bb 加了 conv-msg 兜底保住了消息内容，但方向判定还用死掉的 class，等于把出站全写成 inbound）。AI 有 DB 兜底所以没立刻露馅，但消息历史 + useMessageSync 写 DB 全反
3. 图片气泡没有 `.copyable-text`，几何兜底量整个满宽 wrapper（center≈panelCenter）→ 出站图判不出靠右 → 也成入站

**修法**：
- `auto-translate.ts`：新增 `getBubbles()` 走 `[data-testid^="conv-msg-"]`（旧 class 在则兼容）；`readBubbleText` 改读 `.copyable-text`（`.selectable-text` 没了）；气泡标记类换成 `.sgc-bubble`（CSS 同步加，旧 message-in/out 保留兼容）
- `whatsapp-messages.ts` 新增 `isOutboundBubble(el, panelCenter)` 多信号判方向：① 旧 class ② `[data-icon="tail-out"]`/`tail-in`（每段连续消息只有第一条带尾巴）③ 送达状态 `[aria-label*="已读/送达/已发送/待发送"]`（出站独有，入站绝无）④ 几何兜底量 `.copyable-text` 或最大 img/video（**绝不量满宽 wrapper**）。`findDataId` 的 FB-pair `::out/::in` + 主循环 fromMe 都改用它
- `message-sync.ts` 新增 `fixDirectionMismatch`（方向自愈）：`syncMessages` 用 `ignoreDuplicates:true`，旧错行重新 sync 改不掉 → 2 条批量 UPDATE（出站一批/入站一批）+ `.neq` 只动方向不符的行，用户重开聊天时把 DB 老错行纠回。`database.types.ts` 给 messages Update 类型补 `direction?`（本来当不可变没列）
- **Gemini 选模型**：新增 `lib/gem-models.ts` 预设（flash 默认 / pro / flash-lite，关键词 prefer+avoid 匹配，升版本号不坏）；`gem-automation.ts` `selectModel` 重写成按 prefer 命中 + avoid 排除选**指定**模型（之前写死强制 Pro 还排除 Flash），已是目标模型就跳过开菜单；`GemReplySection` 加模型下拉存 chrome.storage（`gemModel`，默认 flash）；手动 + 自动回复（`auto-reply.ts`）共用；service-worker 透传 `avoidModel`

**验证（Chrome MCP 实测）**：翻译——`getBubbles` 从返回 0 变成正常找到气泡 + 读出英文正文 + shouldTranslate=true。方向——真实客户 Reza 混合聊天 `isOutboundBubble` 对照 prePlain sender ground truth **18/18 全对**；图片几何左对齐图(中心659)→入站、右对齐图(中心826)→出站，数学对称正确。Gemini——真实菜单 flash→「3.5 Flash」、pro→「3.1 Pro」、触发器识别 + 已选则跳过全过。typecheck + build 通过。

**教训**：① 任何"扫 WA 消息气泡"的代码一律走 `[data-testid^="conv-msg-"]`，别再依赖 `.message-in/.message-out` 或 `.selectable-text`——它们已被 WA Web 删除。② 判方向别只看 class，用 tail-out + 已读状态 + 几何三重兜底；图片几何**只能量 img/copyable-text，不能量满宽 wrapper**。③ `syncMessages` 是 `ignoreDuplicates`，改了 DOM 解析逻辑后老错行不会自动改，要专门写 UPDATE 自愈。④ 翻译跟 readChatMessages 是同一套 DOM 依赖，以后改一个记得另一个也过一遍。

### 近期补完（2026-06-11）— last_message_direction RPC 全表扫超时（57014 + Thread killed）

**起点**：用户在 Supabase 后台 PostgREST Logs 看到满屏 `Warp server error: Thread killed by timeout manager` + 一条 `POST /rpc/last_message_direction_per_contact … 500` + `{"code":"57014" … canceling statement due to statement timeout}`，问"这个会有问题吗"。

**根因（实测拿数据，不靠猜）**：`last_message_direction_per_contact` RPC（0019 建、0022 扩）对**整张 messages 表做聚合**（每 contact 的 max(sent_at) filter + count(\*) filter，group by contact_id）。service_role REST 实测 `messages` **38,625 行**、`contacts` 6,177 行。现有索引 `(contact_id, sent_at desc)`（0011）**不含 `direction`**，帮不上这个查询 → 走顺序扫描，把每行的肥 `text` 正文都从堆里读出来。叠加 3 销售每 5min 各并发跑一次 + `useMessageSync` 一直 upsert / 方向自愈 UPDATE 造成的表膨胀 → 38k 行也能撑爆 authenticated 角色 8s `statement_timeout`。`is_org_member` 查过是 `stable`（不是逐行求值，排除嫌疑）。

**影响（不崩，所以静默）**：`fetchMessageDirections`（`useCrmData.ts`）把 500 catch 成空 map → 两层退化：① 「我该回」少了 `lastInbound > lastOutbound` 回填信号（"昨天点开过但没回"的老 case 不进桶，0019 当初要解决的 Antoine 案例复发）；② chat-classifier「有历史保护」拿不到 inbound/outbound count → 火热但近期沉默的客户被 stage-sync 又一次自动 negotiating→lost（2026-05-19 Aca/DON/Grant Wang 那批根因）。外加每次失败前都白跑一个 8s 全表扫 × 3 人 × 每 5min，连接线程堆积拖慢**整库其他查询**，不是孤立的。

**修法**（migration `0032_messages_direction_covering_index.sql`，纯 DB，不动扩展代码）：建一个正好覆盖该查询 3 列的索引 `(contact_id, direction, sent_at) WHERE sent_at IS NOT NULL` → 聚合走 **index-only scan**，完全不碰肥 `text` 堆，38k 行窄索引扫描几十毫秒级。`CONCURRENTLY` 不锁表实时建（但不能在事务块里跑，SQL Editor 里单独执行）。配 `vacuum (analyze) public.messages` 清一次 upsert/UPDATE 攒下的死元组膨胀 + 让 planner 立刻用新索引。

**验证**：根因由实测行数（38,625 messages）+ RPC/索引定义审查确认；修复 SQL + migration 文件已写好。⚠️ **建索引这一步要用户在 Supabase SQL Editor 手动跑**（`.env` 只有 PostgREST service_role key，连不了 DDL；`pg` 依赖连的是旧 localhost 库）——跑完后看 Logs 里 500/57014/Thread-killed 几分钟内停止即确认。

**教训**：① 任何"对整表做聚合"的 RPC，被聚合表有大字段（这里是 `text` 正文）时，要给查询建**只含所需列的覆盖索引**让它走 index-only scan，别让顺序扫描读肥行。② migration 不一定要走 `npm run package`——纯 DB 改动（加索引/RPC）不影响扩展 dist，不用重新打包强制升级，直接 SQL Editor 跑 + 提交 migration 文件即可。③ 长期：messages 涨到几十万行后 index-only scan 也会线性变慢，到时改用 trigger 维护 per-contact 汇总表（last_inbound/outbound + counts），RPC 只读 N 行。

### 近期补完（2026-06-18）— 引用回复读成"被引用原话" + 删除消息当成附件

**起点**：用户看 GPT 给 D'AFRIC 客户（Benin，法语，租车行）的 prompt，报"喂给 AI 的内容不对、全是法语看不懂"。深挖出两个独立的 DOM 解析 bug，都把垃圾喂给三个 AI（Gem/Codex/GPT 共用 `readChatMessages`）：(1) 客户的引用回复被读成"被引用的原话"；(2) 删除消息被当成附件。

**根因（Chrome MCP 实测 live DOM，不靠猜）**：
- **引用回复**：客户"回复"某条消息时，WA Web 把被引用的原消息塞进 `[data-testid="quoted-message"]` 预览框，跟真回复同在一个 bubble。实测 D'AFRIC 那条结构：外层 `.copyable-text[data-pre-plain-text="[3:11 PM,...] +229...:"]` 包住「引用原话(第 1 个 selectable-text) + 真回复(第 2 个 selectable-text)」。`getMessageText` 的 `realWrap.querySelector('.selectable-text')` 命中**第一个 = 引用原话** → 把销售自己之前发的话当成客户消息，真回复"Je préfères... une représentation ici a cotonou ?"（客户唯一明确的问题——科托努有没有代表处）整条丢失。AI 据此瞎答，还在策略里写"客户复制了我的消息"。引用回复在销售场景极常见 → 静默污染大量对话。
- **删除消息**：`copyables: []`——"你已删除这条消息"是不可复制系统占位，不在 `.copyable-text` 里 → `getMessageText` 返回空 → 走 `detectMediaKind` → 没图/视频/文档就兜底 `[媒体]` → `collapseMediaRuns` 合并成 "sent N media items" 发给 AI。`isDeletedPlaceholderText` 跑在最后，但那时 text 已是 `[媒体]`，删除判定永远不触发。实测删除气泡带 `[data-icon="recalled"]` 撤回图标。

**修法**（`content/whatsapp-messages.ts` + `content/auto-translate.ts`）：
- `getMessageText`：读文本前先把 `[data-testid="quoted-message"]` 子树整个剥掉（clone + remove），剩下的就只有真回复。剥完后所有原有路径（realWrap→selectable-text / longest / copyable 兜底）自然只读到真回复，跟 `.selectable-text` class 在不在都不影响。
- `readChatMessages`：`getMessageText` 返回空时，走 `detectMediaKind` **之前**先判删除——`[data-icon="recalled"]`（语言无关最稳）或整气泡文字（`readStrippingInjections(el)` + `stripTrailingMeta`）命中删除占位 → 标 `[已删除]`，绝不当媒体。
- `auto-translate.ts` 的 `readBubbleText`：**同源 bug 第二处**（最初漏了，用户看到 D'AFRIC 客户 3:11 那条引用回复的中文翻译翻的是引用框里销售自己的旧消息、不是客户问的"科托努有没有代表处"才发现）。翻译和读消息是两套独立 DOM 逻辑，`readBubbleText` 也照样 `realWrap.querySelector('.selectable-text')` 命中引用框第一个 → 翻译错对象。同样在开头剥 `[data-testid="quoted-message"]`。全代码库读正文只此两处（`getMessageTimestamp`/`getMessageSender` 只读 pre-plain 属性、引用框预览无该属性，不受影响）。

**验证（Chrome MCP live DOM）**：用户在 D'AFRIC 标签页 console 跑新逻辑——`引用回复_AI现在看到` = "Je préfères cette option, mais dite moi aviez vous une représentation ici a cotonou ?"（真回复）；`删除消息_AI现在看到` = "[已删除]"。`readBubbleText` 修后逻辑跟它完全相同，同一证据覆盖。typecheck + build 通过。

**教训**：① WA Web 引用回复的被引用原话在 `[data-testid="quoted-message"]` 里，任何读 bubble 文本的逻辑都要先剥它，否则读到的是"被引用的旧消息"（常是销售自己的话）而非真回复——这是 `findDataId` / FB ad-pair 之后**第 N 次** WA Web 多文本块结构坑。**读正文有两处独立路径：`getMessageText`（喂 AI）+ `auto-translate.ts readBubbleText`（消息气泡翻译），改一个必须同步改另一个**（AGENTS.md 早有"翻译跟 readChatMessages 同源"警告，这次还是先漏了翻译那处，被用户抓到）。② 删除/撤回消息不在 `.copyable-text` 里（copyables 为空），带 `[data-icon="recalled"]`——空文本 bubble 走媒体探测前必须先判删除，否则被当附件。③ 任何"空文本 → 当媒体"的兜底前，都要先排除「删除占位 / 引用框被剥光后的空壳」等非媒体空文本。

### 近期补完（2026-06-20）— 多代理代码评审：堵 4 个静默数据污染/丢失洞

**起点**：用户问"这个项目逻辑上或代码上有什么问题"。跑了个多代理评审（5 维度并行读真实代码 + 对每条 P0/P1 做对抗性核实），核实出 3 个 confirmed P0 + 若干 P1。用户选了"改，但不增加任何发版/团队工作量"——全部纯扩展代码改动，`npm run package` 流程不变，团队装新 zip 即生效。

**根因 + 修法（4 处，都是核实过的真洞，不是猜）**：

1. **auto-reply 防发错人 + 防跨聊天污染**（P0，`content/auto-reply.ts`）：这条**唯一无人值守**路径有两处裸奔——三个手动 ReplySection + bulk-extract 都有 `verifyHeaderMatches`/`waitForActiveChatPhone` 身份校验，唯独自动回复一直漏了。① `buildPrompt` 里 `syncMessages(contact.id, messages)` 前没校验当前 chat 是不是目标客户 → WA 在等 Gem 的 ~2min 里被切到别的聊天时，会把别人的消息按 `(contact_id, wa_message_id)` UNIQUE **永久**写进这个 contact，且 AI 基于别人对话生成回复。② 发送前（line 196 jump 后）也没校验 → 直接把 AI 回复**发给另一个真实客户**（系统最坏失败）。修法：导入 `verifyHeaderMatches`，定义复用的 `requireMatch={phone,name,waName}`；两处 `jumpToChat` 都传 `requireMatch`；`buildPrompt` 里 `onRightChat` 为 false 时丢弃 DOM 消息、退回纯 DB 历史（`mergeDomWithDbMessages([], id, 50)`），绝不 sync；发送前 `verifyHeaderMatches` 不过就 `throw`（phase=error，banner 报错，宁可不发也不发错）。失败模式安全：正常情况行为不变，只有"聊天没切对"异常分支才介入。

2. **bulk-extract 1000 行陷阱**（P0，`lib/bulk-extract.ts:110` `findExtractTargets`）：`.select('*').eq('org_id', orgId)` 没分页 → PostgREST 静默 1000 行截断。org 已 1700+ 客户，>1000 的那半**永远不进批量抽取**（销售看到"抽取完成"，实际一半客户从没被处理，而这正是 AI 回复质量依赖的数据）。同一陷阱本仓库已害过 3 次。修法：改 PAGE=1000 分页拉全集 + `.order('id')`（PostgREST 不保证 range 跨页稳定），写法对齐 `loadAllMessages`。注：这里的 `syncMessages` 其实已被 `waitForActiveChatPhone`（line 164）挡住污染，所以**只动分页**，不碰 jump 逻辑。

3. **FB 广告配对方向判定漏传 panelCenter**（P1，`content/whatsapp-messages.ts:233` `findDataId`）：`isOutboundBubble(el)` 调用时没传 `panelCenter` → 几何兜底（信号 #4）被关掉。FB ad-reply pair 的纯媒体 bubble 没有 class/tail/送达状态信号 → 一外一内的两条都默认判 `in` → 都拿 `::in` 后缀 → `wa_message_id` 撞车互相覆盖，**客户对广告说的第一句话（通常正是"我要哪款车"）整条丢失**。修法：`findDataId(el, panelCenter?)` 透传，主循环 line 599 调用处把已算好的 `panelCenter` 传进去。

4. **静默失败告警**（P2，`content/whatsapp-messages.ts` `readChatMessages`）：聊天开着（main 在）但 0 条 bubble 解析出来、而面板里有 `[data-id]`/`[role=row]` 行元素 → 选择器疑似被 WA Web 改坏（"读不到消息"不是"没消息"，正是客户 inbound 静默消失的灾难模式）。修法：复用 `maybeLogReadFailure`（throttled 5s）打到 console 让 boss 截图。纯 console，对用户/流程零影响。

**验证**：`npm run typecheck` 0 错 + `npm run build` 通过。逻辑由核实代理对照真实代码确认；auto-reply 的两处 jump 已有 `requireMatch` 基建（jump-to-chat.ts 早支持），FB pair 几何对称、bulk-extract 分页写法均与现有同型代码一致。⚠️ auto-reply 防护要真实 FB lead 才触发，靠装新包后实战观察；DOM 读取回归可用测试号 13552592187 只读验证。

**教训**：① **任何写 `messages` 表的 AI 自动化路径都必须 `verifyHeaderMatches`/`waitForActiveChatPhone` 身份校验** —— 加新自动化路径时对照"三个 ReplySection + bulk-extract 都有、auto-reply 曾漏"这个清单，别漏。无人值守路径尤其要在**发送前**再校验一次（防发错人）。② **`isOutboundBubble` 在任何判方向的地方都要传 `panelCenter`**，否则纯媒体 bubble 几何兜底失效 → FB pair 方向判反 → 消息撞 id 丢失。③ 评审驱动的修复也走完整核实（对抗性 re-read 真实代码），评审代理会夸大（这次驳回了"删除当附件/版本闸门锁死/auto-reply 无限挂起"等几条），别照单全收。

### 近期补完（2026-09-13）— GPT 客户语言与段落保留

**起点**：用户反馈西语聊天生成英语回复、ChatGPT 空行进入 CRM 后粘成一大段，要求设置 R08 专用 GPT 并回复几位客户验证。

**根因**：`gpt-prompt.ts` 的默认角色只有笼统的“customer's language”，Custom GPT 首轮会跳过默认角色，续聊也未明确客户入站优先于旧 CRM Language/销售英语出站。`gpt-automation.ts` 两处对 detached clone 读 `innerText`，没有布局时退化为 `textContent`，丢失 `<p>`/`<br>` 边界。界面的 `pre-wrap` 与 parser/sanitizer 本身保留换行。

**修法**：首轮、Custom GPT、续聊统一注入 `[Reply Language]`，把原始客户入站作为语言证据，明确排除销售出站、广告、媒体等干扰。新增可序列化、自包含的 `readGptResponseSnapshot`，两处抓取共用语义 DOM 遍历，保留段落/列表/软换行并过滤思考区、按钮等。`GPTReplySection` 在客户正文为空时仍显示内部说明，方便看到 ASK_BOSS 的问题。

**验证**：12项语言 prompt 回归、7项 DOM→parser→sanitizer 回归、typecheck/build 通过。新 GPT 网页预览已验证“西语客户＋英语档案”输出西语，以及特批价格输出 ASK_BOSS/空客户正文。扩展部署及真实发送结果记录在 `分析导出/R08_GPT自动回复方案_2026-09-13/`；网页预览不等于新扩展已部署。

**教训**：不能依靠默认角色决定 Custom GPT 的语言；每次客户回复都给出入站证据和优先级。不要对脱离文档的克隆节点使用 `innerText` 恢复视觉排版。ChatGPT 提取函数经 `chrome.scripting` 序列化，所有运行时 helper 必须位于函数内部。真实客户试用仅按用户本轮明确授权执行，未授权时仍遵循测试号规则。

### 近期补完（2026-09-14）— 未联系误判与卢旺达线索清理

**起点**：用户要求删除未联系的卢旺达客户，并反馈姓名带 @ 的老客户误入“广告线索·未联系”、无 WhatsApp 号码无法退出列表。

**根因**：`filters.ts` 原判定只有 `isAdLead && !chat`；本机 JID/手机号匹配失败或未同步会话，就把有历史的客户也当作未联系。Chrome 当前列表的 350 个卢旺达相关号码中，166 个在 DB 有消息；其中 3 个邮箱姓名样本也有历史。未发现“@ 字符直接修改阶段”的分支。列表仅对 needsReply 提供处理按钮，广告线索无法操作退出。

**修法**：新增 `ad-lead-status.ts` 统一计数、筛选与行操作条件：无本机 chat、无消息历史、仍为 new、未标 spam、未手动处理。`fetchAdLeadIds` 仅在广告名单嵌入每人一个消息 id，不读正文，涵盖 sent_at=NULL；读取失败保留原状态并报告错误。消息保存成功发本地事件立即更新历史。`FilteredChatList` 加“已处理”“无 WhatsApp”，用 contact_tags 持久化；写成功才更新列表，所有客户右键可撤销。无匹配弹窗改为客观描述，不直接断言未注册。

**数据清理**：按当时“只看我的”列表快照锁定范围，排除任何消息、报价、任务、非 new 和其他归属异常。137 个目标全部仅由当前用户主理；完整备份后逐批校验 updated_at、归属与最新业务数据，再带 org/id/updated_at/new 条件删除。备份目录 `分析导出/rwanda-cleanup-2026-09-14/`；保留 213 条原列表记录，其中 166 条有消息。未清理同事独占的线索。

**验证**：5 项针对未联系的回归测试，连同已有 GPT 段落/知识测试共 26 项通过；typecheck、build、diff check 通过。已通过 Chrome 扩展管理页重载当前 `extension/dist`，恢复“只看我的”，实测未联系 136、卢旺达 0，新按钮可见。未在真实客户上点击处理按钮或发送消息。只构建本机版本，未发布 required_version、未提交或推送其他已有改动。

**教训**：本机无 chat 是匹配状态，不能代表业务联系历史；不能按 @ 姓名判定，不能用缺失消息时间推断没聊天。删除未联系线索前必须先校正筛选误判，再按消息/报价/任务证据核验和备份。新增处置操作要能持久化、报错和撤销。

### 近期补完（2026-09-16）— R08手动切换修复与积累改动发布

**起点**：用户反馈CRM里R08 GPT“点了没反应”，并指出长期未打包。核实最新zip和服务器required_version均停在0.1.0-20260909。

**根因**：GPT模板下拉value使用自动路由结果，其他车型分支会排除手选R08，R08自动识别还会禁用下拉。新加的3个实际React组件离线回归在修复前全部失败，分别复现生成/讨论选择回弹和R08下拉禁用。浏览器当前CRM可见Miles V2与R08选项，网页GPT规则更新与扩展发布是两条独立链路。

**修法**：`gpt-template-routing.ts`增加当前客户的manualTemplateId优先级；`GPTReplySection`在预览、生成、讨论和指导修改中统一传递，解除自动匹配导致的下拉锁定，增加“恢复自动匹配”。切客户重建组件，不串手动选择；会话仍按客户、模板和实际GPT身份校验。将本周积累的语言/段落抓取、模板批准知识、未联系线索判定、名下无本机会话客户展示及认证参考资料分组一起纳入安装包。

**验证**：7个回归脚本全部通过，Node测试报告75项（其中语言脚本内部另有12个case），35项路由/组件测试通过。TypeScript与Vite构建通过，diff检查通过。访问Chrome扩展管理页被浏览器安全策略拒绝，未绕过，因此发布后本机重载和新版真实WhatsApp UI验收仍待用户操作；不能把离线通过写成已在真实客户页面通过。版本发布和安装包校验记录在`分析导出/CRM发布_20260916/`。

**教训**：自动推荐不能覆盖明确的手动选择，生成/讨论必须与界面选中模板一致。区分“GPT网页已更新”“本地代码已构建”“安装包已发布”“用户已加载”四种状态；用户要求打包发布时执行完整发布流程，不能停在本地build。

### 近期补完（2026-09-17）— R08 技能迁移试点，尚未正式切换

- **起点**：老板要求“行，自己跑通了测测”，验证 GPT 退役后的技能迁移路线。
- **实测**：ChatGPT 账号可从 Skills 编辑器创建并自动安装私人技能。真正调用是 `@` 搜索后选中 `skillMention` 标签；`data-id` 必须匹配技能 ID。只填名称或普通 ChatGPT URL 不等于调用技能。预览/下载早前出现 `File not found`；老板在场复查时预览已恢复、下载提示 `Download started`，独立新对话6项知识验证通过。下载管理页被浏览器策略阻止，未绕过；随后老板提供本地下载zip，CRC通过、技能正文与源稿忽略空白全文一致，落盘完整性也已确认。恢复原因未确认，不应继续报当前预览/下载故障。详情见 `docs/R08技能迁移试点.md`。
- **修法**：模板 metadata v2 存技能 ID/名称，v1 保持原样；管理界面添加技能选项。`gpt-skill.ts` 使用真实选择器点击，再核标签与完整输入；生成/续聊/讨论均传当前技能。`#sgc_skill` 为 CRM 会话身份标记，打开网页前移除；旧 GPT 会话不进入新技能。
- **链接兼容**：新版网页部分命名链接没有DOM href；GPT各请求改为要求完整网址纯文本，实测样本链接可读，旧href链接提取继续兼容。
- **验证**：80项相关离线测试及构建通过，含实际模板表单回归。老板加载后，测试号码13552592187真实5轮通过首次生成、续聊、内部讨论、完整资料链接、ASK_BOSS/NO_REPLY空回复保护及回填预览；未发送消息。新增个人“R08 技能试点 · Miles”，不设默认；原正式模板URL/知识与备份一致，required_version仍0.1.0-20260916，未全员发布。新建技能按钮原误要求隐藏的GPT URL，已修复进最新dist/试点zip，下次重载生效。
- **教训**：ChatGPT 技能编辑器正文虚拟化，读取到的可见 `innerText` 不能当全文保存；必须从完整文件重建并核验。技能配置、实际选中的标签、保存会话三个身份必须一致；错误时不能回退普通聊天。加载/重载扩展此前受自动审批限制，老板已手动完成。CRM档案卡自动保存会写入模拟数据，模拟必须空档案段或先备份；本轮首轮3字段/3标签已精确清理并复核。WhatsApp草稿空字符串fill后可能恢复，最终须原生删除并复核。

### 近期补完（2026-09-17）— 历史销售指导与报价核算版本

**起点**：老板要求消除每个客户重复交代条件、重复算价的问题，继续完成历史记忆与报价链路。

**修法**：原对话销售指导以sales-history.v1追加归档（原日期/原消息/源对话保留，不升级为通用现价）；GPT每次读取相关历史。quote-input.v1交本地整数定点计算，计算结果自动回同一对话组织完整稿；quote-calculation.v1保留输入、来源、费用范围、结果及上一版ID，状态始终为草稿，绝不据此写已发送或任务。内部机器块必须剥离后展示，保存失败不显示成功。新需求隔离旧报价。

**验证**：93项相关离线回归及构建通过；51位客户136条历史指导逐条回读一致，测试/混杂身份等14条排除。真实数据库测试号两版报价与同ID重试通过。真实WhatsApp测试号内部讨论：刷新后只说沿用保存条件得到62000美元/31000每台；只改基本海运10000后得到61000美元/30500每台，两版均落库且parentId关联，原日期不变、DG按柜、FOB港杂不重加。核心客户档案未变。证据见分析导出/历史指导回填_2026-09-17/真实UI两版核算回读.json。

**教训**：归档日期不是原授权/查价日期；数学正确不代表模型提取的来源及授权已核实。原档案、任务、消息和已发报价不因历史回填而改写。此次未全员打包发布。

**真实联调修正**：GPT技能输入前自动切Work并核验；freight.kind只接受public_reference/owner_estimate，允许一次不改变事实的格式纠正。当前时间不能用电脑本地时钟却硬写Asia/Shanghai；现附实际浏览器时区和UTC ISO时刻，Chicago/Shanghai回归及真实请求均验证。Chrome网页控制不支持chrome://时，原生Chrome AX仍可进入已加载Sino Gear CRM详情，核对来源为extension/dist，点Reload看到Reloaded后刷新测试WA；此次已自行完成，不要再直接要求老板反复代点。

**最终收尾**：重载后的生成入口也完成自动核算→英文完整待审稿，61000美元/30500每台、档案段空、内部机器块未入客户正文，第三版引用第二版。14条本次测试事件按ID精确清理、原会话恢复，原12条快照事件和客户核心字段回读一致；快照不是所有类型事件全集，不为追求数量相等删除其他既有事件。未填入或发送WhatsApp。完整证据见分析导出/历史指导回填_2026-09-17/验收进度.md。

### 近期补完（2026-09-17）— 客户记忆、运费报价与 GPT 跟进发布

**起点**：老板要求减少每位客户反复交代条件，由 GPT 判断是否跟进及时间，移除 Claude、暂缓 Gemini 跟进；真实验收后明确要求“发布吧”。

**根因**：以往指导及报价条件分散在对话中，单次草稿无法表示已发送事实，也没有可靠的到期复核与人工接管边界。真实回放需区分报价后尚未问意向、已经问过待答和 PL/CI 仅处于草稿三种状态。

**修法**：sales-work-memory 按客户及需求保存指令和历史来源；freight-query/freight-research 保存可比公开参考及七天有效期，quote-calculation/quote-workflow 定点计算并追加报价版本。gpt-followup 的证据校验、固定任务 ID、写入日志及条件更新保护人工安排；gpt-followup-runner 通过 Chrome 闹钟重新读取上下文后交 GPT 复核，失败退避、同状态三次失败暂停。移除 Claude 调用及权限，抽出 ClientRecordCard，GPT 技能使用真实 Work 标签。

**验证**：发布前 135 项 GPT、跟进、运费、报价、记忆回归全部通过。真实测试号完成三类历史回放、唯一任务保存、刷新保留、Chrome 到期自行触发 GPT 复核并停止原任务；界面人工改期后两次保存均未覆盖。11 条测试事件及 1 个任务精确清理，原 25 条事件、原会话和核心档案保留，未填入或发送 WhatsApp。正式包、服务器 required_version 与 Git 推送另在发布记录核验。

**教训**：草稿不等于已发送；模型判断必须引用真实证据，人工接管优先。后台复核只覆盖当前登录用户已建立的 GPT 任务，依赖 Chrome、登录及已同步消息。七天运费过期在当前询价触发重查，不能宣称后台自动巡查所有航线。打包完成后需回读服务器版本，不能仅凭脚本退出码判定发布成功。

### 近期补完（2026-09-18）— GPT 完成判定与跟进错误隔离

**起点**：老板发来海地客户截图，“GPT未返回唯一的跟进判断”挡住了按中文指令生成的回复。

**证据与根因边界**：只读核对原 ChatGPT 对话，第 8 轮最终正文已正确表达两车当前均按集装箱方案、继续核查其他运输方式，且含唯一完整 crm_followup；第 9–10 轮是另一条后台复核，不是客户正文。旧轮询在 Stop 消失后四秒，只要内容长度不减就返回，未要求内容停止增长或本轮 Copy 出现；超时也返回最后片段，离线时间序列已复现该缺口。失败日志以前没存抓取原文，因此不能断言本次当时截断的准确位置。另一确定缺陷是跟进校验/保存异常会阻断整条正文展示。

**修法**：waitForCompletedGptResponse 要求停止生成、本轮 Copy、正文连续六秒完全相同；超时不返回片段。completeFollowupResult 将跟进异常作为单独状态，保留已完成正文、移除错误机器块，不虚报任务已保存。客户正文/档案中混入机器块仍阻断，报价核算失败仍阻断。失败日志补抓取原文和会话链接，方便今后精确诊断。

**验证**：新增 12 项时序、机器块及实际 React 组件回归，连同既有测试共 147 项通过。原客户对话只读检查，不在真实客户上点击生成、填入或发送。本机构建通过；通过 Chrome 原生扩展详情核对 extension/dist 并重载，WhatsApp 刷新后 CRM 正常，原销售指令仍在。旧失败状态不会因重载自动重放，不宣称已恢复该客户草稿或完成新的真实 GPT 生成。此次未更新团队 required_version。

**教训**：长度继续增加证明生成未结束；超时片段不是最终回复。附加跟进任务失败不能吞掉独立已完成的客户草稿。格式保护与失败提示要分别验证，并保留实际抓取证据。

### 2026-09-18追加：资料研究超过六分钟时过早超时

老板在 Didace 原对话（6aacdf83-ec00-83e9-991a-570d745cefd3）看到配置与运费已整理、客户正文为空，并提供 CRM “ChatGPT响应超时，尚未确认完整生成”截图。实际流程要求先返回 quote_input，再由 CRM 核算并请求最终正文；旧默认等待只有 360 秒，含研究、正文输出和最终 6 秒稳定确认，超时 catch 还会关闭 GPT 标签页，导致未进入核算续轮。

本次将默认响应等待统一为 20 分钟，保留停止生成、当前回合复制按钮、正文稳定 6 秒三项完成条件；超时抛专用错误并保留原 GPT 标签页，不采用半截正文。69 项相关离线测试与 TypeScript/Vite 构建通过，新增覆盖超过六分钟完成、旧截止前刚开始稳定、20分钟硬上限。Chrome 原生扩展页已核对来源 extension/dist，重载后看到 Reloaded；未全员发布，未在真实客户上点击生成或发送，不能宣称该客户旧失败草稿已恢复或完成新的真实长研究验收。

排除项：对网页 innerText 直接 JSON.parse 会因链接图标产生视觉换行报错，但插件的语义 DOM 提取会排除 aria-hidden 图标，按实际提取规则复核 quote_input 可正常解析；不要为这个视觉假象添加 JSON 自动修复。

### 近期补完（2026-09-18）— 浏览器观察后的消息与报价链路修复

**起点**：老板要求把控剩余额度与修复范围，必要时由老板做业务验收。此轮先处理真实观察到的消息遗漏、译文混入、报价展示、跟进保存、模板及旧草稿问题；不是全部架构问题完成。

**根因**：只读原聊天 DOM 确认 `data-virtualized="true"` 空壳被旧读取器当 `[媒体]`；Immersive Translate 译文节点混在正文。原数据库 ignoreDuplicates 不会覆盖全部旧正文，但也不能修复占位/译文旧记录。立即跟进错误绑定模型时间格式；本地核算金额未呈现在 ChatGPT 原草稿。

**修法**：`whatsapp-message-dom.ts` 共享原文清洗及气泡识别；`collectRecentChatMessages` 显式生成前加载最近挂载的 50 行，缺行则报错，切客户或用户滚动立即停止。`repairObservedMessages` 等待带旧值比较的修复完成再读取证据；同步失败不提交指纹。`act` 时间由程序生成，仍需真实依据。`quote-preview` 以会话和 assistant 消息 ID 绑定公开核算草稿，本地展示且不纳入 GPT 抓取，不发送第二轮。新草稿保存输入指纹；手选模板按组织/客户持久化；当地时间优先国家。

**验证**：11 个相关回归脚本共 147 项通过、typecheck/build/diff check 通过。原生 Chrome 核对加载 `extension/dist`，Reloaded 后刷新 WhatsApp；本机已加载本轮构建，覆盖本文件较早的“待重载”状态。测试号 13552592187 验证手选 R08 切面板保留，结束已恢复 Miles V2 自动匹配；未发消息。本轮尚未跑真实 GPT 报价→跟进整链，未发布团队 required_version。具体边界与未完成事项见 `docs/浏览器问题修复与验收_20260918.md`。

**教训**：DOM 空壳不是媒体；插入去重不等于旧错误会修复；本地报价展示不等于修改服务器聊天。不能用离线通过替代业务验收。长期事实记录、旧价格知识冲突、后台复核调用次数、资料交付闭环、真实运费及载重匹配仍需继续验证和实现。

### 近期补完（2026-09-18）— 发布浏览器问题修复版

**起点**：老板明确要求“你是不是得发布一下”。**根因**：此前本机加载成功不等于团队发布。**修法**：沿用 package 发布流程，正式 BUILD_VERSION 为 `0.1.0-20260918`，安装包 `dist-zips/sino-gear-crm-v0.1.0-20260918.zip`，线上 required_version 已更新并回读一致。**验证**：147 项回归再次通过；构建、ZIP 完整性、32 文件逐字节比对通过，SHA256 及验证边界见 `docs/浏览器问题修复与验收_20260918.md`。**教训**：真实客户 GPT 当前在生成，本次发布时没有为了重载正式版本标识而中断它；团队安装包需另行分发。独立 webhook 修改不随此次提交部署。发布不代表待办业务验收已通过。

### 近期补完（2026-09-18）— 事实库与 GPT 后台结果交付

- **起点**：老板反馈 GPT 新页经常要手动激活才能回收，以及希望直接从已有记录建事实库。
- **修法**：新增 `sales_facts` 与审计历史，来源/客户/订单/有效期匹配后条件注入；148 条首批事实已导入。`gpt-automation` 有限唤醒、防丢弃与交付前保存；`gpt-run-delivery` 按请求编号持久化状态和结果，UI 短轮询，可恢复发送后中断的同一页。
- **验证**：119 项专项及相关回归通过，build 通过；RLS、版本审计与本机事实库读取已验证。José 无指令实机直接推进 PI/30%定金。第二轮 Didace 实机结果见 `docs/AI回复改进_协作与验收.md`。
- **以后注意**：不得在结果持久化前关 GPT 页；恢复不能重发 prompt，不能接受 baseline 之前旧回复；用户已转移焦点不抢回。运费导入日期不算查价日期、核算输入不等于已批准来源、订单价不可写成全局价。新自由文本仍走工作记忆，不宣称已自动结构化全部历史。
- **实机追加**：Didace 最终后台回复覆盖八项采购问题并推进 PI，日志 1 次调用/261.1 秒。WhatsApp 长消息必须识别 `caption-read-more-button` 自动展开后再采集；渲染重建后按消息 ID 重找节点。复杂单仍约 9.6 万字符，不宣称已整体瘦身 80%。

### 近期补完（2026-09-18）— 上下文继续去重与 API 预算

老板要求继续优化并按团队量估算 API 费用。主回复/讨论传入本轮完整工作记忆及备注供跟进块引用；只有同客户、同 scope、同记录 ID、原文完全一致的长销售指导可引用，独立跟进仍保留全文。跟进引用校验和保存使用原始完整证据，不缩短数据库记录。上次决策去掉持久化内部字段，保留业务决策/保护/复核状态。77 项回归及 build 通过；这次新增构建尚未重载当前浏览器，未调用付费 API、未全员发版。不是完整职责拆分。

只读 09-04～09-17 CRM 消息聚合，以近期四个完整日约 240 个入站轮次/天规划 250 次生成。经济型约 20～40 元/天的预算以精简到 5k～10k 输入 token 为前提，当前复杂单仍未达标；不能拿字符当计费 token。详情 `docs/API成本估算_2026-09-18.md`。

### 近期补完（2026-09-18）— 保留网页方案，正文不等跟进补块

老板明确因费用取消 API，继续网页方案并节约 Claude 额度。长语言证据已在本轮 Chat History 全文呈现时才允许摘录并引用原始 message ID；不在渲染历史内的长证据仍全文，尾部语言要求不得丢失。销售规程/记忆说明精简，原始客户问题及 owner 指令保留。互动回复/讨论缺跟进块时保留正文并提示，不为内部元数据再自动调用 GPT；有效跟进正常保存、人工任务保护和报价必要纠正不变。

217 项回归、类型及构建通过；随后新增 2 项缺跟进组件验收，组件套件 35 项通过。本机已核对 extension/dist、Reload 并刷新 WA。相同 Didace DB 离线重放 92,515→85,136 字符（约 8%，不是 token 统计）；线上验收结果见 docs/AI回复改进_协作与验收.md。Claude 已确认暂停并接收 docs/网页回复优化_Claude复核.md，重置后只读交叉复核尚未完成。不要声称已经复核、完全拆分职责或整体瘦身80%。未启用 API、未团队发版。

### 近期补完（2026-09-18）— Claude 两轮复核闭环

老板要求不等额度，Claude 即时两轮只读复核。发现群聊续聊不渲染备注而跟进块误引用“见上文”；GPTReplySection 生成/讨论两处在群聊且已有会话时传 includedCustomerNotes=null，四项组件回归覆盖，Claude 二审确认修复。事实来源完全相同范围/日期/来源才共用 provenanceRef，各条 statement/value/id 不变。销售例句加本单事实成立条件，待核事项表达为实际下一步。

224 项相关回归与 build/diff check 通过，最终本机 extension/dist 已重载、WA已刷新。Didace 19:01 后台实机1次/179.2秒/84,593输入字符，八项完整，前一稿两句自我解释消失；未手动激活GPT，未填入/发送，未全员发版。Claude 撤回“后台调度需确认”项：schedule要求开关严格true、默认OFF并清旧alarm；注册handler不等于启动。详细复核 `docs/网页回复优化_Claude复核结果.md`。

### 近期补完（2026-09-19）— 聊天识别桥接恢复与侧栏刷新

**起点**：Ciro Adolfo 聊天已打开，右侧却提示“请选择聊天”。老板提供的新日志来自 `main.tsx-C6PJKx_b.js`，与本轮修改前本地 dist 对应；快照中 `bridgeAttr=null`、号码缓存为空，仅有无关的 Adolfo Vicente 姓名近匹配。旧日志也出现过上一位客户桥接数据。单条启动快照不能证明持续注入失败。

**确认的代码问题与修法**：content/main 未检查 INJECT_FIBER_BRIDGE 的 `ok:false` 且吞掉异常；新 chat-bridge-client 检查返回、5 秒超时、最多三次重试及手动重试去重。observeCurrentChat 原仅观察 body，而桥接写 html；现单独监听该属性并响应缓存刷新事件。useCurrentChat 刷新时也清空已关闭聊天。MAIN-world 函数抽到独立 whatsapp-fiber-bridge，保持身份提取路径和消费者校验，重复注入立即重读且不重复轮询；增加“尚未注入/没有 fiber/没有模型/读取异常”诊断。UnresolvedChat 区分未选聊天与号码未识别，提供重新识别入口；稳定后补诊断，避免仅有启动瞬间快照。

**验证与边界**：11 项聊天识别行为回归与 11 项聊天上下文回归（共 22 项）通过；另增加标题尚未挂载时拒绝桥接身份的保护。同一“html 桥接晚到”用例在 HEAD 旧实现失败、新实现通过。TypeScript 与 Vite 构建通过。保留 Ciro 与旧号码、无关 Adolfo 的身份拒绝，支持群聊，无客户数据写入/发送测试。浏览器访问持续被工具的已保存拒绝权限拦截，本轮按老板同意改走离线修复；尚未重载或实机确认 Ciro 恢复。仅更新本地 extension/dist，未 package、推送或全员发版。

**教训**：跨 world DOM 属性监听必须覆盖实际写入节点；不能把 executeScript 请求完成或 `ok:false` 当作身份已成功识别。离线缺陷修复不等于特定客户实机恢复，不能取消身份一致性检查来消除空白。

### 近期补完（2026-09-20）— 销售技能、提示词与后台复核发版

**起点**：老板要求更新skill，精简提示词并检查“没点生成，GPT也会自己打开或跑起来”，随后明确“发布吧”。**根因**：固定六类画像与新版简短策略重复；复核只在入口检查开关，异步读资料后仍可能继续启动。本机任务页当时显示关闭，不能据此断言历史自动启动来源。**修法**：统一采购背景、决定点、合作价值和信息节奏；压缩角色及共享提示，runner在任务准备及实际调用前重查开关和GPT占用。保留人工任务和正常报价。**验证**：发布前295项Node测试通过；私人线上R08 skill保存后完整回读一致；本机重载尚未确认，正式安装包与线上required_version已独立核验为0.1.0-20260920，32文件逐字节一致，见docs/销售技能与后台复核发布_20260920.md。**教训**：入口检查不能代替异步准备后的执行检查；线上skill、构建产物、本机加载及团队发版分别记录。

### 近期补完（2026-09-20）— 发布孟龙R08 GPT账号副本与刷新取回修复

**起点**：用户反映CRM「R08专用 · Miles」持续404，要求在daimenglong账号建GPT，随后指出需要打包发布。

**根因**：Menglong已登录页面实见旧GPT链接404，My GPTs没有R08；CRM模板仍指向旧ID，自动匹配也只识别旧ID。另一个已完成修复是GPT生成后刷新丢失请求上下文，导致CRM无法取回原结果。

**修法**：在Menglong账号创建私有R08 GPT，模板只更新gpt_url；gpt-template-routing.ts的isR08Template识别两个已核验GPT ID，isConversationForGptTemplate继续严格隔离新旧GPT会话。GPTReplySection在请求前持久化PendingGptAction，recoverGptResult只取原请求，deliverGptResponse串行交付，避免刷新后重发或重复保存。

**验证**：新GPT显示By Menglong Dai、Settings Saved；三种独立模拟回复通过；CRM模板界面回读新链接。本机已Reloaded并刷新WA。发布前224项GPT/报价/销售记忆测试通过；npm run package生成安装包并更新required_version后，独立检查ZIP、版本和服务器回读。详细产物记录见docs/R08副本与生成恢复发布_20260920.md。未向客户发送消息。

**教训**：跨ChatGPT账号复制GPT后，必须同时核对所有者、可访问链接、CRM个人模板及自动匹配；更新模板URL不能继续复用旧GPT会话。本机build/reload不等于团队安装包发布。发布当前构建时，提交须涵盖进入包内的已完成源码修复，不能仅提交版本说明。

### 还可以做的（不急）

- [ ] **AI key（`VITE_DASHSCOPE_API_KEY`）搬 Supabase Edge Function 代理 + 轮换**（代码评审 P0）：key 明文打进 `dist/assets/service-worker.ts-*.js`（实测出现两次），随 zip 发到每个销售机器，任何人可抠出来在老板智谱/DashScope 账号上无限跑推理，无配额/告警/审计；SW message handler 还没 sender/origin 校验。对*团队*是零操作（key 从包里消失，照装 zip），但需要 boss 一次性部署 Edge Function（校验 org 成员 + 限流 + 记花费）+ 轮换 key + 改 `service-worker.ts` 的 callQwen/callQwenTranslate 走代理。`supabase/functions/` 已有 conversions-api / fb-lead-webhook 可参照。**ROI 最高的安全改动**，待用户拍板
- [ ] **三个 ReplySection 抽共享模块 + 起测试**（代码评审 P1）：ClaudeReplySection(1440)/GPTReplySection(1035)/GemReplySection(928) 真重复约 450–500 行（消息加载 + 身份校验 + fillReply），三套各打一遍 DOM fix 易漂移。抽成一个**带单测**的工具模块，顺带给 parser（Codex/gem-parser）+ prompt 分段边界起第一批测试（全仓库目前零自动化测试）
- [ ] **`database.types.ts` 改 CI 自动生成**（代码评审 P1）：手维护，enum/列一改就跟真库漂移（`stalled` 那次就是），直接把过时 `customer_stage` 喂给 AI prompt
- [ ] 暂存盘"刷新即清空"在用户预期外，未来可考虑 IndexedDB 持久化（含 File）
- [ ] Chrome Web Store 私有发布（$5 + 1-3 天审核 → 全员自动更新，告别 zip 分发）
- [ ] `ai_reply_logs` 真正入库（目前 chrome.storage.local 单人单机，团队没法 review 别人的 prompt 质量）
- [ ] `waitForChatMessages` 稳态判定 600ms 仍可能漏最新消息（销售刚发完图就 generate）；目前靠"延迟几秒再点 generate"+ GeneratedAtBadge stale 警告兜底，未来可加"DOM 上最新 bubble 时间戳 ≈ now"的判定

## Gem 配置流程（用户首次设置）

1. **在 Gemini Web 自建 Gem**：打开 https://gemini.google.com/gems → "新建 Gem" → 写 system prompt（建议输出 `[Client Record]` / `[WhatsApp Reply]` / `[Translation & Strategy]` 三段以便 parser 识别；不写也行，parser 会按 CJK 比例兜底）→ 选 Pro 模型 → 保存，复制 Gem URL（形如 `https://gemini.google.com/gem/xxxxx`）
2. **在扩展登录 Google**：第一次自动化时如果未登录会失败 GEMINI_AUTH_REQUIRED，手动开 https://gemini.google.com 登录一次（session 存在 Chrome profile，持久）
3. **在扩展添加模板**：点扩展顶栏 🤖 Gem（或客户卡里"管理模板"）→ "+ 新建模板" → 粘贴 Gem URL + 设为默认 → 创建
4. **使用**：在客户卡 "🤖 Gem AI 回复" → 选模板 → 勾"前台"（首次调试看 puppet）→ 点"生成回复"

## UI 配色

WhatsApp 绿色主题：
- 顶部导航：`#00a884`
- 强调色：`#00a884` / `#008f6f`（hover）
- 文字：`#111b21`（主） / `#667781`（次）
- 背景：`#ffffff`（卡片） / `#f6f7f9`（页面） / `#f0f2f5`（输入框）
- 边框：`#e9edef` / `#d1d7db`
- 错误：`#b91c1c`

## 已知问题 / 风险

- **GPT副本账号与路由**：私人GPT不能假定跨账号可访问。复制后核对页面作者和保存状态，再改对应用户模板及已验证ID列表；旧会话必须按精确GPT ID拒绝续用。团队使用代码修复需单独打包发布，不把本机重载称为全员生效。

- 后台GPT入口和异步资料读取后的实际调用前都需核对启用状态与占用；关闭不等于撤回已发送的远端请求。提示词精简不能删除客户原话和批准条件，不将普通模式减少量宣传为所有模板的减少量。

- **2026-09-18 消息与报价边界**：原文/翻译共用清洗器，必须排除第三方译文与虚拟空壳；最近挂载行采集不是全部历史，未重新观察的旧错行不会凭空修复。报价预览只可绑定精确会话+assistant ID，且只存公开金额，不能用最后一条消息位置或私有成本兜底。新验收文档列出的剩余工作不得当成已经完成。

- **GPT 跟进不能覆盖人工安排或跨登录写入**：保存前复核客户/需求/登录用户及输入状态；人工改标题、日期、完成、暂停或删除后，不因模型再次生成而接管。后台仅扫描当前用户已建 GPT 任务，不能把一分钟扫描周期当作客户催办周期；没有新业务依据不得无限续期。


- **GPT手动选择与发布状态**：手动模板优先于自动车型匹配，保留显式恢复自动；预览、生成、讨论、知识和会话绑定走同一路由。发布前检查zip与服务器required_version；本地build不等于团队已升级，浏览器重载未完成必须如实说明。

- **GPT 语言与段落**：所有客户回复入口都应注入客户语言判定依据，不能让陈旧 CRM Language 或英语销售出站覆盖真实西语入站。网页正文抽取保留语义块边界，不读取 detached clone 的 `innerText`；测试包括 DOM 抓取→parser→sanitizer，不能仅验证 UI 的 `white-space`。

- WhatsApp Web 业务账号（@lid 格式）通过 IndexedDB `contact.phoneNumber` 字段映射到真实手机号
- MV3 service worker 会休眠，不能做后台 24h 监听（必须打开 WhatsApp Web 标签页）。批量抽取跑大量请求时偶尔会因 SW 休眠而静默停止，重新点继续即可（不会重复抽）
- WhatsApp Web 改 DOM 时会破坏 `whatsapp-dom.ts` 选择器；IndexedDB schema 也可能变（虽然更稳定）
- **`findDataId` 永远别再写固定层数父链**（`whatsapp-messages.ts`）：反复因 WA Web DOM 漂移坏过（6 → 3 → 2026-05-22 改 closest + testid → 2026-05-27 再加方向后缀防 FB ad pair data-id 复用）。新版 data-id 在 `.message-in/.message-out` 的 3 层祖父之上的 `[data-testid^="conv-msg-"]` wrapper 上。任何"从 message-in 元素往上爬找 data-id"的逻辑一律用 `el.closest('[data-testid^="conv-msg-"]')`，不要 `for i < N`。一旦这块再坏：**客户所有 inbound 消息从 DOM / DB / AI prompt 同时消失**，销售完全感知不到（DB 表面有消息 = 销售 outbound 占位，但客户回复 0 条），AI 续聊永远只看到销售自己发图
- **WA Web 给 FB ad-reply pair 复用 data-id**（2026-05-27 修，`findDataId`）：销售那条 FB ad reply card (outbound) + 客户对 ad 的第一条 reply (inbound) **各自有独立的 conv-msg- wrapper**（兄弟节点不嵌套），但 **data-id 完全相同**。`closest('[data-testid^="conv-msg-"]')` 两条 bubble 拿到各自不同 wrapper element 但 data-id 一样 → `seen.has(id)` 把客户 inbound 当 dup 跳过 → AI 永远不知道客户对 ad 说了什么车。修法：`findDataId` 检测同 data-id 是否被 ≥ 2 个 conv-msg- wrapper 共享（`document.querySelectorAll('[data-testid^="conv-msg-"][data-id="..."]')`），是的话加 `::out` / `::in` 方向后缀（FB pair 必然一外一内）。单 wrapper 保留原 id 不带后缀（兼容历史 DB 数据，~99.5% 消息 id 不变）。**Lead-from-FB-ad 的客户每次踩这个 bug 第一句话就丢**，而那通常是客户唯一明确说出"想买什么车"的话，AI 全瞎猜
- **WA Web 已放弃 `.selectable-text` class**（2026-05-27 修，`getMessageText`）：新版 bubble 文本直接挂在 `.copyable-text` 自身的 textContent / innerText 上，不再有 `.selectable-text` 子层。原来 `getMessageText` 的 3 条 fallback 全部依赖 `.selectable-text` 找最长 → 全返回空 → 走"任意 `.copyable-text`"兜底拿到第一个（FB 卡片的"Facebook 广告"4 字 header）→ 正文丢。修法：新增"挑最长 `.copyable-text` 自身 textContent"分支，放在 `.copyable-text .selectable-text` 之后兜底
- **WA Web 已删 `.message-in` / `.message-out` class**（2026-06-08 修，实测 `querySelectorAll` 返回 0）：消息级元素只剩 `[data-testid^="conv-msg-"]` wrapper（class 混淆无语义方向）。任何"扫消息气泡"的代码（`auto-translate.ts` / `readChatMessages`）一律走 `getBubbles()` → `[data-testid^="conv-msg-"]`，旧 class 仅做兼容兜底。**这块坏会同时干掉翻译（找不到气泡 → 开关开着也不翻）+ AI 消息读取**，两者同一套 DOM 依赖，改一个记得另一个也过一遍
- **引用回复要先剥 `[data-testid="quoted-message"]`**（2026-06-18 修，`getMessageText`）：客户/销售"回复"某条消息时，被引用的原话塞在 `[data-testid="quoted-message"]` 预览框里，跟真回复同在一个 bubble。实测结构：外层 `.copyable-text[data-pre-plain-text]` 包住「引用原话(第 1 个 selectable-text) + 真回复(第 2 个)」。旧 `realWrap.querySelector('.selectable-text')` 命中**第一个 = 引用原话** → 把销售自己之前发的话当成客户消息发给 AI，**真回复整条丢失**（客户唯一明确的问题——如"科托努有没有代表处"——AI 永远看不到）。修法：`getMessageText` 开头 clone scope 后 remove `[data-testid="quoted-message"]` 再读。**Lead-from-引用 的客户极常见，这块坏 = AI 静默瞎答**。⚠️ 读正文有**两处独立路径**：`getMessageText`（whatsapp-messages.ts，喂 AI）+ `readBubbleText`（auto-translate.ts，气泡翻译）——两处都要剥引用框，改一个记得另一个（2026-06-18 最初只改了前者，翻译那处漏了，被用户发现 D'AFRIC 客户消息翻成了引用框里的旧消息）
- **删除/撤回消息不在 `.copyable-text` 里，空文本走媒体探测前先判删除**（2026-06-18 修，`readChatMessages`）：实测删除气泡 `copyables: []`、带 `[data-icon="recalled"]` 撤回图标。"你已删除这条消息"是不可复制系统占位 → `getMessageText` 返回空 → 旧逻辑直接 `detectMediaKind` → 兜底 `[媒体]` → `collapseMediaRuns` 当附件发给 AI（"客户发了 N 个附件"）。`isDeletedPlaceholderText` 跑在最后但 text 已被改成 `[媒体]`，永不触发。修法：空文本时走 `detectMediaKind` **之前**先判 `[data-icon="recalled"]`（语言无关最稳）或整气泡删除占位文字 → 标 `[已删除]`。**任何"空文本 bubble → 当媒体"的兜底，前面都要先排除删除占位 / 引用框剥光后的空壳**
- **判消息方向别只看 class**（2026-06-08 修，`isOutboundBubble`）：`.message-out` class 没了，`el.classList.contains('message-out')` 永远 false → **所有消息当成入站**（"我发的图被识别成客户发的"）。多信号判定：① 旧 class ② `[data-icon="tail-out"]`/`tail-in`（每段连续消息只有第一条带尾巴）③ 送达状态 `[aria-label*="已读/送达/已发送/待发送"]`（出站独有）④ 几何兜底量 `.copyable-text` 或最大 img/video。**图片气泡没有 `.copyable-text`，几何绝不能量满宽的 conv-msg wrapper**（center≈panelCenter，出站图永远判不出靠右）—— 要量 img 本身
- **`syncMessages` 是 `ignoreDuplicates:true`，方向写错后要专门自愈**（2026-06-08，`fixDirectionMismatch`）：老错行（早期 build 把出站全写成 inbound）重新 sync 不会被 upsert 更新 → 永久卡住。修了方向判定后还要加批量 UPDATE（出站一批/入站一批 + `.neq` 只动方向不符的行），用户重开聊天时纠回。注意 `messages` 的 Update 类型本来没列 `direction`（当不可变），自愈要在 `database.types.ts` 补 `direction?`。**改了 DOM 解析逻辑后，光改解析不够，DB 里旧错行也要想办法自愈**
- **Gemini 选模型**（2026-06-08，`lib/gem-models.ts`）：默认 3.5 Flash（比 Pro 快很多），AI 回复区下拉可切 Pro / Flash-Lite，存 chrome.storage `gemModel`，手动 + 自动回复共用。`selectModel` 按 prefer 命中 + avoid 排除选指定模型（avoid 用来区分 Flash vs Flash-Lite）；用关键词不写死版本号，Gemini 升版本（3.5→3.6）不坏。改 Gem 模型逻辑别再写死强制 Pro
- WhatsApp 搜索框已从 `contenteditable` 改成原生 `<input>`，跳转用 **search + Enter** 而非模拟点击（React 上的 click 事件不触发）
- AI API 限流：`service-worker.ts` 已加 3 次指数退避（3s/8s/15s）；bulk extract 默认 4/min；auto-translate 顺序队列 + 200ms 间隔（因为换 Google Translate 后无配额限制）
- `auto-translate.ts` 早期版本有 drop bug（MAX_CONCURRENT=2 超出直接丢，长聊天后面消息翻不出），已改为顺序 Promise 队列
- `useCurrentChat` 之前有竞态 bug（observer 在 React useEffect 注册前已派发事件被吞），已修：mount 时主动 `readCurrentChat()` 一次
- contact_events 时间轴**只在新动作触发时写入**，历史数据无回填（之前的客户没有 created 事件）
- **Gem 自动化的脆弱点**：依赖 Gemini Web DOM——`.ql-editor` / `.model-response-text` / "停止生成" 按钮 aria-label / 模型选择器位置。改 DOM 时要修 `gem-automation.ts` 的 selector
- **Gem 模型切换**：通过遍历 `<button>` 找文字含"快速/思考/Pro/Flash/Advanced/Ultra"的按钮，文字 < 30 字符且 viewport 内可见，取最后一个（输入框旁那个）作为触发器；菜单 `[role="menuitem"]/[role="option"]` 里找含 "Pro|专业|高级|Advanced" 且不含 "Flash|快速" 的项点击
- **Gem 自动化 busy 串行**：`busy` flag 在 service worker 内存里，SW 重启会重置——Gem 长任务期间持续调 chrome API 保活，正常 < 3min 不会休眠
- **chat URL 持久**：Gemini 在第一次发送 prompt 后立刻分配固定 URL，即使中途出错关 tab，URL 也已经写到 `tab.url`，下次能续聊（只是当次 responseText 是截断的，需要重新生成）
- **Cloudinary CSP**：在 web.whatsapp.com 直接 `<img src="res.cloudinary.com/...">` 会被 CSP 屏蔽——一律用 `CloudinaryImg` 走 fetch + blob URL；新加显示 Cloudinary 图的地方记得换成 CloudinaryImg
- **WA MediaSource 视频**：blob: video src 是 MediaSource 流，直接 fetch 得 0 字节——视频抓取一律走 WA 自带"下载"按钮（chat-media-capture 的多选 toolbar 路径），SW 拦 chrome.downloads 转发回来
- **chat-media-capture DOM 依赖**：lightbox 关闭按钮 `aria-label="关闭"`、下载按钮 `aria-label="下载"`、多选取消 `aria-label="取消选择"`、"已选 N 项" span 文案——WA 改 i18n 或 ARIA 时要修
- **暂存盘不持久化**：刷新页面 / 切扩展 tab 即清空（File 对象不能 serialize），不是 bug 是设计
- **`.in('id', myIds)` URL 长度炸弹**：scope=mine 视图下 myContactIds 可能含数百 UUID，PostgREST 把它们全塞进 query string（每个 37 字符），URL 超 ~12KB 被网络层直接拒，错误是 `TypeError: Failed to fetch`（不是 Supabase 返回的 PostgrestError）。**新加按主理人过滤的查询一律走服务端 join：`.select('..., contact_handlers!inner(user_id)').eq('contact_handlers.user_id', myUserId)`**（嵌套关系用 `'contacts.contact_handlers.user_id'`），URL 长度恒定。已修复点：DashboardPage / TasksPage
- **Supabase 默认 1000 行返回上限**：`.select()` 不加 range 默认最多返回 1000 行，超了静默截断（不报错）。**这个陷阱反复踩**：
  - 2026-05-09：service_role 脚本读 Miles contacts 没分页（2172 行只拿到前 1000），漏掉的 phone 把"无冲突"集合算错 → 误删 137 contacts
  - 2026-05-11：`useCrmData` 自己拉 contacts/vehicle_interests/contact_tags 都没分页，970+ contact 在客户端不存在，导致它们对应的 WA chat 被第二个 loop 当成"孤儿"塞进 merged 时 contact=null，scope=mine 全部过滤掉 → 大量客户在左边列表消失（修复：三张表都分页 fetch）
  - **任何一次性脚本（含 service_role 工具脚本）操作 contacts/messages/handlers 时都要先分页拉全集再处理**
  - **任何客户端代码 `.from('xxx').select('*').eq('org_id', orgId)` 形态的查询，如果该表行数可能 > 1000，必须改成 fetchAll-pattern 分页**
- **新员工误建独立 org**（2026-05-09 已防呆）：被邀请的员工注册后看到 `OrgSetup` 会以为该建团队 → 建出独立 org，CRM 跟主 org 完全隔离。`OrgSetup.tsx` 现在改成 3 步式：guidance（默认显示警告 + 当前邮箱 + 换号登录入口）→ confirm → form。**踩坑救场流程**：手动 SQL 把员工 `organization_members` 行从空 org 删了再插到主 org，**注意删空 org 之前先把 contacts 迁走**——`contacts.org_id → organizations.id` 是 ON DELETE CASCADE，删 org 会连带 cascade 删所有 contacts（教训：2026-05-09 误删过 dengrongc6 的 137 个 SG contacts）
- **删 org 前必须先迁/清 contacts**：`contacts.org_id` 的 FK 是 ON DELETE CASCADE，`DELETE FROM organizations WHERE id = X` 会连带删该 org 全部 contacts + 它们的 messages/tags/interests/quotes/tasks/handlers/events（多级 cascade）。安全顺序：(1) UPDATE contacts SET org_id = newOrg WHERE org_id = oldOrg → (2) 验证 contacts count = 0 in oldOrg → (3) DELETE org_member → (4) DELETE org。**漏第 1 步等于物理删除该 org 的全部数据。**
- **手机端 .txt 导入靠正则识别附件占位**：`isMediaOnly()` 匹配 `IMG-/VID-/AUD-/DOC-/PTT-/STK-/PHOTO-...(文件附件)` 形如的文件名 + `[媒体]`（解析时把 `<省略影音内容>` 替换成的占位）。WhatsApp 改导出格式或换 i18n 文案（如英文环境是 `(file attached)`）时要扩 `isMediaOnly` 和 import-chat-parser 的清洗规则
- **`loadMessages` 现在是 DESC + reverse 取最近 N 条**：改自之前的 ASC + limit N（最老 N 条）。所有现有调用方拿到的列表顺序不变（仍按 sent_at 正序），但内容变成"最近 N"。如果未来有"显示完整历史"需求，limit 要给足够大（500 已经够覆盖大多数客户，特别长的几千条聊天会被截断）
- **WA Web 新版 data-id 不再含 JID**（2026-05 实测）：消息 wrapper 上的 `data-id` 现在是 32-char 不透明哈希（如 `A54FBBB582F9F749D466CF4000D3256F`），跟 chat 身份完全无关。**`readJidFromScope` / `readGroupJidFromScope` 单靠 DOM 抓 JID 已经失效**，必须走 IDB cache（`whatsapp-dom.ts:nameToPhoneCache` 在启动 + 每 30s 从 IDB chats 表按 "header 显示名 → JID" 建索引；readCurrentChat 用 header 显示名查缓存反查 JID）。旧版 WA 的 DOM 抓 JID 路径仍保留兜底，但新装的 WA Web 实例都是新格式
- **群聊在 IDB 里，name 常在 `groupMetadata.subject` 不在 `chat.name`**：读 IDB chat 表时要兜底取 `groupMetadata.subject`，否则群聊缓存的 name 是 null，header 名查不到 → 群聊识别失败。`whatsapp-idb.ts` 已经做了三级 fallback：`chat.name || groupMetadata.subject || formattedTitle`
- **群聊 contact 的 phone 是 NULL**：所有按 `contact.phone` 直读的代码都要做 null check（`contact.phone ?? undefined` 或 `if (!contact.phone) skip`）。已修过的点：bulk-extract / GoogleSyncDialog / useCrmData / gem-prompt（normalizePhone）/ ContactCard / ContactDetailDrawer / ContactsPage / TaskModal。未来加新功能要记得：**只读 phone 必崩，要么过滤 group_jid != null，要么走 phone ?? 兜底**
- **WA Web 的 `/send?phone=` 协议只 in-memory 打开 chat，不写 IDB chat 表**（2026-05-12 实测确认）。意味着：
  - **批量激活 1000 个号到 WA Web 缓存 / 搜索框是不可能的**——WA Web 只持久化"产生过消息级交互"的 chat，cold boot 后 IDB 里就那 ~500 个最常用的
  - `jumpToChat` 的 deep-link fallback（`location.href = '/send?phone='`）能让单个客户瞬间可用（reload 一次进 chat），但 reload 后 IDB 不变
  - 任何"让 WA Web 学会更多客户"的需求都要走"导入聊天 .txt"路径（合法 + 不打扰客户）。**绝不要批量发消息再撤回**（典型 spam pattern，封号高风险 + 客户能看到 push 通知）
  - send 协议处理服务端解析 + chat 加载需要 **≥14 秒**，少于这个时间检查 chat header 会误判为"号未注册"（之前 David Eze 实测验证 fail 的根因——8 秒等待不够）
- **WA Web 多 tab 共享 session 不需要重新扫码**（2026-05-12 验证）：之前以为 WA Web 强制单 tab，实际上同一个 Chrome profile 里第二个 tab 打开 web.whatsapp.com 直接进——session 通过 IndexedDB 共享。这让"用独立 tab 跑后台任务而不打扰主 tab"成为可能。但 IDB 是共享的，两个 tab 写冲突还是要小心
- **活性体检 5 档分类**（`Vitality` 联合类型）：`active` / `stale` / `cold` / **`imported`**（新增，不在 WA Web 缓存但 messages 表有数据）/ `orphan`。**🔵 imported 绝对不要删**——是真客户，只是 WA Web 缓存装不下。任何处理"WA Web 搜不到"的代码都要先看是不是 imported 档
- **Realtime + REPLICA IDENTITY FULL 教训**（migration 0025）：默认 REPLICA IDENTITY 只发 PK，但 `vehicle_interests` / `contact_tags` PK 不含 contact_id，前端 reducer 收到 DELETE / UPDATE 事件时无法定位 state 里属于哪个 contact 的归属。**新加 Realtime-订阅表时如果 PK 不含外键归属列，必须 `ALTER TABLE … REPLICA IDENTITY FULL`**。FULL 把整行旧值都写进 WAL，万级以下行数 overhead 可忽略
- **Realtime filter 不支持 join**：`postgres_changes` filter 只能单列 equality（如 `org_id=eq.<uuid>`），关联表（`vehicle_interests` / `contact_handlers` 等无 org_id 列）只能 listen all-rows，RLS 在服务端确保只下发本 org 可见行。订阅时要清楚 filter 不够细就靠 RLS 兜底
- **slim select 别 select \***：1700 contacts 一次拉全场景下，`select('*')` 每行多 KB（含 notes / google_* / created_at 这些大字段），egress 翻几倍。`CONTACT_LIST_COLS` 只 11 列够列表 / 撞单 / autoStage 用；详情卡（notes 等）走 useContact 单查。**加新列到 list 渲染前问自己：能不能单查？**
- **对整表聚合的 RPC 要建覆盖索引，否则随表增长必超时**（2026-06-11 修，migration 0032）：`last_message_direction_per_contact` 对整张 `messages`（38k 行 + 大 `text` 字段）做 group-by 聚合，原 `(contact_id, sent_at desc)` 索引不含 `direction` → 顺序扫描读全部肥行 → 8s `statement_timeout` 掐断（57014）+ PostgREST `Thread killed by timeout manager` + RPC 500。客户端 `fetchMessageDirections` 把 500 catch 成空 map → 「我该回」回填 + chat-classifier「lost 保护」**静默失效**（不崩，销售只觉得分类不准）。修法：建只含查询所需列的覆盖索引 `(contact_id, direction, sent_at) WHERE sent_at IS NOT NULL` 走 index-only scan，不碰 `text` 堆。**任何新写"对整表聚合"的 RPC**（count/max/group-by 全表）都要：① 给查询建覆盖索引；② 警惕被聚合表有大字段时顺序扫描读肥行；③ 表会持续增长的话，到几十万行就改 trigger 维护汇总表，别再全表扫
- **`.in('id', [...])` URL 长度炸弹依然有效**（前文 2026-05-08 已记）。Realtime 改造后已经全部换 `contact_handlers!inner(user_id)` 服务端 join 路径
- **AI source attribution 是启发式不是真理**（`lib/ai-reply-attribution.ts`）：5 分钟窗口 + 60% 公共前缀阈值。销售改太多字（前缀 60% 不命中）→ 归 null；fill 后超 5 分钟才发 → 归 null。这些都是预期行为不是 bug。`messages.ai_source = null` ≠ "manual"，应理解为"未归因"
- **GPT 不喂 reference data 是有意为之**（`gpt-prompt.ts`）：GPT-5 Thinking 自己联网查 + 推理报价效果更好，prompt 不要塞车型库 / Ghana playbook 等 reference。Codex 那边保留（Codex 默认不联网）。修改 prompt 时不要"对齐两个 AI"
- **Codex `[Sales Guidance — TOP PRIORITY]` 段是 override 不是 hint**：销售在 textarea 里写"用阿拉伯语回复 + 强硬一点"，prompt 顶部注入这段，Codex 必须严格执行覆盖默认行为。改 prompt 模板时不要把这段降级成普通指令
- **自动回复 P0 安全：reply 必须先 `sanitizeReplyForCustomer` 再 paste**（`content/auto-reply.ts`）：自动发=没人 review，Gem 偶尔会把 [INTERNAL] EXW 价或 floor 拼到回复里，泄漏 = 灾难。手动 fillReply 路径可以放过（销售自己看到才发），但 auto-send 路径绝对不能省 sanitize
- **自动回复 P0：写 DB 前 + 发送前都必须 `verifyHeaderMatches`**（2026-06-20 修，`content/auto-reply.ts`）：这条**唯一无人值守**路径曾两处裸奔——① `buildPrompt` 里 `syncMessages` 前没校验当前 chat 是不是目标客户 → WA 在等 Gem 的 ~2min 里被切到别的聊天时，把别人的消息按 `(contact_id, wa_message_id)` UNIQUE **永久**写进这个 contact，AI 还基于别人对话生成回复；② 发送前（line 196 jump 后）没校验 → 直接把回复**发给另一个真实客户**。修法：两处 `jumpToChat` 传 `requireMatch={phone,name,waName}`；`buildPrompt` 里 `onRightChat` 为 false 时丢 DOM 消息退回纯 DB（`mergeDomWithDbMessages([], id, 50)`）绝不 sync；发送前 `verifyHeaderMatches` 不过就 `throw`（宁可不发也不发错）。**任何新加的写 `messages` 表的 AI 自动化路径都要对照"三个 ReplySection + bulk-extract 都有身份校验、auto-reply 曾漏"这个清单**，无人值守的尤其要在发送前再校验一次
- **`findExtractTargets` 必须分页（1000 行陷阱第 4 次）**（2026-06-20 修，`lib/bulk-extract.ts:110`）：`.select('*').eq('org_id')` 没分页 → org 1700+ 客户里 >1000 的那半永远不进批量抽取（销售看到"抽取完成"实际半数没处理）。已改 PAGE 分页 + `.order('id')`。又一次印证"任何客户端 `.select('*').eq('org_id', orgId)` 形态、表行数可能 >1000 的查询，必须 fetchAll-pattern 分页"
- **`isOutboundBubble` 判方向处一律传 `panelCenter`**（2026-06-20 修，`whatsapp-messages.ts:233` `findDataId`）：不传则几何兜底（信号 #4）失效，FB ad-reply pair 的纯媒体 bubble（无 class/tail/送达状态）一外一内都默认判 `in` → 都拿 `::in` 后缀 → `wa_message_id` 撞车互相覆盖，客户对广告的第一句话（往往正是"我要哪款车"）整条丢失。`findDataId` 现接 `panelCenter?` 透传。**新写任何判方向逻辑别忘了把面板中心传进去**
- **MV3 SW + chrome.alarms 调度自动回复**（`background/service-worker.ts` SCHEDULE_AUTO_REPLY）：用 alarm 不用 setTimeout—— alarm 能唤醒休眠的 SW，setTimeout 跟着 SW 一起死。alarm 触发后找 WA Web tab 发 AUTO_REPLY_FIRE；用户重开 WA 时 `recoverStuckSchedules` 扫一遍 scheduled 状态延误的就立即触发
- **`ai-reply-log.ts` 改本地存储不上 Supabase**：单人主用，单条 ~10 KB × MAX_ENTRIES=800 ≈ 8MB 在 chrome.storage.local 10MB 配额内。FIFO LRU evict。**团队场景将来要 review 别人的 prompt 质量再考虑入库**——目前 `ai_reply_logs` migration 0021 已建但代码不用
- **`parsePrePlainText` 必须识别中文时段**（`whatsapp-messages.ts`）：WA Web 中文界面 `data-pre-plain-text="[下午5:18, ...]"` 用中文时段标记（凌晨/清晨/早上/上午/中午/下午/晚上）不是英文 AM/PM。Long-standing bug：之前只匹配 AM/PM → 所有 PM 时间偏 12 小时（"下午5:18" 错成 5:18，相对顺序对所以没被发现）。**任何"看 WA Web 时间字串"的逻辑都要兼容中文时段 + 英文 AM/PM 两种**。中午 / 下午 / 晚上 = PM 走 < 12 → +12；上午 / 凌晨 / 清晨 / 早上 = AM 走 12 → 0
- **`formatTimestamp(null)` 别用 `new Date()` 兜底**（三个 prompt 文件）：WA Web 纯媒体 bubble（图/视频/PDF 无 caption）没 `data-pre-plain-text`，`getMessageTimestamp` 返回 null → 之前 `new Date()` 兜底 = **显示当下时刻**。"客户 5-21 之后没聊过，prompt 里却出现 5-26 媒体"就是这个 bug。返回 `??-?? ??:??`，prompt 顶部加注释告诉 AI "位置非按时序，时间未知"
- **`getMessageTimestamp` 纯媒体 fallback 走 currentDate + bubble 内时间字串**：`readChatMessages` 主循环按 DOM 顺序合并 bubble + date header span 遍历，遇到 date header（"2026年5月18日" / "星期四" / "今天" / "昨天" / "前天" / "周一~周日"）更新 currentDate。纯媒体 bubble pre-plain-text 不存在时，从 `[data-testid="msg-meta"]` 内 `<span>下午2:11</span>` 拿时间 + currentDate 合成 sent_at
- **`stripTrailingMeta` 剥消息末尾 WA Web meta**：`getMessageText` innerText 抓 selectable-text 时会把 bubble 底部"下午2:32" / "已编辑" 等一起带进 text，跟前面结构化 `[MM-DD HH:MM]` 重复 + 矛盾让 AI 困惑。出口剥一遍。**英文兜底必须带 AM/PM 才剥**（防误伤客户写"meet at 5:00"）。新加 prompt-bound 文本字段时记得过这道
- **`jumpToChat` 弱兜底已替换成 RequireMatch**（`lib/jump-to-chat.ts`）：之前 `headerChangedFrom` "header 变了就算跳成功" → 跨聊天污染（搜索过程中 WA 临时切到错 chat，DOM 读到别人的消息，`syncMessages` 写错位到目标 contact 永久污染 messages 表）。**AI 自动化路径**（generate / fillReply / bulk-extract / auto-reply / TagsSection / ContactTasksSection）**必须**传 `requireMatch={phone, name, waName}`；**用户主动跳转路径**（ContactsPage 行点击 / 💬 / FilteredChatList）保持旧宽松行为不用传。`verifyHeaderMatches` 判定：phone digits 命中 header 数字 OR name (≥ 2 字符) 命中 header 文本
- **`syncMessages` 写 DB 前必须 sanity check 当前 chat**（三个 ReplySection 的 `loadAiMessages`）：读完 DOM 后再调 verifyHeaderMatches 一次防 race（generate 期间用户手动切 WA chat）。不匹配 → 放弃 DOM 消息走 DB fallback
- **DB 数据 backfill 不能用 `synced_at` 作 sent_at 近似**（2026-05-26 实测踩坑）：synced_at 是销售首次打开 WA Web sync 进 DB 的时刻，跟消息实际发送时间可能差几天。Samuel 那 PDF 实际 5-21 14:11 客户发的，synced_at = 5-26 15:26（销售 5-26 才打开看），backfill 用 `sent_at = synced_at` 错标 5 天。**真实信息丢了就丢了，靠源头修 + 用户重新打开聊天自动 backfill**（`readChatMessages` 修源头 + `syncMessages` 反向更新）。任何 batch backfill 历史数据之前先 dry-run 跑代表性样本对比
- **AI 回复 done card 必须明示 generatedAt**（`GeneratedAtBadge`）：`usePersistedReplyStatus` 持久化的 done card 没显示生成时间时，用户切回客户看到 1 小时前的 prompt 会误以为是当下的，抱怨"时间错 + 缺消息"。done card 顶部 banner "生成于 XX:XX（X 分钟前）"，> 10 分钟橙色警告"可能不含最新消息，请重新生成"。**新加 persisted UI 状态都要明示时间戳**
- **`usePersistedReplyStatus` async get race**（`panel/hooks/usePersistedReplyStatus.ts`）：useEffect 启动 async get 后，如果用户立刻点 generate 改了 state，async get 完成时**不能用 stale 直接覆盖**——必须 functional setState 判 `current.kind === initial.kind` 才用 stale 恢复。早期 bug：generate 跑完几秒后 async get 回调把 new done 覆盖回 stale done，UI 显示 stale 状态用户以为没点中
- **删除占位识别 + DB 覆盖**（`DELETED_PLACEHOLDER_PATTERNS` + `isDeletedPlaceholderText`）：DOM 抓到"你已删除这条消息" / "This message was deleted" → text 改 `[已删除]`，`syncMessages` 用 onConflict 覆盖之前抓过的原文（用户后来在 WA 端撤回的）。**先 `stripTrailingMeta` 再判删除占位**（防"你已删除这条消息中午11:31"因尾巴匹配不上而失败）
- **`verifyHeaderMatches` 比对 name/wa_name 时必须两侧 strip emoji**（`lib/jump-to-chat.ts`）：销售在 WA 通讯录给客户起带 emoji 爱称（`"K-lonchito 🥰🥰🥰"` / `"🌸🌸Zouhour🌸🌸"` / `"Banks💎👑🌟"`）非常常见，org 内 **~2.7% contact 中招**。但 WA Web header 文本一般不含这些 emoji 或位置不同 → **整串 `header.includes(candidate)` 永远不命中** → DOM 路径被锁死 → AI 生成抛 cold-start 错（DB 空时硬挂）或冻结 DB 历史（DB 有时隐性失效，销售察觉不到只觉得 AI 智商低）。修法 `stripEmojiAndNormalize`：`[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]` 一次 strip + normalize 空格 + lowercase，两侧都过再 includes。**不要用 `\p{Emoji}`** —— 它把 `# * 0-9` 也算 emoji-candidate，会误剥客户名里的数字。**任何新加"比对 contact 名 vs DOM 文本"的逻辑都先剥 emoji**（销售爱用 emoji 给重要客户做视觉标记，这是常态不是边缘 case）
- **`vehicles.created_by` 之前长期全 NULL**（2026-05-29 才补，`VehicleModal.tsx` + 回填脚本）：FK 早就建了（→ auth.users, ON DELETE SET NULL）但插入代码从没写。任何新加"按上传人/创建人排序、过滤、归属"的功能前，**先 SQL 确认该列真有数据**，别假设 FK 存在 = 有值。回填历史用 service_role 脚本时一律分页拉全集 + PATCH filter 带 `created_by=is.null`（幂等，不重复改已填行）
- **own-first 排序复用 ScopeContext 不另发 RPC**（`UploaderBadge` / VehiclePicker / VehiclesPage）：自己的排前面 + 上传人徽标都从 `useScope()` 的 `myUserId` + `membersById` 取数据。新加"按主理人/上传人"的列表入口直接 `const { myUserId, membersById } = useScope()`，**别再单独 `useOrgMembers` 调 list_org_members RPC**（ScopeContext 已经维护这两个 map）。⚠️ `useScope()` 必须在 `<ScopeProvider>` 内（AppShell 已包住全部 6 tab）

## 用户偏好

- 偏好免费方案（不愿付费用 Gemini API，用智谱 GLM 代替；Gem 自动化用网页端而非 API）
- 销售工作台 UX 参考 WAPlus（顶部 tab + 右侧 CRM 面板）
- 中文交流，UI 文案中文 + 客户对话原文（多语言）
- 修改后让我用 Chrome MCP 自动验证，不要每次都让用户手动验
- **prompt 里不要重复传时间**：结构化 `[MM-DD HH:MM]` 已经够了，WA Web bubble 末尾的"下午X:YY" / "晚上X:YY" / "已编辑" 等必须剥掉（2026-05-27 用户明确说"你就别传俩时间给各个 ai 了，把什么下午中午的都删掉"）。任何新加的 prompt-bound 文本字段都要过 `stripTrailingMeta`
- **bug fix 之前先确认用户用的是哪个版本**：踩过坑——我修了代码以为 fix 已生效，用户实际还装着旧版本。判断方法：让用户看 `chrome://extensions/` → Sino Gear CRM → 详细信息 → 版本号，或者打开 panel devtools console 跑 `chrome.runtime.getManifest().version_name`；或者直接看 prompt 里的具体内容是否反映新逻辑（如时间是否 +12）
- **打包发布完整流程**（用户说"打包发布" / "打包" / "发版"时按这个顺序自动做完，不要分步问）：
  1. **改 AGENTS.md**：在"### 还可以做的（不急）"之前插入新章节"### 近期补完（YYYY-MM-DD）— 一句话标题"，含**起点**（用户原话或具体症状） / **根因**（Chrome MCP / 实测拿到的证据，不靠猜） / **修法**（具体改了哪几个函数 + 关键代码思路） / **验证**（Chrome MCP / 实测拿到的结果）/ **教训**（下次别再踩的具体规则）。同时在"## 已知问题 / 风险"段补对应的"以后写新代码要注意"那条
  2. **`cd extension && npm run package`**：自动写 BUILD_VERSION → tsc + vite build → zip 到 `dist-zips/` → 用 service_role 推 `app_config.required_version` 到 Supabase → 还原 build-version.ts（让 git 干净）。**每次打包 = 强制全员升级**，旧版扩展 5 分钟内被 VersionGate 弹窗拦下
  3. **git commit**：中文 message 多段——首行一句话总结；空行；详细段含起点 / 根因 / 修法。用 HEREDOC + `Co-Authored-By: Codex Opus 4.7 (1M context) <noreply@anthropic.com>` trailer。**只 add 改过的源文件 + AGENTS.md**（dist-zips/ 已 gitignore，不管它）
  4. **`git push origin main`**
  5. 报告用户：版本号 + zip 路径 + 提示 boss 自己 chrome://extensions/ 点 ↻ 重载 + WA Web F5；其他销售会被 VersionGate 拦下要装新 zip
