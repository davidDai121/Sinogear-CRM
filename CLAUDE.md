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
  │       vehicle_tags / tasks / quotes / contact_events
  │       gem_templates / gem_conversations
  ├── chrome.storage 持久化 session
  └── Google 联系人同步（chrome.identity OAuth + People API）

外部服务
  ├── AI 字段抽取（OpenAI 兼容 API，可换）— 阿里云 Qwen
  │   ├── 当前：通义千问 qwen-flash（百炼 1M tokens 免费/月）
  │   ├── 端点 + 模型从 .env 配置（VITE_AI_BASE_URL / VITE_AI_MODEL）
  │   └── 备选：DeepSeek / GLM / Kimi / 其他百炼模型，改 .env 即可
  ├── 翻译：Google Translate gtx（免费、无 key、无配额）
  │   ├── translate.googleapis.com — Chrome 自带翻译同 endpoint
  │   └── 失败 fallback 到 Qwen
  ├── Gemini Gem AI 回复：网页端自动化（非 API，免费）
  │   ├── chrome.tabs 后台打开 gemini.google.com Gem URL
  │   ├── chrome.scripting 注入脚本切换 Pro 模型 + 填 prompt + 读响应
  │   └── 用户在 Gem Builder 自建 Gem，URL 存进 gem_templates 表
  └── Google People API — 联系人双向同步
```

**关键决策：** 销售经理不想维护服务器；Supabase 免费额度够用；WhatsApp Web 直接做聊天界面；多销售可共享一个 org 的客户数据。AI 字段抽取用阿里云 Qwen（国内访问稳定 + 免费额度大）；翻译用 Google Translate gtx（免费 + 无配额 + 比 Qwen 快）；AI 回复用 Gemini Gem 网页端自动化（用户偏好 Gem，免费 + 上下文持久）。

## 目录结构

```
/Users/david/Sino Gear CRM/
├── extension/                          ← 新代码全在这里
│   ├── manifest.json                   MV3 + key（固定 ID）+ oauth2
│   ├── vite.config.ts                  @crxjs + react + @ 别名
│   ├── tsconfig.json
│   ├── package.json
│   ├── README.md                       Supabase + Google + Qwen 配置步骤
│   ├── .env                            Supabase URL/key + Google + Qwen（不入 git）
│   ├── public/icons/                   占位绿色图标
│   ├── src/
│   │   ├── background/
│   │   │   └── service-worker.ts       PING + GET/CLEAR_GOOGLE_TOKEN +
│   │   │                               EXTRACT_FIELDS / EXTRACT_TAGS /
│   │   │                               EXTRACT_TASKS / TRANSLATE_TEXT (Google → Qwen fallback)
│   │   │                               GEM_RUN / GEM_BUSY (Gem 自动化)
│   │   ├── content/
│   │   │   ├── main.tsx                Content script 入口，挂 AppShell
│   │   │   ├── whatsapp-dom.ts         testid + span[title] + 多重 fallback
│   │   │   ├── whatsapp-messages.ts    读当前聊天 + waitForChatMessages 轮询
│   │   │   ├── whatsapp-compose.ts     把文本 paste 入聊天输入框（Gem reply 一键填入）
│   │   │   └── auto-translate.ts       消息气泡自动翻译：观察器 + 顺序队列
│   │   │                               + 每条消息悬停 🌐 手动按钮 (200ms 间隔)
│   │   ├── popup/                      扩展弹窗（登录 + 打开 WhatsApp）
│   │   ├── panel/
│   │   │   ├── AppShell.tsx            顶层组件，路由 6 个 tab + body class 切换
│   │   │   ├── styles.css              所有面板样式
│   │   │   ├── components/
│   │   │   │   ├── TopNav.tsx          顶部 6 tab + 翻译开关 + 重译按钮
│   │   │   │   ├── LoginForm.tsx       注册/登录
│   │   │   │   ├── OrgSetup.tsx        首次创建团队
│   │   │   │   ├── ContactEditForm.tsx 客户编辑表单（聊天卡 + drawer 共用）
│   │   │   │   │                       姓名/国家/语言/预算/目的港/质量/阶段/备注
│   │   │   │   ├── ContactCard.tsx     聊天 tab 右侧：AI 抽取 banner +
│   │   │   │   │                       ContactEditForm + Tags + Vehicle +
│   │   │   │   │                       Quotes + Tasks + Timeline (全 sections)
│   │   │   │   ├── ContactDetailDrawer.tsx  客户 tab drawer：同样所有 sections
│   │   │   │   ├── TagsSection.tsx     标签 CRUD + 🤖 AI 建议
│   │   │   │   ├── VehicleInterestsSection.tsx  车型兴趣
│   │   │   │   ├── QuotesSection.tsx   报价历史 (车型 datalist 联动)
│   │   │   │   ├── ContactTasksSection.tsx      任务 + 🤖 AI 建议
│   │   │   │   ├── TimelineSection.tsx 客户事件时间线（图标 + 相对时间）
│   │   │   │   ├── GemReplySection.tsx Gem AI 回复：模板选择 + 前后台开关 +
│   │   │   │   │                       reply/translation/clientRecord 三段卡 +
│   │   │   │   │                       💬 填入聊天框 + "应用 N 项到客户资料" + 续聊输入框
│   │   │   │   ├── GemTemplatesModal.tsx Gem 模板 CRUD（org 共享，is_default 标记）
│   │   │   │   ├── TaskModal.tsx       任务创建/编辑
│   │   │   │   ├── VehicleModal.tsx    车源创建/编辑
│   │   │   │   ├── GoogleSyncDialog.tsx  Google 联系人同步对话框
│   │   │   │   ├── FilterSidebar.tsx   左侧多维筛选（726 行，主战场）
│   │   │   │   └── FilteredChatList.tsx  筛选结果列表
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
│   │   │       └── useAutoExtract.ts   自动 AI 字段抽取 + 写 ai_extracted/vehicle_added 事件
│   │   └── lib/
│   │       ├── supabase.ts             Supabase client（chrome.storage 适配器）
│   │       ├── database.types.ts       完整数据库类型（含 quotes/contact_events）
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
│   │       ├── gem-automation.ts       Gem 网页端自动化（chrome.tabs + executeScript
│   │       │                            + 模型选择 + 等响应停止生成按钮 + busy 串行）
│   │       └── gem-parser.ts           解析 Gem 响应：[Client Record] / [WhatsApp Reply] /
│   │                                    [Translation]，无标签时按 CJK 比例 fallback 拆分
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
│       └── 0008_gem_templates_and_conversations.sql
│                                        gem_templates（org Gem URL 库）+
│                                        gem_conversations（contact+template → chat URL）
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
                        sale_status(available/paused/expired), short_spec, *_at
