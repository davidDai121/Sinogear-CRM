import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const compiled = await build({entryPoints:['src/lib/sales-facts.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {selectSalesFacts, renderSalesFacts, factCategories, reviseSalesFact} = await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const now=Date.parse('2026-09-18T20:00:00Z');
const context={orgId:'org',contactId:'customer',scopeId:'order',salesGuidance:'R08 FOB报价和保修付款',vehicleInterests:[{model:'R08'}]};
const fact=(change={})=>({id:'f',org_id:'org',fact_key:'warranty.coverage',category:'warranty',scope:'product',product_key:'r08',contact_id:null,scope_id:null,status:'approved',authority:'approved_template',observed_at:'2026-09-16T00:00:00Z',valid_until:null,statement:'1 year',value:{years:1},source:{ref:'template',quote:'1 year'},...change});
const selected=(rows,ctx=context)=>selectSalesFacts(rows,ctx,now);
test('customer/order/organization/product isolation',()=>{
 const rows=[fact(),fact({id:'wrong-org',org_id:'other'}),fact({id:'wrong-customer',contact_id:'other',scope:'customer'}),fact({id:'old-order',contact_id:'customer',scope:'order',scope_id:'old'}),fact({id:'wrong-product',product_key:'rd6'})];
 assert.deepEqual(selected(rows).usable.map(f=>f.id),['f']);
});
test('newer applicable owner fact wins, older import does not become fresh',()=>{
 const rows=[fact({id:'old',observed_at:'2026-09-15T00:00:00Z',created_at:'2026-09-18T00:00:00Z',value:{years:0}}),fact()];
 assert.equal(selected(rows).usable[0].id,'f');
});
test('order warranty overrides product only in matching order',()=>{
 const specific=fact({id:'specific',scope:'order',contact_id:'customer',scope_id:'order',value:{components:['engine','transmission','chassis'],years:1}});
 assert.equal(selected([fact(),specific]).usable[0].id,'specific');
 assert.equal(selected([fact(),specific],{...context,scopeId:'new'}).usable[0].id,'f');
});
test('same-date contradictory facts are not silently chosen',()=>{
 const result=selected([fact(),fact({id:'other',value:{years:2}})]);
 assert.equal(result.usable.length,0);assert.equal(result.unavailable.length,2);
});
test('reference/candidate/expired/future facts never become usable',()=>{
 const result=selected([fact({status:'reference'}),fact({status:'candidate'}),fact({valid_until:'2026-09-17T00:00:00Z'}),fact({observed_at:'2026-09-19T00:00:00Z'})]);
 assert.equal(result.usable.length,0);assert.equal(result.unavailable.length,4);
});
const rate=fact({category:'freight',fact_key:'freight.route',scope:'order',contact_id:'customer',scope_id:'order',product_key:null,observed_at:'2026-09-18T10:00:00Z',value:{amountUsd:6000,checkedAt:'2026-09-18T10:00:00Z',origin:'Shanghai',destination:'Miragoane',model:'Yaris',quantity:1,propulsion:'fuel',shippingMode:'roro',containers:1}});
const freightCtx={...context,salesGuidance:'按本单运费计算CIF',contact:{destination_port:'Miragoane'},workMemory:{quoteVersions:[{payload:{input:{origin:'Shanghai',destination:'Miragoane',plans:[{model:'Yaris',quantity:1,propulsion:'fuel',shippingMode:'roro',containers:1}]}}}]}};
test('verified original rate requires exact shipment context',()=>{
 assert.equal(selected([rate],freightCtx).usable.length,1);
 for(const delta of [{quantity:2},{model:'R08'},{shippingMode:'container'},{propulsion:'bev'}]) {
  const ctx=structuredClone(freightCtx);Object.assign(ctx.workMemory.quoteVersions[0].payload.input.plans[0],delta);
  assert.equal(selected([rate],ctx).usable.length,0);
 }
 assert.equal(selected([rate],{...freightCtx,workMemory:undefined}).usable.length,0);
});
test('new quantity and box instructions cannot reuse stale matching quote context',()=>{
 for(const text of ['这次2台算CIF','改成20GP报价','集装箱运费']) assert.equal(selected([rate],{...freightCtx,salesGuidance:text}).usable.length,0);
});
test('rate age uses original check time and provider expiry',()=>{
 assert.equal(selected([fact({...rate,value:{...rate.value,checkedAt:'2026-09-10T00:00:00Z'}})],freightCtx).usable.length,0);
 assert.equal(selected([fact({...rate,valid_until:'2026-09-18T12:00:00Z'})],freightCtx).usable.length,0);
});
test('current order price list suppresses standing list only for that order/product',()=>{
 const base=fact({category:'price',fact_key:'price.base',value:{kind:'base_price_list',amount:14700}});
 const order=fact({id:'special',category:'price',fact_key:'price.order',scope:'order',contact_id:'customer',scope_id:'order',product_key:null,observed_at:'2026-09-18T00:00:00Z',value:{kind:'order_price_list',product:'r08',amount:13800}});
 assert.deepEqual(selected([base,order]).usable.map(f=>f.id),['special']);
 assert.deepEqual(selected([base,order],{...context,scopeId:'new'}).usable.map(f=>f.id),['f']);
});
test('ordinary color response does not inject freight facts',()=>{
 assert.deepEqual(factCategories({orgId:'org',contactId:'c',scopeId:'s',messages:[{text:'What colors are available?',fromMe:false}]}),[]);
});
test('unavailable fact amounts are not rendered; history warnings are bounded',()=>{
 const result={usable:[],unavailable:Array.from({length:50},(_,i)=>({id:String(i),title:'Historical record',reason:'Expired'}))};
 const text=renderSalesFacts(result);assert.match(text,/"unavailableCount":50/);assert.equal((text.match(/"reason"/g)||[]).length,8);
});
test('shared provenance retains every original value, scope and date without changing selections',()=>{
 const rows=[fact({id:'a',fact_key:'price.a',statement:'Alpha original',value:{amount:'12000',currency:'USD'}}),
  fact({id:'b',fact_key:'price.b',statement:'Beta original',value:{amount:'15000',currency:'USD'}}),
  fact({id:'c',scope:'order',scope_id:'order',valid_until:'2026-09-25T00:00:00Z'}),
  fact({id:'d',observed_at:'2026-09-17T00:00:00Z',source:{ref:'other-source'}})];
 const before=JSON.stringify(rows);
 const rendered=JSON.parse(renderSalesFacts({usable:rows,unavailable:[]}).split('\n')[2]);
 assert.equal(Object.keys(rendered.sources).length,3);
 assert.equal(rendered.facts.length,4);
 for(let i=0;i<rows.length;i++){
  const f=rendered.facts[i],original=rows[i],source=rendered.sources[f.provenanceRef];
  assert.equal(f.id,original.id);assert.equal(f.statement,original.statement);assert.deepEqual(f.value,original.value);
  assert.deepEqual(source,{scope:original.scope,product:original.product_key,source:original.source.ref,sourceDate:original.observed_at,validUntil:original.valid_until});
 }
 assert.equal(JSON.stringify(rows),before);
});
test('concurrent edit fails instead of overwriting',async()=>{
 const q={update(){return this},eq(){return this},select(){return this},async maybeSingle(){return {data:null,error:null}}};
 await assert.rejects(reviseSalesFact({from:()=>q},fact(),{status:'retired'}),/已被更新/);
});
