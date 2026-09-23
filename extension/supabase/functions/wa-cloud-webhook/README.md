> 2026-09-22 状态：代码就绪，**尚未部署、尚未接通共存**。
> 已补：业务号码 → 业务员映射（0043 `wa_business_numbers`）、每条消息记 `business_phone`、
> 通讯录同步（`smb_app_state_sync`）、断线心跳（`last_webhook_at`）、历史出站消息客户号修复、
> 接入收尾函数 `wa-onboard` + 授权页 `extension/wa-onboard-page/`。
> 跨号码消息 ID 不做隔离：key_id 是发送方随机生成的 16–32 位 hex，同一客户两个号之间撞车概率可忽略；
> 跨 DOM/Cloud 去重靠同一个 key_id + `(contact_id, wa_message_id)` 唯一约束，DOM 先写的行胜出。
> 上线前还要：Meta 后台配置（见文末「上线清单」）、授权页托管到 https 域名、用测试号 +8613552592187 验证双向同步。

# wa-cloud-webhook —— WhatsApp Cloud API 消息回传（coexistence）

## 这个函数解决什么

扩展原本靠抓 WhatsApp Web DOM 攒 `messages` 表，只覆盖「人点开过的聊天」的
「渲染出来的 30 条」。2026-08-19 实测：近 7 天本机 202 个聊天 / 2499 条消息，
库里只有 155 个 / 1361 条，**丢 69%**，另有 5733 条无时间戳。

coexistence 接上后消息由 Meta 主动推送，DOM 那条路可以退役。

同时补上归因缺口：全库 9100 个客户的 `ctwa_clid` / `fb_ad_id` 一直是 0，
导致 Meta 只能拿「表单提交」当优化目标 —— 于是卢旺达线索 83% 只要 1 台车、
62% 填个人自用。Click-to-WhatsApp 来的消息带 `referral.ctwa_clid`，
本函数会写进 contact。

## 前置条件（这些不是代码能解决的）

1. **必须通过 BSP（Solution Partner / Tech Provider）做 embedded signup** —— 不能自助
2. **WhatsApp Business App ≥ 2.24.17**
3. 接入时**所有 companion device 会被断开**，需重新扫码链接
4. ⚠️ **只用 WhatsApp Web 或 WhatsApp for Mac**。
   WhatsApp for Windows 和 WearOS 不受 coexistence 支持 ——
   从那些设备发出的消息会出现在 App 里但**不会触发 `smb_message_echoes`**，
   静默丢失。这正是我们花一整天修的那类问题，别再踩。

## 部署

```bash
supabase functions deploy wa-cloud-webhook --no-verify-jwt
```

`--no-verify-jwt` 必须加：Meta 不带 JWT。安全靠 `hub.verify_token` + `X-Hub-Signature-256`。

### 环境变量

| 变量 | 说明 |
|---|---|
| `FB_APP_SECRET` | 算 X-Hub-Signature-256，与 fb-lead-webhook 共用 |
| `WA_VERIFY_TOKEN` | 订阅握手用；没配则回退到 `FB_VERIFY_TOKEN` |
| `FB_ORG_ID` | 消息归到哪个 CRM org |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase 自动注入 |

### Meta 后台要订阅的 webhook 字段

- `messages` —— 客户来信（含 CTWA referral）
- `smb_message_echoes` —— 销售在 App / Web 发出去的
- `history` —— 接入时 180 天回填，分 day0-1 / 1-90 / 90-180 三段推
  （媒体只含最近 14 天）
- `smb_app_state_sync` —— 手机通讯录（Meta 要求必须订阅）；只给还没名字的客户补备注名，不新建客户

## 关键实现：wamid → key_id

Cloud API 用 `wamid.<base64>` 标识消息，而 `messages.wa_message_id` 存的是
WhatsApp 原生 key_id（`3EB0C92FBCD18A6747989F` / `AC1B15F3...`）——
DOM 抓取和 crypt15 备份导入用的都是它。

wamid 解开是：

```
\x1c\x18<len><手机号ascii>\x15\x02\x00\x11\x18<len><KEYID ascii>\x00
```

