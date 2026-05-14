-- 0019_last_message_direction.sql
--
-- 给"我该回"判定用的高效聚合：每个 contact 的最近 inbound 时间 + 最近
-- outbound 时间。让客户端不用拉几万行消息再客户端 GROUP BY，PostgreSQL
-- 一次返回 N_contacts 行就够。
--
-- 触发场景：客户发消息 → 用户点开 WA Web → WhatsApp 立刻把 unreadCount
-- 清零。旧 needsReply 逻辑 (unreadCount > 0) 立刻把这聊天踢出"我该回"，
-- 哪怕用户没回。新逻辑配合 chrome.storage 的 pending 追踪只能 forward-fill，
-- 解决不了"早就点开过的老 case"（如 Antoine +224 628 19 03 90 案例
-- 2026-05-13 ——昨天打开过，今天还在欠回）。
--
-- 这个 RPC 给 useCrmData 用：补 lastInbound > lastOutbound 这个回填信号。
-- 需要 messages 表里有数据；useMessageSync 在用户开聊天时会自动 sync，
-- 加密备份导入和手机端 .txt 导入也都写到这张表，覆盖率足够。

create or replace function public.last_message_direction_per_contact(p_org_id uuid)
returns table (
  contact_id uuid,
  last_inbound_t timestamptz,
  last_outbound_t timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.contact_id,
    max(case when m.direction = 'inbound' then m.sent_at end) as last_inbound_t,
    max(case when m.direction = 'outbound' then m.sent_at end) as last_outbound_t
  from public.messages m
  inner join public.contacts c on c.id = m.contact_id
  where c.org_id = p_org_id
    and public.is_org_member(p_org_id)
    and m.sent_at is not null
  group by m.contact_id;
$$;

grant execute on function public.last_message_direction_per_contact(uuid) to authenticated;

comment on function public.last_message_direction_per_contact(uuid) is
  '每个 contact 最后一次 inbound 时间 + 最后一次 outbound 时间，给客户端"我该回"判定用。';
