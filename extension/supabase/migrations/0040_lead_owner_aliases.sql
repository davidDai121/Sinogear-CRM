-- 0040: 广告线索按「命名代号」自动归属，不再靠样本反推
--
-- 背景（2026-09-09）：0037 的做法是「等表单攒够 3 条聊过的线索，按主理人分布推断」。
-- 实际跑了两周暴露的问题：新表单上线的头几天没人聊、推不出来，
-- 而这几天正是线索最密的时候——9/7 上线的 4 个表单 97 条线索里 85 条没归属，
-- 业务员开「只看我的」什么都看不到，以为 CRM 又漏单了。
--
-- boss 拍板：以后表单名 / 广告名开头写业务员代号（`miles-哥伦比亚-904`、
-- `grant-几内亚`），系统按代号直接归属，不用猜。
--
-- 解析规则（客户端 lead-routing.ts 里有同一份，改一处要同步改另一处）：
--   取名字开头连续的 ASCII 字母/数字，转小写，就是代号。
--   `miles-哥伦比亚-904` → miles      `Cheryl-卢旺达` → cheryl
--   `RW-Nammi01-…`       → rw（没登记就当没代号，走老的表单规则）
--
-- 优先级：lead_routing_rules（按表单名精确指定）> 表单名代号 > 广告名代号。
-- 精确规则放最前是为了保留人工改判的能力：某个表单临时给别人跟，
-- 在线索分配页指定一下就覆盖了命名。

create table public.lead_owner_aliases (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  alias       text not null check (alias = lower(alias) and alias ~ '^[a-z0-9]+$'),
  user_id     uuid not null references auth.users(id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, alias)
);

alter table public.lead_owner_aliases enable row level security;

create policy "alias read"   on public.lead_owner_aliases for select using (public.is_org_member(org_id));
create policy "alias insert" on public.lead_owner_aliases for insert with check (public.is_org_member(org_id));
create policy "alias update" on public.lead_owner_aliases for update using (public.is_org_member(org_id));
create policy "alias delete" on public.lead_owner_aliases for delete using (public.is_org_member(org_id));

create trigger lead_owner_aliases_touch
  before update on public.lead_owner_aliases
  for each row execute function public.touch_updated_at();

-- ── 从名字里取代号 ────────────────────────────────────────────────
create or replace function public.lead_owner_alias_of(p_name text)
returns text
language sql
immutable
as $$
  select lower((regexp_match(coalesce(p_name, ''), '^\s*([A-Za-z0-9]+)'))[1]);
$$;

-- ── 一条线索归谁：精确规则 > 表单名代号 > 广告名代号 ─────────────────
-- security definer：webhook 用 service_role 调、面板用业务员身份调，
-- 两边都要能读 rules / aliases，不依赖调用者的 RLS。
create or replace function public.resolve_lead_owner(
  p_org_id    uuid,
  p_form_name text,
  p_ad_name   text
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select r.user_id from public.lead_routing_rules r
      where r.org_id = p_org_id and r.form_name = p_form_name and p_form_name is not null
      limit 1),
    (select a.user_id from public.lead_owner_aliases a
      where a.org_id = p_org_id and a.alias = public.lead_owner_alias_of(p_form_name)
      limit 1),
    (select a.user_id from public.lead_owner_aliases a
      where a.org_id = p_org_id and a.alias = public.lead_owner_alias_of(p_ad_name)
      limit 1)
  );
$$;

grant execute on function public.lead_owner_alias_of(text) to authenticated, service_role;
grant execute on function public.resolve_lead_owner(uuid, text, text) to authenticated, service_role;

-- ── 单条线索落主理人（webhook 收到线索时调）────────────────────────
-- 只动「有 fb_lead_id 且还没有任何主理人」的客户，已经有人在跟的绝不抢走。
-- 返回落到了谁头上；没规则/没代号/已有人跟 → null。
create or replace function public.route_lead_contact(p_contact_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid;
  v_owner uuid;
begin
  select c.org_id into v_org
  from public.contacts c
  where c.id = p_contact_id and c.fb_lead_id is not null;
  if v_org is null then
    return null;
  end if;

  -- service_role（webhook）直接放行；业务员身份要是本 org 成员
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_org_member(v_org) then
    raise exception 'not a member of this org';
  end if;

  if exists (select 1 from public.contact_handlers h where h.contact_id = p_contact_id) then
    return null;
  end if;

  select public.resolve_lead_owner(v_org, e.payload ->> 'form_name', e.payload ->> 'ad_name')
    into v_owner
  from public.contact_events e
  where e.contact_id = p_contact_id and e.event_type = 'fb_lead_received'
  order by e.created_at desc
  limit 1;

  if v_owner is null then
    return null;
  end if;

  insert into public.contact_handlers (contact_id, user_id, last_seen_at)
  values (p_contact_id, v_owner, now())
  on conflict (contact_id, user_id) do nothing;

  return v_owner;
end;
$$;

grant execute on function public.route_lead_contact(uuid) to authenticated, service_role;

-- ── 批量分配改用同一套解析（面板「一键分配」按钮）───────────────────
-- 原版只认 lead_routing_rules；现在没规则但名字带代号的表单也能分出去。
create or replace function public.apply_lead_routing(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_org_member(p_org_id) then
    raise exception 'not a member of this org';
  end if;

  with latest as (
    select distinct on (c.id)
      c.id as contact_id,
      e.payload ->> 'form_name' as form_name,
      e.payload ->> 'ad_name'   as ad_name
    from public.contacts c
    join public.contact_events e
      on e.contact_id = c.id and e.event_type = 'fb_lead_received'
    where c.org_id = p_org_id
      and c.fb_lead_id is not null
      and not exists (
        select 1 from public.contact_handlers h where h.contact_id = c.id
      )
    order by c.id, e.created_at desc
  ),
  candidate as (
    select l.contact_id,
           public.resolve_lead_owner(p_org_id, l.form_name, l.ad_name) as user_id
    from latest l
  )
  insert into public.contact_handlers (contact_id, user_id, last_seen_at)
  select contact_id, user_id, now()
  from candidate
  where user_id is not null
  on conflict (contact_id, user_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
