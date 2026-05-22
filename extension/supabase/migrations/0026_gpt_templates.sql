-- 0026: ChatGPT 自建 GPT 模板化 — 跟 Gem 那套对齐
--
-- 背景：之前 gpt_conversations（0023）跟 claude_conversations 一样走单 persona
-- 路径，自定义 GPT URL 用 chrome.storage 存一个全局 URL。现在改成 Gem 模式：
--   - gpt_templates：用户在 chatgpt.com/gpts 自建多个 Custom GPT，每个 URL 存一行
--   - gpt_conversations：PK 改 (contact_id, template_id)，每个 (客户, 模板) 一条
--     续聊 chat URL
--
-- per-user RLS：跟 0014 给 gem_templates 改的一样——每个销售只看到自己 ChatGPT
-- 账号下建的 Custom GPT URL（别人的 URL 自己访问会 404 / 权限失败）
-- is_default 含义：'我的默认'（per-user）
--
-- 自包含：无论 0023 是否应用过都能跑（drop if exists + 重建 gpt_conversations）

------------------------------------------------------------------------------
-- 1. gpt_templates 表
------------------------------------------------------------------------------

create table gpt_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  gpt_url     text not null,
  description text,
  is_default  boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index on gpt_templates (org_id, created_at desc);
create index on gpt_templates (created_by);

create trigger gpt_templates_touch_updated
  before update on gpt_templates
  for each row execute function public.touch_updated_at();

alter table gpt_templates enable row level security;

-- per-user RLS（跟 0014 的 gem_templates 同款）：
-- 读写都要求 created_by = auth.uid() 且 caller 是 org 成员
create policy "gpt_templates read"
  on gpt_templates for select using (
    public.is_org_member(org_id) and created_by = auth.uid()
  );

create policy "gpt_templates write"
  on gpt_templates for all using (
    public.is_org_member(org_id) and created_by = auth.uid()
  ) with check (
    public.is_org_member(org_id) and created_by = auth.uid()
  );

-- 自动填 created_by = auth.uid() 如果客户端没传（跟 gem_templates 同款）
create or replace function public.fill_gpt_template_owner()
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

create trigger gpt_templates_fill_owner
  before insert on gpt_templates
  for each row execute function public.fill_gpt_template_owner();

------------------------------------------------------------------------------
-- 2. gpt_conversations 表（drop + 重建，自包含）
--
-- 旧 0023 schema 里 PK 是单列 contact_id（"无模板默认 GPT"）。新 schema 改成
-- (contact_id, template_id) UNIQUE + id 主键。chat URL 缓存而已，丢了下次
-- 重新生成 GPT 会发新的，没有数据需要保留。
-- 0023 没跑过的 Supabase 也能直接执行（drop if exists）。
------------------------------------------------------------------------------

drop table if exists gpt_conversations cascade;

create table gpt_conversations (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references contacts(id) on delete cascade,
  template_id   uuid not null references gpt_templates(id) on delete cascade,
  chat_url      text not null,
  last_used_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (contact_id, template_id)
);

create index on gpt_conversations (contact_id);
create index on gpt_conversations (template_id);
create index on gpt_conversations (last_used_at desc);

alter table gpt_conversations enable row level security;

create policy "gpt_conversations read"
  on gpt_conversations for select using (
    exists (
      select 1 from contacts c
      where c.id = gpt_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "gpt_conversations write"
  on gpt_conversations for all using (
    exists (
      select 1 from contacts c
      where c.id = gpt_conversations.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = gpt_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

comment on table gpt_templates is
  'Per-user Custom GPT templates (mirror of gem_templates). Each row is a Custom GPT URL the sales rep built on chatgpt.com.';
comment on table gpt_conversations is
  'Per-(contact, template) ChatGPT chat URL cache. Continues the same chat URL next time so GPT remembers context.';
