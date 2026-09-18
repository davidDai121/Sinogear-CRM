# 已完成使命的一次性脚本存档

这些脚本对应的操作已在生产库执行完毕（时间线见 CLAUDE.md 对应「近期补完」章节），
留档仅供追溯，**不要再跑**：

- `backfill-null-sent-at.mjs` / `rollback-null-sent-at-backfill.mjs` / `dryrun-timestamp-fix.mjs`
  — 2026-05-26 sent_at 回填 + 当天全量回滚（教训：别用 synced_at 近似 sent_at）
- `backfill-vehicle-uploaders.mjs` / `inspect-vehicle-uploaders.mjs`
  — 2026-05-29 vehicles.created_by 回填（36 boss / 10 Grant），已带唯一写入防线
- `fix-fb-lead-duplicates.mjs` — 2026-08-21 清理 74 个表单号码错配的重复客户；
  预防逻辑已进 message-sync.ts 的 reconcileFbLeadDuplicate
- `repair-missing-lead-events.mjs` — 2026-08-21 补回 webhook void-promise 丢失的
  8 条 fb_lead_received 事件；根因（Edge Function 里 await）已修
- `daimenglong-valuable-followups.mjs` — 一次性客户分析导出
