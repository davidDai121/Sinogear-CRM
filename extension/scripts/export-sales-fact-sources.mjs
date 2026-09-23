// Read-only source inventory. Run from extension/; credentials never enter output.
import fs from 'node:fs';
import { parse } from 'dotenv';
import { execFileSync } from 'node:child_process';
const env = parse(fs.readFileSync('.env'));
const out = '../分析导出/事实库_2026-09-18';
fs.mkdirSync(out, { recursive: true });
const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
async function getAll(table, params) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${table}?${new URLSearchParams({ ...params, order: 'id', limit: '500', offset: String(offset) })}`, { headers });
    if (!r.ok) throw Error(`${table}: ${r.status} ${(await r.text()).slice(0, 250)}`);
    const page = await r.json(); rows.push(...page);
    if (page.length < 500) return rows;
  }
}
const [templates, vehicles] = await Promise.all([
  getAll('gpt_templates', { select: 'id,org_id,name,description,updated_at', org_id: 'eq.' + env.ORG_ID }),
  getAll('vehicles', { select: 'id,org_id,brand,model,version,fuel_type,base_price,currency,short_spec,pricing_tiers,sale_status,updated_at', org_id: 'eq.' + env.ORG_ID }),
]);
fs.writeFileSync(`${out}/模板与车源快照.json`, JSON.stringify({ templates, vehicles }, null, 2));
let token = execFileSync('security', ['find-generic-password', '-s', 'Supabase CLI', '-w'], { encoding: 'utf8' }).trim();
if (token.startsWith('go-keyring-base64:')) token = Buffer.from(token.slice(18), 'base64').toString();
const ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
if (!/^[a-f0-9-]+$/i.test(env.ORG_ID)) throw Error('Invalid org');
const rows = [];
for (let offset = 0; ; offset += 500) {
  const query = `SELECT e.id,e.contact_id,e.created_at,e.payload,c.phone,c.name,c.country,c.destination_port
FROM public.contact_events e JOIN public.contacts c ON c.id=e.contact_id
WHERE c.org_id='${env.ORG_ID}' AND e.event_type='ai_extracted'
AND (e.payload->>'schema' IN ('sales-history.v1','quote-calculation.v1')
 OR (e.payload->>'schema'='sales-work.v1' AND e.payload->>'kind' IN ('sales_instruction','sales_discussion','freight_lookup')))
ORDER BY e.id LIMIT 500 OFFSET ${offset}`;
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!r.ok) throw Error((await r.text()).slice(0, 350));
  const page = await r.json(); rows.push(...page);
  if (page.length < 500) break;
}
fs.writeFileSync(`${out}/销售指导与运费来源.json`, JSON.stringify(rows, null, 2));
console.log(JSON.stringify({ templates: templates.length, vehicles: vehicles.length, sourceEvents: rows.length,
  kinds: rows.reduce((a, x) => { const k = x.payload.kind || x.payload.schema; a[k] = (a[k] || 0) + 1; return a; }, {}) }));
