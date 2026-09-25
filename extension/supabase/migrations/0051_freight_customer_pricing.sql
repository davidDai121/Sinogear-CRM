-- 0051: 运费对客口径 —— 保险每台 $100 + 按客户国家分档加价
--
-- 老板（2026-09-25）：
--   保险：每台 $100（替代 2026-09-18 的「总运费 × 1.1」保险预算）。
--   加价：报给客户的运费每台加 500 / 750 / 1000，看客户国家有没有钱。按世界银行收入分组：
--         高收入 1000、中高收入 750、中低及低收入 500；看的是「客户」的国家，不是港口国家
--         （玻利维亚客户走智利阿里卡，照样按玻利维亚 500）。没填国家的按目的港国家，再不知道按 500。
--   加价只进 CIF 总价，不单列给客户。

alter table public.freight_settings
  add column insurance_usd_per_car numeric not null default 100,
  add column default_markup_usd_per_car numeric not null default 500;

create table public.freight_country_markup (
  org_id              uuid not null references public.organizations(id) on delete cascade,
  country             text not null,            -- 和 contacts.country 的写法一致（英文名）
  iso2                text check (iso2 ~ '^[A-Z]{2}$'),
  tier                text not null check (tier in ('high', 'upper_middle', 'lower')),
  markup_usd_per_car  numeric not null check (markup_usd_per_car >= 0),
  updated_at          timestamptz not null default now(),
  primary key (org_id, country)
);
create index freight_country_markup_iso2_idx on public.freight_country_markup (org_id, iso2);

alter table public.freight_country_markup enable row level security;
create policy "freight markup read"   on public.freight_country_markup for select using (public.is_org_member(org_id));
create policy "freight markup write"  on public.freight_country_markup for insert with check (public.is_org_member(org_id));
create policy "freight markup update" on public.freight_country_markup for update using (public.is_org_member(org_id));

insert into public.freight_country_markup (org_id, country, iso2, tier, markup_usd_per_car)
select o.org_id, v.country, v.iso2, v.tier,
       case v.tier when 'high' then 1000 when 'upper_middle' then 750 else 500 end
from (select distinct org_id from public.lead_owner_aliases) o
cross join (values
  -- 高收入 +1000
  ('Curaçao','CW','high'), ('UAE','AE','high'), ('Poland','PL','high'), ('Sint Maarten','SX','high'),
  ('Panama','PA','high'), ('Bahamas','BS','high'), ('France','FR','high'), ('United Kingdom','GB','high'),
  ('Netherlands','NL','high'), ('Saudi Arabia','SA','high'), ('Russia','RU','high'), ('Chile','CL','high'),
  ('Australia','AU','high'), ('Anguilla','AI','high'), ('Aruba','AW','high'), ('Kuwait','KW','high'),
  ('Qatar','QA','high'), ('Oman','OM','high'), ('Uruguay','UY','high'),
  -- 中高收入 +750
  ('Colombia','CO','upper_middle'), ('Dominican Republic','DO','upper_middle'), ('Azerbaijan','AZ','upper_middle'),
  ('Iraq','IQ','upper_middle'), ('China','CN','upper_middle'), ('Iran','IR','upper_middle'), ('Peru','PE','upper_middle'),
  ('Venezuela','VE','upper_middle'), ('Armenia','AM','upper_middle'), ('Algeria','DZ','upper_middle'),
  ('Costa Rica','CR','upper_middle'), ('Botswana','BW','upper_middle'), ('Argentina','AR','upper_middle'),
  ('El Salvador','SV','upper_middle'), ('Albania','AL','upper_middle'), ('Georgia','GE','upper_middle'),
  ('Ecuador','EC','upper_middle'), ('Jamaica','JM','upper_middle'), ('Brazil','BR','upper_middle'),
  ('Turkey','TR','upper_middle'), ('South Africa','ZA','upper_middle'), ('Namibia','NA','upper_middle'),
  ('Gabon','GA','upper_middle'), ('Jordan','JO','upper_middle'),
  -- 中低及低收入 +500
  ('Ghana','GH','lower'), ('Rwanda','RW','lower'), ('Afghanistan','AF','lower'), ('Côte d''Ivoire','CI','lower'),
  ('Togo','TG','lower'), ('Nigeria','NG','lower'), ('Ethiopia','ET','lower'), ('Cameroon','CM','lower'),
  ('Guinea','GN','lower'), ('Comoros','KM','lower'), ('Vanuatu','VU','lower'), ('Honduras','HN','lower'),
  ('Nicaragua','NI','lower'), ('Djibouti','DJ','lower'), ('Tunisia','TN','lower'), ('Bolivia','BO','lower'),
  ('Senegal','SN','lower'), ('Burkina Faso','BF','lower'), ('DR Congo','CD','lower'), ('Lebanon','LB','lower'),
  ('Angola','AO','lower'), ('Gambia','GM','lower'), ('Benin','BJ','lower'), ('São Tomé and Príncipe','ST','lower'),
  ('Kenya','KE','lower'), ('Malawi','MW','lower'), ('Haiti','HT','lower'), ('Tanzania','TZ','lower'),
  ('Uganda','UG','lower'), ('Zimbabwe','ZW','lower'), ('Morocco','MA','lower'), ('Mali','ML','lower'),
  ('Liberia','LR','lower'), ('Pakistan','PK','lower'), ('Cambodia','KH','lower'), ('Madagascar','MG','lower'),
  ('Niger','NE','lower'), ('Sierra Leone','SL','lower'), ('Burundi','BI','lower'), ('Somalia','SO','lower'),
  ('Congo','CG','lower'), ('Mozambique','MZ','lower'), ('Sudan','SD','lower'), ('Egypt','EG','lower'),
  ('Bangladesh','BD','lower'), ('Papua New Guinea','PG','lower'), ('Fiji','FJ','upper_middle'),
  ('Mauritania','MR','lower'), ('Zambia','ZM','lower')
) as v(country, iso2, tier)
on conflict do nothing;
