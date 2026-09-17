import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/lib/freight-query.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {queryFreight:query}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const request={origin:'Shanghai',destination:'La Guaira',vehicle:'R08 EV 510',quantity:2,propulsion:'bev',container:'40HC'};
function server(text='USD 5000 per 40HC; illustrative fixture only',code=200){
 const calls=[];return {calls,fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push(body);
  assert.equal(url,'https://search.shaq-logistics.com/mcp');
  if(code!==200)return new Response('blocked',{status:code});
  let result=body.method==='tools/list'?{tools:[{name:'search_freight_rates',annotations:{readOnlyHint:true}}]}:
    body.method==='tools/call'?{structuredContent:{result:text},isError:false}:{};
  return new Response(body.method==='notifications/initialized'?'':`event: message\r\ndata: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\r\n\r\n`,{status:200});
 }};
}
test('only read-only discovery and rate queries run; numbers remain unconfirmed vehicle reference',async()=>{
 const s=server();const r=await query(request,s.fetch);
 assert.equal(r.status,'reference');assert.equal(r.bindingQuote,false);assert.equal(r.validUntil,null);assert.equal(r.vehicleAcceptance,'unconfirmed');
 assert.deepEqual(s.calls.filter(c=>c.method==='tools/call').map(c=>c.params.name),['search_freight_rates']);
 assert.equal(s.calls.at(-1).params.arguments.container_type,'40HC');assert.equal(r.request.quantity,2);
});
test('no result, payment challenge and timeout never become fallback prices',async()=>{
 assert.equal((await query(request,server('No rates found for Shanghai -> La Guaira').fetch)).status,'no_results');
 for(const code of [402,522]){const s=server('',code);const r=await query(request,s.fetch);assert.equal(r.status,'unavailable');assert.equal(s.calls.length,1);assert.ok(r.raw.includes(String(code)));}
 assert.equal((await query(request,async()=>{throw new Error('timeout');})).status,'unavailable');
});
test('missing route, invalid quantity or unsupported container cannot query',async()=>{
 let calls=0;const f=async()=>{calls++;};
 for(const patch of [{destination:''},{quantity:0},{quantity:1.5},{container:'guessed'}])await assert.rejects(query({...request,...patch},f));
 assert.equal(calls,0);
});
