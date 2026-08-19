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
