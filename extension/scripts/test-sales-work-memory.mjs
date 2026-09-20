import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/lib/sales-work-memory.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {loadSalesWorkMemory:load,saveSalesWorkEntry:save,renderSalesWorkMemory:render}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function store(){
 const tables={contacts:[{id:'a',org_id:'org'},{id:'b',org_id:'other'}],contact_events:[],tasks:[{id:'task1',org_id:'org',contact_id:'a',title:'等待客户确认付款方式',status:'open',due_at:null}]};
 const db={tables,fail:null,from(table){let eqs=[],contains=[],orders=[],range=[0,Infinity],one=false,insert;
 const q={select(){return q;},eq(k,v){eqs.push([k,v]);return q;},contains(k,v){contains.push([k,v]);return q;},order(k,o){orders.push([k,o?.ascending!==false]);return q;},range(a,b){range=[a,b];return q;},limit(n){range=[0,n-1];return q;},single(){one=true;return q;},insert(x){insert=x;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
  if(db.fail===table)return {data:null,error:{message:'offline'}};
  if(insert){if(tables[table].some(r=>r.id===insert.id))return{error:{code:'23505',message:'duplicate'}};
   tables[table].push({...structuredClone(insert),created_at:new Date(1700000000000+tables[table].length*1000).toISOString()});return {error:null};}
  let rows=tables[table].filter(r=>eqs.every(([k,v])=>r[k]===v)&&contains.every(([k,v])=>Object.keys(v).every(x=>r[k]?.[x]===v[x])));
  rows.sort((a,b)=>{for(const [k,asc]of orders){if(a[k]!==b[k])return (a[k]<b[k]?-1:1)*(asc?1:-1);}return 0;});rows=rows.slice(range[0],range[1]+1);
  return {data:structuredClone(one?rows[0]??null:rows),error:null};
 }).then(resolve,reject);}};return q;}};return db;
}
const entry=(id,text,kind='sales_instruction',scopeId='a')=>({id,scopeId,kind,text});
test('save/read survives a new session; retry is idempotent and draft stays unapproved',async()=>{
 const db=store();const e=entry('id1','地面费2000，保留上一版赠品');await save(db,'org','a',e);await save(db,'org','a',e);
 await save(db,'org','a',entry('id2','旧AI建议附加4000预留','assistant_draft'));
 const m=await load(db,'org','a');assert.equal(m.entries.length,2);assert.equal(m.tasks.length,1);
 assert.ok(render(m).includes('unapproved, unsent'));assert.equal(m.entries[0].text,e.text);
 await assert.rejects(save(db,'org','a',{...e,text:'changed'}),/保存/);
});
test('organization mismatch, failed reads and failed writes cannot masquerade as empty memory',async()=>{
 const db=store();await assert.rejects(load(db,'org','b'),/组织/);await assert.rejects(save(db,'org','b',entry('x','foo')),/组织/);
 db.fail='contact_events';await assert.rejects(load(db,'org','a'),/读取/);await assert.rejects(save(db,'org','a',entry('x','foo')),/保存/);
 db.fail='tasks';await assert.rejects(load(db,'org','a'),/待办/);
});
test('new demand selects its own records without deleting old demand or creating tasks',async()=>{
 const db=store();await save(db,'org','a',entry('old','旧单赠品ALPHA'));
 await save(db,'org','a',entry('scope','第二批','scope','new'));
 await save(db,'org','a',entry('newinput','新单只买一台','sales_instruction','new'));
 const m=await load(db,'org','a');assert.equal(m.scopeId,'new');assert.ok(!render(m).includes('ALPHA'));assert.equal(db.tables.contact_events.length,3);assert.equal(db.tables.tasks.length,1);
});
test('pagination preserves early approvals and current corrections beyond one page',async()=>{
 const db=store();for(let i=0;i<205;i++)await save(db,'org','a',entry(`id${i}`,`第${i}条授权`));
 const m=await load(db,'org','a');assert.equal(m.entries.length,205);assert.ok(render(m).includes('第0条授权'));assert.ok(render(m).includes('第204条授权'));
});
test('malformed memory fails loudly; oversized history is not silently truncated',async()=>{
 const db=store();await save(db,'org','a',entry('id','text'));db.tables.contact_events[0].payload.text=null;
 await assert.rejects(load(db,'org','a'),/格式/);
 assert.throws(()=>render({contactId:'a',scopeId:'a',label:'x',tasks:[],entries:[{...entry('big','a'.repeat(100000)),at:'now'}]}),/过长/);
});
test('archived guidance retains original dates and source; quote versions stay scoped',async()=>{
 const db=store();db.tables.contact_events.push({id:'history',contact_id:'a',event_type:'ai_extracted',created_at:'2026-09-17T12:00:00Z',payload:{schema:'sales-history.v1',sourceAt:'2026-09-11T12:00:00Z',text:'本单运费7000',sourceChatUrl:'https://chatgpt.com/c/source'}},
 {id:'quote-old',contact_id:'a',event_type:'ai_extracted',created_at:'2026-09-17T12:00:00Z',payload:{schema:'quote-calculation.v1',scopeId:'a',status:'draft',summary:'OLD_QUOTE'}},
 {id:'other',contact_id:'b',event_type:'ai_extracted',created_at:'2026-09-17T12:00:00Z',payload:{schema:'sales-history.v1',text:'OTHER_CUSTOMER'}});
 let m=await load(db,'org','a');assert.equal(m.historicalGuidance.length,1);assert.equal(m.quoteVersions.length,1);assert.equal(m.historicalGuidance[0].payload.sourceAt,'2026-09-11T12:00:00Z');assert.doesNotMatch(render(m),/OTHER_CUSTOMER/);
 await save(db,'org','a',entry('scope','新单','scope','new'));m=await load(db,'org','a');assert.equal(m.quoteVersions.length,0);assert.match(render(m),/source conversation\/order/);assert.doesNotMatch(render(m),/OLD_QUOTE/);
});

