-- 0018: 修 0016 的 ON CONFLICT 错误
--
-- 0016 给 group_jid 用了 partial unique INDEX（带 WHERE group_jid IS NOT NULL），
-- 但 supabase-js 的 .upsert({ onConflict: 'org_id,group_jid' }) 不支持指定
-- index predicate，导致 bulk-sync 报 "42P10: there is no unique or exclusion
-- constraint matching the ON CONFLICT specification"。
--
-- 改成普通 UNIQUE CONSTRAINT —— PostgreSQL 对含 NULL 的组合永远不视为冲突
-- （NULL != NULL），所以个人 contact 全是 group_jid=NULL 也仍然可以共存。

drop index if exists contacts_org_group_jid_key;

alter table contacts
  add constraint contacts_org_id_group_jid_key
  unique (org_id, group_jid);
