-- 0008: Gemini Gem 模板 + 客户对话缓存
--   gem_templates       一个 org 拥有多个 Gem 模板（用户在 gemini.google.com 自建的 Gem URL）
--   gem_conversations   每个 (contact, template) 第一次对话后存下 chat URL，下次续聊直接打开

create table gem_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  gem_url     text not null,
  description text,
  is_default  boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index on gem_templates (org_id, created_at desc);

create trigger gem_templates_touch_updated
  before update on gem_templates
  for each row execute function public.touch_updated_at();

alter table gem_templates enable row level security;

create policy "gem_templates read"
  on gem_templates for select using (public.is_org_member(org_id));

create policy "gem_templates write"
  on gem_templates for all using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));


create table gem_conversations (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references contacts(id) on delete cascade,
  template_id   uuid not null references gem_templates(id) on delete cascade,
  gem_chat_url  text not null,
  last_used_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (contact_id, template_id)
);

create index on gem_conversations (contact_id);
create index on gem_conversations (template_id);

alter table gem_conversations enable row level security;

create policy "gem_conversations read"
  on gem_conversations for select using (
    exists (
      select 1 from contacts c
      where c.id = gem_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "gem_conversations write"
  on gem_conversations for all using (
    exists (
      select 1 from contacts c
      where c.id = gem_conversations.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = gem_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );
