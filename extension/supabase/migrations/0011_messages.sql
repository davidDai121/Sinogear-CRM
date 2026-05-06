-- 0011: WhatsApp 消息历史持久化
--
-- 每次客户聊天打开时，content script 调 syncMessages 把当前 DOM 可见的消息 upsert 进来。
-- 用 wa_message_id (来自 WhatsApp data-id) 去重，所以重复 sync 不会产生重复行。
-- 历史消息靠"被动累积"——用户每次打开/滚动聊天，能看见的部分自动入库。

create type message_direction as enum ('inbound', 'outbound');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references contacts(id) on delete cascade,
  wa_message_id   text not null,
  direction       message_direction not null,
  text            text not null,
  sent_at         timestamptz,
  synced_at       timestamptz not null default now(),
  unique (contact_id, wa_message_id)
);

create index on messages (contact_id, sent_at desc);

alter table messages enable row level security;

create policy "messages read"
  on messages for select using (
    exists (
      select 1 from contacts c
      where c.id = messages.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "messages write"
  on messages for all using (
    exists (
      select 1 from contacts c
      where c.id = messages.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = messages.contact_id and public.is_org_member(c.org_id)
    )
  );
