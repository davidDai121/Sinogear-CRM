-- 0048: 运费估算改用货代规则 + 修正海纳校准点日期
--
-- 1) 货代（2026-09-24 老板转述）：「最高运费能包住港杂，装箱每台车 + ¥2,000 就行」。
--    用鑫齿海运询价群 9/10–9/21 的 10 条货代全包价检验：这条规则平均误差 13.7%，多数偏高 8–19%；
--    原来的「最低价 + 2,500」平均误差 21.9%。规则本身偏保守，所以没校准的航线不再另加缓冲。
-- 2) 危险品差价：群里同日同航线普货/危险品价差 海纳 +400、布埃纳文图拉 20GP +600 / 40HQ +800，默认取 600。
-- 3) 海纳 10,800 / 11,200 那两条：原始报价是 2026-09-03（群里美艳小老太），不是 9/24。9/3 当时 EMC 平台价
--    在 7–8 月高点附近（20GP 10,925），和今天（8,080）差很多，今天的平台快照不能跟它配对 → 清空 platform_base_usd，
--    这两条暂不参与校准，只作记录。

alter table public.freight_settings
  add column loading_cny_per_car numeric not null default 2000;

alter table public.freight_settings alter column uncalibrated_buffer_pct set default 0;
alter table public.freight_settings alter column default_dg_premium_usd set default 600;
update public.freight_settings set uncalibrated_buffer_pct = 0, default_dg_premium_usd = 600, updated_at = now();

comment on column public.freight_settings.default_addon_usd is '已停用（0048 起没校准的航线按 loading_cny_per_car 算）';

update public.freight_calibrations
set quoted_on = '2026-09-03', quoted_on_known = true, platform_base_usd = null,
    forwarder = '美艳小老太 王新如', source_ref = '微信群:鑫齿海运询价群（老板 9/24 对话转述）',
    note = '一装一全包；原始报价 2026-09-03，当时平台价处在 7–8 月高点，缺同周平台快照，暂不参与校准'
where dest_code = 'DORHA' and all_in_usd in (10800, 11200) and quoted_on = '2026-09-24';
