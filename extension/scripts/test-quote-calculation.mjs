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
test('CIF default applies ten percent to transport only for five and six FOB cars',()=>{
 const x=fixture(),p=x.plans[0]; x.fx=null;p.propulsion='fuel';p.quantity=5;p.containers=3;
 p.vehicle.amount='15100';p.vehicle.groundIncluded=true;p.freight.amountUsd='12000';
 p.insurance={basis:'freight_10_percent',source:'老板2026-09-18：总运费x1.1'};
 x.plans.push({...structuredClone(p),label:'六台',quantity:6});
 const [five,six]=calc(x,now);
 assert.equal(five.insuranceUsd,'1200.00');assert.equal(five.transportWithInsuranceUsd,'13200.00');
 assert.equal(five.totalUsd,'88700.00');assert.equal(five.perVehicleUsd,'17740.00');
 assert.equal(six.totalUsd,'103800.00');assert.equal(six.perVehicleUsd,'17300.00');
 assert.equal(six.groundCny,'0.00');assert.equal(six.insuranceBasis,'freight_10_percent');
});
test('CIF insurance uses uncovered fuel surcharge budget with currency conversion',()=>{
 const x=fixture(),p=x.plans[0];p.propulsion='fuel';p.vehicle.amount='15100';p.quantity=5;p.containers=3;
 p.freight.amountUsd='12000';x.fx.cnyPerUsd='10';
 p.insurance={basis:'freight_10_percent',source:'老板通用公式'};
 const [r]=calc(x,now);assert.equal(r.groundCny,'10000.00');assert.equal(r.dgUsd,'0.00');
 assert.equal(r.transportBeforeInsuranceUsd,'13000.00');assert.equal(r.insuranceUsd,'1300.00');assert.equal(r.totalUsd,'89800.00');
});
test('CIF BEV transport includes DG per container and counts all-in charges only once',()=>{
 const x=fixture(),p=x.plans[0];x.fx.cnyPerUsd='10';p.freight.amountUsd='10000';
 p.insurance={basis:'freight_10_percent',source:'老板通用公式'};
 let [r]=calc(x,now);assert.equal(r.transportBeforeInsuranceUsd,'11600.00');assert.equal(r.insuranceUsd,'1160.00');assert.equal(r.totalUsd,'62760.00');
 p.freight.dgIncluded=true;p.freight.groundIncluded=true;x.fx=null;
 [r]=calc(x,now);assert.equal(r.transportWithInsuranceUsd,'11000.00');assert.equal(r.totalUsd,'61000.00');
});
test('fixed insurance overrides remain supported and mixed/doubled insurance inputs fail',()=>{
 const x=fixture(),p=x.plans[0];p.insurance={amountUsdTotal:'100',source:'本单明确覆盖'};
 assert.equal(calc(x,now)[0].insuranceUsd,'100.00');assert.equal(calc(x,now)[0].insuranceBasis,'fixed');
 p.insurance={basis:'freight_10_percent',amountUsdTotal:'100',source:'不能两种叠加'};assert.throws(()=>calc(x,now),/字段/);
 p.insurance={basis:'cargo_110_percent',source:'错误乘数'};assert.throws(()=>calc(x,now),/保险/);
 p.insurance={basis:'freight_10_percent',source:''};assert.throws(()=>calc(x,now),/来源/);
});
test('CIF calculated insurance reaches the final composition without asking for a premium',async()=>{
 const x=fixture(),p=x.plans[0];p.propulsion='fuel';p.vehicle.groundIncluded=true;p.vehicle.amount='15100';p.quantity=5;p.freight.amountUsd='12000';
 p.insurance={basis:'freight_10_percent',source:'老板通用公式'};
 const r=await complete('<quote_input>'+JSON.stringify(x)+'</quote_input>','reply',async prompt=>{
  assert.match(prompt,/"insuranceUsd":"1200.00"/);assert.match(prompt,/"transportWithInsuranceUsd":"13200.00"/);
  return '[WhatsApp Reply]\nCIF reference: USD 88,700 total, USD 17,740 per vehicle.\n[Full Translation & Strategy]\n老板授权运输保险预算已含。';
 },now);
 assert.equal(r.result[0].totalUsd,'88700.00');
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

test('Carlos PHEV with confirmed included DG quotes once without relabelling or double charging',async()=>{
 const x=fixture(),p=x.plans[0];x.fx=null;x.destination='Caucedo';
 Object.assign(p,{model:'ZEEKR 9X Hyper 70kWh',quantity:1,propulsion:'phev'});
 Object.assign(p.vehicle,{amount:'106300',groundIncluded:true});
 Object.assign(p.freight,{amountUsd:'11000',dgIncluded:true,groundIncluded:true,source:'海运10000 + 本单老板确认DG1000'});
 p.insurance={basis:'freight_10_percent',source:'老板：运费x1.1'};
 const draft='[WhatsApp Reply]\nCarlos, CIF reference: USD {{quote.1.totalUsd}}.\n[Full Translation & Strategy]\nCIF参考总额{{quote.1.totalUsd}}美元，保险预算{{quote.1.insuranceUsd}}美元。';
 const r=await complete(draft+'\n<quote_input>'+JSON.stringify(x)+'</quote_input>','reply',async()=>{throw Error('Unnecessary GPT call')},now);
 assert.equal(r.input.plans[0].propulsion,'phev');assert.equal(r.result[0].dgUsd,'0.00');assert.equal(r.result[0].totalUsd,'118400.00');
 assert.match(r.text,/USD 118,400.00/);assert.match(r.text,/保险预算1,100.00/);assert.doesNotMatch(r.text,/\{\{|quote_input/);
 p.freight.dgIncluded=false;assert.throws(()=>calc(x,now),/DG/);
 p.freight.dgIncluded=true;p.freight.groundIncluded=false;p.vehicle.groundIncluded=false;x.fx=fixture().fx;
 assert.throws(()=>calc(x,now));
});

test('multiple plan placeholders map totals and per-unit values locally in reply and discussion',async()=>{
 const x=fixture(),p=x.plans[0];p.vehicle.groundIncluded=true;p.freight.dgIncluded=true;p.freight.amountUsd='15000';
 x.plans.unshift({...structuredClone(p),label:'一台',quantity:1,freight:{...p.freight,amountUsd:'14000'}});
 const draft='[WhatsApp Reply]\nOne: USD {{quote.1.totalUsd}}; two: USD {{quote.2.totalUsd}}, each USD {{quote.2.perVehicleUsd}}.\n[Full Translation & Strategy]\n节省{{quote.2.savingsTotalUsd}}';
 for(const mode of ['reply','discuss']) {
  const r=await complete(draft+'<quote_input>'+JSON.stringify(x)+'</quote_input>',mode,async()=>{throw Error('Unnecessary GPT call')},now);
  assert.match(r.text,/One: USD 39,000.00; two: USD 65,000.00, each USD 32,500.00/);assert.match(r.text,/节省13,000.00/);
 }
});

test('invalid private placeholder repairs once and cannot leak internal amounts',async()=>{
 const x=fixture();let calls=0;
 const draft='[WhatsApp Reply]{{quote.1.totalUsd}} {{quote.1.perVehicleUsd}} {{quote.1.internalProfitCny}}[Full Translation & Strategy]';
 const r=await complete(draft+'<quote_input>'+JSON.stringify(x)+'</quote_input>','reply',async()=>{calls++;return '[WhatsApp Reply]USD 63,159.14 total; USD 31,579.57 each.[Full Translation & Strategy]';},now);
 assert.equal(calls,1);assert.doesNotMatch(r.text,/internalProfit|\{\{/);
 await assert.rejects(complete(draft,'reply',async()=>{throw Error('Should not run')},now),/缺少计算输入/);
});
