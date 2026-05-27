-- 0029: Meta Conversions API 集成
-- 给 contacts 加 FB lead 归因字段 + 给 contact_events 加 fb_conversion_sent 事件类型
--
-- fb_lead_id: Meta 生成的 15-17 位数字 ID，FB Lead Ads 表单提交时由 Meta 分配
--             用 Conversions API 时按 lead_id 匹配 → 高精度归因
-- ctwa_clid:  Click-to-WhatsApp Ads 点击 ID，客户从 FB 广告点 "发消息" 进 WA 时
--             带在第一条消息的 referral 字段里。精度比 lead_id 弱但比 hashed phone 强
-- fb_ad_id:   广告创意 ID（可选），用于归因到具体广告/广告组
--
-- 这 3 个字段都不强制非空——只有从 FB 引流的客户才有，自然流量客户保持 NULL

alter table contacts
  add column if not exists fb_lead_id text,
  add column if not exists ctwa_clid text,
  add column if not exists fb_ad_id text;

-- 同 org 内 fb_lead_id 唯一（防 webhook 重复推送时重复建 contact）
-- 用普通 UNIQUE CONSTRAINT 而不是 partial INDEX（NULL/NULL 在 PG 里不冲突，
-- 没有 lead_id 的 contact 可共存；同时 supabase-js .upsert(onConflict) 才能识别）
-- 详见 0018_fix_group_jid_unique.sql 同款踩坑记
alter table contacts
  add constraint contacts_org_fb_lead_id_key unique (org_id, fb_lead_id);

create index if not exists contacts_ctwa_clid_idx
  on contacts (ctwa_clid)
  where ctwa_clid is not null;

-- contact_event_type 枚举加新值：Edge Function 每次成功 POST 到 Meta
-- 都会写一条 fb_conversion_sent 到时间轴，payload 含 event_name / fb_event_id
alter type contact_event_type add value if not exists 'fb_conversion_sent';
