import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const QUOTA = 10 * 1024 * 1024;
async function moduleOf(path){const b=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text+`\n// ${Math.random()}`).toString('base64')}`);}
const bytes=data=>Object.entries(data).reduce((n,[k,v])=>n+k.length+JSON.stringify(v).length,0);
/** Fake chrome.storage.local that enforces Chrome's 10 MB quota exactly like the real one. */
function fakeStorage(seed={}){
  const data=structuredClone(seed);
  globalThis.chrome={storage:{local:{
    get:async k=>k==null?structuredClone(data):{[k]:structuredClone(data[k])},
    set:async o=>{const next={...data,...o};if(bytes(next)>QUOTA)throw new Error('Resource::kQuotaBytes quota exceeded');Object.assign(data,structuredClone(o));},
    remove:async keys=>(Array.isArray(keys)?keys:[keys]).forEach(k=>delete data[k]),
  }}};
  globalThis.console={...console,log(){},warn(){}};
  return data;
}
const log=(i,size,ts)=>[`aiReplyLog:${String(i).padStart(4,'0')}`,{id:String(i),org_id:'org',contact_id:'c',source:'gpt',mode:'gpt_first',prompt:'p'.repeat(size),response:null,response_parsed:null,guidance:null,message_source:'dom',message_count:1,chat_url:null,was_filled:false,filled_at:null,generated_at:ts,duration_ms:null,error:null}];
const logKeys=d=>Object.keys(d).filter(k=>k.startsWith('aiReplyLog:')).sort();
const logBytes=d=>bytes(Object.fromEntries(Object.entries(d).filter(([k])=>k.startsWith('aiReplyLog:'))));

test('a full store still accepts a new GPT log: oldest logs are evicted before the write',async()=>{
  const seed={};for(let i=0;i<141;i++){const [k,v]=log(i,74_000,1_000+i);seed[k]=v;}
  const data=fakeStorage(seed);
  assert.ok(bytes(data)>QUOTA-200_000,'seed must sit at the quota, like the 2026-09-22 profile');
  const {logAiReply,LOG_BUDGET_BYTES}=await moduleOf('src/lib/ai-reply-log.ts');
  const id=await logAiReply({orgId:'org',contactId:'c',source:'gpt',mode:'gpt_first',prompt:'x'.repeat(120_000)});
  assert.ok(id,'write must succeed');
  assert.ok(data['aiReplyLog:'+id],'new entry stored');
  assert.ok(logBytes(data)<=LOG_BUDGET_BYTES,'logs inside budget');
  const kept=logKeys(data).filter(k=>k!=='aiReplyLog:'+id);
  assert.equal(kept[0],'aiReplyLog:'+String(141-kept.length).padStart(4,'0'),'evicted from the oldest');
  assert.ok(kept.includes('aiReplyLog:0140'),'newest old log kept');
});

test('logs shrink further when other keys already fill the store',async()=>{
  const seed={'gpt.pendingAction:org:c':{startedAt:1,prompt:'q'.repeat(7_500_000)}};
  for(let i=0;i<20;i++){const [k,v]=log(i,100_000,i);seed[k]=v;}
  const data=fakeStorage(seed);
  const {enforceAiReplyLogBudget}=await moduleOf('src/lib/ai-reply-log.ts');
  const r=await enforceAiReplyLogBudget(0);
  assert.ok(r.removed>0);
  assert.ok(bytes(data)<=QUOTA-1.5*1024*1024,'headroom left for other writes');
  assert.ok(data['gpt.pendingAction:org:c'],'never touches non-log keys');
});

test('a store under budget is left alone',async()=>{
  const seed={};for(let i=0;i<10;i++){const [k,v]=log(i,10_000,i);seed[k]=v;}
  const data=fakeStorage(seed);
  const {enforceAiReplyLogBudget}=await moduleOf('src/lib/ai-reply-log.ts');
  assert.deepEqual((await enforceAiReplyLogBudget(50_000)).removed,0);
  assert.equal(logKeys(data).length,10);
});

test('housekeeping prunes archived actions older than 7 days and logs over budget, keeps the rest',async()=>{
  const now=Date.parse('2026-09-22T12:00:00Z'),day=86_400_000;
  const seed={'gpt.archivedAction:old':{startedAt:now-8*day,prompt:'a'},'gpt.archivedAction:new':{startedAt:now-2*day,prompt:'b'},
    'gpt.pendingAction:org:c':{startedAt:now-30*day,prompt:'keep'},'gpt.delivery.x':{createdAt:now-30*day},'gemModel':'flash','jev.credentials.v1':{key:'retired'}};
  for(let i=0;i<60;i++){const [k,v]=log(i,100_000,i);seed[k]=v;}
  const data=fakeStorage(seed);
  const {runStorageHousekeeping}=await moduleOf('src/lib/storage-housekeeping.ts');
  await runStorageHousekeeping(now);
  assert.equal(data['gpt.archivedAction:old'],undefined);
  assert.ok(data['gpt.archivedAction:new']);
  assert.ok(data['gpt.pendingAction:org:c']&&data['gpt.delivery.x']&&data.gemModel==='flash');
  assert.equal(data['jev.credentials.v1'],undefined,'retired Jev key removed');
  assert.ok(logBytes(data)<=3*1024*1024);
  assert.ok(logKeys(data).includes('aiReplyLog:0059'));
});
