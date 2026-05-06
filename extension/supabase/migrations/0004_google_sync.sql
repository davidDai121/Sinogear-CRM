-- Google Contacts sync metadata
-- Stores the People API resourceName so we can update the same Google contact
-- without creating duplicates on subsequent syncs.

alter table contacts
  add column google_resource_name text,
  add column google_synced_at timestamptz;

create unique index contacts_google_resource_name_uniq
  on contacts (org_id, google_resource_name)
  where google_resource_name is not null;
