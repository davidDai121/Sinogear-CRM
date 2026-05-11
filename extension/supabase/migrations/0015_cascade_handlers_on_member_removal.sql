-- 0015: org 成员被移除时，自动清掉他在该 org 所有 contact 上的 handler 行
--
-- 背景（2026-05-09）：
--   一个 auth user (3190696498@qq.com) 短暂加入过 Miles org，被移除后
--   contact_handlers 里他的 512 行没被清掉，导致 459 个客户长期显示"撞单"。
--   0014 里的 RLS 已经阻止非成员写入新 handler 行，但旧行需要级联清理。
--
-- 这个 migration 加一个 AFTER DELETE on organization_members 的 trigger，
-- 自动删掉被移除成员在该 org 所有 contact 上的 handler 行。

create or replace function public.cleanup_handlers_on_member_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from contact_handlers ch
  using contacts c
  where ch.contact_id = c.id
    and ch.user_id = old.user_id
    and c.org_id = old.org_id;
  return old;
end;
$$;

drop trigger if exists organization_members_cleanup_handlers on organization_members;

create trigger organization_members_cleanup_handlers
  after delete on organization_members
  for each row execute function public.cleanup_handlers_on_member_removal();
