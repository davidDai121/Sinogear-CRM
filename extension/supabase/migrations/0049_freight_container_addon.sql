-- 0049: 默认估算改为「平台最高价 + 每柜 $400」
--
-- 老板标准（2026-09-25）：估出来的运费要比实际贵，但别超 1,000 美元。
-- 用鑫齿海运询价群 9/10–9/21 的 9 条货代全包价检验（同柜型、平台价取 9/24）：
--   最高价 + 每柜 400   → 7/9 落在 [0, +1000]，0 条低估，超出的是布埃纳文图拉大柜 +1,124、科林托 +2,861
--   最高价 + 每台 ¥2,000 → 4/9（0048 用的货代经验；一柜装多台时按台加装箱费加多了）
--   最高价 + 0           → 7/9，但阿比让低估 368
-- 全包价按柜涨、不按台涨，所以附加费按柜算。

alter table public.freight_settings
  add column container_addon_usd numeric not null default 400;

comment on column public.freight_settings.loading_cny_per_car is '已停用（0049 起默认附加按柜 container_addon_usd）';
