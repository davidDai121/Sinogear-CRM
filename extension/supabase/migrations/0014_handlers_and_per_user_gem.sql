-- 0014: 客户主理人 (contact_handlers) + Gem 模板改 per-user
--
-- 背景：
--   团队多个销售共用一个 org 时，A 不希望聊天/客户/任务列表被 B 的客户淹没。
--   方案：按"客户主理人"过滤视图，但数据本身仍 org 共享。
--
-- contact_handlers：(contact_id, user_id) 对一个客户来说，谁打开过 / 谁聊过的人都算
--   - 创建客户时通过 trigger 自动注册创建者
--   - 进入 WhatsApp 聊天时由 useMessageSync 心跳 upsert
--   - 同一 contact 出现 2+ user_id → 撞单（前端给名字加 tag）
--
-- gem_templates per-user：
--   - 每个销售在自己 Gemini 账号下建的 Gem，URL 别人打不开
--   - RLS 改为只读/写 created_by = auth.uid() 的模板
--   - is_default 含义从 "org 默认" 变为 "我的默认"

------------------------------------------------------------------------------
-- 1. contact_handlers 表
------------------------------------------------------------------------------

create table contact_handlers (
  contact_id   uuid not null references contacts(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (contact_id, user_id)
);

create index on contact_handlers (user_id, last_seen_at desc);
create index on contact_handlers (contact_id);

alter table contact_handlers enable row level security;

-- RLS：通过 contact 反查 org_id 来判断是否同 org 成员
create policy "contact_handlers read"
  on contact_handlers for select using (
    exists (
      select 1 from contacts c
      where c.id = contact_handlers.contact_id
        and public.is_org_member(c.org_id)
    )
  );

-- 写：只能给自己加/改/删；并且必须是该 org 成员
create policy "contact_handlers write"
  on contact_handlers for all using (
    user_id = auth.uid()
    and exists (
      select 1 from contacts c
      where c.id = contact_handlers.contact_id
        and public.is_org_member(c.org_id)
    )
  ) with check (
    user_id = auth.uid()
    and exists (
      select 1 from contacts c
      where c.id = contact_handlers.contact_id
        and public.is_org_member(c.org_id)
    )
  );

------------------------------------------------------------------------------
-- 2. 自动注册 trigger：创建 contact 时把当前 auth.uid() 注册为 handler
------------------------------------------------------------------------------

create or replace function public.auto_register_contact_handler()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into contact_handlers (contact_id, user_id)
    values (new.id, auth.uid())
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger contacts_auto_register_handler
  after insert on contacts
  for each row execute function public.auto_register_contact_handler();

------------------------------------------------------------------------------
-- 3. 历史回填：已有客户的 created_by 注册为 handler
--    （没有 created_by 的老数据跳过 — 等用户下次打开聊天时心跳补上）
------------------------------------------------------------------------------

insert into contact_handlers (contact_id, user_id, last_seen_at)
select id, created_by, created_at
from contacts
where created_by is not null
on conflict do nothing;

------------------------------------------------------------------------------
-- 4. gem_templates RLS 改 per-user
--
--    旧策略：is_org_member(org_id) → 全 org 共享
--    新策略：is_org_member(org_id) AND created_by = auth.uid() → 仅自己
------------------------------------------------------------------------------

drop policy if exists "gem_templates read" on gem_templates;
drop policy if exists "gem_templates write" on gem_templates;

create policy "gem_templates read"
  on gem_templates for select using (
    public.is_org_member(org_id) and created_by = auth.uid()
  );

create policy "gem_templates write"
  on gem_templates for all using (
    public.is_org_member(org_id) and created_by = auth.uid()
  ) with check (
    public.is_org_member(org_id) and created_by = auth.uid()
  );

-- 自动填 created_by = auth.uid() 如果客户端没传
create or replace function public.fill_gem_template_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger gem_templates_fill_owner
  before insert on gem_templates
  for each row execute function public.fill_gem_template_owner();
