#!/usr/bin/env node
/**
 * Dump 当前 claude-prompt.ts 里所有 const 字符串内容到 markdown 文件，
 * 方便人工 review prompt 全貌。
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptFile = resolve(__dirname, '..', 'src', 'lib', 'claude-prompt.ts');
const signalsFile = resolve(__dirname, '..', 'src', 'lib', 'customer-signals.ts');

const src = readFileSync(promptFile, 'utf-8');
const signalsSrc = readFileSync(signalsFile, 'utf-8');

function extractBacktickConst(text, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}[^=]*=\\s*\`([\\s\\S]*?)\`;`, 'm');
  const m = text.match(re);
  return m ? m[1] : null;
}

function extractStyleAnchors(text) {
  // DEFAULT_STYLE_ANCHORS is an array of objects, not a single backtick string
  const start = text.indexOf('export const DEFAULT_STYLE_ANCHORS');
  if (start === -1) return null;
  const arrStart = text.indexOf('[', start);
  let depth = 0;
  let i = arrStart;
  for (; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  return text.slice(arrStart, i + 1);
}

function extractFunctionReturn(text, fnName) {
  const start = text.indexOf(`function ${fnName}`);
  if (start === -1) return null;
  const ret = text.indexOf('return `', start);
  if (ret === -1) return null;
  // find matching backtick
  let i = ret + 'return `'.length;
  while (i < text.length && text[i] !== '`') {
    if (text[i] === '\\') i += 2;
    else i++;
  }
  return text.slice(ret + 'return `'.length, i);
}

const rolePrompt = extractBacktickConst(src, 'ROLE_PROMPT');
const vehicleKnowledge = extractBacktickConst(src, 'VEHICLE_KNOWLEDGE');
const ghanaPlaybook = extractBacktickConst(src, 'GHANA_MARKET_PLAYBOOK');
const anchorsArr = extractStyleAnchors(src);
const replyAsk = extractFunctionReturn(src, 'buildReplyAsk');
const analyzeAsk = extractFunctionReturn(src, 'buildAnalyzeAsk');
const variantsAsk = extractFunctionReturn(src, 'buildVariantsAsk');
const quoteAsk = extractFunctionReturn(src, 'buildQuoteAsk');

const out = [];
out.push('# Sino Gear · Claude Prompt 完整 Dump');
out.push('');
out.push(`生成时间: ${new Date().toISOString()}`);
out.push(`源文件: extension/src/lib/claude-prompt.ts (${src.split('\n').length} 行)`);
out.push('');
out.push('AI 实际看到的 prompt 是这几个 section 按需拼接的:');
out.push('- buildFirstMessage = ROLE_PROMPT + VEHICLE_KNOWLEDGE + (GHANA_MARKET_PLAYBOOK if Ghana) + [Sales Guidance] + Style Anchors + [Customer] + [Vehicle Interests] + [Customer Signals] + [Chat History] + buildModeAsk');
out.push('- buildFollowUpMessage = [Sales Guidance] + [Objection Radar] + [New Messages Since Last Time] + buildModeAsk (用同一 Claude 对话续聊，不重发 ROLE_PROMPT)');
out.push('');
out.push('---');
out.push('');
out.push('## 1. ROLE_PROMPT (always sent in first message)');
out.push('');
out.push('```');
out.push(rolePrompt);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 2. VEHICLE_KNOWLEDGE (always sent in first message)');
out.push('');
out.push('```');
out.push(vehicleKnowledge);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 3. GHANA_MARKET_PLAYBOOK (only sent when Ghana context detected — phone +233 / country Ghana / chat mentions Tema/Accra/GHS)');
out.push('');
out.push('```');
out.push(ghanaPlaybook);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 4. DEFAULT_STYLE_ANCHORS (8 段，always injected unless caller overrides)');
out.push('');
out.push('```typescript');
out.push(anchorsArr);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 5. customer-signals.ts (auto-detected [Customer Signals] block injected before [Chat History])');
out.push('');
out.push('```typescript');
out.push(signalsSrc);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 6. buildReplyAsk output (mode=reply, sent every time including follow-ups)');
out.push('');
out.push('```');
out.push(replyAsk);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 7. buildAnalyzeAsk output (mode=analyze)');
out.push('');
out.push('```');
out.push(analyzeAsk);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 8. buildVariantsAsk output (mode=variants)');
out.push('');
out.push('```');
out.push(variantsAsk);
out.push('```');
out.push('');
out.push('---');
out.push('');
out.push('## 9. buildQuoteAsk output (mode=quote)');
out.push('');
out.push('```');
out.push(quoteAsk);
out.push('```');

const outPath = resolve(__dirname, '..', '..', 'current-prompt-2026-05-18.md');
writeFileSync(outPath, out.join('\n'), 'utf-8');
console.log(`✓ 写入: ${outPath}`);
console.log(`  大小: ${(out.join('\n').length / 1024).toFixed(1)} KB`);
