import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/lib/freight-research.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {extractFreightResearch:extract}=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
test('research persists separately while customer and internal conclusion remain clean',()=>{
 const text='[Client Record]\n\n[WhatsApp Reply]\n参考金额\n[Full Translation & Strategy]\n内部结论\n<freight_research>同口径最高4000；https://example.com/rate；保险未知</freight_research>';
 const r=extract(text);assert.match(r.record,/最高4000/);assert.match(r.responseText,/内部结论/);assert.doesNotMatch(r.responseText,/freight_research|example.com/);
 assert.equal(extract('普通回复').record,undefined);
 assert.equal(extract('内部讨论\n<freight_research>工具不可用</freight_research>').record,'工具不可用');
});
test('malformed or customer-facing records fail instead of leaking metadata or silently losing it',()=>{
 for(const s of ['<freight_research>未闭合','</freight_research>','<freight_research> </freight_research>',
 '[WhatsApp Reply]<freight_research>内部数据</freight_research>[Full Translation & Strategy]结论',
 '<freight_research>a</freight_research><freight_research>b</freight_research>'])assert.throws(()=>extract(s));
});
