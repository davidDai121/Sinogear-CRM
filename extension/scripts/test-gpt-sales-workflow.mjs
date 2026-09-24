import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({entryPoints:[fileURLToPath(new URL('../src/lib/gpt-prompt.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {buildFirstMessage:first,buildFollowUpMessage:follow,buildDiscussionMessage:discuss} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const contact={phone:'13552592187',group_jid:null,name:'Replay',wa_name:null,country:null,language:'Spanish',budget_usd:null,destination_port:null,customer_stage:'new',notes:null};
const messages=[{id:'test',text:'Ok perfecto',fromMe:false,sender:null,timestamp:1700000000000}];
const header='[Sales Workflow — current request and continuity]';
test('current time labels the actual browser timezone and includes an unambiguous freight instant',()=>{
 const original=process.env.TZ;
 try {
  for(const zone of ['America/Chicago','Asia/Shanghai']) {
   process.env.TZ=zone;
   const start=Date.now();
   const prompt=first({contact,messages,useCustomGpt:true});
   assert.ok(prompt.includes(`boss's local time, ${zone}`));
   const iso=prompt.match(/Exact current instant: ([0-9TZ:.-]+)/)?.[1].replace(/\.$/,'');
   assert.ok(iso && Date.parse(iso)>=start && Date.parse(iso)<=Date.now());
  }
 } finally { if(original===undefined)delete process.env.TZ;else process.env.TZ=original; }
});
test('first and follow-up preserve seller review intent instead of directing it into customer copy',()=>{
 for(const prompt of [first({contact,messages,useCustomGpt:true,salesGuidance:'你确定吗'}),follow({contact,newMessages:messages,salesGuidance:'先汇报给我'})]){
  assert.equal(prompt.split(header).length-1,1);
  assert.ok(prompt.includes('leave BOTH [Client Record] and [WhatsApp Reply] empty'));
  assert.ok(!prompt.includes('Apply it strictly to the [WhatsApp Reply]'));
  assert.ok(prompt.indexOf(header)<prompt.indexOf('\n[Reply Language]\n'));
 }
});
test('both discussion routes receive continuity rules and keep internal discussion format',()=>{
 for(const prompt of [discuss({ctx:{contact,messages,useCustomGpt:true},question:'成本重算'}),discuss({contact,newMessages:messages,question:'成本重算'})]){
  assert.equal(prompt.split(header).length-1,1);
  assert.ok(prompt.includes('[Sales conversation — follow the current request]'));
  assert.ok(!prompt.includes('Reminder: output exactly three sections'));
 }
});
test('fresh customer gets general workflow but no prior customer-specific approvals',()=>{
 const a=first({contact,messages,salesGuidance:'客户A本单赠品ALPHA-GIFT；运费14000',useCustomGpt:true});
 const b=first({contact:{...contact,name:'Different customer'},messages:[],useCustomGpt:true});
 assert.ok(a.includes('ALPHA-GIFT'));assert.ok(!b.includes('ALPHA-GIFT'));assert.ok(!b.includes('14000'));
 assert.ok(b.includes(header));
});

test('all prompt entrypoints carry single-pass quoting and pending owner clarification continuity',()=>{
 for(const prompt of [first({contact,messages,useCustomGpt:true,salesGuidance:'就是dg'}),follow({contact,newMessages:messages,salesGuidance:'就是dg'}),discuss({ctx:{contact,messages,useCustomGpt:true},question:'报价'}),discuss({contact,newMessages:messages,question:'报价'})]){
  assert.match(prompt,/ONE-PASS QUOTING/);assert.match(prompt,/continues the pending instruction/);
  assert.doesNotMatch(prompt,/Leave WhatsApp Reply empty for this intermediate/);
  assert.match(prompt,/PHEV is supported/);
 }
});

// 2026-09-23 Jaycee "Right" 实测：判断题默认 2–4 句、先判断再依据；只在讨论路径，生成路径不带
test('discussion routes carry the 2-4 sentence judgment default; generate routes do not',()=>{
 const q='客户回了 Right，我觉得不用再推了，你怎么看？先和我讨论，不要写给客户的新消息。';
 for(const prompt of [discuss({ctx:{contact,messages,useCustomGpt:true},question:q}),discuss({contact,newMessages:messages,question:q})]){
  assert.match(prompt,/by default 2–4 natural Chinese sentences \(中文\), the verdict first/);
  assert.match(prompt,/No headings, numbered points, nested lists, restated known prices/);
  assert.match(prompt,/Expand into structure only for a complex quote, a multi-option comparison, a risk review/);
  assert.match(prompt,/“Right”, “OK”, a thumbs-up or a one-word answer is a low-information acknowledgement/);
  assert.match(prompt,/not objecting is not accepting/);
  assert.doesNotMatch(prompt,/answer directly in concise Chinese/);
  assert.ok(prompt.indexOf(q)<prompt.indexOf('by default 2–4 natural Chinese sentences'));
 }
 for(const prompt of [first({contact,messages,useCustomGpt:true,salesGuidance:'你怎么看'}),follow({contact,newMessages:messages,salesGuidance:'你怎么看'})]){
  assert.doesNotMatch(prompt,/by default 2–4 natural Chinese sentences/);
  assert.match(prompt,/output exactly three sections/);
 }
});

test('output reminder tells both reply routes to leave the reply empty instead of re-sending sent content',()=>{
 for(const prompt of [first({contact,messages,useCustomGpt:true}),follow({contact,newMessages:messages}),first({contact,messages,useCustomGpt:true,salesGuidance:'跟他说柴油四驱就剩五台了'})]){
  assert.match(prompt,/leave \[WhatsApp Reply\] empty instead of re-sending or paraphrasing sent content/);
  assert.match(prompt,/let the CRM follow-up block carry the dated second follow-up/);
 }
});
