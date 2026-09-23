import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
async function mod(path, plugins=[]) { const b=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false,plugins});return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`); }
const {taskBucket}=await mod('src/lib/task-presentation.ts');
const {parseGptResponse,normalizeGptReply}=await mod('src/lib/gpt-reply-state.ts');
const {followupProse}=await mod('src/lib/gpt-followup-result.ts');
const task={id:'t',org_id:'o',contact_id:'c',title:'Send the reply',status:'open',due_at:null,created_by:'u'};
const plan={phase:'applied',orgId:'o',scopeId:'s',taskId:'t',userId:'u',evaluatedAt:'2026-09-21T10:00:34Z',after:task,protected:false,decision:{decision:'act',completion:'send_reply'}};
const reply='Hello Carlos, the final freight estimate is USD 5,612.';
const plugins=[{name:'isolated-followup',setup(b){b.onResolve({filter:/gpt-followup$/},()=>({path:'followup',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export const loadFollowupContext=async()=>globalThis.caseState.ctx; export const sameTask=(a,b)=>JSON.stringify(a)===JSON.stringify(b); export const saveFollowup=async(...args)=>{if(globalThis.caseState.fail)throw Error('offline');globalThis.caseState.saves.push(args);};`,loader:'js'}));}}];
const {canBindSendTask,matchingSentEvidence,completeTaskFromSyncedMessages}=await mod('src/lib/task-send-completion.ts',plugins);
test('waiting/review groups require the exact unedited applied task; manual overrides stay visible',()=>{
 for(const [decision,expected] of [['wait','waiting'],['review','review'],['act','action']])assert.equal(taskBucket(task,{...plan,decision:{decision}}),expected);
 for(const change of [{title:'Manual'},{due_at:'2026-10-01T12:00:00Z'},{created_by:'other'},{org_id:'other'},{status:'done'}])assert.equal(taskBucket({...task,...change},{...plan,decision:{decision:'wait'}}),'action');
 for(const change of [{phase:'intent'},{protected:true},{orgId:'other'}])assert.equal(taskBucket(task,{...plan,...change,decision:{decision:'wait'}}),'action');
});
test('only an explicit send-only applied action can bind a sufficiently specific draft',()=>{
 assert.equal(canBindSendTask(plan,reply),true);
 for(const change of [{protected:true},{phase:'intent'},{after:{...task,status:'done'}},{decision:{decision:'act',completion:'manual'}},{decision:{decision:'wait',completion:'send_reply'}},{decision:{decision:'act',completion:'send_reply',replyRequired:false}}])assert.equal(canBindSendTask({...plan,...change},reply),false);
 assert.equal(canBindSendTask(plan,'OK'),false);
});
test('sending proof needs full body, outbound direction, real time and a new persisted message id',()=>{
 const binding={plan,reply,knownMessageIds:['message:old']};
 const m={id:'new',direction:'outbound',text:reply,sent_at:'2026-09-21T10:01:00Z'};
 assert.equal(matchingSentEvidence(binding,[m]),m);
 assert.ok(matchingSentEvidence(binding,[{...m,text:reply.replaceAll(' ','\n')}]),'whitespace only changes are acceptable');
 for(const change of [{id:'old'},{direction:'inbound'},{sent_at:null},{sent_at:'invalid'},{sent_at:'2026-09-21T09:59:00Z'},{text:reply+' changed'},{text:reply.slice(0,25)}])assert.equal(matchingSentEvidence(binding,[{...m,...change}]),undefined);
});
const wrapped=r=>`[Client Record]\nNo change\n[WhatsApp Reply]\n${r}\n[Full Translation & Strategy]\n等待客户确认。`;
test('NO_REPLY and old Portuguese internal directives have no sendable reply',()=>{
 for(const r of ['NO_REPLY','Não é necessário enviar uma nova mensagem agora.','当前无需发送消息'])assert.equal(parseGptResponse(wrapped(r)).reply,null);
 assert.equal(parseGptResponse(wrapped('You do not need to pay yet.')).reply,'You do not need to pay yet.');
 assert.equal(parseGptResponse(wrapped('不用发送定金，确认车型就可以。')).reply,'不用发送定金，确认车型就可以。');
 assert.equal(parseGptResponse(wrapped(reply)+'\n<crm_followup>{"replyRequired":false,"reason":"Wait"}</crm_followup>').reply,null);
 assert.equal(parseGptResponse(normalizeGptReply(wrapped('NO_REPLY'))).reply,null);
});
test('NO_REPLY must not conceal misplaced internal machine metadata',()=>{
 assert.throws(()=>followupProse(wrapped('NO_REPLY\n<crm_followup>{"replyRequired":false}</crm_followup>')),/客户正文/);
});
function setup(change={}) {
 const binding={plan,reply,knownMessageIds:[]}, data={'gpt.sendCompletion:u:c':binding};
 globalThis.chrome={storage:{local:{get:async k=>({[k]:data[k]}),remove:async k=>{delete data[k];}}}};
 globalThis.caseState={ctx:{userId:'u',scopeId:'s',previous:plan,tasks:[task],...change},saves:[]};
 let rows=[{id:'persisted',direction:'outbound',text:reply,sent_at:'2026-09-21T10:01:00Z'}];
 const db={auth:{getSession:async()=>({data:{session:{user:{id:'u'}}}})},from(){const q={select:()=>q,eq:()=>q,in:()=>q,then:f=>Promise.resolve({data:rows}).then(f)};return q;}};
 return {db,data,setRows:r=>{rows=r;}};
}
const observed=[{wa_message_id:'wa-new',direction:'outbound',text:reply,sent_at:'2026-09-21T10:01:00Z'}];
test('completion uses persisted message evidence, and removes binding after a confirmed save',async()=>{
 const {db,data}=setup();await completeTaskFromSyncedMessages(db,'c',observed);
 assert.equal(caseState.saves.length,1);assert.equal(caseState.saves[0][2].decision,'done');assert.equal(caseState.saves[0][2].evidence[0].id,'message:persisted');assert.deepEqual(data,{});
});
test('unsynced DOM, changed identity/scope/task or changed plan cannot close a task',async()=>{
 const {db,setRows}=setup();setRows([]);await completeTaskFromSyncedMessages(db,'c',observed);assert.equal(caseState.saves.length,0);
 for(const change of [{userId:'other'},{scopeId:'other'},{previous:{...plan,protected:true}},{previous:{...plan,evaluatedAt:'later'}},{tasks:[{...task,title:'Manual edit'}]}]){const {db}=setup(change);await completeTaskFromSyncedMessages(db,'c',observed);assert.equal(caseState.saves.length,0);}
 const other=setup();await completeTaskFromSyncedMessages(other.db,'other',observed);assert.equal(caseState.saves.length,0);
});
test('save failure preserves binding so successful sync can retry without GPT',async()=>{
 const {db,data}=setup();caseState.fail=true;await assert.rejects(completeTaskFromSyncedMessages(db,'c',observed),/offline/);assert.ok(data['gpt.sendCompletion:u:c']);
 caseState.fail=false;await completeTaskFromSyncedMessages(db,'c',observed);assert.equal(caseState.saves.length,1);assert.deepEqual(data,{});
});
