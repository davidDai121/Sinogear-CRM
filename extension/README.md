# Sino Gear CRM — Chrome Extension

WhatsApp Web 内嵌的 CRM 面板，多用户协作，数据存 Supabase。

## 架构

```
Chrome Extension (Manifest V3)
  ├── Content Script  → 注入 web.whatsapp.com，叠加 CRM 面板
  ├── Popup           → 登录 / 状态
  ├── Background SW   → 跨 tab 协调（后续 Gemini 自动化）
  └── React + Vite + TypeScript

Supabase
  ├── Auth     → 邮箱密码登录
  ├── Postgres → 客户、车辆、任务、标签
  └── RLS      → 多租户（按 organization_id 隔离）
```

---

## 一次性设置（你需要做的）

### 1. 创建 Supabase 项目

1. 登录 https://supabase.com → New project
2. 起个名字（例如 `sino-gear-crm`），选离你最近的区域
3. 设个数据库密码，记住
4. 等待项目创建完成（约 2 分钟）

### 2. 跑数据库迁移

打开 Supabase Dashboard → SQL Editor → New query，**按顺序**复制粘贴执行：

1. `supabase/migrations/0001_init.sql` — 建表 + RLS 策略
2. `supabase/migrations/0002_create_org_rpc.sql` — 创建团队的 RPC 函数

### 3. 拿到 API 密钥

Supabase Dashboard → Project Settings → API：
- **Project URL** → `https://xxx.supabase.co`
- **anon / public key** → `eyJhbGciOi...`（很长一串）

### 4. 配置扩展环境变量

```bash
cd extension
cp .env.example .env
# 用编辑器打开 .env，填入上面拿到的两个值
```

### 5. 安装依赖 + 构建

```bash
npm install
npm run build
```

构建产物在 `dist/`。

### 6. 装到 Chrome

1. 打开 `chrome://extensions/`
2. 右上角打开"开发者模式"
3. 点"加载已解压的扩展程序"
4. 选 `extension/dist/` 文件夹
5. 扩展装好后，浏览器右上角会出现图标

### 7. 第一次使用

1. 点扩展图标 → 注册账号（邮箱 + 密码）
2. **重要：去 Supabase Dashboard → Authentication → Users**，找到刚注册的用户，**手动确认邮箱**（或在 Auth Settings 关掉邮箱验证）
3. 回到扩展，登录
4. 创建团队（输入团队名称）
5. 打开 https://web.whatsapp.com/ → 扫码登录 WhatsApp
6. 点开任意聊天 → 右侧应该出现 CRM 面板

---

## 开发

```bash
npm run dev      # 启动 Vite dev server（热更新）
npm run build    # 生产构建
npm run typecheck  # 仅类型检查
```

开发模式下：
- 修改代码会自动重新构建到 `dist/`
- 在 `chrome://extensions/` 点扩展卡片上的"刷新"按钮重新加载
- 刷新 web.whatsapp.com 看效果

---

## Google 联系人同步设置（一次性）

扩展 ID 已经被 manifest 里的 key 字段固定为：

```
mjleiklkaailpmmclejegahkfnjhjkpj
```

下面的步骤一次配置完毕，以后就不用再动。

### 1. 创建 Google Cloud 项目

1. 打开 https://console.cloud.google.com/
2. 顶栏 → 选择项目 → "新建项目"
3. 项目名：`Sino Gear CRM`，组织/位置默认 → 创建

### 2. 启用 People API

1. 左侧菜单 → "API 和服务" → "已启用的 API 和服务"
2. 点 "+ 启用 API 和服务"
3. 搜 "People API" → 点进去 → 启用

### 3. 配置 OAuth 同意屏幕

1. 左侧 → "OAuth 同意屏幕"
2. User Type 选 "External" → 创建
3. 应用名称：`Sino Gear CRM`
4. 用户支持电子邮件：你的邮箱
5. 开发者联系信息：你的邮箱
6. 保存并继续 → Scopes 跳过 → 测试用户：**添加你自己的 Gmail** → 保存

（不用提交审核——只要你自己用，加自己为测试用户就行）

### 4. 创建 OAuth Client ID

1. 左侧 → "凭据"
2. 点 "+ 创建凭据" → "OAuth 客户端 ID"
3. 应用类型：**Chrome 扩展**
4. 名称：`Sino Gear CRM Extension`
5. 应用 ID（Application ID）：`mjleiklkaailpmmclejegahkfnjhjkpj`
6. 创建 → 复制弹窗里的 **Client ID**（形如 `xxx.apps.googleusercontent.com`）

### 5. 把 Client ID 加到 .env

```bash
cd extension
echo "VITE_GOOGLE_CLIENT_ID=你刚复制的-client-id.apps.googleusercontent.com" >> .env
npm run build
```

然后 `chrome://extensions/` → ↻ 重新加载扩展。

### 6. 第一次使用

1. WhatsApp Web → 客户 tab → 右上角 "↻ Google 同步"
2. 选同步方向（推荐先 Google → CRM 试试）
3. 点 "开始同步"
4. 第一次会弹 Google 授权页，登录你的 Gmail，同意访问联系人
5. 等同步完成，看摘要（新增 N / 更新 M / 跳过 K）

匹配规则：用手机号匹配（Google 联系人和 CRM 客户用 +国际区号 + 数字 比较）。

---

## 团队协作（多用户）

目前邀请新成员的流程是手工的：

1. 新成员先在扩展里注册（会创建 auth.users 记录）
2. 现有 owner 在 Supabase SQL Editor 执行：
   ```sql
   insert into organization_members (org_id, user_id, role)
   values (
     '<your-org-id>',
     (select id from auth.users where email = 'newmember@example.com'),
     'member'
   );
   ```

后续会做邀请 UI。

---

## 目录结构

```
extension/
├── manifest.json              # MV3 清单
├── vite.config.ts             # Vite + @crxjs 插件
├── tsconfig.json
├── .env.example
├── src/
│   ├── background/
│   │   └── service-worker.ts  # 后台脚本
│   ├── content/
│   │   ├── main.tsx           # Content script 入口
│   │   └── whatsapp-dom.ts    # WhatsApp Web DOM 读取
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── Popup.tsx
│   │   └── popup.css
│   ├── panel/
│   │   ├── Panel.tsx          # 注入到 WhatsApp Web 的主面板
│   │   ├── styles.css
│   │   ├── components/
│   │   │   ├── LoginForm.tsx
│   │   │   ├── OrgSetup.tsx
│   │   │   └── ContactCard.tsx
│   │   └── hooks/
│   │       ├── useAuth.ts
│   │       ├── useOrg.ts
│   │       ├── useCurrentChat.ts
│   │       └── useContact.ts
│   └── lib/
│       ├── supabase.ts        # Supabase client
│       └── database.types.ts  # 数据库类型
└── supabase/
    └── migrations/
        ├── 0001_init.sql
        └── 0002_create_org_rpc.sql
```

---

## 后续功能（按优先级）

- [ ] 标签系统（contact_tags 表已建好）
- [ ] 车辆兴趣（vehicle_interests 表已建好）
- [ ] 任务管理（tasks 表已建好）
- [ ] Gemini Gem 自动化（chrome.tabs API）
- [ ] 自动翻译（Google Translate）
- [ ] 消息历史抓取（DOM mutation observer）
- [ ] 团队成员邀请 UI
- [ ] 数据从旧 PostgreSQL 迁移
