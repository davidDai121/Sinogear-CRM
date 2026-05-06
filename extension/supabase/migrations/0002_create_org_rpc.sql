-- RPC: create an organization and atomically add the caller as owner.
-- Bypasses RLS so the caller doesn't have to be an existing owner.

create or replace function public.create_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  insert into organizations (name) values (org_name)
  returning id into new_org_id;

  insert into organization_members (org_id, user_id, role)
  values (new_org_id, auth.uid(), 'owner');

  return new_org_id;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;
