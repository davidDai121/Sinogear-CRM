-- Vehicle inventory (brand × model × version × year the team sells)

create type fuel_type as enum ('gas', 'diesel', 'hybrid', 'ev');
create type sale_status as enum ('available', 'paused', 'expired');

create table vehicles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  brand           text not null,
  model           text not null,
  year            int,
  version         text,
  vehicle_condition vehicle_condition not null default 'new',
  fuel_type       fuel_type,
  steering        vehicle_steering,
  base_price      numeric(12, 2),
  currency        text not null default 'USD',
  logistics_cost  numeric(12, 2),
  sale_status     sale_status not null default 'available',
  short_spec      text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on vehicles (org_id);
create index on vehicles (org_id, sale_status);
create index on vehicles (org_id, brand);

create trigger vehicles_touch_updated
  before update on vehicles
  for each row execute function public.touch_updated_at();

create table vehicle_tags (
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  tag         text not null,
  created_at  timestamptz not null default now(),
  primary key (vehicle_id, tag)
);

-- RLS: same org-based pattern as other tables

alter table vehicles     enable row level security;
alter table vehicle_tags enable row level security;

create policy "vehicles read"
  on vehicles for select using (public.is_org_member(org_id));
create policy "vehicles insert"
  on vehicles for insert with check (public.is_org_member(org_id));
create policy "vehicles update"
  on vehicles for update using (public.is_org_member(org_id));
create policy "vehicles delete"
  on vehicles for delete using (public.is_org_member(org_id));

create policy "vehicle_tags read"
  on vehicle_tags for select using (
    exists (
      select 1 from vehicles v
      where v.id = vehicle_tags.vehicle_id and public.is_org_member(v.org_id)
    )
  );
create policy "vehicle_tags write"
  on vehicle_tags for all using (
    exists (
      select 1 from vehicles v
      where v.id = vehicle_tags.vehicle_id and public.is_org_member(v.org_id)
    )
  ) with check (
    exists (
      select 1 from vehicles v
      where v.id = vehicle_tags.vehicle_id and public.is_org_member(v.org_id)
    )
  );
