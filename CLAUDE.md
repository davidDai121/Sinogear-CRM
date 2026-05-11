## 项目背景

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
│       └── 0016_groups.sql              支持 WA 群聊作为 contact：加 group_jid 列 +
│                                        partial unique 索引 + check 约束 +
│                                        放宽 phone NOT NULL
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
                        sort_order, created_by, created_at
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
messages                id, contact_id, wa_message_id, direction(inbound/outbound),
                        text, sent_at, synced_at
                        UNIQUE(contact_id, wa_message_id)
_keepalive              singleton (id=1, last_ping) — pg_cron 每日心跳
                        防 Supabase 免费层 7 日无活动自动暂停
```

**RLS：** 所有表的 SELECT/INSERT/UPDATE/DELETE 都要求 `auth.uid()` 是 `org_id` 成员（通过 `is_org_member(org_id)` SECURITY DEFINER 函数）。
- quotes / contact_events / gem_conversations / messages / contact_handlers 通过 contact 反查 org_id（无 org_id 列）
- vehicle_media 通过 vehicle 反查 org_id
- contact_events 只有 SELECT/INSERT policy（append-only）
- contact_handlers：读取要求同 org，写入只能 user_id=auth.uid()
- gem_templates：0014 起改 per-user，只能 created_by=auth.uid()
- _keepalive 全部 deny，仅 pg_cron 内部 postgres role 可写

**Helpers：**
- `create_organization(name)` RPC — 原子建 org + 把 caller 加 owner
- `is_org_member(org_id)` — RLS 用
- `touch_updated_at()` trigger — contacts/vehicles/quotes/gem_templates 自动更新 updated_at

**所有 14 个 migration 都已应用到生产 Supabase。**

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
- 验证 UI 用 Chrome MCP（claude-in-chrome），扩展只能在用户已登录的 Chrome 里测，MCP tab 共享同一 profile

## 已完成功能

### 基础设施
- [x] Chrome 扩展骨架（MV3 + Vite + React + TS，@crxjs/vite-plugin 2.4 正式版）
- [x] Supabase 多租户 schema + RLS（**14 个 migration 全部上线**）
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
- [x] **数据自动刷新**：useCrmData 20s 轮询 + 自动 syncAutoStages

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
- CLAUDE.md "绝不能在真实客户聊天上操作" 红线
- **任何"让 WA Web 自动学会更多客户"的需求都要走"导入聊天 .txt"路径**（合法+不打扰客户）

**未做的可选项**（用户决定要不要）：
- 写"批量验证"工具（4 小时跑 1000 次 reload 区分真活/真死号）—— 不解决搜索问题，只能给死号打标签便于清理。当前 🔴 orphan 那档已经是清理候选，**不值得再花 4 小时**。

### 还可以做的（不急）

- [ ] 暂存盘"刷新即清空"在用户预期外，未来可考虑 IndexedDB 持久化（含 File）
- [ ] Chrome Web Store 私有发布（$5 + 1-3 天审核 → 全员自动更新，告别 zip 分发）

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

- WhatsApp Web 业务账号（@lid 格式）通过 IndexedDB `contact.phoneNumber` 字段映射到真实手机号
- MV3 service worker 会休眠，不能做后台 24h 监听（必须打开 WhatsApp Web 标签页）。批量抽取跑大量请求时偶尔会因 SW 休眠而静默停止，重新点继续即可（不会重复抽）
- WhatsApp Web 改 DOM 时会破坏 `whatsapp-dom.ts` 选择器；IndexedDB schema 也可能变（虽然更稳定）
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

## 用户偏好

- 偏好免费方案（不愿付费用 Gemini API，用智谱 GLM 代替；Gem 自动化用网页端而非 API）
- 销售工作台 UX 参考 WAPlus（顶部 tab + 右侧 CRM 面板）
- 中文交流，UI 文案中文 + 客户对话原文（多语言）
- 修改后让我用 Chrome MCP 自动验证，不要每次都让用户手动验
