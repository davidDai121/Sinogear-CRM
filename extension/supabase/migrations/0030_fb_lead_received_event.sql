-- 0030: 给 contact_event_type 加 'fb_lead_received'
-- 用途：fb-lead-webhook Edge Function 收到 Meta Lead Ads 表单时写一条
--      payload 含 fb_lead_id / form_id / ad_id / 拉到的原始字段
-- 跟 fb_conversion_sent 配对：先 received（webhook 入），后 sent（CRM 回传 Lead 事件）

alter type contact_event_type add value if not exists 'fb_lead_received';
