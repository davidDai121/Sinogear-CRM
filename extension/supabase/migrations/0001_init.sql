-- Sino Gear CRM — initial schema
-- Multi-tenant: every business table is scoped by org_id, and RLS enforces
-- that the authenticated user must be a member of that org.

create extension if not exists "pgcrypto";

------------------------------------------------------------------------------
-- ORGANIZATIONS + MEMBERSHIP
------------------------------------------------------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create type member_role as enum ('owner', 'admin', 'member');

create table organization_members (
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        member_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index on organization_members (user_id);

-- Helper: returns true if the calling auth.uid() belongs to org_id.
-- SECURITY DEFINER so RLS on organization_members doesn't recurse.
create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where org_id = target_org and user_id = auth.uid()
  );
$$;

------------------------------------------------------------------------------
-- CONTACTS
------------------------------------------------------------------------------

create type customer_stage as enum (
  'new', 'qualifying', 'negotiating', 'quoted', 'won', 'lost'
);

create table contacts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  phone             text not null,
  wa_name           text,
  name              text,
  country           text,
  language          text,
  budget_usd        numeric(12, 2),
  customer_stage    customer_stage not null default 'new',
  destination_port  text,
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, phone)
);

create index on contacts (org_id);
create index on contacts (org_id, customer_stage);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger contacts_touch_updated
  before update on contacts
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- CONTACT TAGS
------------------------------------------------------------------------------

create table contact_tags (
  contact_id  uuid not null references contacts(id) on delete cascade,
  tag         text not null,
  created_at  timestamptz not null default now(),
  primary key (contact_id, tag)
);

------------------------------------------------------------------------------
-- VEHICLE INTERESTS
------------------------------------------------------------------------------

create type vehicle_condition as enum ('new', 'used');
create type vehicle_steering  as enum ('LHD', 'RHD');

create table vehicle_interests (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references contacts(id) on delete cascade,
  model       text not null,
  year        int,
  condition   vehicle_condition,
  steering    vehicle_steering,
  notes       text,
  created_at  timestamptz not null default now()
);

create index on vehicle_interests (contact_id);

------------------------------------------------------------------------------
-- TASKS
------------------------------------------------------------------------------

create type task_status as enum ('open', 'done', 'cancelled');

create table tasks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  contact_id  uuid not null references contacts(id) on delete cascade,
  title       text not null,
  due_at      timestamptz,
  status      task_status not null default 'open',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index on tasks (org_id, status, due_at);
create index on tasks (contact_id);

------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
------------------------------------------------------------------------------

alter table organizations         enable row level security;
alter table organization_members  enable row level security;
alter table contacts              enable row level security;
alter table contact_tags          enable row level security;
alter table vehicle_interests     enable row level security;
alter table tasks                 enable row level security;

-- organizations: members can read; only owners can update; anyone authenticated can create
create policy "org members read org"
  on organizations for select
  using (public.is_org_member(id));

create policy "auth users create org"
  on organizations for insert to authenticated
  with check (true);

create policy "owners update org"
  on organizations for update
  using (
    exists (
      select 1 from organization_members
      where org_id = organizations.id
        and user_id = auth.uid()
        and role = 'owner'
    )
  );

-- organization_members: members can see their own org's members
create policy "members read own membership"
  on organization_members for select
  using (user_id = auth.uid() or public.is_org_member(org_id));

create policy "owners manage members"
  on organization_members for insert
  with check (
    -- first member of a new org is allowed; otherwise must be owner
    not exists (select 1 from organization_members where org_id = organization_members.org_id)
    or exists (
      select 1 from organization_members om
      where om.org_id = organization_members.org_id
        and om.user_id = auth.uid()
        and om.role = 'owner'
    )
  );

create policy "owners update members"
  on organization_members for update
  using (
    exists (
      select 1 from organization_members om
      where om.org_id = organization_members.org_id
        and om.user_id = auth.uid()
        and om.role = 'owner'
    )
  );

create policy "owners delete members"
  on organization_members for delete
  using (
    exists (
      select 1 from organization_members om
      where om.org_id = organization_members.org_id
        and om.user_id = auth.uid()
        and om.role = 'owner'
    )
  );

-- contacts: full CRUD for org members
create policy "org members read contacts"
  on contacts for select using (public.is_org_member(org_id));
create policy "org members insert contacts"
  on contacts for insert with check (public.is_org_member(org_id));
create policy "org members update contacts"
  on contacts for update using (public.is_org_member(org_id));
create policy "org members delete contacts"
  on contacts for delete using (public.is_org_member(org_id));

-- contact_tags: derive org via parent contact
create policy "tags read"
  on contact_tags for select using (
    exists (
      select 1 from contacts c
      where c.id = contact_tags.contact_id and public.is_org_member(c.org_id)
    )
  );
create policy "tags insert"
  on contact_tags for insert with check (
    exists (
      select 1 from contacts c
      where c.id = contact_tags.contact_id and public.is_org_member(c.org_id)
    )
  );
create policy "tags delete"
  on contact_tags for delete using (
    exists (
      select 1 from contacts c
      where c.id = contact_tags.contact_id and public.is_org_member(c.org_id)
    )
  );

-- vehicle_interests: same pattern
create policy "vehicles read"
  on vehicle_interests for select using (
    exists (
      select 1 from contacts c
      where c.id = vehicle_interests.contact_id and public.is_org_member(c.org_id)
    )
  );
create policy "vehicles write"
  on vehicle_interests for all using (
    exists (
      select 1 from contacts c
      where c.id = vehicle_interests.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = vehicle_interests.contact_id and public.is_org_member(c.org_id)
    )
  );

-- tasks
create policy "tasks read"
  on tasks for select using (public.is_org_member(org_id));
create policy "tasks write"
  on tasks for all using (public.is_org_member(org_id))
                with check (public.is_org_member(org_id));
