-- 0012_keepalive.sql
-- Prevent Supabase free-tier auto-pause (after 7 days of no activity).
-- Strategy: a pg_cron job writes a heartbeat row daily, which counts
-- as database activity in Supabase's pause detection.
--
-- Prereq: pg_cron extension. It's pre-installed on Supabase free tier;
-- if not yet enabled, turn it on at:
--   Dashboard → Database → Extensions → search "pg_cron" → toggle on.
-- (Or run `create extension if not exists pg_cron;` first.)

-- ---------------------------------------------------------------
-- Heartbeat table — one row, holds the last ping timestamp
-- ---------------------------------------------------------------
create table if not exists public._keepalive (
  id         int primary key default 1,
  last_ping  timestamptz not null default now(),
  constraint _keepalive_singleton check (id = 1)
);

insert into public._keepalive (id, last_ping)
values (1, now())
on conflict (id) do nothing;

-- Block all client access. Cron runs as postgres role and bypasses RLS,
-- so the daily update will still work.
alter table public._keepalive enable row level security;

-- ---------------------------------------------------------------
-- Schedule daily heartbeat at 03:00 UTC
-- Idempotent: re-running this migration replaces any existing job.
-- (Supabase blocks direct DELETE on cron.job — must use cron.unschedule().)
-- ---------------------------------------------------------------
do $$
begin
  perform cron.unschedule('sgc-keepalive');
exception when others then
  -- Job didn't exist yet, that's fine
  null;
end $$;

select cron.schedule(
  'sgc-keepalive',
  '0 3 * * *',
  $$update public._keepalive set last_ping = now() where id = 1$$
);

-- ---------------------------------------------------------------
-- Verify with:
--   select * from cron.job where jobname = 'sgc-keepalive';
--   select * from public._keepalive;
-- After 24h, last_ping should auto-advance.
-- Job run log:
--   select * from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'sgc-keepalive')
--    order by start_time desc limit 5;
-- ---------------------------------------------------------------
