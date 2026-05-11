#!/usr/bin/env node
// 打包扩展为带版本号 + 日期戳的 zip
// 用法：npm run package
//
// 流程：
//   1. 写入 src/lib/build-version.ts（BUILD_VERSION = '0.1.0-YYYYMMDD'）
//   2. 跑 npm run build（用刚写入的版本号构建）
//   3. 把 dist/ 打成 zip 放到 dist-zips/
//   4. 把同样的版本号 upsert 到 Supabase app_config.required_version
//      —— 这一步让其他销售扩展自动检测到版本过时被 VersionGate 拦下
//
// 推送 Supabase 需要 .env 里有 VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY；
// 没有就跳过（只打 zip + 提示手动跑 SQL）。

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(__dirname, '..');
const distDir = join(extensionRoot, 'dist');
const repoRoot = join(extensionRoot, '..');
const outDir = join(repoRoot, 'dist-zips');
const buildVersionPath = join(extensionRoot, 'src/lib/build-version.ts');
const envPath = join(extensionRoot, '.env');

// ─────────────────────────────────────────────
// 1. 计算版本号
// ─────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8'));
const semver = pkg.version;
const now = new Date();
const datestamp =
  now.getFullYear().toString() +
  String(now.getMonth() + 1).padStart(2, '0') +
  String(now.getDate()).padStart(2, '0');
const fullVersion = `${semver}-${datestamp}`;
const zipName = `sino-gear-crm-v${fullVersion}.zip`;
const zipPath = join(outDir, zipName);

// ─────────────────────────────────────────────
// 2. 写入 build-version.ts（覆盖之前的 'dev'）
// ─────────────────────────────────────────────
const buildVersionContent = `// ⚠️ 此文件由 scripts/package.mjs 自动覆写。**不要手改**。
//
// \`npm run dev\` 默认值 'dev' → version-check 直接放行（开发模式）。
// \`npm run package\` 会写成 '0.1.0-YYYYMMDD'，并把同样的字符串
// upsert 到 Supabase \`app_config.required_version\`。其他销售扩展拉
// required 后跟这里对比，不匹配则 VersionGate 拦死。
export const BUILD_VERSION: string = '${fullVersion}';
`;
writeFileSync(buildVersionPath, buildVersionContent, 'utf8');
console.log(`📝 写入 build-version.ts: BUILD_VERSION = '${fullVersion}'`);

// ─────────────────────────────────────────────
// 3. 重跑 build（确保 dist/ 用最新版本号）
// ─────────────────────────────────────────────
console.log('🔨 重新构建（npm run build）…');
try {
  execSync('npm run build', { cwd: extensionRoot, stdio: 'inherit' });
} catch {
  console.error('✗ build 失败，停止打包');
  process.exit(1);
}

// ─────────────────────────────────────────────
// 4. zip
// ─────────────────────────────────────────────
if (!existsSync(distDir) || !existsSync(join(distDir, 'manifest.json'))) {
  console.error('✗ dist/ 或 dist/manifest.json 不存在，build 没产出对');
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`📦 打包 ${zipName}…`);
try {
  execSync(`cd "${distDir}" && zip -rqX "${zipPath}" .`, {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch {
  console.error('✗ zip 命令失败。Windows 用户请装 zip 工具或用 7-Zip 手动打包 dist/');
  process.exit(1);
}

const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`✓ 已打包：${zipPath}`);
console.log(`  大小：${sizeMb} MB`);

// ─────────────────────────────────────────────
// 5. 推送 required_version 到 Supabase
// ─────────────────────────────────────────────
const env = readEnvFile(envPath);
const supabaseUrl = env.VITE_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (supabaseUrl && serviceKey) {
  console.log(`🔐 推送 required_version='${fullVersion}' 到 Supabase…`);
  try {
    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    const { error } = await sb.from('app_config').upsert(
      { key: 'required_version', value: fullVersion, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) {
      console.error(`✗ 推送失败：${error.message}`);
      console.error('  → 请手动在 Supabase SQL Editor 跑：');
      console.error(`    update app_config set value='${fullVersion}', updated_at=now() where key='required_version';`);
    } else {
      console.log('✓ Supabase app_config.required_version 已更新');
      console.log('  其他销售下次打开扩展（5 分钟内）就会被 VersionGate 拦下，必须装新版');
    }
  } catch (err) {
    console.error('✗ Supabase 推送异常：', err);
  }
} else {
  console.warn('⚠ .env 里没找到 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY —— 跳过版本推送');
  console.warn('  请手动在 Supabase SQL Editor 跑：');
  console.warn(`    update app_config set value='${fullVersion}', updated_at=now() where key='required_version';`);
}

// ─────────────────────────────────────────────
// 6. 把 build-version.ts 还原为 'dev'，保持 git 树干净
//    （dist/ 里已经是带版本号的产物，源码不留痕）
// ─────────────────────────────────────────────
const devContent = `// ⚠️ 此文件由 scripts/package.mjs 自动覆写。**不要手改**。
//
// \`npm run dev\` 默认值 'dev' → version-check 直接放行（开发模式）。
// \`npm run package\` 会写成 '0.1.0-YYYYMMDD'，并把同样的字符串
// upsert 到 Supabase \`app_config.required_version\`。其他销售扩展拉
// required 后跟这里对比，不匹配则 VersionGate 拦死。
export const BUILD_VERSION: string = 'dev';
`;
writeFileSync(buildVersionPath, devContent, 'utf8');

console.log('');
console.log('🚀 分发步骤：');
console.log('  1. 把这个 zip 发给团队（微信群 / 网盘 / 邮件）');
console.log('  2. 让他们解压到固定文件夹（别删）');
console.log('  3. chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序（首次）');
console.log('     已装过的：替换文件夹后 chrome://extensions/ 点 ↻ 重载 + WhatsApp Web F5 刷新');
console.log('');
console.log('💡 重要：旧版扩展打开后 5 分钟内会被 VersionGate 弹窗拦住，必须装新版才能继续用。');

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const txt = readFileSync(path, 'utf8');
  const out = {};
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    // 去掉两端引号（如果有）
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}