vehicle_tags            vehicle_id, tag
tasks                   id, org_id, contact_id, title, due_at,
                        status(open/done/cancelled), created_by, created_at
quotes                  id, contact_id, vehicle_model, price_usd,
                        sent_at, status(draft/sent/accepted/rejected),
                        notes, created_at, updated_at
contact_events          id, contact_id, event_type, payload jsonb, created_at
                        event_type: created/stage_changed/tag_added/
                                    vehicle_added/quote_created/
                                    task_created/ai_extracted
gem_templates           id, org_id, name, gem_url, description, is_default,
                        created_by, *_at
gem_conversations       id, contact_id, template_id, gem_chat_url,
                        last_used_at, created_at
                        UNIQUE(contact_id, template_id)
```

**RLS：** 所有表的 SELECT/INSERT/UPDATE/DELETE 都要求 `auth.uid()` 是 `org_id` 成员（通过 `is_org_member(org_id)` SECURITY DEFINER 函数）。
- quotes / contact_events / gem_conversations 通过 contact 反查 org_id（无 org_id 列）
- contact_events 只有 SELECT/INSERT policy（append-only）

**Helpers：**
- `create_organization(name)` RPC — 原子建 org + 把 caller 加 owner
- `is_org_member(org_id)` — RLS 用
- `touch_updated_at()` trigger — contacts/vehicles/quotes/gem_templates 自动更新 updated_at

**所有 8 个 migration 都已应用到生产 Supabase。**

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
```

**扩展 ID 已用 manifest.json 的 key 字段固定为 `mjleiklkaailpmmclejegahkfnjhjkpj`**——这样 Google OAuth 配置不用每次重装扩展都改。

