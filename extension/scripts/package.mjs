#!/usr/bin/env node
// 打包扩展为带版本号 + 日期戳的 zip
// 用法：npm run package
//
// 产物示例：sino-gear-crm-v0.1.0-20260508.zip
// 放在仓库根目录 dist-zips/ 下

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(__dirname, '..');
const distDir = join(extensionRoot, 'dist');
const repoRoot = join(extensionRoot, '..');
const outDir = join(repoRoot, 'dist-zips');

// 1. 读 version
const pkg = JSON.parse(
  readFileSync(join(extensionRoot, 'package.json'), 'utf8'),
);
const version = pkg.version;

// 2. 日期戳 YYYYMMDD
const now = new Date();
const datestamp =
  now.getFullYear().toString() +
  String(now.getMonth() + 1).padStart(2, '0') +
  String(now.getDate()).padStart(2, '0');

const zipName = `sino-gear-crm-v${version}-${datestamp}.zip`;
const zipPath = join(outDir, zipName);

// 3. 必须先 build
if (!existsSync(distDir)) {
  console.error('✗ dist/ 不存在，先跑 npm run build');
  process.exit(1);
}
const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('✗ dist/manifest.json 不存在，build 没产出对');
  process.exit(1);
}
const distMtime = statSync(distDir).mtimeMs;
const ageMin = (Date.now() - distMtime) / 60000;
if (ageMin > 30) {
  console.warn(
    `⚠ dist/ 上次构建是 ${Math.round(ageMin)} 分钟前，建议重跑 npm run build`,
  );
}

// 4. 创建输出目录
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// 5. zip（macOS / Linux 自带 zip 命令；Windows 需要装 7z 或类似）
console.log(`📦 打包 ${zipName}…`);
try {
  // -r 递归 -X 不带额外属性 -q 安静
  execSync(`cd "${distDir}" && zip -rqX "${zipPath}" .`, {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch (err) {
  console.error('✗ zip 命令失败。Windows 用户请装 zip 工具或用 7-Zip 手动打包 dist/');
  process.exit(1);
}

const stat = statSync(zipPath);
const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
console.log(`✓ 已打包：${zipPath}`);
console.log(`  大小：${sizeMb} MB`);
console.log('');
console.log('🚀 分发步骤：');
console.log('  1. 把这个 zip 发给团队（微信群 / 网盘 / 邮件）');
console.log('  2. 让他们解压到固定文件夹（别删）');
console.log('  3. chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序');
console.log('  4. 选解压出来的文件夹');
console.log('');
console.log('💡 重要提醒：');
console.log('  - 改了 schema 需要先在 Supabase 跑 migration');
console.log('  - 然后通知团队替换 zip 文件夹 + 在 chrome://extensions/ 点 ↻ 重新加载');
