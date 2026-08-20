-- 0036: 给 contact_event_type 加 'lead_qualified'
--
-- 背景（2026-08-20）：boss 要做的闭环是
--   Facebook Lead → CRM → 销售跟进 → 判定合格/不合格 → 回传 Meta → Meta 学会找对人
--
-- 实测发现两个前提没满足，这条迁移解决第二个：
--   ① 归因断了：9,128 个客户里 fb_lead_id / ctwa_clid / fb_ad_id 全是 0。
--      没有 lead_id，Meta 收到回传也接不回具体哪条广告线索。
--      （靠 fb-lead-webhook + wa-cloud-webhook 配通解决，不在这条迁移范围）
--   ② 「合格」目前是 AI 猜的：近 8 周 qualifying 变更 532 条里 415 条是
--      AI 自动推的（78%），negotiating 401 条里 385 条（96%）。而同一个 AI
--      今天被实测证明会把广告表单的自动首句读成「客户已购买并支付定金」。
--      拿这种判断去训练 Meta，等于教它「发广告表单自动消息的人是优质客户」。
--
-- 所以合格与否必须是人点的，且 append-only 留证 —— 跟 0035 的水单同一个模式。
-- payload: { qualified: bool, reason?: string, note?: string, fb_event_sent?: bool }

alter type contact_event_type add value if not exists 'lead_qualified';
