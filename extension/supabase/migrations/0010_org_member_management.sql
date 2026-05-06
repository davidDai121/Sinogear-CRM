-- 0010: 团队成员管理 RPC
--   invite_user_to_org(email, role, org)  → 添加已注册用户到 org
--   list_org_members(org)                  → 列出 org 成员（含 email）
--   remove_org_member(user_id, org)        → 移除成员（owner 不能移自己）
--
-- 安全：所有 RPC 都用 SECURITY DEFINER 才能访问 auth.users，
-- 但内部检查调用者是 owner/admin 才允许变更。

------------------------------------------------------------------------------
-- invite: 通过 email 把已注册用户加入 org
------------------------------------------------------------------------------

create or replace function public.invite_user_to_org(
  target_email  text,
  target_role   text default 'member',
  target_org    uuid default null
) returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller_uid uuid := auth.uid();
  resolved_org uuid := target_org;
  target_uid uuid;
  validated_role member_role;
begin
  if caller_uid is null then
    return 'unauthorized';
  end if;

  -- role 验证
  begin
    validated_role := target_role::member_role;
  exception when others then
    return 'invalid_role';
  end;

  -- 没传 org → 用 caller 的第一个 org（owner/admin 身份）
  if resolved_org is null then
    select org_id into resolved_org
    from organization_members
    where user_id = caller_uid and role in ('owner', 'admin')
    limit 1;
    if resolved_org is null then
      return 'no_org';
    end if;
  end if;

  -- caller 必须是该 org 的 owner/admin
  if not exists (
    select 1 from organization_members
    where org_id = resolved_org
      and user_id = caller_uid
      and role in ('owner', 'admin')
  ) then
    return 'forbidden';
  end if;

  -- 查目标用户（按 email）
  select id into target_uid
  from auth.users
  where lower(email) = lower(trim(target_email))
  limit 1;

  if target_uid is null then
    return 'user_not_found';
  end if;

  -- 已是成员 → 不动
  if exists (
    select 1 from organization_members
    where org_id = resolved_org and user_id = target_uid
  ) then
    return 'already_member';
  end if;

  insert into organization_members (org_id, user_id, role)
  values (resolved_org, target_uid, validated_role);

  return 'added';
end;
$$;

------------------------------------------------------------------------------
-- list: 列出 org 成员（含 email），仅成员可调
------------------------------------------------------------------------------

create or replace function public.list_org_members(target_org uuid)
returns table (
  user_id     uuid,
  email       text,
  role        text,
  joined_at   timestamptz,
  is_self     boolean
)
language plpgsql
security definer
stable
set search_path = public, auth
as $$
begin
  if not public.is_org_member(target_org) then
    return;
  end if;

  return query
    select
      m.user_id,
      u.email::text as email,
      m.role::text as role,
      m.created_at as joined_at,
      (m.user_id = auth.uid()) as is_self
    from organization_members m
    join auth.users u on u.id = m.user_id
    where m.org_id = target_org
    order by
      case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
      m.created_at;
end;
$$;

------------------------------------------------------------------------------
-- remove: owner/admin 移除成员；不能移自己；不能移最后一个 owner
------------------------------------------------------------------------------

create or replace function public.remove_org_member(
  target_user_id uuid,
  target_org     uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_uid uuid := auth.uid();
  caller_role member_role;
  target_role member_role;
  owner_count int;
begin
  if caller_uid is null then return 'unauthorized'; end if;

  if target_user_id = caller_uid then
    return 'cannot_remove_self';
  end if;

  -- caller 角色
  select role into caller_role
  from organization_members
  where org_id = target_org and user_id = caller_uid;

  if caller_role is null or caller_role not in ('owner', 'admin') then
    return 'forbidden';
  end if;

  -- 目标的角色
  select role into target_role
  from organization_members
  where org_id = target_org and user_id = target_user_id;

  if target_role is null then
    return 'not_member';
  end if;

  -- admin 不能移除 owner
  if caller_role = 'admin' and target_role = 'owner' then
    return 'forbidden';
  end if;

  -- 不能移最后一个 owner
  if target_role = 'owner' then
    select count(*) into owner_count
    from organization_members
    where org_id = target_org and role = 'owner';
    if owner_count <= 1 then
      return 'last_owner';
    end if;
  end if;

  delete from organization_members
  where org_id = target_org and user_id = target_user_id;

  return 'removed';
end;
$$;

------------------------------------------------------------------------------
-- update_org_member_role: 改角色（owner 才能改）
------------------------------------------------------------------------------

create or replace function public.update_org_member_role(
  target_user_id uuid,
  target_org     uuid,
  new_role       text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_uid uuid := auth.uid();
  validated_role member_role;
  target_current member_role;
  owner_count int;
begin
  if caller_uid is null then return 'unauthorized'; end if;

  begin
    validated_role := new_role::member_role;
  exception when others then
    return 'invalid_role';
  end;

  -- caller 必须是 owner
  if not exists (
    select 1 from organization_members
    where org_id = target_org and user_id = caller_uid and role = 'owner'
  ) then
    return 'forbidden';
  end if;

  select role into target_current
  from organization_members
  where org_id = target_org and user_id = target_user_id;

  if target_current is null then
    return 'not_member';
  end if;

  -- 把唯一 owner 降级 → 不允许
  if target_current = 'owner' and validated_role <> 'owner' then
    select count(*) into owner_count
    from organization_members
    where org_id = target_org and role = 'owner';
    if owner_count <= 1 then
      return 'last_owner';
    end if;
  end if;

  update organization_members
  set role = validated_role
  where org_id = target_org and user_id = target_user_id;

  return 'updated';
end;
$$;
