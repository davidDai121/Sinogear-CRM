-- 0046: 支持只有 WhatsApp 用户 ID、没有手机号的客户
--
-- 背景（2026-09-24）：Meta 推出 WhatsApp 用户名 / BSUID，隐藏号码的客户来信时
-- 载荷里只有 from_user_id（形如 CO.1234567890123456）和 profile.username，没有手机号。
-- 共存模式接入后 Sophia 这边 22 批整批入库失败、746 条被跳过，其中不少是广告带来的新客户
-- （消息带 referral.ctwa_clid）。contacts 要求 phone 或 group_jid 至少一个，这些人建不出来。
--
-- wa_user_id 是 WhatsApp 按「业务账号」作用域给的用户 ID，同一个客户对同一个 WABA 稳定。
-- 以后若同一条载荷里同时出现手机号和 user id，webhook 会把 user id 补写到手机号客户上。

alter table public.contacts
  add column wa_user_id text,
  add column wa_username text;

alter table public.contacts
  add constraint contacts_org_id_wa_user_id_key unique (org_id, wa_user_id);

alter table public.contacts drop constraint contacts_identity_check;
alter table public.contacts add constraint contacts_identity_check
  check (phone is not null or group_jid is not null or wa_user_id is not null);
