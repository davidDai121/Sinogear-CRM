/** Owner-authorized archival import. Does not change stages, tasks, quotes or messages.
 * Run without --apply first; apply requires exact reviewed plan checksum. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.cwd();
const folder = path.join(root,'分析导出/销售技能一周验证_2026-09-17');
const out = path.join(root,'分析导出/历史指导回填_2026-09-17');fs.mkdirSync(out,{recursive:true});
const env = Object.fromEntries(fs.readFileSync(path.join(root,'extension/.env'),'utf8').split('\n').filter(l=>l.trim()&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
async function rest(table,query,options={}){const r=await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${table}?${new URLSearchParams(query)}`,{...options,headers:{...headers,...options.headers}});if(!r.ok)throw new Error(`${table}: HTTP ${r.status}`);return r.status===204?null:r.json();}
const guidance=JSON.parse(fs.readFileSync(path.join(folder,'owner-guidance.json'),'utf8'));
const index=JSON.parse(fs.readFileSync(path.join(folder,'gpt-week-index.json'),'utf8'));
const candidates=[],skipped=[];
for (const [i,g] of guidance.entries()) {
  const thread=g.thread.split('#')[0];
  const mappings=index.filter(r=>r.chat_url.split('/c/')[1]?.split(/[?#]/)[0]===thread);
  const ids=[...new Set(mappings.map(r=>r.contact_id))];
  const row=mappings[0];
  // Pre-reviewed compact owner turns only. Bulk CRM context is not an owner instruction.
  if (ids.length!==1 || !row || row.contacts.phone?.replace(/\D/g,'').endsWith('13552592187') || g.guidance.startsWith('[Current Time]') || g.guidance.includes('仅测试号码') || g.guidance.length>1800) {skipped.push({index:i,thread,reason:'unmapped/ambiguous/test/bulk_context'});continue;}
  if (/fernando/i.test(`${row.contacts.name} ${row.contacts.wa_name}`)) {skipped.push({index:i,thread,reason:'known mixed-identity history'});continue;}
  const source=JSON.parse(fs.readFileSync(path.join(folder,`gpt-reviewed/${thread}.json`),'utf8'));
  const turn=source.turns.find(t=>t.id===g.turn);
  if(!turn?.items.some(x=>x.type==='userMessage'&&x.text===g.guidance))throw new Error(`Source mismatch ${i}`);
  const hash=crypto.createHash('sha256').update(`sales-history.v1:${ids[0]}:${thread}:${g.turn}`).digest('hex');
  const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  candidates.push({id,contact_id:ids[0],event_type:'ai_extracted',payload:{schema:'sales-history.v1',sourceChatUrl:source.url,sourceThread:thread,sourceTurn:g.turn,sourceAt:new Date(g.at*1000).toISOString(),text:g.guidance,authority:'historical_salesperson_statement',scope:'source_conversation_only',status:'archived_not_current_approval',title:g.title},review:{index:i,name:row.contacts.name,phone:row.contacts.phone}});
}
// Source chronology is retained in payload; event.created_at is import time, never quote freshness.
candidates.sort((a,b)=>a.payload.sourceAt.localeCompare(b.payload.sourceAt)||a.id.localeCompare(b.id));
const checksum=crypto.createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
const plan={checksum,rows:candidates,skipped};fs.writeFileSync(path.join(out,'回填计划.json'),JSON.stringify(plan,null,2));
const contacts=[...new Set(candidates.map(x=>x.contact_id))];
for(const id of contacts){const rows=await rest('contacts',{id:`eq.${id}`,org_id:`eq.${env.ORG_ID}`,select:'id,name,phone'});if(rows.length!==1)throw new Error(`Contact not in authorized org ${id}`);}
if(!process.argv.includes('--apply')){console.log(JSON.stringify({mode:'dry-run',checksum,records:candidates.length,contacts:contacts.length,skipped:skipped.length,plan:path.join(out,'回填计划.json'),samples:[0,30,70,candidates.length-1].map(i=>candidates[i])},null,2));process.exit(0);}
if(process.argv[process.argv.indexOf('--apply')+1]!==checksum)throw new Error('Exact reviewed checksum required');
let inserted=0,reused=0;
for(const {review,...row} of candidates){
 const existing=await rest('contact_events',{id:`eq.${row.id}`,select:'id,contact_id,event_type,payload'});
 if(existing.length){if(JSON.stringify(existing[0].payload)!==JSON.stringify(row.payload)){
  const same=existing[0].contact_id===row.contact_id&&Object.entries(row.payload).every(([k,v])=>existing[0].payload[k]===v)&&Object.keys(existing[0].payload).length===Object.keys(row.payload).length;
  if(!same)throw new Error(`Existing record differs ${row.id}`);
 }reused++;continue;}
 await rest('contact_events',{}, {method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(row)});inserted++;
}
let verified=0;
for(const row of candidates){const [saved]=await rest('contact_events',{id:`eq.${row.id}`,contact_id:`eq.${row.contact_id}`,select:'id,payload'});if(!saved||!Object.entries(row.payload).every(([k,v])=>saved.payload[k]===v))throw new Error(`Readback mismatch ${row.id}`);verified++;}
const result={checksum,inserted,reused,verified,contacts:contacts.length,at:new Date().toISOString(),changedTables:['contact_events'],untouched:['contacts','tasks','quotes','messages']};fs.writeFileSync(path.join(out,'回读结果.json'),JSON.stringify(result,null,2));console.log(result);
