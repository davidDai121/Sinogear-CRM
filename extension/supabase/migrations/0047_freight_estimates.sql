-- 0047: 运费估算 —— 平台运价快照 + 货代全包价校准 + 估算参数
--
-- 背景（2026-09-24）：GPT 在写回复的那一轮现查网页、现挑运费，多米尼加一周内报价相对实际成本
-- 偏差 −2,242 ~ +4,323（hugolembcke / Jose francisco 两单低于成本已发出）。老板不想再每月
-- 找货代问价，所以运费改成软件估算：
--
--   全包估算/柜 = 平台当前最低价（海运 + 起运港杂，物流巴巴 API）
--               + 汽车附加（装车绑扎、拖车、报关、保险、货代利润，用货代全包价校准）
--               + 危险品差价（纯电 / 插混）
--               + 缓冲
--
-- 实测校准点：海纳 EMC 20GP 货代全包 10,800 / 危险品 11,200；同日平台 EMC 20GP 8,080 +
-- 港杂 CNY 1,464 ≈ 8,300 → 汽车附加 ≈ 2,500，危险品差价 400。
-- 平台价本身不是报给客户的价：直接按平台价报每台少收约 2,500。
--
-- 条款（物流巴巴开放平台）：数据只做内部使用，展示时标注 "Data from Awice Logistics"。

-- 每周自动刷新的航线。dest_code 是平台解析出的港口代码（首次刷新写入）。
create table public.freight_routes (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  origin             text not null default 'CNSHA',
  dest_query         text not null,                 -- 查平台用的港口英文名或代码
  dest_country       text not null check (dest_country ~ '^[A-Z]{2}$'),
  dest_code          text,
  dest_name          text,
  active             boolean not null default true,
  last_refreshed_at  timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  unique (org_id, origin, dest_query, dest_country)
);

-- 平台运价快照，只增不改，留作历史（校准过期货代报价、算波动都靠它）。
create table public.freight_rate_snapshots (
  id              bigserial primary key,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  route_id        uuid references public.freight_routes(id) on delete set null,
  origin_code     text not null,
  pol_code        text,                 -- 实际起运码头：CNYAN 洋山 / CNWGQ 外高桥
  dest_code       text not null,
  carrier         text not null,
  price_20gp      numeric,
  price_40gp      numeric,
  price_40hq      numeric,
  currency        text not null default 'USD',
  surcharges      jsonb not null default '[]',
  valid_until     date,
  departure_date  date,
  transit_days    int,
  transshipment   text,
  awice_rate_id   text,
  fetched_at      timestamptz not null default now()
);
create index freight_rate_snapshots_dest_idx on public.freight_rate_snapshots (org_id, dest_code, fetched_at desc);

-- 货代全包价：用来校准"汽车附加"。过期的也有用 —— 只要知道报价日期，就能和当天平台价相减。
create table public.freight_calibrations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  dest_code          text not null,
  dest_name          text,
  carrier            text,
  container          text not null check (container in ('20GP', '40HQ')),
  cargo              text not null check (cargo in ('general', 'dg')),
  all_in_usd         numeric not null check (all_in_usd > 0),
  quoted_on          date,
  quoted_on_known    boolean not null default true,  -- 日期不确定时 false，估算会标低可信度
  forwarder          text,
  platform_base_usd  numeric,          -- 报价当天同船公司平台价（海运 + 起运港杂），能对上才填
  source_ref         text,             -- 出处：老板聊天 / 微信 / 货代名
  note               text,
  created_by         uuid default auth.uid() references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index freight_calibrations_dest_idx on public.freight_calibrations (org_id, dest_code);

-- 估算参数，一个 org 一行。缓冲和默认附加都在这里改，不改代码。
create table public.freight_settings (
  org_id                   uuid primary key references public.organizations(id) on delete cascade,
  buffer_pct               numeric not null default 5,
  buffer_min_usd           numeric not null default 500,   -- 每柜
  uncalibrated_buffer_pct  numeric not null default 10,
  default_addon_usd        numeric not null default 2500,  -- 没有本航线校准时用
  default_dg_premium_usd   numeric not null default 400,
  cny_per_usd              numeric,
  fx_source                text,
  fx_at                    timestamptz,
  updated_at               timestamptz not null default now()
);

alter table public.freight_routes         enable row level security;
alter table public.freight_rate_snapshots enable row level security;
alter table public.freight_calibrations   enable row level security;
alter table public.freight_settings       enable row level security;

-- 业务员可读全部、可录入校准和航线；快照只由 Edge Function（service role）写。
create policy "freight routes read"   on public.freight_routes for select using (public.is_org_member(org_id));
create policy "freight routes write"  on public.freight_routes for insert with check (public.is_org_member(org_id));
create policy "freight routes update" on public.freight_routes for update using (public.is_org_member(org_id));
create policy "freight snapshots read" on public.freight_rate_snapshots for select using (public.is_org_member(org_id));
create policy "freight calib read"   on public.freight_calibrations for select using (public.is_org_member(org_id));
create policy "freight calib insert" on public.freight_calibrations for insert with check (public.is_org_member(org_id));
create policy "freight calib update" on public.freight_calibrations for update using (public.is_org_member(org_id));
create policy "freight calib delete" on public.freight_calibrations for delete using (public.is_org_member(org_id));
create policy "freight settings read"   on public.freight_settings for select using (public.is_org_member(org_id));
create policy "freight settings update" on public.freight_settings for update using (public.is_org_member(org_id));

insert into public.freight_settings (org_id)
select id from public.organizations
on conflict (org_id) do nothing;

-- 首批航线：2026-09-17 ~ 09-23 CRM 实际查过运费的目的地 + 广告在投的市场。
-- 只给正式业务 org（有线索代号的那个）建：每条航线每次刷新扣 1 积分，测试 org 不跟着花。
insert into public.freight_routes (org_id, dest_query, dest_country)
select o.org_id, v.q, v.c
from (select distinct org_id from public.lead_owner_aliases) o
cross join (values
  ('rio haina', 'DO'), ('caucedo', 'DO'),
  ('willemstad', 'CW'), ('port au prince', 'HT'),
  ('dakar', 'SN'), ('tema', 'GH'), ('lagos', 'NG'), ('abidjan', 'CI'), ('conakry', 'GN'),
  ('buenaventura', 'CO'), ('cartagena', 'CO'), ('corinto', 'NI'),
  ('mombasa', 'KE'), ('dar es salaam', 'TZ')
) as v(q, c)
on conflict do nothing;
