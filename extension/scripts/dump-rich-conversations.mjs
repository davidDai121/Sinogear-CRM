#!/usr/bin/env node
/**
 * Dump 所有 outbound>=5 && inbound>=5 的 contact 的对话到 markdown 文件。
 * 用于人工 review 销售回复风格。
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORG_ID } = process.env;
if (!VITE_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ORG_ID) {
  console.error('缺 env');
  process.exit(1);
}

const sb = createClient(VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
async function fetchAllPaged(query) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

console.log('拉 contacts + messages + vehicle_interests...');
const [contacts, messages, vehicleInterests] = await Promise.all([
  fetchAllPaged(
    sb
      .from('contacts')
      .select('id, phone, name, wa_name, country, language, budget_usd, customer_stage, quality, notes, destination_port, group_jid')
      .eq('org_id', ORG_ID),
  ),
  fetchAllPaged(
    sb
      .from('messages')
      .select('contact_id, direction, text, sent_at'),
  ),
  fetchAllPaged(
    sb
      .from('vehicle_interests')
      .select('contact_id, model, year, condition, target_price_usd'),
  ),
]);

const contactById = new Map(contacts.map((c) => [c.id, c]));
const interestsByContact = new Map();
for (const vi of vehicleInterests) {
  let arr = interestsByContact.get(vi.contact_id);
  if (!arr) { arr = []; interestsByContact.set(vi.contact_id, arr); }
  arr.push(vi);
}

const msgsByContact = new Map();
for (const m of messages) {
  if (!contactById.has(m.contact_id)) continue;
  let arr = msgsByContact.get(m.contact_id);
  if (!arr) { arr = []; msgsByContact.set(m.contact_id, arr); }
  arr.push(m);
}

// Sort 每个 contact 的 messages by sent_at asc
for (const arr of msgsByContact.values()) {
  arr.sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
}

// 筛 qualified
const THRESHOLD = 5;
const qualified = [];
for (const [cid, arr] of msgsByContact) {
  const inbound = arr.filter((m) => m.direction === 'inbound').length;
  const outbound = arr.filter((m) => m.direction === 'outbound').length;
  if (inbound >= THRESHOLD && outbound >= THRESHOLD) {
    qualified.push({ cid, inbound, outbound, total: arr.length, msgs: arr });
  }
}

// 按总消息数降序
qualified.sort((a, b) => b.total - a.total);

console.log(`合格 contact: ${qualified.length}`);

// ── 媒体占位识别 + collapse 连续媒体 ──
function isMediaOnly(text) {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (t === '[媒体]' || t === '<媒体>' || t === '[图片]') return true;
  if (/^‎?(IMG|VID|VIDEO|AUD|AUDIO|DOC|PTT|STK|PHOTO|GIF)[-_].+?\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|opus|m4a|mp3|pdf|docx?|xlsx?|pptx?)\s*\(文件附件\)$/i.test(t))
    return true;
  return false;
}

function collapseMediaRuns(msgs) {
  const result = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const n = run.length;
    result.push({
      direction: first.direction,
      text: n === 1 ? '[图片/媒体]' : `[图片/媒体 × ${n}]`,
      sent_at: last.sent_at,
    });
    run = [];
  };
  for (const m of msgs) {
    if (isMediaOnly(m.text)) {
      if (run.length === 0 || run[run.length - 1].direction === m.direction) {
        run.push(m);
      } else {
        flush();
        run.push(m);
      }
    } else {
      flush();
      result.push(m);
    }
  }
  flush();
  return result;
}

function fmtTs(s) {
  const d = new Date(s);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 写 markdown ──
const out = [];
out.push('# Rich Conversations — outbound≥5 ∧ inbound≥5');
out.push('');
out.push(`Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
out.push(`Total: ${qualified.length} contacts`);
out.push('');
out.push('Index: ' + qualified.map((q, i) => {
  const c = contactById.get(q.cid);
  const name = c?.name?.trim() || c?.wa_name?.trim() || `(unnamed)`;
  return `${i + 1}.${name}`;
}).slice(0, 50).join(' | ') + (qualified.length > 50 ? ` | ... (+${qualified.length - 50} more)` : ''));
out.push('');
out.push('---');
out.push('');

for (let idx = 0; idx < qualified.length; idx++) {
  const q = qualified[idx];
  const c = contactById.get(q.cid);
  const name = c?.name?.trim() || c?.wa_name?.trim() || '(unnamed)';
  const country = c?.country || '(no country)';
  const lang = c?.language || '(no lang)';
  const stage = c?.customer_stage || '(no stage)';
  const budget = c?.budget_usd ? `$${c.budget_usd}` : '(no budget)';
  const port = c?.destination_port || '(no port)';
  const notes = c?.notes?.trim() || '';
  const vis = interestsByContact.get(q.cid) || [];

  out.push(`## #${idx + 1} — ${name}`);
  out.push('');
  out.push(`- Phone: ${c?.phone || '(group/none)'}`);
  out.push(`- Country: ${country} | Language: ${lang} | Stage: ${stage}`);
  out.push(`- Budget: ${budget} | Port: ${port}`);
  if (notes) out.push(`- Notes: ${notes}`);
  if (vis.length) {
    out.push(`- Interests: ${vis.map((v) => `${v.model}${v.year ? ' ' + v.year : ''}${v.condition ? ' ' + v.condition : ''}${v.target_price_usd ? ' @ $' + v.target_price_usd : ''}`).join(' | ')}`);
  }
  out.push(`- Msgs: ${q.total} (inbound ${q.inbound} / outbound ${q.outbound})`);
  out.push('');

  const collapsed = collapseMediaRuns(q.msgs);
  for (const m of collapsed) {
    const role = m.direction === 'inbound' ? 'Customer' : '**Sales**';
    const text = (m.text ?? '').replace(/\n/g, ' ⏎ ');
    out.push(`[${fmtTs(m.sent_at)}] ${role}: ${text}`);
  }
  out.push('');
  out.push('---');
  out.push('');
}

const path = resolve(__dirname, '..', '..', 'rich-conversations.md');
writeFileSync(path, out.join('\n'), 'utf-8');
console.log(`写入: ${path}`);
console.log(`大小: ${(out.join('\n').length / 1024).toFixed(1)} KB`);
