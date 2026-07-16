-- 0034: compact per-contact sales evidence summary.
--
-- Problems addressed:
--   1. customer_stage is a workflow field, not proof of quote/payment;
--   2. reports downloading all message text waste free-tier egress;
--   3. last_message_direction_per_contact scanned the growing messages table
--      every five minutes.
--
-- One compact row is maintained per contact. Statement-level triggers refresh
-- only contacts touched by a message write. The existing direction RPC now
-- reads this table instead of aggregating all message rows.

create table public.contact_sales_signals (
  contact_id                 uuid primary key references public.contacts(id) on delete cascade,
  message_count              integer not null default 0,
  inbound_count              integer not null default 0,
  outbound_count             integer not null default 0,
  first_message_at           timestamptz,
  last_message_at            timestamptz,
  last_inbound_at            timestamptz,
  last_inbound_text          text,
  last_outbound_at           timestamptz,
  last_outbound_text         text,
  quote_signal_at            timestamptz,
  quote_excerpt              text,
  accepted_signal_at         timestamptz,
  accepted_excerpt           text,
  payment_pending_at         timestamptz,
  payment_pending_excerpt    text,
  payment_received_at        timestamptz,
  payment_received_excerpt   text,
  updated_at                 timestamptz not null default now()
);

alter table public.contact_sales_signals enable row level security;

create policy "org members read contact_sales_signals"
  on public.contact_sales_signals for select
  using (
    exists (
      select 1
      from public.contacts c
      where c.id = contact_sales_signals.contact_id
        and public.is_org_member(c.org_id)
    )
  );

grant select on public.contact_sales_signals to authenticated;

