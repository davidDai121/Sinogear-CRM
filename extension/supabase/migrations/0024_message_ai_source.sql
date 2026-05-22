-- 0024: messages 表加 ai_source 列 —— 出站消息的 AI 来源 attribution
--
-- 目的：用户填入 AI 回复后可能改了/删了/换 AI 重新生成，事后能 review 哪个 AI 实际成单。
--
-- 枚举值：
--   'claude'    — Claude AI 回复填入
--   'gem'       — Gemini Gem 手动填入
--   'gem_auto'  — Gem 自动回复（FB lead 等无人值守路径）
--   'gpt'       — ChatGPT 填入
--   NULL        — 销售自己手打 / 复制粘贴而不点填入 / 改动太大归因 miss
--
-- 归因机制：fillReply 时把 {contact_id, source, snippet, fillAt} 存 chrome.storage 5 分钟窗口，
--          syncMessages 写入站消息时查窗口 + 文本相似度匹配 → 写 ai_source。
--          匹配不到 = manual。详见 lib/ai-reply-attribution.ts。

alter table messages add column ai_source text;

comment on column messages.ai_source is
  'AI source attribution for outbound messages: claude/gem/gem_auto/gpt, or NULL for manual/unattributed';
