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
│       │                                Claude.ai per-contact chat URL 缓存（无 template）
│       ├── 0021_contact_pins.sql        contact_pins (contact_id, user_id) per-user 置顶
│       ├── 0022_message_counts_for_classifier.sql 0019 RPC 扩展回 inbound_count/
│       │                                outbound_count（chat-classifier 有历史保护用）
│       ├── 0023_gpt_conversations.sql   gpt_conversations(contact_id, chat_url)
│       │                                ChatGPT per-contact chat URL 缓存（无 template）
│       ├── 0024_message_ai_source.sql   messages 加 ai_source 列：claude/gem/gem_auto/gpt
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
                        Claude.ai per-contact chat URL（单一 Miles persona，无 template）
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
                        ai_source: claude/gem/gem_auto/gpt（出站消息 AI 归因，NULL=manual）
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
- 验证 UI 用 Chrome MCP（claude-in-chrome），扩展只能在用户已登录的 Chrome 里测，MCP tab 共享同一 profile

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
- CLAUDE.md "绝不能在真实客户聊天上操作" 红线
- **任何"让 WA Web 自动学会更多客户"的需求都要走"导入聊天 .txt"路径**（合法+不打扰客户）

**未做的可选项**（用户决定要不要）：
- 写"批量验证"工具（4 小时跑 1000 次 reload 区分真活/真死号）—— 不解决搜索问题，只能给死号打标签便于清理。当前 🔴 orphan 那档已经是清理候选，**不值得再花 4 小时**。

### 近期补完（2026-05-13 ~ 2026-05-20）— 多 AI 整合 + Realtime + 自动回复 + AI 归因

**AI 回复三足鼎立：Gem / Claude / GPT 同 UI 共存**
- [x] **Claude AI 回复**（`lib/claude-automation.ts` + `lib/claude-prompt.ts` + `panel/components/ClaudeReplySection.tsx`）：
  - 网页端自动化 claude.ai（chrome.tabs + 注入脚本）；首次开新对话拿 chat URL → `claude_conversations` 表 per-contact 缓存；下次续聊
  - **prompt 体系升级**（`claude-prompt.ts`）：ROLE_PROMPT（Miles 第一人称 + 6 类买家自适应）+ VEHICLE_KNOWLEDGE（全场景注入，所有 SKU + EXW 价 + 卖点 + 目标买家）+ GHANA_MARKET_PLAYBOOK（isGhanaContext 命中时注入：CIF 价格 / 关税 / Stallion vs Zonda 竞品 / 6 节点漏斗）+ Color Stock Rule（hard rule，绝不问颜色）
  - **5 种 mode**：reply（默认，只出 reply + translation，可选 Customer Read / Client Record）/ analyze（深度分析 5 段）/ variants（3 个不同语气）/ quote（quote draft + 报价回复）/ discuss（自由对话）
  - **客户信号注入**（`lib/customer-signals.ts`）：英语水平 + 情绪 + 沉默天数 + Pricing Math 段 — 在 chat history 之前注入到 prompt
  - **Pricing Math 段去重**（`claude-prompt.ts` 1 次注入 + signals 不重复）
- [x] **GPT-5 Thinking 回复**（`lib/gpt-automation.ts` + `lib/gpt-prompt.ts` + `panel/components/GPTReplySection.tsx` + migration `0023`）：
  - 网页端自动化 chatgpt.com；首次开新对话拿 chat URL → `gpt_conversations` 表 per-contact 缓存
  - **故意精简 prompt**：GPT-5 Thinking 自己联网查 + 推理报价效果更好，prompt 不喂 Vehicle Knowledge / Ghana playbook（Claude 那边保留，因为 Claude 默认不联网）
  - 输出格式跟 Claude 一致（[WhatsApp Reply] + [Translation] + 可选 [Client Record]），共用 parser
- [x] **AIReplyTab dropdown 切三档**：`🤖 Gem` / `🧠 GPT-5 Thinking` / `✨ Claude`，按钮选择持久化 chrome.storage