`wamidToKeyId()` 抠出 KEYID，于是新消息和已入库的 118,506 条靠
`(contact_id, wa_message_id)` 唯一约束**天然去重**，不重复也不用迁移。
解不出来时回退到整个 wamid 字符串 —— 宁可偶尔重复一条，也不丢。

## 上线顺序建议

1. 先拿**次要号**试，不要动主力号 +86 155 5517 2187
2. 验证 `smb_message_echoes` 确实覆盖 WhatsApp Web 发出的消息
3. 验证 CTWA 来的对话能拿到 `ctwa_clid`
4. 跑通后再上主力号，然后停掉 `useMessageSync` 的 DOM 同步

## 2026-09-17 接收可靠性修复（本地，未部署）

- 配置缺失、客户查询/创建失败、消息写入失败、广告归因失败均返回 503，不能把未保存消息以 200 确认。
- 空验证 token 不再放行；校验签名格式、JSON 顶层与时间戳；历史正文缺本机号码时拒绝猜方向。
- 广告事件字段改为实际 schema 的 `event_type`；事件 ID 按消息确定，重试幂等。
- 归因写入使用 `ctwa_clid IS NULL` 条件，避免并发覆盖已有归因。
- 验证：在 extension 目录运行 `node --test scripts/test-wa-cloud-webhook.mjs`。数据库全部模拟，不发送 WhatsApp 消息。
- 返回 503 只保留上游重试机会，不等于永久队列；正式接入仍须监控失败并制定重放策略。

## 2026-09-22 业务号码 / 通讯录 / 接入函数

- **业务号码**：每个 change 的 `metadata.display_phone_number` 记到 `messages.business_phone`；
  没有任何主理人的客户，归给 `wa_business_numbers` 里登记的业务员（已有人跟的不动）。
  已登记：Miles +8615555172187 / Grant +8617364388937 / Sophia +8618949842722 /
  Cheryl +8618399455977 / 测试号 +8613552592187（不绑人）。新号码首次推送时自动建行、user_id 留空。
- **断线监控**：每次收到推送刷新 `last_webhook_at`。App 13–14 天不打开会静默断开，查：
  `select label, phone, last_webhook_at from wa_business_numbers order by last_webhook_at nulls first;`
- **历史出站修复**：`history` 里我方发出的消息只有 `from`，客户号在 `thread.id`；之前会整条被拒收。
- **wa-onboard**：Embedded Signup 完成后换 token → 订阅 app 到 WABA → 触发通讯录 + 历史同步
  （24 小时内必须触发）→ 登记号码。只有 org owner 能调。token 存 `wa_business_accounts`（无 RLS policy，仅 service_role）。

## 上线清单

1. 跑 migration `0043_wa_business_numbers.sql`
2. Meta App（CRMDataSource `1364804098472538`）：
   - 添加 WhatsApp 产品
   - Facebook 登录 for Business → 新建配置 → 类型选 WhatsApp Embedded Signup → 拿配置 ID 填进授权页 `CONFIG_ID`
   - 登录设置里登记授权页的 https 域名（允许的网域 + 有效 OAuth 跳转 URI）
   - WhatsApp → 配置 → Webhook 回调地址 `https://hgkjmmvotpakcetcwpoy.supabase.co/functions/v1/wa-cloud-webhook`，
     verify token 用 `WA_VERIFY_TOKEN`，订阅 `messages` / `smb_message_echoes` / `history` / `smb_app_state_sync`
3. Supabase secrets：`FB_APP_ID=1364804098472538`、`WA_VERIFY_TOKEN`（新生成）；`FB_APP_SECRET` / `FB_ORG_ID` 已有
4. 部署：`supabase functions deploy wa-cloud-webhook --no-verify-jwt` + `supabase functions deploy wa-onboard`
5. 授权页托管到 https 域名，用测试号接入 → 双向发消息 → 查 `messages.business_phone` 是否落库
6. 测试一周无误后按 Miles → Grant → Sophia → Cheryl 逐个接入