test('quarantined original text is absent and prior snapshot authority is explicitly withdrawn',async()=>{
 const db=store();db.tables.contacts[0].phone='+573246874685';
 db.tables.contact_events.push({id:'foreign',contact_id:'a',event_type:'ai_extracted',created_at:'2026-09-18T00:00:00Z',payload:{schema:'sales-history.v1',sourceAt:'2026-09-16T00:00:00Z',sourceThread:'foreign-thread',text:'我有个委内瑞拉的客户，电话+58 412-2611301，运费FOREIGN_PRICE'}});
 const m=await load(db,'org','a');assert.equal(m.quarantinedGuidance.length,1);assert.equal(m.historicalGuidance.length,0);
 const prompt=render(m);assert.doesNotMatch(prompt,/FOREIGN_PRICE/);assert.match(prompt,/foreign-thread/);assert.match(prompt,/no longer applicable/);
});
test('prompt keeps all owner approvals but only latest unapproved research/draft/full quote',()=>{
 const m={contactId:'a',scopeId:'a',label:'x',tasks:[],entries:[entry('a','EARLY_APPROVAL'),entry('b','OLD_DRAFT'.repeat(1000),'assistant_draft'),entry('c','OLD_RESEARCH'.repeat(1000),'freight_lookup'),entry('d','LATEST_DRAFT','assistant_draft'),entry('e','LATEST_RESEARCH','freight_lookup')],quoteVersions:[{id:'q1',at:'old',payload:{input:'OLD_INPUT'.repeat(1000),summary:'old summary'}},{id:'q2',at:'new',payload:{input:'CURRENT_INPUT'}}]};
 const prompt=render(m);assert.match(prompt,/EARLY_APPROVAL/);assert.match(prompt,/LATEST_DRAFT/);assert.match(prompt,/LATEST_RESEARCH/);assert.match(prompt,/CURRENT_INPUT/);assert.match(prompt,/old summary/);assert.doesNotMatch(prompt,/OLD_DRAFT|OLD_RESEARCH|OLD_INPUT/);assert.equal(m.entries.length,5);
});
