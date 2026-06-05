-- 0031_weekly_reports.sql
-- 每周/每月分析报告存储。由本地脚本 / 后端用 service_role 写入(绕过 RLS);
-- 组织成员经 RLS 只读自己组织的报告,供扩展「周报」标签展示(可切换 周报/月报)。

create table if not exists public.weekly_reports (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  period      text not null default 'week',  -- 'week'(近7天) | 'month'(近30天)
  week_of     date not null,                 -- 报告数据截至日
  summary     jsonb,        -- 头部关键指标(扩展内联展示用)
  html        text,         -- 完整自包含看板 HTML(点开新标签查看)
  created_at  timestamptz not null default now(),
  unique (org_id, period, week_of)
);

create index if not exists weekly_reports_org_period_week_idx
  on public.weekly_reports (org_id, period, week_of desc);

alter table public.weekly_reports enable row level security;

drop policy if exists "org members read weekly_reports" on public.weekly_reports;
create policy "org members read weekly_reports"
  on public.weekly_reports for select
  using (
    org_id in (
      select org_id from public.organization_members where user_id = auth.uid()
    )
  );

-- 写入仅走 service_role(自动绕过 RLS),不开放 anon/authenticated 的写策略。

-- ── 若表已按 0003 早期版本(无 period 列)建好,在生产库执行以下迁移即可 ──
-- alter table public.weekly_reports add column if not exists period text not null default 'week';
-- alter table public.weekly_reports drop constraint if exists weekly_reports_org_id_week_of_key;
-- do $$ begin
--   if not exists (select 1 from pg_constraint where conname='weekly_reports_org_period_week_key') then
--     alter table public.weekly_reports add constraint weekly_reports_org_period_week_key unique (org_id, period, week_of);
--   end if;
-- end $$;
