-- 0050: 运费航线扩到「有客户的国家」+ 刷新分级
--
-- 老板（2026-09-25）：「尽量获取更多的港口」。按 CRM 客户国家（6 月后新增）逐个配主港；
-- 内陆国走邻国港：埃塞俄比亚→吉布提、玻利维亚→阿里卡（智利）、阿塞拜疆/亚美尼亚→波蒂（格鲁吉亚）、
-- 阿富汗→卡拉奇（巴基斯坦）/阿巴斯（伊朗）、卢旺达/乌干达/布隆迪→达累斯萨拉姆/蒙巴萨（已有）、
-- 布基纳法索/马里/尼日尔→洛美/科托努/阿比让、马拉维/赞比亚/津巴布韦/博茨瓦纳→德班/贝拉。
--
-- 积分：物流巴巴每查一条航线 1 积分（没有运价不扣）。¥99 = 1,500 积分/半年 ≈ 250/月。
--   weekly    每周一自动刷新（主要市场，约 25 条 ≈ 110 积分/月）
--   on_demand 不定时刷新，有人报价时数据超过 3 天才现查（查一次 1 积分）

alter table public.freight_routes
  add column refresh_tier text not null default 'weekly' check (refresh_tier in ('weekly', 'on_demand')),
  add column last_quoted_at timestamptz;

insert into public.freight_routes (org_id, dest_query, dest_country, refresh_tier)
select o.org_id, v.q, v.c, v.t
from (select distinct org_id from public.lead_owner_aliases) o
cross join (values
  -- 西非
  ('lome', 'TG', 'weekly'), ('cotonou', 'BJ', 'weekly'), ('douala', 'CM', 'weekly'),
  ('banjul', 'GM', 'on_demand'), ('freetown', 'SL', 'on_demand'), ('monrovia', 'LR', 'on_demand'),
  ('nouakchott', 'MR', 'on_demand'), ('libreville', 'GA', 'on_demand'), ('pointe noire', 'CG', 'on_demand'),
  ('matadi', 'CD', 'on_demand'), ('luanda', 'AO', 'on_demand'), ('sao tome', 'ST', 'on_demand'),
  ('apapa', 'NG', 'on_demand'), ('tin can', 'NG', 'on_demand'),
  -- 东非 / 印度洋 / 南非
  ('djibouti', 'DJ', 'weekly'), ('moroni', 'KM', 'weekly'), ('toamasina', 'MG', 'on_demand'),
  ('mogadishu', 'SO', 'on_demand'), ('berbera', 'SO', 'on_demand'), ('port sudan', 'SD', 'on_demand'),
  ('beira', 'MZ', 'on_demand'), ('maputo', 'MZ', 'on_demand'), ('durban', 'ZA', 'on_demand'),
  ('walvis bay', 'NA', 'on_demand'),
  -- 北非
  ('rades', 'TN', 'weekly'), ('casablanca', 'MA', 'on_demand'), ('algiers', 'DZ', 'on_demand'),
  ('alexandria', 'EG', 'on_demand'),
  -- 中东 / 南亚
  ('umm qasr', 'IQ', 'weekly'), ('jebel ali', 'AE', 'weekly'), ('jeddah', 'SA', 'on_demand'),
  ('dammam', 'SA', 'on_demand'), ('bandar abbas', 'IR', 'weekly'), ('beirut', 'LB', 'on_demand'),
  ('aqaba', 'JO', 'on_demand'), ('shuwaikh', 'KW', 'on_demand'), ('hamad', 'QA', 'on_demand'),
  ('sohar', 'OM', 'on_demand'), ('karachi', 'PK', 'weekly'), ('chittagong', 'BD', 'on_demand'),
  -- 高加索 / 欧洲
  ('poti', 'GE', 'weekly'), ('gdansk', 'PL', 'weekly'), ('durres', 'AL', 'on_demand'), ('mersin', 'TR', 'on_demand'),
  -- 中美 / 加勒比
  ('puerto cortes', 'HN', 'weekly'), ('san lorenzo', 'HN', 'on_demand'), ('acajutla', 'SV', 'on_demand'),
  ('puerto limon', 'CR', 'on_demand'), ('caldera', 'CR', 'on_demand'), ('colon', 'PA', 'on_demand'),
  ('manzanillo', 'PA', 'on_demand'), ('philipsburg', 'SX', 'on_demand'), ('nassau', 'BS', 'on_demand'),
  ('kingston', 'JM', 'on_demand'), ('santo domingo', 'DO', 'on_demand'), ('oranjestad', 'AW', 'on_demand'),
  -- 南美
  ('guayaquil', 'EC', 'on_demand'), ('callao', 'PE', 'weekly'), ('arica', 'CL', 'weekly'),
  ('iquique', 'CL', 'on_demand'), ('san antonio', 'CL', 'on_demand'), ('la guaira', 'VE', 'on_demand'),
  ('puerto cabello', 'VE', 'on_demand'), ('montevideo', 'UY', 'on_demand'), ('buenos aires', 'AR', 'on_demand'),
  ('santos', 'BR', 'on_demand'),
  -- 亚太
  ('port vila', 'VU', 'weekly'), ('sihanoukville', 'KH', 'on_demand'), ('lae', 'PG', 'on_demand'), ('suva', 'FJ', 'on_demand')
) as v(q, c, t)
on conflict do nothing;
