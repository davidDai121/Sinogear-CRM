# Menglong R08 GPT 副本与 404 修复（2026-09-20）

## 现场与结果

Menglong Dai 已登录，旧 R08 GPT g-6aa7711ad9cc8191aa3d3693cfd7ad9f 实见404；My GPTs没有R08。该旧GPT归属Yang的推测本轮未直接核验。
新建私有GPT **Sino Gear R08 Miles**，作者页面实见Menglong Dai，保存提示Settings Saved。
链接：https://chatgpt.com/g/g-6aaff2e20f848191a17b81f6786cdebe-sino-gear-r08-miles

以9月17日已核对在线版为源，K01–K11全文保留；压缩重复行为描述，更新Client Record为增量，并内置9月20日首回复及9月18日保险/费用覆盖规则。最终7990字符，表单回读逐字一致。与原GPT一样采用内置知识；浏览器上传返回Not allowed，两份详细知识附件未上传，不声称附件已完成。未修改Yang GPT或既有R08技能。

只改Menglong的gpt_templates b31c9b55-e31f-42d7-bfd7-2b7da35db805 的gpt_url，组织和owner过滤、备份、dry-run逐条核对、updated_at乐观锁、写后回读均完成。模板名称、知识、默认值不变；Miles V2仍默认。旧会话记录保留；生成路径按新GPT ID拒绝复用旧GPT会话，并可从CRM上下文新建。

CRM路由增加孟龙新GPT ID；保留旧ID用于其他账号，新旧GPT会话不能互相续聊。79项相关离线测试通过，TypeScript/Vite构建通过。Native Chrome在本仓库extension/dist对应Sino Gear CRM上点击Reload，实见Reloaded，WhatsApp已刷新。未打团队安装包、未改required_version。

## 验证

新GPT页面正常访问并显示By Menglong Dai。独立模拟三场景通过：西语首次回复正确给12200/14700/25000三类FOB起价；柴油2.3T/8AT四驱Comfort 17400及一年三大件店保正确；两台25000、单柜运输3000已含DG/地面，按运输×1.1得到53300，没有重加费用。测试为明确虚构的内部验收，不是真实客户CRM生成全链路。
模拟会话：https://chatgpt.com/g/g-6aaff2e20f848191a17b81f6786cdebe-sino-gear-r08-miles/c/6aaff3eb-6f58-83ea-8446-2a7e3161f01d

备份、最终指令、数据库计划与回读、模拟验收在分析导出/R08_GPT账号副本_2026-09-20/。没有向WhatsApp客户填入或发送消息。
