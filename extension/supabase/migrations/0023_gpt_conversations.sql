-- 0023: GPT (chatgpt.com) AI 回复 — per-contact chat URL 缓存
--
-- 跟 claude_conversations 同一套思路：
--   - 没有 template（单一 Miles persona prompt）
--   - (contact_id) 唯一：每个客户一条对话
--
-- 工作流：
--   1. 第一次给客户生成回复 → chatgpt.com → 发完跳转到 chatgpt.com/c/<uuid>
--      → 把这个 URL upsert 到本表
--   2. 第二次生成（同一客户）→ 读出 chat_url → 打开它 → 续聊
--   3. "清除并新建" → DELETE 这一行，下次又走 chatgpt.com

create table gpt_conversations (
  contact_id    uuid primary key references contacts(id) on delete cascade,
  chat_url      text not null,
  last_used_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index on gpt_conversations (last_used_at desc);

alter table gpt_conversations enable row level security;

create policy "gpt_conversations read"
  on gpt_conversations for select using (
    exists (
      select 1 from contacts c
      where c.id = gpt_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "gpt_conversations write"
  on gpt_conversations for all using (
    exists (
      select 1 from contacts c
      where c.id = gpt_conversations.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = gpt_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

comment on table gpt_conversations is
  'Per-contact ChatGPT chat URL cache. One row per contact (no template, single Miles persona).';
