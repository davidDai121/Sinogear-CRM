-- 0022_message_counts_for_classifier.sql
--
-- 扩展 0019 的 RPC：除了 last_inbound_t / last_outbound_t，再多返回
-- inbound_count / outbound_count。
--
-- 用途：chat-classifier 的"有历史保护"。当客户在 messages 表里有实质
-- 双向历史（双方各 ≥ 5 条），即使 WA chat.t 跨过 7 天的 lost 阈值，
-- 也只降到 stalled，不允许自动改成 lost——防止"以前聊得火热、最近
-- 沉默"的客户被 stage-sync 反复改回 lost 覆盖手工 negotiating 标记
-- （2026-05-19 Aca / DON / Grant Wang 等 70+ 客户案例的根因）。

create or replace function public.last_message_direction_per_contact(p_org_id uuid)
returns table (
  contact_id uuid,
  last_inbound_t timestamptz,
  last_outbound_t timestamptz,
  inbound_count int,
  outbound_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.contact_id,
    max(case when m.direction = 'inbound' then m.sent_at end) as last_inbound_t,
    max(case when m.direction = 'outbound' then m.sent_at end) as last_outbound_t,
    count(*) filter (where m.direction = 'inbound')::int as inbound_count,
    count(*) filter (where m.direction = 'outbound')::int as outbound_count
  from public.messages m
  inner join public.contacts c on c.id = m.contact_id
  where c.org_id = p_org_id
    and public.is_org_member(p_org_id)
    and m.sent_at is not null
  group by m.contact_id;
$$;

grant execute on function public.last_message_direction_per_contact(uuid) to authenticated;

comment on function public.last_message_direction_per_contact(uuid) is
  '每个 contact 最后一次 inbound/outbound 时间 + 各方向消息总数。chat-classifier 的"有历史保护"逻辑用 count 做实质对话判断。';
