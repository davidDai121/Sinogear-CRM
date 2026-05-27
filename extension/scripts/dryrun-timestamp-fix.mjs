#!/usr/bin/env node
/**
 * Dry-run：测试 timestamp null 修复方案对 prompt 输出的影响。
 *
 * 模拟 buildFollowUpMessage（GPT/Claude 续聊路径）的输出，对比 3 种方案：
 *   - current: formatTimestamp(null) → new Date()（当前 bug）
 *   - planA:   formatTimestamp(null) → '??-?? ??:??'（最小改动）
 *   - planB:   collapseMediaRuns 用邻居 timestamp 推断 null → 然后正常 formatTimestamp
 *
 * 测试 4 个代表性 contact，每个跑 3 种方案，对比 [New Messages] section 输出。
 * 不动代码，不写 DB。
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('missing env');
  process.exit(1);
}

// ── 复制自 chat-media-utils.ts（inline 避免 ts 编译） ──

function isMediaOnly(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (/^\[(图片|视频|语音|文档|贴纸|媒体)\]$/.test(t)) return true;
  if (t === '<媒体>') return true;
  if (
    /^‎?(IMG|VID|VIDEO|AUD|AUDIO|DOC|PTT|STK|PHOTO|GIF)[-_].+\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|opus|m4a|mp3|pdf|docx?|xlsx?|pptx?)\s*\(文件附件\)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

function mediaKind(text) {
  const t = (text || '').trim();
  if (t === '[图片]') return 'image';
  if (t === '[视频]') return 'video';
  if (t === '[语音]') return 'audio';
  if (t === '[文档]') return 'document';
  if (t === '[贴纸]') return 'sticker';
  if (t === '[媒体]' || t === '<媒体>') return 'media';
  const m = t.match(/^‎?(IMG|PHOTO|GIF|VID|VIDEO|AUD|AUDIO|PTT|DOC|STK)[-_]/i);
  if (m) {
    const p = m[1].toUpperCase();
    if (p === 'IMG' || p === 'PHOTO' || p === 'GIF') return 'image';
    if (p === 'VID' || p === 'VIDEO') return 'video';
    if (p === 'AUD' || p === 'AUDIO' || p === 'PTT') return 'audio';
    if (p === 'DOC') return 'document';
    if (p === 'STK') return 'sticker';
  }
  if (/\.(pdf|docx?|xlsx?|pptx?)\s*\(文件附件\)$/i.test(t)) return 'document';
  if (/\.(mp4|mov|webm)\s*\(文件附件\)$/i.test(t)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)\s*\(文件附件\)$/i.test(t)) return 'image';
  if (/\.(opus|m4a|mp3)\s*\(文件附件\)$/i.test(t)) return 'audio';
  return 'media';
}

function formatMediaPlaceholder(kind, n, fromMe) {
  const who = fromMe ? 'Sales sent' : 'Customer sent';
  const plural = n > 1;
  switch (kind) {
    case 'image':
      return `[${who} ${n} ${plural ? 'photos' : 'photo'}${fromMe ? ' to customer' : ''}]`;
    case 'video':
      return `[${who} ${n} ${plural ? 'videos' : 'video'}${fromMe ? ' to customer' : ''}]`;
    case 'audio':
      return `[${who} ${n} ${plural ? 'voice messages' : 'voice message'}]`;
    case 'document':
      return `[${who} ${n} ${plural ? 'documents' : 'document'} (PDF / spec sheet / Word / Excel)${fromMe ? ' to customer' : ''}]`;
    case 'sticker':
      return `[${who} ${n} ${plural ? 'stickers' : 'sticker'}]`;
    default:
      return `[${who} ${n} ${plural ? 'attachments' : 'attachment'}${fromMe ? ' to customer' : ''}]`;
  }
}

function collapseMediaRuns(messages) {
  const result = [];
  let run = [];
  let runKind = null;
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const n = run.length;
    const kind = runKind ?? 'media';
    result.push({
      id: first.id + (n > 1 ? `:+${n - 1}` : ''),
      fromMe: first.fromMe,
      text: formatMediaPlaceholder(kind, n, first.fromMe),
      timestamp: last.timestamp ?? first.timestamp,
      sender: first.sender,
    });
    run = [];
    runKind = null;
  };
  for (const m of messages) {
    if (isMediaOnly(m.text)) {
      const kind = mediaKind(m.text);
      const sameDir = run.length === 0 || run[run.length - 1].fromMe === m.fromMe;
      const sameKind = runKind === null || runKind === kind;
      if (sameDir && sameKind) {
        run.push(m);
        runKind = kind;
      } else {
        flush();
        run.push(m);
        runKind = kind;
      }
    } else {
      flush();
      result.push(m);
    }
  }
  flush();
  return result;
}

// ── 复制 sales-pitch.ts 的 isSalesPitch ──
function isSalesPitch(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (/\$\s*[\d,]+\+?\s*(less\s+than|off|cheaper|saving|saved?)/i.test(t)) return true;
  if (/save\s+(up\s+to\s+)?\$\s*[\d,]+/i.test(t)) return true;
  if (/\d+\s*%\s*(less|off|cheaper|more\s+(power|range|economy|economical|space|fuel|mileage|torque))/i.test(t)) return true;
  if (/check\s+out\s+the/i.test(t) && /(\$|\d+\s*%)/.test(t) && /(less|off|cheaper|more|save)/i.test(t)) return true;
  if (/(limited\s+time|this\s+(week|month)\s+only|special\s+offer|promo\s+price)/i.test(t) && /\$\s*[\d,]+/.test(t)) return true;
  if (/logo-facebook-round/i.test(t)) return true;
  if (/priced\s+from\s+\$\s*[\d,]+/i.test(t)) return true;
  if (/calling\s+all\s+(car\s+)?(dealers?|importers?|buyers?|customers?)/i.test(t)) return true;
  return false;
}

// ── 三种 formatTimestamp 方案 ──

function formatTimestampCurrent(ms) {
  const d = ms ? new Date(ms) : new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function formatTimestampPlanA(ms) {
  if (ms == null) return '??-?? ??:??';
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

// ── 方案 B 的预处理：邻居推断 timestamp ──
//
// 跑在 collapseMediaRuns 之前，对 messages 数组中 timestamp=null 的行尝试推断：
//   - 双侧都有非 null timestamp: 取两侧中点（不破坏顺序）
//   - 只有前一侧: prev.timestamp + 1ms * (i - prev_i)
//   - 只有后一侧: next.timestamp - 1ms * (next_i - i)
//   - 双侧都没有: 保持 null
function fillNullTimestampsByNeighbor(messages) {
  const out = messages.map((m) => ({ ...m }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].timestamp != null) continue;
    // 找前面最近的非 null
    let prevIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (out[j].timestamp != null) {
        prevIdx = j;
        break;
      }
    }
    // 找后面最近的非 null（要看原数组，不是 out，因为 out 在改）
    let nextIdx = -1;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].timestamp != null) {
        nextIdx = j;
        break;
      }
    }
    if (prevIdx >= 0 && nextIdx >= 0) {
      const prev = out[prevIdx].timestamp;
      const next = messages[nextIdx].timestamp;
      // 在 prev 和 next 之间均匀插入
      const span = next - prev;
      const gapCount = nextIdx - prevIdx;
      const offset = (i - prevIdx) * (span / gapCount);
      out[i].timestamp = Math.round(prev + offset);
    } else if (prevIdx >= 0) {
      // 只有 prev，相对偏移
      out[i].timestamp = out[prevIdx].timestamp + (i - prevIdx);
    } else if (nextIdx >= 0) {
      // 只有 next，相对偏移
      out[i].timestamp = messages[nextIdx].timestamp - (nextIdx - i);
    }
    // 双侧都 null → 保持 null
  }
  return out;
}

// ── formatMessage（跟 gpt-prompt.ts 一致） ──
function formatMessage(msg, isGroup, formatTs) {
  const ts = formatTs(msg.timestamp);
  let role;
  const isAd = isSalesPitch(msg.text);
  if (msg.fromMe) {
    role = isAd
      ? 'Sales (AD COPY — marketing pitch, NOT a price offer or customer budget)'
      : 'Sales (you, Miles)';
  } else if (isGroup) {
    role = msg.sender ? `Member (${msg.sender})` : 'Member';
  } else {
    role = isAd
      ? "Customer (FB AD AUTO-MSG — Facebook lead-form template, NOT the customer's own words or budget)"
      : 'Customer';
  }
  return `[${ts}] ${role}: ${msg.text}`;
}

// ── 构造 [New Messages] section（模拟 buildFollowUpMessage） ──
function buildSection(messages, planName) {
  // messages 已经按 sent_at NULLS FIRST 排过（跟 production mergeDomWithDbMessages 行为一致）
  let arr = messages;
  let formatTs = formatTimestampCurrent;
  if (planName === 'planA') {
    formatTs = formatTimestampPlanA;
  } else if (planName === 'planB') {
    arr = fillNullTimestampsByNeighbor(messages);
    formatTs = formatTimestampPlanA; // 仍然兜底显示 ??-??（极端 case 全 null）
  }
  const collapsed = collapseMediaRuns(arr).slice(-50);
  const lines = [`[New Messages Since Last Reply]`];
  for (const m of collapsed) {
    const formatted = formatMessage(m, false, formatTs);
    // 单条消息内容截到 80 字符，保留 [time] role: prefix 完整
    const colonIdx = formatted.indexOf(': ');
    if (colonIdx > 0 && formatted.length > colonIdx + 80) {
      const body = formatted.slice(colonIdx + 2).replace(/\n+/g, ' ').slice(0, 75);
      lines.push(formatted.slice(0, colonIdx + 2) + body + '…');
    } else {
      lines.push(formatted.replace(/\n+/g, ' '));
    }
  }
  return lines.join('\n');
}

// ── 拉 DB ──
async function fetchMessages(contactId) {
  // 跟 production mergeDomWithDbMessages 的排序一致：sent_at 升序，NULL 排最前
  const url = `${SUPABASE_URL}/rest/v1/messages?contact_id=eq.${contactId}&select=wa_message_id,direction,text,sent_at,synced_at&order=sent_at.asc.nullsfirst`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    id: r.wa_message_id,
    fromMe: r.direction === 'outbound',
    text: r.text,
    timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
    sender: null,
  }));
}

async function fetchContact(contactId) {
  const url = `${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}&select=name,wa_name,phone,country`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
  const rows = await res.json();
  return rows[0];
}

// ── 主流程 ──
const samples = [
  { id: 'af76e0cb-88ed-4850-89df-d0f81f61d258', label: 'Samuel - album+PDF+text mix' },
  { id: '024e797f-efe1-47e6-b2d0-b6f884438e79', label: 'Ferdinand - PDF at top' },
  { id: '58459a8d-d0c5-4fb1-aa08-fe8c0dfc0e99', label: 'Carlos - 4 consecutive NULL' },
  { id: '023c3c59-599c-4177-8d23-8b927f84f65a', label: 'prophet elijah - just FB ad placeholder' },
  // 回归测试：完全没 NULL sent_at 的 contact，三种方案输出应该一模一样
  { id: '0efab9d2-61e6-4b4c-bf84-c17db09f45df', label: 'CLEAN - 21 messages, no NULL (regression test)' },
];

const plans = ['current', 'planA', 'planB'];

for (const sample of samples) {
  const contact = await fetchContact(sample.id);
  const messages = await fetchMessages(sample.id);
  const nullCount = messages.filter((m) => m.timestamp == null).length;
  console.log('\n' + '='.repeat(80));
  console.log(`# ${sample.label}`);
  console.log(`  contact: ${contact.name || contact.wa_name} (${contact.phone}, ${contact.country})`);
  console.log(`  total messages: ${messages.length}, NULL sent_at: ${nullCount}`);
  console.log('='.repeat(80));

  for (const plan of plans) {
    console.log('\n' + '-'.repeat(80));
    console.log(`### Plan: ${plan}`);
    console.log('-'.repeat(80));
    const section = buildSection(messages, plan);
    // Truncate per-line for readability — preserve structure, cap each msg to 100 chars
    const truncated = section
      .split('\n')
      .map((line) => (line.length > 200 ? line.slice(0, 197) + '...' : line))
      .join('\n');
    console.log(truncated);
  }
}

console.log('\n' + '='.repeat(80));
console.log('Done.');
console.log('='.repeat(80));
