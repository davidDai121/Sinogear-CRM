import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const b=await build({entryPoints:['src/lib/message-sync.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'boundaries',setup(build){
 const mocks={
 './supabase':'export const supabase={from:(...args)=>globalThis.repairDb.from(...args)};',
 './ai-reply-attribution':'export const attributeOutboundMessage=async()=>null;',
 './ai-reply-log':'export const markAiReplyFilled=async()=>{};',
 './ad-lead-status':"export const MESSAGES_SYNCED_EVENT='synced';",
 };
 build.onResolve({filter:/.*/},a=>a.path in mocks?{path:a.path,namespace:'mock'}:null);
 build.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}));
}}]});
const {repairObservedMessages,syncMessages}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
function database(rows){return{rows:structuredClone(rows),fail:false,race:false,from(table){assert.equal(table,'messages');let filters=[],patch,upserts;
 const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(k,v){return q.eq(k,v);},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},update(v){patch=v;return q;},upsert(v){upserts=v;return q;},then(resolve){
  if(this!==q)throw Error('bad query');const db=globalThis.repairDb;
  if(patch&&db.fail)return Promise.resolve({error:{message:'offline'},data:null}).then(resolve);
  if(patch&&db.race)db.rows[0].text='concurrent edit';
  if(upserts){for(const r of upserts)if(!db.rows.some(x=>x.contact_id===r.contact_id&&x.wa_message_id===r.wa_message_id))db.rows.push({...r,id:'inserted'});}
  const found=db.rows.filter(r=>filters.every(f=>f(r)));const before=structuredClone(found);
  if(patch)found.forEach(r=>Object.assign(r,patch));return Promise.resolve({data:before,error:null,count:0}).then(resolve);
 }};return q;}};}
const old={id:'db1',contact_id:'c',wa_message_id:'m',text:'[媒体]',direction:'inbound',sent_at:null};
const observed={wa_message_id:'m',text:'Abidjan?',direction:'outbound',sent_at:'2026-09-18T18:22:00Z'};
test('re-observed text repairs old shell and direction before sync resolves',async()=>{
 globalThis.repairDb=database([old]);
 const r=await syncMessages('c',[{id:'m',text:observed.text,fromMe:true,timestamp:Date.parse(observed.sent_at),sender:null}]);
 assert.equal(r.error,undefined);assert.deepEqual(repairDb.rows[0],{...old,...observed,sent_at:new Date(observed.sent_at).toISOString()});
});
test('new original text repairs translated capture while unrelated customer is untouched',async()=>{
 globalThis.repairDb=database([{...old,text:'Oui 是的',sent_at:observed.sent_at},{...old,id:'foreign',contact_id:'other'}]);
 await repairObservedMessages('c',[{...observed,text:'Oui',direction:'inbound'}]);
 assert.equal(repairDb.rows[0].text,'Oui');assert.deepEqual(repairDb.rows[1],{...old,id:'foreign',contact_id:'other'});
});
test('generic media cannot erase captured text; real retraction can',async()=>{
 globalThis.repairDb=database([{...old,text:'Confirmed'}]);
 await repairObservedMessages('c',[{...observed,text:'[媒体]',direction:'inbound'}]);
 assert.equal(repairDb.rows[0].text,'Confirmed');
 await repairObservedMessages('c',[{...observed,text:'[已删除]',direction:'inbound'}]);
 assert.equal(repairDb.rows[0].text,'[已删除]');
});
test('repair failure is returned to generation; concurrent newer edit is not overwritten',async()=>{
 for(const mode of ['fail','race']){
  globalThis.repairDb=database([old]);repairDb[mode]=true;
  assert.match(await repairObservedMessages('c',[observed]),/尚未保存/);
  assert.equal(repairDb.rows[0].text,mode==='race'?'concurrent edit':'[媒体]');
 }
});
