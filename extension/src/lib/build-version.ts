// ⚠️ 此文件由 scripts/package.mjs 自动覆写。**不要手改**。
//
// `npm run dev` 默认值 'dev' → version-check 直接放行（开发模式）。
// `npm run package` 会写成 '0.1.0-YYYYMMDD'，并把同样的字符串
// upsert 到 Supabase `app_config.required_version`。其他销售扩展拉
// required 后跟这里对比，不匹配则 VersionGate 拦死。
export const BUILD_VERSION: string = 'dev';
