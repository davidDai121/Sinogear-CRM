-- 0020: Claude AI 回复 — per-contact chat URL 缓存
--
-- 跟 gem_conversations 一样的用途，但更简单：
--   - 没有 template（Claude 是单一 persona，不像 Gemini Gem 多模板）
--   - (contact_id) 唯一：每个客户一条对话
--
-- 工作流：
--   1. 第一次给客户生成回复 → claude.ai/new → 发完跳转到 claude.ai/chat/<uuid>
--      → 把这个 URL upsert 到本表
--   2. 第二次生成（同一客户）→ 读出 chat_url → 打开它 → 续聊
--   3. "清除并新建" → DELETE 这一行，下次又走 /new

create table claude_conversations (
  contact_id    uuid primary key references contacts(id) on delete cascade,
  chat_url      text not null,
  last_used_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index on claude_conversations (last_used_at desc);

alter table claude_conversations enable row level security;

create policy "claude_conversations read"
  on claude_conversations for select using (
    exists (
      select 1 from contacts c
      where c.id = claude_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

create policy "claude_conversations write"
  on claude_conversations for all using (
    exists (
      select 1 from contacts c
      where c.id = claude_conversations.contact_id and public.is_org_member(c.org_id)
    )
  ) with check (
    exists (
      select 1 from contacts c
      where c.id = claude_conversations.contact_id and public.is_org_member(c.org_id)
    )
  );

comment on table claude_conversations is
  'Per-contact Claude.ai chat URL cache. One row per contact (no template, single persona).';