create or replace function public.rebuild_contact_sales_signals(
  p_contact_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_contact_ids is null or array_length(p_contact_ids, 1) is null then
    return;
  end if;

  insert into public.contact_sales_signals (
    contact_id,
    message_count,
    inbound_count,
    outbound_count,
    first_message_at,
    last_message_at,
    last_inbound_at,
    last_inbound_text,
    last_outbound_at,
    last_outbound_text,
    quote_signal_at,
    quote_excerpt,
    accepted_signal_at,
    accepted_excerpt,
    payment_pending_at,
    payment_pending_excerpt,
    payment_received_at,
    payment_received_excerpt,
    updated_at
  )
  with scoped as (
    select
      m.id,
      m.contact_id,
      m.direction,
      m.text,
      coalesce(m.sent_at, m.synced_at) as event_at
    from public.messages m
    where m.contact_id = any(p_contact_ids)
  ),
  aggregated as (
    select
      contact_id,
      count(*)::integer as message_count,
      count(*) filter (where direction = 'inbound')::integer as inbound_count,
      count(*) filter (where direction = 'outbound')::integer as outbound_count,
      min(event_at) as first_message_at,
      max(event_at) as last_message_at,
      max(event_at) filter (where direction = 'inbound') as last_inbound_at,
      left((
        array_agg(text order by event_at desc, id desc)
          filter (where direction = 'inbound')
      )[1], 500) as last_inbound_text,
      max(event_at) filter (where direction = 'outbound') as last_outbound_at,
      left((
        array_agg(text order by event_at desc, id desc)
          filter (where direction = 'outbound')
      )[1], 500) as last_outbound_text,
      max(event_at) filter (
        where direction = 'outbound'
          and text ~* '(USD|US\$|\$)[[:space:]]*[0-9][0-9,.]{3,}|CIF[[:space:]]+[[:alpha:]]|FOB[[:space:]]+[[:alpha:]]|precio[[:space:]]+(CIF|FOB)|prix[[:space:]]+(CIF|FOB)'
      ) as quote_signal_at,
      left((
        array_agg(text order by event_at desc, id desc)
          filter (
            where direction = 'outbound'
              and text ~* '(USD|US\$|\$)[[:space:]]*[0-9][0-9,.]{3,}|CIF[[:space:]]+[[:alpha:]]|FOB[[:space:]]+[[:alpha:]]|precio[[:space:]]+(CIF|FOB)|prix[[:space:]]+(CIF|FOB)'
          )
      )[1], 500) as quote_excerpt,
      max(event_at) filter (
        where direction = 'inbound'
          and text ~* 'please proceed|go ahead|next steps to complete the order|I(''ll| will) take|confirm the order|ready to order|vamos a proceder|puede proceder|je confirme|nous allons procéder'
      ) as accepted_signal_at,
      left((
        array_agg(text order by event_at desc, id desc)
          filter (
            where direction = 'inbound'
              and text ~* 'please proceed|go ahead|next steps to complete the order|I(''ll| will) take|confirm the order|ready to order|vamos a proceder|puede proceder|je confirme|nous allons procéder'
          )
      )[1], 500) as accepted_excerpt,
      max(event_at) filter (
        where direction = 'inbound'
          and text ~* 'bank|deposit|payment|transfer|receipt|acompte|banque|virement|banco|pago'
      ) as payment_pending_at,
      left((
        array_agg(text order by event_at desc, id desc)
          filter (
            where direction = 'inbound'
              and text ~* 'bank|deposit|payment|transfer|receipt|acompte|banque|virement|banco|pago'
          )
      )[1], 500) as payment_pending_excerpt,
      max(event_at) filter (
        where text ~* 'payment received|deposit received|received (the )?(payment|deposit)|order confirmed|receipt confirmed|付款已收到|收到(了)?定金|定金到账|paiement reçu|acompte reçu|reçu bancaire confirmé'
      ) as payment_received_at,
      left((
        array_agg(text order by event_at desc, id desc)
          filter (
            where text ~* 'payment received|deposit received|received (the )?(payment|deposit)|order confirmed|receipt confirmed|付款已收到|收到(了)?定金|定金到账|paiement reçu|acompte reçu|reçu bancaire confirmé'
          )
      )[1], 500) as payment_received_excerpt
    from scoped
    group by contact_id
  )
  select
    contact_id,
    message_count,
    inbound_count,
    outbound_count,
    first_message_at,
    last_message_at,
    last_inbound_at,
    last_inbound_text,
    last_outbound_at,
    last_outbound_text,
    quote_signal_at,
    quote_excerpt,
    accepted_signal_at,
    accepted_excerpt,
    payment_pending_at,
    payment_pending_excerpt,
    payment_received_at,
    payment_received_excerpt,
    now()
  from aggregated
  on conflict (contact_id) do update set
    message_count = excluded.message_count,
    inbound_count = excluded.inbound_count,
    outbound_count = excluded.outbound_count,
    first_message_at = excluded.first_message_at,
    last_message_at = excluded.last_message_at,
    last_inbound_at = excluded.last_inbound_at,
    last_inbound_text = excluded.last_inbound_text,
    last_outbound_at = excluded.last_outbound_at,
    last_outbound_text = excluded.last_outbound_text,
    quote_signal_at = excluded.quote_signal_at,
    quote_excerpt = excluded.quote_excerpt,
    accepted_signal_at = excluded.accepted_signal_at,
    accepted_excerpt = excluded.accepted_excerpt,
    payment_pending_at = excluded.payment_pending_at,
    payment_pending_excerpt = excluded.payment_pending_excerpt,
    payment_received_at = excluded.payment_received_at,
    payment_received_excerpt = excluded.payment_received_excerpt,
    updated_at = excluded.updated_at;

  delete from public.contact_sales_signals s
  where s.contact_id = any(p_contact_ids)
    and not exists (
      select 1 from public.messages m where m.contact_id = s.contact_id
    );
end;
$$;

revoke all on function public.rebuild_contact_sales_signals(uuid[]) from public;

create or replace function public.refresh_sales_signals_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  select array_agg(distinct contact_id) into ids from new_message_rows;
  perform public.rebuild_contact_sales_signals(ids);
  return null;
end;
$$;

create or replace function public.refresh_sales_signals_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  select array_agg(distinct contact_id)
  into ids
  from (
    select contact_id from new_message_rows
    union
    select contact_id from old_message_rows
  ) changed;
  perform public.rebuild_contact_sales_signals(ids);
  return null;
end;
$$;

create or replace function public.refresh_sales_signals_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  select array_agg(distinct contact_id) into ids from old_message_rows;
  perform public.rebuild_contact_sales_signals(ids);
  return null;
end;
$$;

revoke all on function public.refresh_sales_signals_after_insert() from public;
revoke all on function public.refresh_sales_signals_after_update() from public;
revoke all on function public.refresh_sales_signals_after_delete() from public;

create trigger messages_refresh_sales_signals_insert
  after insert on public.messages
  referencing new table as new_message_rows
  for each statement execute function public.refresh_sales_signals_after_insert();

create trigger messages_refresh_sales_signals_update
  after update on public.messages
  referencing old table as old_message_rows new table as new_message_rows
  for each statement execute function public.refresh_sales_signals_after_update();

create trigger messages_refresh_sales_signals_delete
  after delete on public.messages
  referencing old table as old_message_rows
  for each statement execute function public.refresh_sales_signals_after_delete();

-- One-time backfill. Runs inside PostgreSQL, so no message text leaves the DB.
select public.rebuild_contact_sales_signals(
  array(select distinct contact_id from public.messages)
);

-- Replace the five-minute full messages aggregation with a compact summary read.
create or replace function public.last_message_direction_per_contact(p_org_id uuid)
returns table (
  contact_id uuid,
  last_inbound_t timestamptz,
  last_outbound_t timestamptz,
  inbound_count int,
  outbound_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.contact_id,
    s.last_inbound_at,
    s.last_outbound_at,
    s.inbound_count,
    s.outbound_count
  from public.contact_sales_signals s
  inner join public.contacts c on c.id = s.contact_id
  where c.org_id = p_org_id
    and public.is_org_member(p_org_id);
$$;

grant execute on function public.last_message_direction_per_contact(uuid) to authenticated;

comment on table public.contact_sales_signals is
  'Compact per-contact evidence summary maintained from messages. Used for sales status validation and low-egress reporting.';

comment on function public.last_message_direction_per_contact(uuid) is
  'Reads compact contact_sales_signals instead of aggregating all message rows every five minutes.';
