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
  assert.ok(prompt.includes('[Discussion — NOT a customer reply request]'));
  assert.ok(!prompt.includes('Reminder: output exactly three sections'));
 }
});
test('fresh customer gets general workflow but no prior customer-specific approvals',()=>{
 const a=first({contact,messages,salesGuidance:'客户A本单赠品ALPHA-GIFT；运费14000',useCustomGpt:true});
 const b=first({contact:{...contact,name:'Different customer'},messages:[],useCustomGpt:true});
 assert.ok(a.includes('ALPHA-GIFT'));assert.ok(!b.includes('ALPHA-GIFT'));assert.ok(!b.includes('14000'));
 assert.ok(b.includes(header));
});
