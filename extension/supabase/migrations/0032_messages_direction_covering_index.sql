-- 0032_messages_direction_covering_index.sql
--
-- 修 last_message_direction_per_contact RPC 超时（57014 statement timeout
-- + PostgREST "Thread killed by timeout manager" 满屏 500）。
--
-- 根因：该 RPC（0019 建、0022 扩）对整张 messages 表做聚合——
--   select contact_id,
--          max(sent_at) filter (direction=inbound/outbound),
--          count(*) filter (direction=inbound/outbound)
--   from messages join contacts ... group by contact_id
-- 现有索引 (contact_id, sent_at desc) 不含 direction，查询走的是顺序扫描，
-- 把每行的肥 text 正文都读出来。38k 行 + text 大字段 + 3 销售每 5min 并发
-- + upsert/方向自愈造成的表膨胀 → 轻松撑爆 authenticated 角色 8s 超时。
--
-- 修法：建一个正好覆盖该查询所需 3 列的索引 (contact_id, direction, sent_at)，
-- 让聚合走 index-only scan，完全不碰 text 堆。partial WHERE sent_at IS NOT NULL
-- 对齐 RPC 里的 `and m.sent_at is not null`，索引更小。
--
-- CONCURRENTLY = 不锁表，可在生产实时建（messages 一直被 useMessageSync 写）。
-- ⚠️ CONCURRENTLY 不能在事务块里跑——在 Supabase SQL Editor 里单独执行本语句，
--    不要和别的语句一起包进 BEGIN/COMMIT。

create index concurrently if not exists messages_contact_dir_sent_idx
  on public.messages (contact_id, direction, sent_at)
  where sent_at is not null;

-- 让 planner 立刻用上新索引 + 顺手清一次 upsert/UPDATE 攒下的死元组膨胀。
-- （analyze 可在事务里；vacuum 也要单独跑，别包事务。）
analyze public.messages;