**.env 需要的变量：**
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — 必填
- `VITE_GOOGLE_CLIENT_ID` — Google 联系人同步用
- `VITE_DASHSCOPE_API_KEY` — AI key（阿里云百炼）
- `VITE_AI_BASE_URL` — 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`（国内）
- `VITE_AI_MODEL` — 默认 `qwen-flash`（百炼免费档，1M tokens/月）
  - 备选：`qwen-turbo-1101`（10M 额度但老）/ `deepseek-v3.2` / `glm-4.7` / `kimi-k2.6`
  - 国际版：endpoint 改成 `dashscope-intl.aliyuncs.com/compatible-mode/v1`

## 测试规则（重要）

- **只能用测试号 13552592187 测试 WhatsApp 功能**，绝不能在真实客户聊天上操作
- WhatsApp Web 的 DOM 经常变。`whatsapp-dom.ts` 已经用 testid + span[title] + dir=auto 三重 fallback；`whatsapp-idb.ts` 直接读 IndexedDB 更稳定
- 修改 UI 后要在真实 WhatsApp Web 上观察行为，不能只看 API 返回
- 验证 UI 用 Chrome MCP（claude-in-chrome），扩展只能在用户已登录的 Chrome 里测，MCP tab 共享同一 profile

## 已完成功能

### 基础设施
- [x] Chrome 扩展骨架（MV3 + Vite + React + TS）
- [x] Supabase 多租户 schema + RLS（**7 个 migration 全部上线**）
- [x] 邮箱密码登录（chrome.storage 持久 session）+ 创建团队
- [x] WhatsApp Web 内嵌顶部 **6 tab**（看板 / 聊天 / 客户 / 车源 / 任务 / 标签）+ 自动 shrink

### WhatsApp 集成
- [x] **聊天检测**：testid + 手机号 parse + IndexedDB 直读 + **保存的联系人 name 缓存**
- [x] **WhatsApp Web IndexedDB 直读**：chats、labels、label-association、contact（@lid → @c.us 映射）
- [x] **WhatsApp 标签 → CRM 字段智能同步**：标签自动归类到 quality / stage / country / vehicle / tag
- [x] **批量同步**：把 WhatsApp 所有聊天导入 contacts（含 @lid 业务号）
- [x] **跳转聊天**：搜索框输入手机号 + 按 **Enter** 键打开

### 客户管理
- [x] **共享 ContactEditForm**：聊天 tab 卡片 + 客户 tab drawer **完全一致**（姓名/国家/语言/预算/目的港/⭐⭐⭐质量/完整 7 阶段/备注）
- [x] **聊天 tab 右侧面板**：核心字段 + 标签 + 车辆兴趣 + 报价历史 + 任务 + 时间轴（drawer 同款全 sections）
- [x] **客户 tab**：列表 + 搜索/阶段筛选 + 每行 **💬 聊天按钮**（一键切到聊天 tab + WhatsApp 跳转）
- [x] **任务 tab 看板化**：4 KPI 卡（今日/本周/累计待跟进/总数）+ 日历常驻（每天写客户名 + "+N" 溢出）+ 选中日详情列表
- [x] **车源库**：vehicles 表 + 卡片网格 + 创建/编辑模态 + 筛选
- [x] **标签 tab**：列表 + 改名/合并/删除（内联确认替代 native confirm）
- [x] **看板 tab**：周/月切换 + 6 KPI 卡 + 阶段漏斗 + 热门车型 Top 5

### 多维筛选系统
- [x] **左侧 240px FilterSidebar**：5 维度（阶段 / 质量 / 区域 / 车型 / 预算）+ 今日待办
- [x] **筛选条件持久化** + **不自动关闭** + **品牌可折叠**
- [x] **车型规范化**：60+ 别名规则 + 噪音剥离 + 一键合并去重
- [x] **品牌自动识别**：30+ 主流品牌 + 首词 fallback + 用户右键改组
- [x] **国家区域映射**：手机号区号 → 国家 → 13 大区
- [x] **预算分档**：新车 / 二手切换 + 5 档

### AI（Qwen 全套，4 种 prompt）
- [x] **AI 字段提取**（`useAutoExtract` 单聊 + `bulk-extract.ts` 批量）：name / country / language / budget / port + vehicles[]
- [x] **AI 标签建议**（TagsSection "🤖 AI 建议"）：销售特征标签（支付方式/紧急度/决策阶段/反对信号），跳过国家/语言/车型等已抽取字段
- [x] **AI 任务建议**（ContactTasksSection "🤖 AI 建议"）：销售下一步动作（动词开头 12 字内 + due_in_days），跳过"等客户回复"
- [x] **自动翻译**（顶栏 "🌐 翻译" 开关 + "🔁 重译" + 每条消息悬停 🌐 按钮）：observer + 顺序队列 + 200ms 间隔 + 缓存，CJK > 30% 自动跳过；**主 Google Translate gtx（免费、无 key、无配额）**，失败 fallback 到 Qwen
- [x] **公共 callQwen helper**：3 次指数退避（3s/8s/15s）+ JSON mode + temperature 0.1

### 销售工作流
- [x] **报价记录**（QuotesSection）：car/price/status(draft/sent/accepted/rejected)/sent_at/notes，车型 datalist 联动 vehicle_interests
- [x] **客户时间轴**（TimelineSection）：append-only contact_events，事件源遍布所有写入点（stage/tag/vehicle/quote/task/ai_extracted/created），垂直时间线 + 图标 + 相对时间
- [x] **阶段自动写回**（stage-sync.ts）：autoStage → DB customer_stage，映射 active→negotiating；sticky stages: quoted/won；并发保护用 `.eq('customer_stage', expected)`

### Gem AI 回复（Phase 4 完整闭环）
- [x] **Gem 模板管理**（GemTemplatesModal）：用户在 gemini.google.com 自建的 Gem URL 录入，is_default 默认模板，CRUD + 顶栏 🤖 Gem 按钮 / 客户卡 "管理模板" 都能进
- [x] **新客户 vs 老客户对话路由**：第一次发送用 template.gem_url 开新对话，Gem 返回的 chat URL 存到 gem_conversations，下次同一 (contact, template) 直接打开那个 URL 续聊（保留 Gem 上下文）
- [x] **chrome.tabs 自动化**（gem-automation.ts）：后台/前台开关 → 创建 tab 加载 Gem URL → 等 ready → 注入脚本切换 Pro 模型（适配中文界面"快速/思考/Pro/Ultra"）→ 填 prompt + 点发送 → 等"停止生成"按钮消失（240s timeout）→ 取最终 chat URL → 关 tab；busy 单 flag 串行
- [x] **响应解析**（gem-parser.ts）：拆 [Client Record] / [WhatsApp Reply] / [Translation] 三段，无标签时按 CJK 比例兜底
- [x] **Reply card + 一键填入**（GemReplySection + whatsapp-compose.ts）：reply 显示成绿边卡，💬 按钮 paste 到 WhatsApp 输入框（不自动发送），不在当前聊天则先 jumpToChat
- [x] **[Client Record] 应用到客户资料**：差异化对比 + "应用 N 项" 按钮 → update contacts (country/language/budget_usd/destination_port/customer_stage/name) + upsert contact_tags + 写 ai_extracted 时间轴事件
- [x] **续聊对话框**：done 状态下常驻 textarea，Cmd/Ctrl+Enter 发送，输入啥发啥（不加 [Sales Guidance] 前缀，自由对话），保留 Gem 上下文

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

### 还可以做的（不急）

- [ ] 聊天媒体捕获 Phase C 收尾：lightbox 边播边录视频已上 + 多选 toolbar 加 PDF/Excel/视频；如需更稳的视频抓取可调研 WA 内部 download API
- [ ] 旧"已知问题"清理 + WA Web DOM/IDB schema 漂移监测

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

## 用户偏好

- 偏好免费方案（不愿付费用 Gemini API，用阿里云 Qwen 代替；Gem 自动化用网页端而非 API）
- 销售工作台 UX 参考 WAPlus（顶部 tab + 右侧 CRM 面板）
- 中文交流，UI 文案中文 + 客户对话原文（多语言）
- 修改后让我用 Chrome MCP 自动验证，不要每次都让用户手动验