**AI source attribution（出站消息 AI 归因）**
- [x] **`lib/ai-reply-attribution.ts`**（183 行）：fillReply 时存 5 分钟 pending fill 窗口（chrome.storage.local），syncMessages 写出站消息时按 contactId + 时间窗口 + 文本相似度（公共前缀比例 ≥ 0.6）匹配，命中后写 `messages.ai_source`
- [x] **migration `0024_message_ai_source.sql`**：messages 加 ai_source 列（claude/gem/gem_auto/gpt/null）
- [x] **MessagesHistoryModal 来源 chip**：每条出站消息显示来源标签（✨Claude / 🤖Gem / ⚡自动 / 🧠GPT / 🌐翻译 / ⌨️手打）+ 顶部统计行"出站 N 条：claude × N，gem × M，manual × K"
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
- [x] **`lib/ai-reply-log.ts` 改 chrome.storage.local 存储**（早期考虑过建 ai_reply_logs 表入库，对应 migration 未纳入仓库，最终改本地存）：FIFO LRU，800 条上限，AIReplyLogModal 列表 + markdown 导出给 Claude review 质量
- [x] **`MessagesHistoryModal` 加完整出站统计**：source × count 标签，让 boss 一眼看哪个 AI 用得多
- [x] **强制版本闸门 → 0017 已上线**（前文 2026-05-10 已记，沿用至今）
- [x] **`useCrmData` 分页全面铺开**：`fetchAllContacts` / `fetchAllVehicleInterests` / `fetchAllContactTags` 全走 PAGE=1000 分页，**`.order(...)` 必须加**（PostgREST 不保证 range 跨页稳定，并发写入时同行可能跨页重复）

### 近期补完（2026-05-22）— WA Web DOM 漂移：客户 inbound 全部丢失

- [x] **`findDataId` 改用 closest + testid，不再固定 N 层父链爬**（`content/whatsapp-messages.ts:65-86`）

**症状**：销售用 AI 续聊（Gem / Claude / GPT 三个都一样），prompt 里 `[New Messages Since Last Reply]` 段只剩销售自己发的 photo 占位（`[Sales sent 1 photo to customer]`），**客户最近发的所有文字 inbound（"9,000 Ghana / ??? / And location"）完全消失**；`messages` 表也只有销售 outbound 占位，客户文字 0 条入库（=> useMessageSync 跑过但每次都漏 inbound）。

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

### 还可以做的（不急）

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

