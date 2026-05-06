-- 0009: 给所有已有 contacts 回填 'created' 事件，让历史客户也有时间轴起点。
--
-- 安全：用 NOT EXISTS 防止重复回填（这个 migration 跑多次也只会插一次）。
-- 跳过：已经有 'created' 事件的 contact。

insert into contact_events (contact_id, event_type, payload, created_at)
select
  c.id,
  'created'::contact_event_type,
  jsonb_build_object('source', 'backfill', 'phone', c.phone),
  c.created_at
from contacts c
where not exists (
  select 1 from contact_events e
  where e.contact_id = c.id and e.event_type = 'created'
);
