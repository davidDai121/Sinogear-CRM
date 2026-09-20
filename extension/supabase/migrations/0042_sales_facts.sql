-- Structured, sourced facts. Approved policies, order facts and historical
-- references are separate; every edit is versioned in an append-only journal.
create table public.sales_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  fact_key text not null check (length(fact_key) between 1 and 200),
  category text not null check (category in ('price','freight','payment','warranty','logistics','insurance')),
  scope text not null check (scope in ('org','product','customer','order')),
  product_key text,
  contact_id uuid references public.contacts(id) on delete cascade,
  scope_id text,
  title text not null check (length(title) between 1 and 300),
  statement text not null check (length(statement) between 1 and 6000),
  value jsonb not null default '{}' check (jsonb_typeof(value) = 'object'),
  status text not null check (status in ('approved','reference','candidate','retired')),
  authority text not null check (authority in ('owner_statement','approved_template','sales_message','supplier_quote','inventory','model_research','manual')),
  source jsonb not null check (jsonb_typeof(source) = 'object' and source ? 'ref' and source ? 'quote'),
  observed_at timestamptz not null,
  valid_until timestamptz,
  dedupe_key text not null,
  version integer not null default 1,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, dedupe_key),
  check ((scope in ('org','product') and contact_id is null and scope_id is null)
    or (scope='customer' and contact_id is not null and scope_id is null)
    or (scope='order' and contact_id is not null and scope_id is not null)),
  check (scope <> 'product' or product_key is not null),
  check (valid_until is null or valid_until > observed_at)
);
create index sales_facts_lookup_idx on public.sales_facts (org_id,category,contact_id,status);

create table public.sales_fact_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  fact_id uuid not null references public.sales_facts(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  unique (fact_id,version)
);
create index sales_fact_history_org_fact_idx on public.sales_fact_history (org_id,fact_id,version);

create function public.validate_sales_fact() returns trigger language plpgsql
set search_path = public as $$
begin
  if new.contact_id is not null and not exists (select 1 from contacts where id=new.contact_id and org_id=new.org_id) then
    raise exception 'Fact contact belongs to another organization';
  end if;
  if tg_op='UPDATE' then
    if new.org_id<>old.org_id or new.id<>old.id or new.created_by is distinct from old.created_by then
      raise exception 'Fact identity cannot be changed';
    end if;
    new.version := old.version+1;
    new.created_at := old.created_at;
  else
    new.version := 1;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger sales_facts_validate before insert or update on public.sales_facts
for each row execute function public.validate_sales_fact();

create function public.audit_sales_fact() returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into sales_fact_history (org_id,fact_id,version,snapshot,changed_by)
  values (new.org_id,new.id,new.version,to_jsonb(new),auth.uid());
  return new;
end $$;
create trigger sales_facts_audit after insert or update on public.sales_facts
for each row execute function public.audit_sales_fact();

alter table public.sales_facts enable row level security;
alter table public.sales_fact_history enable row level security;
create policy sales_facts_read on public.sales_facts for select using (public.is_org_member(org_id));
create policy sales_facts_insert on public.sales_facts for insert with check (
  public.is_org_member(org_id) and (
    exists (select 1 from public.organization_members m where m.org_id=sales_facts.org_id and m.user_id=auth.uid() and m.role in ('owner','admin'))
    or (status='candidate' and created_by=auth.uid())
  )
);
create policy sales_facts_update on public.sales_facts for update using (
  exists (select 1 from public.organization_members m where m.org_id=sales_facts.org_id and m.user_id=auth.uid() and m.role in ('owner','admin'))
) with check (
  exists (select 1 from public.organization_members m where m.org_id=sales_facts.org_id and m.user_id=auth.uid() and m.role in ('owner','admin'))
);
create policy sales_fact_history_read on public.sales_fact_history for select using (public.is_org_member(org_id));
-- No client delete or journal-write policy. Retire facts; preserve revisions.
notify pgrst, 'reload schema';
