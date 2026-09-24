import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
async function load(file) { const r=await build({entryPoints:[file],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64')); }
const {waitForCompletedGptResponse:wait,GptResponseTimeoutError}=await load('src/lib/gpt-response-wait.ts');
const {completeFollowupResult:complete,preserveFollowupTasks}=await load('src/lib/gpt-followup-result.ts');
const {parseClaudeResponse}=await load('src/lib/claude-parser.ts');
const {sanitizeReplyForCustomer}=await load('src/lib/reply-sanitize.ts');
async function sequence(frames,timeoutMs=30000){let time=0,index=0;return wait(async()=>frames[Math.min(index++,frames.length-1)],{timeoutMs,now:()=>time,sleep:async ms=>{time+=ms;}});}
const frame=(content,generating=false,hasCopyBtn=true)=>({content,generating,hasCopyBtn});
const reply='My friend, the shipping situation is the same for both cars.\n\nLet me check whether there is another way to ship a single car for you.';
const prose='[Client Record]\n\n[WhatsApp Reply]\n\n'+reply+'\n\n[Full Translation & Strategy]\n按老板要求回复，待发送。';
const decision={decision:'act',title:'核对草稿',reason:'老板已提供回复口径，尚未发送',dueAt:'2026-09-18T06:18:31.617Z',timeBasis:'gpt',evidence:[{id:'owner:test',quote:'两款车都用集装箱'}],existingTaskId:null};
const block='<crm_followup>'+JSON.stringify(decision)+'</crm_followup>';
const ctx={evidence:[{id:'owner:test',role:'owner',text:'两款车都用集装箱'}],tasks:[]};
const save=async d=>({decision:d,protected:false,after:{due_at:d.dueAt}});
const noRepair=async()=>{throw Error('Unexpected repair');};
test('growing response across the old completion window is not accepted',async()=>{
 assert.equal(await sequence([frame(prose,true),frame(prose),frame(prose+'\n<crm_followup>'),frame(prose+'\n<crm_followup>{"decision":"act"'),frame(prose+'\n'+block)]),prose+'\n'+block);
});
test('paused stream without this turn copy control cannot complete',async()=>{
 assert.equal(await sequence([frame(prose,false,false),frame(prose,false,false),frame(prose,false,false),frame(prose,false,false),frame(prose+'\n'+block)]),prose+'\n'+block);
});
test('generation resuming resets the stable window',async()=>{
 assert.equal(await sequence([frame(prose),frame(prose),frame(prose,true),frame(prose+'\n'+block)]),prose+'\n'+block);
});
test('timeout never returns the last partial response',async()=>{
 await assert.rejects(sequence([frame(prose+'\n<crm_followup>',true,false)],10000),/未使用半截回复/);
});
test('default wait accepts research completing beyond six minutes',async()=>{
 let time=0;
 const result=await wait(async()=>time<390000 ? frame('',true,false) : frame(prose+'\n'+block),
  {now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.equal(result,prose+'\n'+block);
 assert.equal(time,396000);
});
test('research near the old deadline still gets a full stable completion window',async()=>{
 let time=0;
 const result=await wait(async()=>time<358000 ? frame(prose,true,false) : frame(prose+'\n'+block),
  {now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.equal(result,prose+'\n'+block);
 assert.equal(time,364000);
});
test('default wait remains bounded and identifies a timeout for tab retention',async()=>{
 let time=0;
 await assert.rejects(wait(async()=>frame(prose,true,false),{now:()=>time,sleep:async ms=>{time+=ms;}}),
  error=>error instanceof GptResponseTimeoutError && /原对话页面已保留/.test(error.message));
 assert.equal(time,1200000);
});
test('short complete replies are accepted after stable completion',async()=>{
 assert.equal(await sequence([frame('NO_REPLY')]),'NO_REPLY');
});
test('reported two-paragraph draft survives valid metadata and parsing',async()=>{
 const result=await complete(prose+'\n'+block,ctx,noRepair,save);
 assert.equal(result.warning,undefined);assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(result.text).reply),reply);
 assert.doesNotMatch(result.text,/<crm_followup>/);
});
test('truncated duplicate or invalid metadata preserves draft without saving task',async()=>{
 for(const meta of ['<crm_followup>{"decision":"act"',block+block,'<crm_followup>bad json</crm_followup>',block.replace('owner:test','owner:invented')]){
  let calls=0;const result=await complete(prose+'\n'+meta,ctx,noRepair,async d=>{calls++;return save(d);});
  assert.equal(calls,0);assert.match(result.warning,/正文已保留/);
  assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(result.text).reply),reply);assert.doesNotMatch(result.text,/<crm_followup|owner:invented/);
 }
});
test('missing metadata repair cannot replace original customer text',async()=>{
 let calls=0;const result=await complete(prose,ctx,async()=>{calls++;return 'A different answer\n'+block;},save);
 assert.equal(calls,1);assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(result.text).reply),reply);
});
test('interactive missing metadata returns the finished draft without another call or task write',async()=>{
 let writes=0;
 const result=await complete(prose,ctx,null,async d=>{writes++;return save(d);});
 assert.equal(writes,0);assert.match(result.warning,/未追加GPT调用/);
 assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(result.text).reply),reply);
 const valid=await complete(prose+'\n'+block,ctx,null,async d=>{writes++;return save(d);});
 assert.equal(writes,1);assert.equal(valid.warning,undefined);
});
test('repair or save failure keeps draft and reports no confirmed save',async()=>{
 for(const stage of ['repair','save']){
  const result=await complete(prose+(stage==='save'?'\n'+block:''),ctx,async()=>{throw Error('GPT忙');},async()=>{throw Error('写入失败');});
  assert.match(result.warning,/未确认保存/);assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(result.text).reply),reply);
 }
});
test('metadata in customer section remains blocking',async()=>{
 await assert.rejects(complete(prose.replace('[Full Translation & Strategy]',block+'\n[Full Translation & Strategy]'),ctx,noRepair,save),/客户正文/);
});

 test('unresolved quote placeholders never become fillable customer text',()=>{
 assert.equal(sanitizeReplyForCustomer('CIF USD {{quote.1.totalUsd}}.'),'');
 assert.equal(sanitizeReplyForCustomer('CIF USD 118,400.00.'),'CIF USD 118,400.00.');
});

