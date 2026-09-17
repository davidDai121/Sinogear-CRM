import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const load=async p=>{const b=await build({entryPoints:[p],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`)};
const {calculateQuote:calc,extractQuoteInput}=await load('src/lib/quote-calculation.ts');
const {completeQuoteCalculation:complete}=await load('src/lib/quote-workflow.ts');
const now=Date.parse('2026-09-17T17:00:00Z');
function fixture(){return {schema:'quote-input.v1',origin:'Shanghai',destination:'La Guaira',fx:{cnyPerUsd:'7',source:'本单测试授权汇率',at:'2026-09-17T00:00:00Z'},plans:[{label:'两台',model:'R08 EV510',quantity:2,propulsion:'bev',shippingMode:'container',containers:1,loadingBasis:'本单明确按两台一柜作估算',vehicle:{basis:'approved_fob',amount:'25000',currency:'USD',source:'批准车型价',groundIncluded:false},freight:{amountUsd:'11302',source:'本单公开来源记录',dgIncluded:false,groundIncluded:false,checkedAt:'2026-09-17T00:00:00Z',validUntil:null,kind:'public_reference'},profit:null,groundOverride:null,insurance:null,fixedSelling:null}]};}
test('DG per container, ground per car, separate currency conversion and no double count',()=>{
 const x=fixture();let [p]=calc(x,now);assert.equal(p.dgUsd,'1000.00');assert.equal(p.groundCny,'6000.00');assert.equal(p.totalUsd,'63159.14');assert.equal(p.perVehicleUsd,'31579.57');assert.equal(p.insuranceUsd,null);
 x.plans[0].containers=2;[p]=calc(x,now);assert.equal(p.dgUsd,'2000.00');assert.equal(p.totalUsd,'64159.14');
 x.plans[0].freight.dgIncluded=true;x.plans[0].vehicle.groundIncluded=true;[p]=calc(x,now);assert.equal(p.dgUsd,'0.00');assert.equal(p.groundCny,'0.00');assert.equal(p.totalUsd,'61302.00');
});
test('fuel and RoRo do not receive EV container DG; all-in ground is not duplicated',()=>{
 const x=fixture(),p=x.plans[0];p.propulsion='fuel';p.freight.groundIncluded=true;assert.equal(calc(x,now)[0].dgUsd,'0.00');assert.equal(calc(x,now)[0].groundCny,'0.00');
 p.propulsion='bev';p.shippingMode='roro';p.containers=null;assert.equal(calc(x,now)[0].dgUsd,'0.00');
});
test('original lookup expires at seven days or earlier source expiry',()=>{
 const x=fixture();x.plans[0].freight.checkedAt='2026-09-10T17:00:00Z';assert.throws(()=>calc(x,now),/到期/);assert.doesNotThrow(()=>calc(x,now-1));
 x.plans[0].freight.checkedAt='2026-09-17T00:00:00Z';x.plans[0].freight.validUntil='2026-09-17T16:00:00Z';assert.throws(()=>calc(x,now),/到期/);
 x.plans[0].freight.checkedAt='nonsense';assert.throws(()=>calc(x,now),/日期/);
});
test('missing source, FX, inclusion, classification or loading stops calculation',()=>{
 for(const edit of [x=>x.fx=null,x=>x.plans[0].containers=null,x=>x.plans[0].freight.dgIncluded=null,x=>x.plans[0].vehicle.source='',x=>x.plans[0].propulsion='phev',x=>x.plans[0].vehicle.amount='NaN',x=>x.fx.cnyPerUsd='0',x=>x.plans[0].profit={amountCnyPerVehicle:'10000',source:'wrong extra profit'}]){const x=fixture();edit(x);assert.throws(()=>calc(x,now));}
});
test('historical Curacao comparison arithmetic: total, unit, savings and additional budget',()=>{
 const x=fixture(),p=x.plans[0];x.destination='Curacao';p.vehicle.groundIncluded=true;p.freight.dgIncluded=true;p.freight.kind='owner_estimate';p.freight.amountUsd='15000';
 x.plans.unshift({...structuredClone(p),label:'一台',quantity:1,freight:{...p.freight,amountUsd:'14000'}});
 const [one,two]=calc(x,now);assert.equal(one.totalUsd,'39000.00');assert.equal(two.totalUsd,'65000.00');assert.equal(two.perVehicleUsd,'32500.00');assert.equal(two.savingsPerVehicleUsd,'6500.00');assert.equal(two.savingsTotalUsd,'13000.00');assert.equal(two.additionalBudgetUsd,'26000.00');
});
test('La Guaira supplied all-in fee does not add ground again',()=>{
 const x=fixture(),p=x.plans[0];p.propulsion='fuel';p.vehicle.amount='14000';p.freight.amountUsd='11238';p.freight.groundIncluded=true;p.freight.dgIncluded=true;assert.equal(calc(x,now)[0].totalUsd,'39238.00');assert.equal(calc(x,now)[0].perVehicleUsd,'19619.00');
});
test('cost correction changes margin while explicitly fixed selling price stays constant',()=>{
 const x=fixture(),p=x.plans[0];p.quantity=1;p.propulsion='fuel';p.vehicle={basis:'procurement',amount:'100000',currency:'CNY',source:'采购授权',groundIncluded:false};p.freight.amountUsd='0';p.profit={amountCnyPerVehicle:'10000',source:'本单利润批准'};
 assert.equal(calc(x,now)[0].totalUsd,'16000.00');p.fixedSelling={amountUsdTotal:'17000',source:'老板明确保持17000'};let [r]=calc(x,now);assert.equal(r.internalProfitCny,'17000.00');
 p.groundOverride={amountCnyPerVehicle:'1000',source:'老板更正本单地面'};[r]=calc(x,now);assert.equal(r.totalUsd,'17000.00');assert.equal(r.internalProfitCny,'18000.00');
});
test('malformed or customer-facing internal blocks are blocked',()=>{
 assert.throws(()=>extractQuoteInput('[WhatsApp Reply]<quote_input>{}</quote_input>'));
 assert.throws(()=>extractQuoteInput('<quote_input>{'));
 assert.equal(extractQuoteInput('普通话术').input,undefined);
});
test('automatic composition uses computed values and rejects stale answers or loops',async()=>{
 const x=fixture();let calls=0;const input=`[WhatsApp Reply]\n\n[Full Translation & Strategy]\n<quote_input>${JSON.stringify(x)}</quote_input>`;
 const ok=await complete(input,'reply',async prompt=>{calls++;assert.match(prompt,/63159.14/);return '[WhatsApp Reply]\nUSD 63,159.14 total, USD 31,579.57 per car.\n[Full Translation & Strategy]\n保险未含';},now);
 assert.equal(calls,1);assert.equal(ok.result[0].dgUsd,'1000.00');assert.doesNotMatch(ok.text,/quote_input/);
 await assert.rejects(complete(input,'reply',async()=> '[WhatsApp Reply]USD 1 total[Full Translation & Strategy]',now),/缺少/);
 await assert.rejects(complete(input,'reply',async()=>input,now),/重新生成/);
 assert.equal((await complete('普通问答','reply',async()=>{throw Error('should not call')},now)).text,'普通问答');
});

test('observed owner_approved enum repairs once without changing monetary evidence',async()=>{
 const input=fixture();input.plans[0].freight.kind='owner_approved';const wrap=x=>'<quote_input>'+JSON.stringify(x)+'</quote_input>';
 const repaired=structuredClone(input);repaired.plans[0].freight.kind='owner_estimate';let calls=0;
 const r=await complete(wrap(input),'discuss',async()=>++calls===1?wrap(repaired):'内部总额63159.14美元',now);
 assert.equal(calls,2);assert.equal(r.input.plans[0].freight.kind,'owner_estimate');assert.equal(r.result[0].totalUsd,'63159.14');
 const altered=structuredClone(repaired);altered.plans[0].freight.amountUsd='1';await assert.rejects(complete(wrap(input),'discuss',async()=>wrap(altered),now),/改变/);
 calls=0;await assert.rejects(complete(wrap(input),'discuss',async()=>{calls++;return wrap(input)},now),/kind/);assert.equal(calls,1);
});
