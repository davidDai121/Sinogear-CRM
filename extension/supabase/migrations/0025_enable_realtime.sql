-- 0025: 启用 Supabase Realtime（postgres_changes 订阅）
--
-- 目的：替代 useCrmData / ScopeContext 的定时轮询。免费层 5 GB egress
-- 限制下，1700 contacts × 20s 轮询 × 多销售一两天就跑爆。改 Realtime 后
-- 只在初次加载 + 30 分钟兜底 refetch 时拉数据，正常使用 egress 趋近 0。
--
-- REPLICA IDENTITY FULL：让 DELETE / UPDATE 事件的 payload.old 包含完整
-- 旧行（不仅 PK）。前端关联表（vehicle_interests / contact_tags /
-- contact_handlers）需要 contact_id 来定位 state 里的归属，默认 IDENTITY
-- 只发 PK：vehicle_interests PK 是 id，不含 contact_id。
-- 这些表行数都在万级，FULL 的 WAL overhead 可忽略。

alter table public.contacts          replica identity full;
alter table public.vehicle_interests replica identity full;
alter table public.contact_tags      replica identity full;
alter table public.contact_handlers  replica identity full;

-- 加入 supabase_realtime publication（已存在则跳过）
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'contacts'
  ) then
    alter publication supabase_realtime add table public.contacts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'vehicle_interests'
  ) then
    alter publication supabase_realtime add table public.vehicle_interests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'contact_tags'
  ) then
    alter publication supabase_realtime add table public.contact_tags;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'contact_handlers'
  ) then
    alter publication supabase_realtime add table public.contact_handlers;
  end if;
end $$;
