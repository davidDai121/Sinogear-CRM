-- 0005: add 'stalled' stage + quality field + reminder overrides + vehicle target price.

-- 1. Add 'stalled' (待跟进) to customer_stage enum
alter type customer_stage add value if not exists 'stalled' before 'quoted';

-- 2. Customer quality (manual or synced from WhatsApp label)
create type customer_quality as enum ('big', 'potential', 'normal', 'spam');

alter table contacts
  add column quality customer_quality not null default 'potential',
  add column reminder_ack_at timestamptz,
  add column reminder_disabled boolean not null default false;

create index on contacts (org_id, quality);

-- 3. Vehicle interest — per-vehicle target price
alter table vehicle_interests
  add column target_price_usd numeric(12, 2);
