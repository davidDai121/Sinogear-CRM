-- 0021: contact_pins — 销售员个人置顶客户
--
-- 背景：
--   销售经理每天 50-100 个客户，需要标记"我现在重点要跟"的几个，
--   让他们在左边栏顶部独立成档，不被其他客户淹没。
--
-- 设计跟 contact_handlers 类同：
--   - per-user（每个销售自己的置顶集，互不影响）
--   - (contact_id, user_id) 复合主键
--   - 用户切换设备能看到自己的置顶（DB 而不是 chrome.storage）
--
-- 字段：
--   - pinned_at：置顶时间，前端可以按这个排序（最近置顶在上）
--   - note：可选备注（例如"这个月一定要成交"），暂不在 UI 暴露但留好扩展位

create table contact_pins (
  contact_id  uuid not null references contacts(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  pinned_at   timestamptz not null default now(),
  note        text,
  primary key (contact_id, user_id)
);

create index on contact_pins (user_id, pinned_at desc);
create index on contact_pins (contact_id);

alter table contact_pins enable row level security;

-- RLS：读取要求同 org（通过 contact 反查 org_id），写入只能 user_id=auth.uid()
create policy "contact_pins read"
  on contact_pins for select using (
    exists (
      select 1 from contacts c
      where c.id = contact_pins.contact_id
        and public.is_org_member(c.org_id)
    )
  );

create policy "contact_pins write"
  on contact_pins for all using (
    user_id = auth.uid()
    and exists (
      select 1 from contacts c
      where c.id = contact_pins.contact_id
        and public.is_org_member(c.org_id)
    )
  ) with check (
    user_id = auth.uid()
    and exists (
      select 1 from contacts c
      where c.id = contact_pins.contact_id
        and public.is_org_member(c.org_id)
    )
  );