test('ready prose is delivered before an auxiliary task save settles; failure remains retryable',async()=>{
 let ready=false;
 const result=await complete(prose+'\n'+block,ctx,null,async()=>{assert.equal(ready,true);throw Error('offline');},async text=>{assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(text).reply),reply);ready=true;});
 assert.equal(result.retryable,true);assert.match(result.warning,/offline/);
 const absent=await complete(prose,ctx,null,save);assert.equal(absent.retryable,false);
});

 test('explicit current owner opt-out preserves tasks even if model returns metadata',async()=>{
 for(const request of ['本轮只是修改未发送草稿，不创建或调整跟进任务。','不要更新跟进任务',"Do not create or update follow-up tasks",
  // 2026-09-23 David 实测两句原话：旧正则都不命中，任务被改
  // 2026-09-23 Jaycee 复测：否定的跟进 / 提醒 / 回访没有“任务”二字也算不动任务
  'Right 是真认同我们，还是只是礼貌附和？你会怎么判断？不要写客户回复，也不安排跟进。','不用跟进','别提醒我了','这轮不安排回访','no follow-up needed this turn',"don't schedule a reminder",
  '这次帮我写客户回复：英文一句话。只改未发送草稿，不更新客户资料和跟进任务。','先跟我分析一下这个客户现在卡在哪，别写回复。这次只讨论，不新增或修改客户资料和跟进任务。','本轮只讨论','不要动跟进任务','别改任务',"Don't touch the follow-up tasks this turn"]){
  assert.equal(preserveFollowupTasks(request),true);
  for(const text of [prose,prose+'\n'+block]){
   const result=await complete(text,ctx,noRepair,async()=>assert.fail('task write forbidden'),undefined,true);
   assert.equal(result.text,prose);assert.equal(result.warning,undefined);
  }
 }
 for(const request of ['', '不新增承诺，安排跟进任务', '请调整跟进任务','帮我改成一句英文','只讨论完再写回复并安排任务','安排下周跟进','三天后提醒我催他','跟他说不用担心运费'])assert.equal(preserveFollowupTasks(request),false,request);
});

test('translation-only requests are detected without swallowing normal drafting',async()=>{
 const {translationOnlyRequested}=await load('src/lib/gpt-request-scope.ts');
 for(const q of ['附一句中文翻译。不写策略分析','只附中文翻译','附对应中文翻译，别写策略分析。本轮不创建或调整跟进任务。','translation only please','No strategy, just the reply and translation']) assert.equal(translationOnlyRequested(q),true,q);
 for(const q of ['','帮我改成一句英文','附中文翻译和策略','先跟我分析一下这个客户']) assert.equal(translationOnlyRequested(q),false,q);
});
