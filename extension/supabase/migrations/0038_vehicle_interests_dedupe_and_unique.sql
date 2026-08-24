-- 0038：vehicle_interests 去重 + 唯一约束
--
-- 背景（2026-08-23 实测）：表涨到 43,569 行，其中 38,320 行（88%）是
-- (contact_id, model) 完全重复。最严重的一个客户身上挂了 1,476 条一模一样的
-- "Toyota Corolla"，插入时刻间隔正好 10 分钟 —— 对应 useCrmData 里每 10 分钟
-- 一次的 syncWhatsAppLabels，即每跑一次就再插一条。
--
-- 不是 AI 抽取干的：那个客户的 contact_events('vehicle_added') 是 0 条，而
-- useAutoExtract / bulk-extract 每插一条都记事件；只有 label-sync 不记事件，
-- 它的 existingVehicleSet 去重没起作用。
--
-- 代价：useCrmData 启动时 fetchAllVehicleInterests 要串行翻 44 页、每页约 1 秒、
-- 共 6.9 MB，而且 setDbState 是一次性写 —— 整个 CRM 左栏要等它跑完才渲染。
-- 销售的原话是"重新加载要等好久未联系才会有数据"。
--
-- 与其继续追 label-sync 那条读路径为什么失效，不如在 DB 上堵死：加唯一约束，
-- 插入点改 upsert(ignoreDuplicates)。不管哪条读路径将来又失效，DB 都挡得住。
--
-- ⚠️ 这个文件是**已执行操作的记录**（2026-08-23 通过 Management API 跑的），
-- 删除部分不幂等，不要重复执行。全表备份在
-- vehicle_interests_backup_2026-08-23.json（43,569 行，未入 git）。

-- 1) 去重：每个 (contact_id, lower(btrim(model))) 只留一行。
--    保留优先级：condition 非空 > target_price_usd 非空 > 最早创建。
--    （用 lower+btrim 做分组键，防大小写 / 首尾空白造成的漏网）
with ranked as (
  select id,
         row_number() over (
           partition by contact_id, lower(btrim(model))
           order by (condition is not null) desc,
                    (target_price_usd is not null) desc,
                    created_at asc,
                    id asc
         ) as rn
  from public.vehicle_interests
)
delete from public.vehicle_interests v
using ranked r
where v.id = r.id and r.rn > 1;
-- 实际删除 38,320 行，剩 5,249 行

-- 2) 归一化首尾空白，让下面的普通 UNIQUE 约束干净
update public.vehicle_interests
set model = btrim(model)
where model <> btrim(model);

-- 3) 唯一约束。
--    ⚠️ 故意用普通列约束而不是 lower(model) 表达式索引 —— PostgREST 的
--    on_conflict 参数只接列名，表达式索引没法在 upsert 里被 ON CONFLICT 命中。
--    三个插入点（useAutoExtract / bulk-extract / label-sync）都先过
--    canonicalizeModel()，存进来的大小写本来就是统一的，普通约束够用。
alter table public.vehicle_interests
  add constraint vehicle_interests_contact_model_key unique (contact_id, model);
