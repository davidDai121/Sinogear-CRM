import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/lib/gpt-run-delivery.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fake-run',setup(b){b.onResolve({filter:/gpt-automation$/},()=>({path:'fake',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export const runGpt = o=>globalThis.h.run(o); export const resumeGptRun=o=>globalThis.h.resume(o); export class GptResultUnsavedError extends Error {constructor(result){super('save');this.result=result;}} globalThis.Unsaved = GptResultUnsavedError;`}));}}]});
let instance=0;
async function setup(){const data={};globalThis.chrome={storage:{local:{get:async k=>k==null?structuredClone(data):{[k]:structuredClone(data[k])},set:async o=>Object.assign(data,structuredClone(o)),remove:async keys=>keys.forEach(k=>delete data[k])}}};globalThis.h={run:async()=>{},resume:async()=>{}};const mod=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text+`\n// ${instance++}`).toString('base64'));return {data,...mod};}
const id='request-123456789';const result={responseText:'Hola',chatUrl:'https://chatgpt.com/c/test',tabId:42};
const settle=()=>new Promise(r=>setImmediate(r));
test('result is durable before browser closes and repeated polling does not resend',async()=>{
 const s=await setup();let calls=0;
 h.run=async o=>{calls++;await o.onProgress({phase:'sent',tabId:42,baseline:{lastAssistantId:'old'}});await o.beforeClose(result);assert.equal(s.data['gpt.delivery.'+id].result.responseText,'Hola');};
 await s.startDeliveredGptRun(id,{url:'https://chatgpt.com/',prompt:'hello'});await settle();
 assert.equal((await s.pollDeliveredGptRun(id)).responseText,'Hola');
 assert.equal((await s.startDeliveredGptRun(id,{url:'https://chatgpt.com/',prompt:'hello'})).responseText,'Hola');assert.equal(calls,1);
});
test('worker restart resumes known baseline without sending prompt again',async()=>{
 const s=await setup();s.data['gpt.delivery.'+id]={requestId:id,createdAt:Date.now(),url:'https://chatgpt.com/',state:'running',tabId:42,baseline:{lastAssistantId:'old'}};
 let resumed=0;h.run=()=>{throw Error('must not send')};h.resume=async o=>{resumed++;assert.equal(o.baseline.lastAssistantId,'old');await o.beforeClose(result)};
 assert.equal((await s.pollDeliveredGptRun(id)).pending,true);await settle();assert.equal((await s.pollDeliveredGptRun(id)).responseText,'Hola');assert.equal(resumed,1);
});
test('interrupted send is never resent automatically',async()=>{
 const s=await setup();s.data['gpt.delivery.'+id]={requestId:id,createdAt:Date.now(),url:'https://chatgpt.com/',state:'starting',tabId:42};h.run=h.resume=()=>{throw Error('must not run')};
 const answer=await s.pollDeliveredGptRun(id);assert.equal(answer.ok,false);assert.match(answer.error,/发送阶段被中断/);
});
test('expired results are pruned but recent result is retained',async()=>{
 const s=await setup();s.data['gpt.delivery.old-123456789']={createdAt:Date.now()-25*3600000};s.data['gpt.delivery.recent-123456789']={createdAt:Date.now(),state:'done',result};
 await s.startDeliveredGptRun(id,{url:'https://chatgpt.com/',prompt:'hello'});assert.equal(s.data['gpt.delivery.old-123456789'],undefined);assert.ok(s.data['gpt.delivery.recent-123456789']);
});
test('a captured result remains deliverable when persistent storage fills up',async()=>{
 const s=await setup();
 h.run=async o=>{globalThis.chrome.storage.local.set=async()=>{throw Error('quota')};try{await o.beforeClose(result)}catch{throw new globalThis.Unsaved(result)}};
 await s.startDeliveredGptRun(id,{url:'https://chatgpt.com/',prompt:'hello'});await settle();assert.equal((await s.pollDeliveredGptRun(id)).responseText,'Hola');
});
