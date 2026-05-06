-- 0007: 客户时间轴事件 — append-only log of meaningful contact actions.

create type contact_event_type as enum (
  'created',
  'stage_changed',
  'tag_added',
  'vehicle_added',
  'quote_created',
  'task_created',
  'ai_extracted'
);

create table contact_events (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references contacts(id) on delete cascade,
  event_type  contact_event_type not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index on contact_events (contact_id, created_at desc);

alter table contact_events enable row level security;

create policy "events read"
  on contact_events for select using (
    exists (
      select 1 from contacts c
      where c.id = contact_events.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "events insert"
  on contact_events for insert with check (
    exists (
      select 1 from contacts c
      where c.id = contact_events.contact_id and public.is_org_member(c.org_id)
    )
  );

-- No update/delete policies — events are append-only.
