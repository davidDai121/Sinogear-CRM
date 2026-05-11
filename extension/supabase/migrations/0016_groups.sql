-- 0016: 支持 WhatsApp 群聊作为 contact
--
-- 群聊在 WA 里有全球唯一的 JID（<creator_phone>-<timestamp>@g.us），
-- 用它当 contact 标识。群聊没手机号，phone 留 NULL。
--
-- 个人 contact 不变（phone 必填、group_jid=NULL）。
-- 群 contact：phone=NULL、group_jid 必填。

alter table contacts
  add column group_jid text;

-- 群聊在同 org 内 JID 唯一（partial unique，允许多个个人 contact 同时 group_jid=NULL）
create unique index contacts_org_group_jid_key
  on contacts (org_id, group_jid)
  where group_jid is not null;

-- 放宽 phone 的 NOT NULL（群聊允许 NULL）
alter table contacts
  alter column phone drop not null;

-- 数据完整性：phone 和 group_jid 至少有一个非空
alter table contacts
  add constraint contacts_identity_check
  check (phone is not null or group_jid is not null);

-- 现有 unique (org_id, phone) 不动 ——
--   PG 默认对含 NULL 的组合不视为冲突，所以多个 group contact phone=NULL 共存没问题
