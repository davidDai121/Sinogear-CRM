-- 0045: coexistence 同步健康度——每个号每天收了多少、入库多少、跳过/失败多少
--
-- 背景（2026-09-23）：Grant 接入当天，Meta 推来的前几批 history 被 webhook 解析成 0 条
-- 并回了 200——Meta 认为送达、不会再推，这些数据就永久丢了，而系统没有任何告警，
-- 是翻函数日志才发现的。boss 要求「同步出错要看得见」。
--
--   wa_number_daily_stats  每号每天计数，CRM「📡 号码同步状态」读它（org 成员可读）
--   wa_webhook_failures    失败批次 / 跳过的畸形消息原始载荷，留着补录（仅 service_role）
--   wa_business_numbers.last_error / last_error_at  最近一次出错，卡片上直接显示

create table public.wa_number_daily_stats (
  org_id    uuid not null references public.organizations(id) on delete cascade,
  phone     text not null,
  day       date not null,
  received  integer not null default 0,  -- webhook 解析出的消息条数
  inserted  integer not null default 0,  -- 新入库（其余是已有消息被去重）
  skipped   integer not null default 0,  -- 格式异常被跳过（原文进 wa_webhook_failures）
  failed    integer not null default 0,  -- 整批入库失败、回了 503 等 Meta 重推的次数
  updated_at timestamptz not null default now(),
  primary key (org_id, phone, day)
);

alter table public.wa_number_daily_stats enable row level security;
create policy "wa stats read" on public.wa_number_daily_stats
  for select using (public.is_org_member(org_id));

create table public.wa_webhook_failures (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  org_id      uuid,
  phone       text,
  kind        text not null check (kind in ('batch_failed', 'message_skipped')),
  reason      text,
  payload     jsonb not null
);
create index wa_webhook_failures_created_idx on public.wa_webhook_failures (created_at desc);

-- 含客户聊天原文：不开任何 policy，只有 service_role（webhook / 补录脚本）能读写
alter table public.wa_webhook_failures enable row level security;

alter table public.wa_business_numbers
  add column last_error text,
  add column last_error_at timestamptz;

-- webhook 每批调一次，按天累加
create or replace function public.wa_record_stats(
  p_org uuid, p_phone text,
  p_received integer, p_inserted integer, p_skipped integer, p_failed integer
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.wa_number_daily_stats as s
    (org_id, phone, day, received, inserted, skipped, failed)
  values (p_org, p_phone, (now() at time zone 'utc')::date,
          p_received, p_inserted, p_skipped, p_failed)
  on conflict (org_id, phone, day) do update set
    received   = s.received + excluded.received,
    inserted   = s.inserted + excluded.inserted,
    skipped    = s.skipped  + excluded.skipped,
    failed     = s.failed   + excluded.failed,
    updated_at = now();
$$;

revoke all on function public.wa_record_stats(uuid, text, integer, integer, integer, integer) from public, anon, authenticated;
