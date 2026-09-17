// Read-only, org-scoped export for the user-authorized sales skill evaluation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'extension/package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(root, 'extension/.env')));
const end = process.argv[2] || '2026-09-17T14:30:30.000Z';
const start = new Date(new Date(end).getTime() - 7 * 86400000).toISOString();
const owner = 'ecca2247-1490-41e1-b52b-8ac962df25b7'; // Owner of the user's verified R08 template.
const outdir = path.join(root, '分析导出/销售技能一周验证_2026-09-17');
fs.mkdirSync(outdir, { recursive: true });
const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const requests = [];
async function all(table, select, filters = {}, order = 'id') {
  const result = []; let expected = null;
  for (let offset = 0; ; offset += 500) {
    const u = new URL(`/rest/v1/${table}`, env.VITE_SUPABASE_URL);
    u.searchParams.set('select', select); u.searchParams.set('order', order);
    for (const [key, value] of Object.entries(filters)) u.searchParams.set(key, value);
    const response = await fetch(u, { headers: { ...headers, Range: `${offset}-${offset+499}`, Prefer: 'count=exact' } });
    if (!response.ok) throw new Error(`${table} HTTP ${response.status}`);
    const contentRange = response.headers.get('content-range');
    const total = Number(contentRange?.split('/')[1]);
    if (expected === null && Number.isFinite(total)) expected = total;
    const rows = await response.json(); result.push(...rows);
    if (rows.length < 500) break;
  }
  requests.push({ table, select, filters, order, expected, fetched: result.length });
  if (expected !== null && expected !== result.length) throw new Error(`${table} count changed: ${expected} vs ${result.length}`);
  return result;
}
function save(name, value) { fs.writeFileSync(path.join(outdir, name), JSON.stringify(value, null, 2)); }
const templates = await all('gpt_templates', 'id,name,created_by', { org_id:`eq.${env.ORG_ID}`, created_by:`eq.${owner}` });
const conversations = await all('gpt_conversations', 'id,contact_id,template_id,chat_url,last_used_at,created_at,contacts!inner(id,name,wa_name,phone,country,destination_port,customer_stage,quality),gpt_templates!inner(name,created_by,org_id)', { 'contacts.org_id':`eq.${env.ORG_ID}`, 'gpt_templates.org_id':`eq.${env.ORG_ID}`, 'gpt_templates.created_by':`eq.${owner}` });
const handlers = await all('contact_handlers', 'contact_id,user_id,contacts!inner(id)', { user_id:`eq.${owner}`, 'contacts.org_id':`eq.${env.ORG_ID}` }, 'contact_id');
const created = await all('contacts', 'id', { org_id:`eq.${env.ORG_ID}`, created_by:`eq.${owner}` });
const ids = [...new Set([...handlers.map(x=>x.contact_id), ...created.map(x=>x.id), ...conversations.map(x=>x.contact_id)])];
save('templates.json',templates);save('gpt-conversations-all.json',conversations);
const weekConversations=conversations.filter(x=>Date.parse(x.last_used_at)>=Date.parse(start)&&Date.parse(x.last_used_at)<=Date.parse(end));
save('gpt-week-index.json',weekConversations);
const groups = [
  { name:'created', embed:'contacts!inner(id)', filters:{'contacts.created_by':`eq.${owner}`} },
  { name:'assigned', embed:'contacts!inner(id,contact_handlers!inner(user_id))', filters:{'contacts.contact_handlers.user_id':`eq.${owner}`} },
];
const messagesById=new Map(),undatedById=new Map();
async function loadMessages(embed, filters) {
  for(const [target, extra] of [[messagesById,{and:`(sent_at.gte.${start},sent_at.lte.${end})`}],[undatedById,{sent_at:'is.null',and:`(synced_at.gte.${start},synced_at.lte.${end})`}]]) {
    for(const m of await all('messages',`id,contact_id,direction,text,sent_at,synced_at,wa_message_id,ai_source,${embed}`,{'contacts.org_id':`eq.${env.ORG_ID}`,...filters,...extra},'id')) target.set(m.id,m);
  }
}
for(const group of groups){await loadMessages(group.embed,group.filters);console.log(`${group.name}: dated ${messagesById.size}, undated ${undatedById.size}`);}
const directlyOwned=new Set([...handlers.map(x=>x.contact_id),...created.map(x=>x.id)]);
const extraIds=[...new Set(conversations.map(x=>x.contact_id))].filter(id=>!directlyOwned.has(id));
for(let i=0;i<extraIds.length;i+=80) await loadMessages('contacts!inner(id)',{contact_id:`in.(${extraIds.slice(i,i+80).join(',')})`});
const messages=[...messagesById.values()],undated=[...undatedById.values()];
const activeIds=new Set(messages.map(x=>x.contact_id));
const browserCandidates=conversations.filter(x=>activeIds.has(x.contact_id)||weekConversations.some(y=>y.id===x.id));
const neededIds=[...new Set([...messages.map(x=>x.contact_id),...undated.map(x=>x.contact_id),...weekConversations.map(x=>x.contact_id)])];
const contacts=[],quotes=[];
for(let i=0;i<neededIds.length;i+=80){
 const filter=`in.(${neededIds.slice(i,i+80).join(',')})`;
 contacts.push(...await all('contacts','id,name,wa_name,phone,group_jid,country,language,destination_port,budget_usd,customer_stage,quality,notes,created_by',{org_id:`eq.${env.ORG_ID}`,id:filter}));
 quotes.push(...await all('quotes','id,contact_id,vehicle_model,price_usd,status,sent_at,contacts!inner(id)',{contact_id:filter,'contacts.org_id':`eq.${env.ORG_ID}`,and:`(sent_at.gte.${start},sent_at.lte.${end})`},'sent_at,id'));
}
save('templates.json',templates);save('gpt-conversations-all.json',conversations);save('gpt-week-index.json',weekConversations);
save('gpt-browser-candidates.json',browserCandidates);save('contacts.json',contacts);save('messages.json',messages);save('undated-synced.json',undated);save('quotes.json',quotes);
const manifest={exported_at:new Date().toISOString(),window:{start,end,timezone:'UTC',definition:'rolling 168 hours; inclusive bounds'},scope:{org_id:env.ORG_ID,owner,method:'contacts assigned to owner, created by owner, or associated with owner GPT templates; shared contacts may include team messages'},counts:{contacts:contacts.length,active_contacts:activeIds.size,messages:messages.length,undated_synced:undated.length,quotes:quotes.length,gpt_index_total:conversations.length,gpt_index_week:weekConversations.length,gpt_browser_candidates:browserCandidates.length},limits:['Database coverage is not all WhatsApp history.','synced_at is not a substitute for sent_at; undated messages kept separately.','GPT last_used_at only describes recorded CRM use, not all manual ChatGPT activity.','GPT indexes are links, not proof of having read the conversations.'],requests};
save('manifest.json',manifest);console.log(JSON.stringify({window:manifest.window,counts:manifest.counts,outdir}));
