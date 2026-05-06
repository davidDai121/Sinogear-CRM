-- 0006: 报价记录 — track price quotes sent to customers per vehicle.

create type quote_status as enum ('draft', 'sent', 'accepted', 'rejected');

create table quotes (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references contacts(id) on delete cascade,
  vehicle_model   text not null,
  price_usd       numeric(12, 2) not null,
  sent_at         timestamptz,
  status          quote_status not null default 'draft',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on quotes (contact_id, created_at desc);

create trigger quotes_touch_updated
  before update on quotes
  for each row execute function public.touch_updated_at();

alter table quotes enable row level security;

create policy "quotes read"
  on quotes for select using (
    exists (
      select 1 from contacts c
      where c.id = quotes.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "quotes write"
  on quotes for all using (
    exists (
      select 1 from contacts c
      where c.id = quotes.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = quotes.contact_id and public.is_org_member(c.org_id)
    )
  );
