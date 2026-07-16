-- 0033: persist WhatsApp labels and their contact associations in CRM.
--
-- WhatsApp keeps labels in the local `model-storage` IndexedDB. The old
-- sync only copied selected label names into contact_tags, which loses the
-- WhatsApp label id/color and cannot reconcile rename/remove operations.
--
-- Label ids are scoped to a WhatsApp account. Store the syncing CRM user as
-- part of the unique key so multiple salespeople in one org cannot collide.

create table public.whatsapp_labels (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  user_id        uuid not null,
  wa_label_id    text not null,
  name           text not null,
  color_index    integer not null default 0,
  label_type     integer not null default 0,
  is_active      boolean not null default true,
  synced_at      timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint whatsapp_labels_membership_fkey
    foreign key (org_id, user_id)
    references public.organization_members (org_id, user_id)
    on delete cascade,
  constraint whatsapp_labels_org_user_wa_id_key
    unique (org_id, user_id, wa_label_id)
);

create index whatsapp_labels_org_active_idx
  on public.whatsapp_labels (org_id, is_active, name);

create trigger whatsapp_labels_touch_updated
  before update on public.whatsapp_labels
  for each row execute function public.touch_updated_at();

create table public.contact_whatsapp_labels (
  id                   uuid primary key default gen_random_uuid(),
  contact_id           uuid not null references public.contacts(id) on delete cascade,
  whatsapp_label_id    uuid not null references public.whatsapp_labels(id) on delete cascade,
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  constraint contact_whatsapp_labels_contact_label_key
    unique (contact_id, whatsapp_label_id)
);

create index contact_whatsapp_labels_contact_idx
  on public.contact_whatsapp_labels (contact_id);
create index contact_whatsapp_labels_label_idx
  on public.contact_whatsapp_labels (whatsapp_label_id);

alter table public.whatsapp_labels enable row level security;
alter table public.contact_whatsapp_labels enable row level security;

create policy "org members read whatsapp_labels"
  on public.whatsapp_labels for select
  using (public.is_org_member(org_id));

create policy "users manage own whatsapp_labels"
  on public.whatsapp_labels for all
  using (
    user_id = auth.uid()
    and public.is_org_member(org_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_org_member(org_id)
  );

create policy "org members read contact_whatsapp_labels"
  on public.contact_whatsapp_labels for select
  using (
    exists (
      select 1
      from public.contacts c
      join public.whatsapp_labels wl
        on wl.id = contact_whatsapp_labels.whatsapp_label_id
       and wl.org_id = c.org_id
      where c.id = contact_whatsapp_labels.contact_id
        and public.is_org_member(c.org_id)
    )
  );

create policy "users manage own contact_whatsapp_labels"
  on public.contact_whatsapp_labels for all
  using (
    exists (
      select 1
      from public.contacts c
      join public.whatsapp_labels wl
        on wl.id = contact_whatsapp_labels.whatsapp_label_id
       and wl.org_id = c.org_id
      where c.id = contact_whatsapp_labels.contact_id
        and wl.user_id = auth.uid()
        and public.is_org_member(c.org_id)
    )
  )
  with check (
    exists (
      select 1
      from public.contacts c
      join public.whatsapp_labels wl
        on wl.id = contact_whatsapp_labels.whatsapp_label_id
       and wl.org_id = c.org_id
      where c.id = contact_whatsapp_labels.contact_id
        and wl.user_id = auth.uid()
        and public.is_org_member(c.org_id)
    )
  );
