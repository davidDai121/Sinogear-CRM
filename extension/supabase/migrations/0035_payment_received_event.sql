-- 0035: 给 contact_event_type 加 'payment_received'
--
-- 背景（2026-08-19 boss 定的口径）：**客户发来水单（银行回单）才算成交。**
-- 起因是有几个没成交的被标成了成交 —— 实测 Karim (+237671205883) 库里是 won，
-- 但他最后两句还在砍价（"The price is a little high can you bring it lower"）。
-- 根因：Gem/Claude 回复里解析出的 won/closed/closed_won 被直接落库。
--
-- 修法分两层：
--   ① useAutoFbStage.isStageTransitionAllowed 硬拦 next === 'won'（已上线）
--   ② won 只能由人点「已收水单」按钮产生，同时写一条本事件留证（本次）
--
-- 事件 payload：
--   { receipt_url, receipt_public_id, file_name, amount_usd, note, source: 'manual' }
--   receipt_url 为 null = 销售确认收到但没上传图，复核清单里会单独标出来。
--
-- 注意：contact_sales_signals.payment_received_at 那一列不要再当成交依据 ——
-- 它的正则没分方向也没排除否定句，全库只命中 5 条且全是我方发的
-- "we still have not received the payment"。判成交一律以本事件为准。

alter type contact_event_type add value if not exists 'payment_received';
