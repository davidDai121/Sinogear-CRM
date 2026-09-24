// 把 wa_webhook_failures 里留底的载荷重新喂给 wa-cloud-webhook（修完解析 bug 后补录用）。
// 去重靠 (contact_id, wa_message_id)，重放多少次都不会重复。成功的行删除，失败的留着。
//   node scripts/replay-wa-webhook-failures.mjs          只看会重放多少
//   node scripts/replay-wa-webhook-failures.mjs --apply  真的重放
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.VITE_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.WA_PATH_SECRET;
if (!SECRET) throw new Error('需要环境变量 WA_PATH_SECRET');
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };
const apply = process.argv.includes('--apply');
const hook = `${U}/functions/v1/wa-cloud-webhook/${SECRET}`;

async function all() {
  const out = [];
  for (let from = 0; ; from += 500) {
    const r = await fetch(`${U}/rest/v1/wa_webhook_failures?select=id,kind,phone,payload&order=id`, { headers: { ...H, Range: `${from}-${from + 499}` } });
    const rows = await r.json(); out.push(...rows); if (rows.length < 500) return out;
  }
}

// 跳过的单条消息没有外层信封：按「隐藏号码客户发来的历史消息」包回去
function envelope(row) {
  if (row.kind === 'batch_failed') return row.payload;
  const m = row.payload;
  const uid = m.from_user_id ?? m.to_user_id;
  const pnid = pnidOf.get(row.phone);
  if (!uid || !row.phone || !pnid) return null;
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'history', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: row.phone.replace('+', ''), phone_number_id: pnid },
    history: [{ threads: [{ id: uid, messages: [m] }] }],
  } }] }] };
}

const numbers = await (await fetch(`${U}/rest/v1/wa_business_numbers?select=phone,phone_number_id`, { headers: H })).json();
const pnidOf = new Map(numbers.map((n) => [n.phone, n.phone_number_id]));
const rows = await all();
const plan = rows.map((r) => ({ r, body: envelope(r) }));
console.log(`共 ${rows.length} 行：可重放 ${plan.filter((p) => p.body).length}，无法重放 ${plan.filter((p) => !p.body).length}`);
if (!apply) process.exit(0);

let ok = 0, bad = 0;
const done = [];
for (const { r, body } of plan) {
  if (!body) continue;
  const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) { ok++; done.push(r.id); } else { bad++; }
}
for (let i = 0; i < done.length; i += 100) {
  await fetch(`${U}/rest/v1/wa_webhook_failures?id=in.(${done.slice(i, i + 100).join(',')})`, { method: 'DELETE', headers: H });
}
console.log(`重放成功 ${ok}，失败 ${bad}（失败的仍留在表里）`);
