import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
async function moduleOf(path){const b=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);}
const f=await moduleOf('src/lib/gpt-followup.ts');
const {runDueFollowup}=await moduleOf('src/lib/gpt-followup-runner.ts');
let browserBindings={};
globalThis.chrome={storage:{local:{get:async key=>({[key]:browserBindings[key]})}}};
const NOW=Date.parse('2026-09-17T18:00:00Z');
const decision=(over={})=>({decision:'review',title:'确认采购进度',reason:'客户约定明天讨论',dueAt:'2026-09-18T18:00:00Z',timeBasis:'customer',evidence:[{id:'message:m',quote:'tomorrow'}],existingTaskId:null,...over});
const encode=d=>`<crm_followup>${JSON.stringify(d)}</crm_followup>`;
function store(){
 const tables={contacts:[{id:'c',org_id:'org'},{id:'other',org_id:'foreign'}],tasks:[],contact_events:[],messages:[{id:'m',contact_id:'c',direction:'inbound',text:'Call me tomorrow',sent_at:'2026-09-17T17:00:00Z'}],gpt_templates:[{id:'template',org_id:'org',gpt_url:'https://chatgpt.com/?model=gpt-5-thinking',description:null}]};
 const db={tables,fail:null,writes:[],beforeWrite:null,auth:{getUser:async()=>({data:{user:{id:'user'}}})},from(table){let filters=[],sorts=[],range=[0,Infinity],one=false,op='select',payload;
 const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(k,v){return q.eq(k,v);},contains(k,v){filters.push(r=>Object.entries(v).every(([a,b])=>r[k]?.[a]===b));return q;},order(k,o){sorts.push([k,o?.ascending!==false]);return q;},range(a,b){range=[a,b];return q;},limit(n){range=[0,n-1];return q;},single(){one=true;return q;},insert(x){op='insert';payload=structuredClone(x);return q;},update(x){op='update';payload=x;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
 if(db.fail?.(table,op,payload))return{data:null,error:{message:'offline'}};
 if(op!=='select')db.beforeWrite?.(table,op,payload);
 if(op==='insert'){if(tables[table].some(r=>r.id===payload.id))return{data:null,error:{code:'23505',message:'duplicate'}};const r={created_at:new Date(NOW+db.writes.length*10).toISOString(),...payload};tables[table].push(r);db.writes.push({table,op,payload});return{data:[structuredClone(r)],error:null};}
 let rows=tables[table].filter(r=>filters.every(fn=>fn(r)));if(op==='update'){rows.forEach(r=>Object.assign(r,payload));db.writes.push({table,op,payload});}
 rows.sort((a,b)=>{for(const[k,asc]of sorts)if(a[k]!==b[k])return(a[k]<b[k]?-1:1)*(asc?1:-1);return 0;});rows=rows.slice(range[0],range[1]+1);return{data:structuredClone(one?rows[0]??null:rows),error:null};}).then(resolve,reject);}};return q;}};return db;
}
const context=db=>f.loadFollowupContext(db,'org','c');
test('shared owner instructions are referenced only for exact identity, scope and text; validation keeps originals',async()=>{
 const c=await context(store());
 const text='本单已批准一年三大件保修，轮胎包两千美元。'.repeat(80);
 c.evidence.push({id:'owner:approval',role:'owner',text,at:null});
 const memory={contactId:'c',scopeId:c.scopeId,label:'当前需求',tasks:[],entries:[{id:'approval',kind:'sales_instruction',text,scopeId:c.scopeId,at:'2026-09-17T17:00:00Z'}]};
 const full=f.followupPrompt(c),slim=f.followupPrompt(c,{includedWorkMemory:memory});
 assert.ok(slim.length<full.length-800);assert.match(slim,/fullTextRef/);
 assert.equal(c.evidence.at(-1).text,text);
 assert.doesNotThrow(()=>f.extractFollowup(encode(decision({evidence:[{id:'owner:approval',quote:text.slice(-100)}],timeBasis:'owner'})),c,NOW));
 for(const wrong of [{...memory,contactId:'foreign'},{...memory,scopeId:'old'}, {...memory,entries:[{...memory.entries[0],id:'other'}]}, {...memory,entries:[{...memory.entries[0],text:text+' changed'}]}]) {
   assert.ok(f.followupPrompt(c,{includedWorkMemory:wrong}).includes(JSON.stringify(text)));
 }
 assert.ok(full.includes(JSON.stringify(text)), 'standalone follow-up retains complete evidence');
});
test('customer notes dedupe requires the complete same notes; current tasks and previous protection survive',async()=>{
 const c=await context(store());const notes='客户要求下个月再联系，不改人工日期。'.repeat(100);
 c.customer.notes=notes;c.tasks=[{id:'manual',title:'人工安排',due_at:'2026-10-01T12:00:00Z',status:'open'}];
 c.previous={decision:decision(),protected:true,unchangedReviews:2,evaluatedAt:'2026-09-17T17:00:00Z',phase:'applied',before:{internal:'old-row'},after:{internal:'new-row'},inputKey:'private-state-hash'};
 const slim=f.followupPrompt(c,{includedCustomerNotes:notes});
 assert.ok(!slim.includes(JSON.stringify(notes)));assert.match(slim,/Full sales notes/);
 assert.ok(f.followupPrompt(c,{includedCustomerNotes:notes.slice(0,200)}).includes(JSON.stringify(notes)));
 assert.ok(f.followupPrompt(c,{includedCustomerNotes:null}).includes(JSON.stringify(notes)), 'group continuation keeps notes when main prompt did not render them');
 assert.match(slim,/人工安排/);assert.match(slim,/"protected":true/);assert.match(slim,/"unchangedReviews":2/);
 assert.ok(!slim.includes('private-state-hash'));assert.equal(c.customer.notes,notes);
});
const save=(db,ctx,d=decision(),bg=false)=>f.saveFollowup(db,ctx,d,'template','https://chatgpt.com/c/test',bg);
async function initial(db,d=decision()){await save(db,await context(db),d);return context(db);}
test('stable task identity isolates organization/customer/demand',async()=>{const id=await f.followupTaskId('o','c','s');assert.equal(id,await f.followupTaskId('o','c','s'));for(const args of [['x','c','s'],['o','x','s'],['o','c','x']])assert.notEqual(id,await f.followupTaskId(...args));});
test('real evidence, timezone, completion source and unique block are mandatory',async()=>{const c=await context(store());assert.equal(f.extractFollowup('内部判断\n'+encode(decision()),c,NOW).text,'内部判断');for(const d of [decision({evidence:[{id:'draft:x',quote:'tomorrow'}]}),decision({evidence:[{id:'message:m',quote:'paid'}]}),decision({dueAt:'2026-09-18T12:00:00'}),decision({timeBasis:'owner'}),decision({decision:'done',dueAt:null,timeBasis:'none'})])assert.throws(()=>f.extractFollowup(encode(d),c,NOW));assert.throws(()=>f.extractFollowup(encode(decision())+encode(decision()),c,NOW));});
test('GPT can choose a justified review time; waiting need not invent one',async()=>{const c=await context(store());assert.equal(f.extractFollowup(encode(decision({timeBasis:'gpt'})),c,NOW).decision.timeBasis,'gpt');assert.equal(f.extractFollowup(encode(decision({decision:'wait',dueAt:null,timeBasis:'none'})),c,NOW).decision.dueAt,null);});
test('repeated interactions update one task and preserve decision history',async()=>{const db=store();await save(db,await initial(db),decision({title:'确认最终台数'}));assert.equal(db.tables.tasks.length,1);assert.match(db.tables.tasks[0].title,/最终台数/);assert.equal(db.tables.contact_events.length,4);assert.equal((await context(db)).previous.phase,'applied');});
test('manual dates, title, completion, cancellation, pause and deletion survive AI updates',async()=>{for(const edit of [t=>t.due_at='2026-10-01T18:00:00Z',t=>t.title='人工任务',t=>t.status='done',t=>t.status='cancelled',t=>t.due_at=null]){const db=store();await initial(db);edit(db.tables.tasks[0]);const before=structuredClone(db.tables.tasks[0]);await save(db,await context(db),decision({title:'模型想覆盖'}));assert.deepEqual(db.tables.tasks[0],before);}const db=store();await initial(db);db.tables.tasks=[];await save(db,await context(db));assert.equal(db.tables.tasks.length,0);});
test('manual reversion to a previous AI value is also protected',async()=>{const db=store();await initial(db);const before=structuredClone(db.tables.tasks[0]);await save(db,await context(db),decision({title:'第二版'}));db.tables.tasks[0]=before;const p=await save(db,await context(db));assert.equal(p.protected,true);});
test('new messages or manual edits during generation prevent stale saving',async()=>{for(const change of [db=>db.tables.messages[0].text='Now I want two',db=>db.tables.tasks[0].due_at=null]){const db=store();const c=await initial(db);change(db);const n=db.writes.length;await assert.rejects(save(db,c),/有更新/);assert.equal(db.writes.length,n);}});
test('existing manual task suppresses duplicate without taking control',async()=>{const db=store();db.tables.tasks.push({id:'manual',org_id:'org',contact_id:'c',title:'联系客户',status:'open',due_at:null,created_by:'user'});const p=await save(db,await context(db),decision({existingTaskId:'manual'}));assert.equal(p.protected,true);assert.equal(db.tables.tasks.length,1);});
test('journal failure makes no task; failed projection retries without duplicates',async()=>{const db=store();const c=await context(db);db.fail=(t,o)=>t==='contact_events'&&o==='insert';await assert.rejects(save(db,c));assert.equal(db.tables.tasks.length,0);db.fail=(t,o)=>t==='tasks'&&o==='insert';await assert.rejects(save(db,c));db.fail=null;await save(db,await context(db));assert.equal(db.tables.tasks.length,1);});
test('CAS protects an edit arriving after validation but before task update',async()=>{const db=store();const c=await initial(db);db.beforeWrite=(t,o)=>{if(t==='tasks'&&o==='update')db.tables.tasks[0].status='done';};await assert.rejects(save(db,c,decision({title:'新任务'})),/尚未更新/);assert.equal(db.tables.tasks[0].status,'done');});
test('due/new message triggers review, unsent drafts do not; manual pause and completion skip',async()=>{const db=store();let c=await initial(db);assert.equal(f.needsFollowupReview(c,NOW),false);assert.equal(f.needsFollowupReview(c,NOW+86400001),true);db.tables.contact_events.push({id:'draft',contact_id:'c',event_type:'ai_extracted',payload:{schema:'sales-work.v1',scopeId:'c',kind:'assistant_draft',text:'I sent it'},created_at:'2026-09-17T19:00:00Z'});assert.equal(f.needsFollowupReview(await context(db),NOW),false);db.tables.messages[0].text='I am ready';assert.equal(f.needsFollowupReview(await context(db),NOW),true);db.tables.tasks[0].due_at=null;assert.equal(f.needsFollowupReview(await context(db),NOW),false);db.tables.tasks[0].status='done';assert.equal(f.needsFollowupReview(await context(db),NOW),false);});
test('unchanged silent reviews end in condition waiting',async()=>{const db=store();await save(db,await initial(db),decision(),true);const p=await save(db,await context(db),decision(),true);assert.equal(p.decision.decision,'wait');assert.equal(db.tables.tasks[0].due_at,null);});
test('cross-org access fails; pagination retains over 200 tasks for deduplication',async()=>{const db=store();await assert.rejects(f.loadFollowupContext(db,'org','other'),/组织/);for(let i=0;i<205;i++)db.tables.tasks.push({id:`t${i}`,org_id:'org',contact_id:'c',title:'人工',status:'open',due_at:null});assert.equal((await context(db)).tasks.length,205);});
test('scheduler uses latest evidence, updates only the managed task and never sends',async()=>{const db=store();await initial(db,decision({dueAt:'2026-09-17T17:30:00Z'}));let calls=0;const next=await runDueFollowup(db,async opts=>{calls++;assert.match(opts.prompt,/Call me tomorrow/);assert.match(opts.prompt,/不自动发送/);assert.match(opts.prompt,/不查运费/);return{responseText:encode(decision({decision:'wait',dueAt:null,timeBasis:'none'})),chatUrl:'https://chatgpt.com/c/test'};},{},NOW);assert.equal(calls,1);assert.equal(db.tables.tasks[0].due_at,null);assert.equal(next.lastError,undefined);});
test('disabling background reviews during preparation prevents GPT dispatch and preserves tasks',async()=>{
 for(const stopAt of [1,2,3]){
  const db=store();await initial(db,decision({dueAt:'2026-09-17T17:30:00Z'}));
  const before=structuredClone(db.tables);let checks=0,calls=0;
  const next=await runDueFollowup(db,async()=>{calls++;throw Error('must not dispatch');},{},NOW,async()=>++checks<stopAt);
  assert.equal(checks,stopAt);assert.equal(calls,0);assert.deepEqual(db.tables,before);assert.equal(next.lastError,undefined);
 }
});
test('scheduler failures back off and preserve task; new evidence permits retry',async()=>{const db=store();await initial(db,decision({dueAt:'2026-09-17T17:30:00Z'}));const before=structuredClone(db.tables.tasks);let calls=0;const run=async()=>{calls++;throw Error('GPT logged out');};let s=await runDueFollowup(db,run,{},NOW);s=await runDueFollowup(db,run,s,NOW+60000);assert.equal(calls,1);assert.deepEqual(db.tables.tasks,before);assert.match(s.lastError,/logged out/);db.tables.messages[0].text='New detail';await runDueFollowup(db,run,s,NOW+120000);assert.equal(calls,2);});
test('internal block cannot be accepted inside customer reply',async()=>{const c=await context(store());assert.throws(()=>f.extractFollowup('[WhatsApp Reply]\nHello '+encode(decision())+'\n[Full Translation & Strategy]内部',c,NOW),/客户正文/);});
test('manual future date is respected, then due review records advice without moving date',async()=>{const db=store();await initial(db);db.tables.tasks[0].due_at='2026-09-20T18:00:00Z';let c=await context(db);assert.equal(f.needsFollowupReview(c,NOW),false);assert.equal(f.needsFollowupReview(c,NOW+4*86400000),true);const p=await save(db,c,decision({decision:'wait',dueAt:null,timeBasis:'none'}),true);assert.equal(p.protected,true);assert.equal(db.tables.tasks[0].due_at,'2026-09-20T18:00:00Z');assert.equal(f.needsFollowupReview(await context(db),NOW+4*86400000),false);});
test('different current demand prevents old plan from being reviewed',async()=>{const db=store();await initial(db);db.tables.contact_events.push({id:'scope-new',contact_id:'c',event_type:'ai_extracted',payload:{schema:'sales-work.v1',kind:'scope',scopeId:'new',text:'新需求'},created_at:'2026-09-18T19:00:00Z'});assert.equal(f.needsFollowupReview(await context(db),NOW+3*86400000),false);let called=false;await runDueFollowup(db,async()=>{called=true;throw Error('must not run');},{},NOW+3*86400000);assert.equal(called,false);});
test('switching CRM user while GPT is running rejects the old save',async()=>{const db=store();const c=await initial(db);db.auth.getUser=async()=>({data:{user:{id:'another-user'}}});await assert.rejects(save(db,c),/有更新/);assert.equal(db.tables.tasks[0].created_by,'user');});

test('scheduler skips another browser private GPT without changing its task',async()=>{
 const db=store();await initial(db,decision({dueAt:'2026-09-17T17:30:00Z'}));
 const before=structuredClone(db.tables.tasks);let calls=0;
 browserBindings={'gptBrowserBinding:org:user':{defaultTemplateId:'yang',r08TemplateId:'yang-r08'}};
 try{const next=await runDueFollowup(db,async()=>{calls++;throw Error('wrong account');},{},NOW);assert.equal(calls,0);assert.equal(next.lastError,undefined);assert.deepEqual(db.tables.tasks,before);}
 finally{browserBindings={};}
});
