-- 0017: app_config 通用键值配置表 + required_version 强制版本号
--
-- 用途：boss 这台机器是权威。`npm run package` 后脚本自动 upsert
-- ('required_version', '0.1.0-YYYYMMDD')。其他销售扩展启动时拉这一行，
-- 跟自己烤进客户端的 BUILD_VERSION 对比，**不一致或拉不到 → 拦死**。

create table app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz default now()
);

alter table app_config enable row level security;

-- 公开可读（用 anon key 也能拉 — VersionGate 在登录前就能拦截，避免
-- 旧版扩展先尝试登录、登录失败时让人摸不着头脑）
create policy "app_config read" on app_config
  for select using (true);

-- 不写客户端写入策略：service_role 默认 bypass RLS，只有打包脚本
-- （拿 SUPABASE_SERVICE_ROLE_KEY）能写。普通登录 user 不能改。

-- 启动种子（实际值会被 package 脚本覆盖）
insert into app_config (key, value)
  values ('required_version', '0.0.0-bootstrap')
  on conflict (key) do nothing;
