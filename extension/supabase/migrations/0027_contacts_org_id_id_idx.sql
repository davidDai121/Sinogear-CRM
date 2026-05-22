-- useCrmData.fetchAllContacts 用 .eq('org_id', X).order('id', asc).range(from, to) 分页拉，
-- 原本只有 (org_id) 单列索引 → planner 走 bitmap scan + sort → 国内访问新加坡每页 7s。
-- (org_id, id) 复合索引让分页直接走 index range scan，order 免 sort，跨页稳定且单页 ~100ms 级。
-- ScopeContext.auto-claim 的 contacts id 分页拉也吃这个索引。

create index if not exists contacts_org_id_id_idx
  on contacts (org_id, id);