- WhatsApp Web 业务账号（@lid 格式）通过 IndexedDB `contact.phoneNumber` 字段映射到真实手机号
- MV3 service worker 会休眠，不能做后台 24h 监听（必须打开 WhatsApp Web 标签页）。批量抽取跑大量请求时偶尔会因 SW 休眠而静默停止，重新点继续即可（不会重复抽）
- WhatsApp Web 改 DOM 时会破坏 `whatsapp-dom.ts` 选择器；IndexedDB schema 也可能变（虽然更稳定）
- **`findDataId` 永远别再写固定层数父链**（`whatsapp-messages.ts`）：反复因 WA Web DOM 漂移坏过（6 → 3 → 2026-05-22 改 closest + testid → 2026-05-27 再加方向后缀防 FB ad pair data-id 复用）。新版 data-id 在 `.message-in/.message-out` 的 3 层祖父之上的 `[data-testid^="conv-msg-"]` wrapper 上。任何"从 message-in 元素往上爬找 data-id"的逻辑一律用 `el.closest('[data-testid^="conv-msg-"]')`，不要 `for i < N`。一旦这块再坏：**客户所有 inbound 消息从 DOM / DB / AI prompt 同时消失**，销售完全感知不到（DB 表面有消息 = 销售 outbound 占位，但客户回复 0 条），AI 续聊永远只看到销售自己发图
- **WA Web 给 FB ad-reply pair 复用 data-id**（2026-05-27 修，`findDataId`）：销售那条 FB ad reply card (outbound) + 客户对 ad 的第一条 reply (inbound) **各自有独立的 conv-msg- wrapper**（兄弟节点不嵌套），但 **data-id 完全相同**。`closest('[data-testid^="conv-msg-"]')` 两条 bubble 拿到各自不同 wrapper element 但 data-id 一样 → `seen.has(id)` 把客户 inbound 当 dup 跳过 → AI 永远不知道客户对 ad 说了什么车。修法：`findDataId` 检测同 data-id 是否被 ≥ 2 个 conv-msg- wrapper 共享（`document.querySelectorAll('[data-testid^="conv-msg-"][data-id="..."]')`），是的话加 `::out` / `::in` 方向后缀（FB pair 必然一外一内）。单 wrapper 保留原 id 不带后缀（兼容历史 DB 数据，~99.5% 消息 id 不变）。**Lead-from-FB-ad 的客户每次踩这个 bug 第一句话就丢**，而那通常是客户唯一明确说出"想买什么车"的话，AI 全瞎猜
- **WA Web 已放弃 `.selectable-text` class**（2026-05-27 修，`getMessageText`）：新版 bubble 文本直接挂在 `.copyable-text` 自身的 textContent / innerText 上，不再有 `.selectable-text` 子层。原来 `getMessageText` 的 3 条 fallback 全部依赖 `.selectable-text` 找最长 → 全返回空 → 走"任意 `.copyable-text`"兜底拿到第一个（FB 卡片的"Facebook 广告"4 字 header）→ 正文丢。修法：新增"挑最长 `.copyable-text` 自身 textContent"分支，放在 `.copyable-text .selectable-text` 之后兜底
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
- **`.in('id', [...])` URL 长度炸弹依然有效**（前文 2026-05-08 已记）。Realtime 改造后已经全部换 `contact_handlers!inner(user_id)` 服务端 join 路径
- **AI source attribution 是启发式不是真理**（`lib/ai-reply-attribution.ts`）：5 分钟窗口 + 60% 公共前缀阈值。销售改太多字（前缀 60% 不命中）→ 归 null；fill 后超 5 分钟才发 → 归 null。这些都是预期行为不是 bug。`messages.ai_source = null` ≠ "manual"，应理解为"未归因"
- **GPT 不喂 reference data 是有意为之**（`gpt-prompt.ts`）：GPT-5 Thinking 自己联网查 + 推理报价效果更好，prompt 不要塞车型库 / Ghana playbook 等 reference。Claude 那边保留（Claude 默认不联网）。修改 prompt 时不要"对齐两个 AI"
- **Claude `[Sales Guidance — TOP PRIORITY]` 段是 override 不是 hint**：销售在 textarea 里写"用阿拉伯语回复 + 强硬一点"，prompt 顶部注入这段，Claude 必须严格执行覆盖默认行为。改 prompt 模板时不要把这段降级成普通指令
- **自动回复 P0 安全：reply 必须先 `sanitizeReplyForCustomer` 再 paste**（`content/auto-reply.ts`）：自动发=没人 review，Gem 偶尔会把 [INTERNAL] EXW 价或 floor 拼到回复里，泄漏 = 灾难。手动 fillReply 路径可以放过（销售自己看到才发），但 auto-send 路径绝对不能省 sanitize
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
  1. **改 CLAUDE.md**：在"### 还可以做的（不急）"之前插入新章节"### 近期补完（YYYY-MM-DD）— 一句话标题"，含**起点**（用户原话或具体症状） / **根因**（Chrome MCP / 实测拿到的证据，不靠猜） / **修法**（具体改了哪几个函数 + 关键代码思路） / **验证**（Chrome MCP / 实测拿到的结果）/ **教训**（下次别再踩的具体规则）。同时在"## 已知问题 / 风险"段补对应的"以后写新代码要注意"那条
  2. **`cd extension && npm run package`**：自动写 BUILD_VERSION → tsc + vite build → zip 到 `dist-zips/` → 用 service_role 推 `app_config.required_version` 到 Supabase → 还原 build-version.ts（让 git 干净）。**每次打包 = 强制全员升级**，旧版扩展 5 分钟内被 VersionGate 弹窗拦下
  3. **git commit**：中文 message 多段——首行一句话总结；空行；详细段含起点 / 根因 / 修法。用 HEREDOC + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer。**只 add 改过的源文件 + CLAUDE.md**（dist-zips/ 已 gitignore，不管它）
  4. **`git push origin main`**
  5. 报告用户：版本号 + zip 路径 + 提示 boss 自己 chrome://extensions/ 点 ↻ 重载 + WA Web F5；其他销售会被 VersionGate 拦下要装新 zip
