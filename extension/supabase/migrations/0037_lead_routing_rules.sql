-- 0037: 广告线索按「表单」落到业务员头上
--
-- 背景（2026-08-21）：boss 要「一个表单只给一个业务员」，但这个绑定
-- **Meta 不给读**——实测 7 种 Graph API 字段/端点、表单库 UI、6 页表单预览、
-- 整页 DOM 全文搜索，全都拿不到表单绑的 WhatsApp 号。只有表单编辑器里能看见，
-- 而有线索的表单 Meta 锁定不给编辑。
--
-- 解法：从**已经发生的事实**反推。点过「Chat on WhatsApp」的客户被真实路由到
-- 了某个业务员的号上，而每个业务员用自己的 WhatsApp 登录扩展，contact_handlers
-- 会自动登记。按表单统计主理人分布，纯度高得惊人：
--   RW-Nammi01-HigherIntent-EN-202608-1  130 条  daimenglong    100%
--   AZ-B2B-QINPLUS-form-v1                18 条  2064026258     100%
--   PL-B2B-QINPLUS-form-v2-1               9 条  2064026258     100%
--   RW-Nammi01-HigherIntent-EN-202608     24 条  daimenglong     92%
--   RW-B2B-QINPLUS-form-v1                22 条  2064026258      91%
-- 8-9% 的杂音是别人临时点开过聊天（主理人不是排他的）。
--
-- ⚠️ 顺带证明了「按国家分」是错的：卢旺达有两个表单，RW-Nammi01 归 daimenglong、
-- RW-B2B-QINPLUS 归 2064026258。同一个国家两个人，按国家分必然分错。
--
-- 以后新建表单同样处理：等它攒够几条「客户点了按钮」的线索，
-- 跑 scripts/route-fb-leads.mjs --detect 就能推出归属。

create table public.lead_routing_rules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  form_name     text not null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  auto_detected boolean not null default false,
  confidence    numeric,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, form_name)
);

create index on public.lead_routing_rules (org_id);

alter table public.lead_routing_rules enable row level security;

create policy "routing read"   on public.lead_routing_rules for select using (public.is_org_member(org_id));
create policy "routing insert" on public.lead_routing_rules for insert with check (public.is_org_member(org_id));
create policy "routing update" on public.lead_routing_rules for update using (public.is_org_member(org_id));
create policy "routing delete" on public.lead_routing_rules for delete using (public.is_org_member(org_id));

create trigger lead_routing_rules_touch
  before update on public.lead_routing_rules
  for each row execute function public.touch_updated_at();

-- ── 按规则批量落主理人 ────────────────────────────────────────────
--
-- 为什么要 RPC：contact_handlers 的 RLS 是「写入只能 user_id = auth.uid()」
-- （0014 定的，防止互相抢单）。但线索分配天然是「把线索指给别人」，
-- 客户端直接写会被 RLS 拒掉。所以走 security definer，由函数校验调用者
-- 是不是本 org 成员，再代为写入。
--
-- 只动「有 fb_lead_id 且还没有任何主理人」的客户——已经有人在跟的绝不抢走
-- （boss 的原话：先遵循客户意愿）。
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

  with candidate as (
    select distinct on (c.id) c.id as contact_id, r.user_id
    from public.contacts c
    join public.contact_events e
      on e.contact_id = c.id and e.event_type = 'fb_lead_received'
    join public.lead_routing_rules r
      on r.org_id = p_org_id
     and r.form_name = e.payload ->> 'form_name'
    where c.org_id = p_org_id
      and c.fb_lead_id is not null
      and not exists (
        select 1 from public.contact_handlers h where h.contact_id = c.id
      )
    order by c.id, e.created_at desc
  )
  insert into public.contact_handlers (contact_id, user_id, last_seen_at)
  select contact_id, user_id, now() from candidate
  on conflict (contact_id, user_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.apply_lead_routing(uuid) to authenticated;
