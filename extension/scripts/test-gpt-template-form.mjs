/** Real template form regression; only Supabase is mocked, no network or customer writes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import React, { act } from 'react';
const { window } = parseHTML('<html><body></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Node:window.Node,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'offline-form-test'}});
globalThis.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}};
globalThis.fetch=()=>{throw Error('Network forbidden');};
const require=createRequire(import.meta.url);
const { createRoot }=require('react-dom/client');
const { Simulate }=require('react-dom/test-utils');
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/panel/components/GPTTemplatesModal.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'offline-supabase',setup(b){b.onResolve({filter:/^@\/lib\/supabase$/},()=>({path:'mock',namespace:'offline'}));b.onLoad({filter:/.*/,namespace:'offline'},()=>({contents:'export const supabase = { from: table => globalThis.__formHarness.query(table) };',loader:'js'}));}}]});
const loaded={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(require,loaded,loaded.exports);
const { GPTTemplatesModal }=loaded.exports;
async function settle(){for(let i=0;i<3;i++)await act(async()=>{await new Promise(r=>setImmediate(r));});}
async function mount(t){
 const h={writes:[],query(table){assert.equal(table,'gpt_templates');let payload;const q={select(){return q;},eq(){return q;},order(){return q;},insert(x){payload=x;return q;},single(){return q;},then(resolve,reject){return Promise.resolve().then(()=>{if(payload){h.writes.push(payload);return {data:{id:'saved'},error:null};}return {data:[{id:'existing',created_by:'offline-user',name:'Existing GPT',gpt_url:'https://chatgpt.com/g/g-existing',description:null,is_default:true}],error:null};}).then(resolve,reject);}};return q;}};
 globalThis.__formHarness=h;
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>root.render(React.createElement(GPTTemplatesModal,{orgId:'offline-org',onClose(){}})));await settle();
 t.after(async()=>{await act(async()=>root.unmount());container.remove();});
 await act(async()=>Simulate.click([...container.querySelectorAll('button')].find(b=>b.textContent==='+ 新建模板')));await settle();
 return {h,container};
}
function field(c,name){const label=[...c.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent===name);assert.ok(label,name);return label.querySelector('input,textarea,select');}
async function change(node,value){await act(async()=>Simulate.change(node,{target:typeof value==='boolean'?{checked:value}:{value}}));await settle();}
const submitButton=c=>c.querySelector('button[type="submit"]');
async function submit(c){assert.equal(submitButton(c).disabled,false);await act(async()=>Simulate.submit(c.querySelector('form'),{preventDefault(){}}));await settle();}
test('new skill can be created without entering a hidden legacy GPT URL',async t=>{
 const {h,container:c}=await mount(t);
 await change(field(c,'模板名称'),'R08 skill pilot');
 await change(field(c,'使用已安装的 ChatGPT 技能'),true);
 assert.equal(submitButton(c).disabled,true);
 await change(field(c,'技能名称（ChatGPT 中显示的名称）'),'sino gear r08 miles');
 assert.equal(submitButton(c).disabled,true);
 await change(field(c,'技能 / 插件 ID（详情页链接末尾）'),'6aabac4c1240819193bc311372c9d2ab');
 await change(field(c,'已确认业务知识'),'Approved fixture only');
 assert.equal(c.querySelector('input[placeholder="https://chatgpt.com/g/g-xxxxx-name"]'),null);
 await submit(c);
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].gpt_url,'https://chatgpt.com/');assert.equal(h.writes[0].is_default,false);
 const config=JSON.parse(h.writes[0].description.split('\n').slice(1).join('\n'));
 assert.equal(config.version,2);assert.deepEqual(config.skill,{id:'6aabac4c1240819193bc311372c9d2ab',name:'sino gear r08 miles'});assert.equal(config.approvedKnowledge,'Approved fixture only');
});
test('legacy GPT still requires a URL when switching back from skill mode',async t=>{
 const {h,container:c}=await mount(t);await change(field(c,'模板名称'),'Legacy');
 assert.equal(submitButton(c).disabled,true);
 await change(field(c,'使用已安装的 ChatGPT 技能'),true);
 await change(field(c,'技能名称（ChatGPT 中显示的名称）'),'sino gear r08 miles');await change(field(c,'技能 / 插件 ID（详情页链接末尾）'),'6aabac4c1240819193bc311372c9d2ab');
 await change(field(c,'使用已安装的 ChatGPT 技能'),false);assert.equal(submitButton(c).disabled,true);
 await change(field(c,'Custom GPT URL'),'https://chatgpt.com/g/g-existing');await submit(c);
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].gpt_url,'https://chatgpt.com/g/g-existing');assert.equal(h.writes[0].description,null);
});

test('new Chat plugin accepts its current display name and plugin ID without losing knowledge', async t => {
 const {h,container:c}=await mount(t);
 await change(field(c,'模板名称'),'R08 Chat plugin');
 await change(field(c,'使用已安装的 ChatGPT 技能'),true);
 await change(field(c,'技能名称（ChatGPT 中显示的名称）'),'Sino Gear R08 Miles');
 const id='plugin_5e838f5f90dc81919776e122e642836e';
 const idField=field(c,'技能 / 插件 ID（详情页链接末尾）');
 assert.equal(new RegExp('^'+idField.getAttribute('pattern')+'$').test(id),true);
 await change(idField,id); await change(field(c,'已确认业务知识'),'Existing approved knowledge');
 await change(field(c,'思考强度（普通 Chat，不使用 Pro 模型）'),'extra_high');
 await submit(c);
 const config=JSON.parse(h.writes[0].description.split('\n').slice(1).join('\n'));
 assert.deepEqual(config.skill,{id,name:'Sino Gear R08 Miles',thinkingEffort:'extra_high'});
 assert.equal(config.approvedKnowledge,'Existing approved knowledge');
});
