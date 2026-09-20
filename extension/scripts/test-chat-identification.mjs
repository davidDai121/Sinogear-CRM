import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';

async function compile(entry, plugins = []) {
  const r = await build({ entryPoints:[entry], bundle:true, write:false, format:'cjs', platform:'node', plugins });
  return r.outputFiles[0].text;
}
const mocks = {name:'offline-chat-data',setup(b) {
  b.onResolve({filter:/(?:whatsapp-idb|jid-phone-cache)$/}, a=>({path:a.path,namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'}, a=>({contents:a.path.endsWith('whatsapp-idb') ? `
    export async function readWhatsAppData(){return {contacts:[],chats:[],jidToPhoneJid:new Map()};}
    export function jidToPhone(j){return /^\\d+@(c\\.us|s\\.whatsapp\\.net)$/.test(j)?'+'+j.split('@')[0]:null;}
  ` : `
    export function getJidPhoneCacheSync(){return {};}
    export async function rememberJidPhone(jid,phone){window.remembered.push({jid,phone});}
  `}));
}};
const domCode=await compile('src/content/whatsapp-dom.ts',[mocks]);
const clientCode=await compile('src/content/chat-bridge-client.ts');
const bridgeCode=await compile('src/background/whatsapp-fiber-bridge.ts');
function env(code,sendMessage=async()=>({ok:true})) {
  const {window,document}=parseHTML('<html><body><div id="main"><header><span title="Ciro Adolfo">Ciro Adolfo</span></header></div></body></html>');
  window.remembered=[];let serial=0;const timers=new Map(),warnings=[],intervals=[];
  const sandbox={module:{exports:{}},window,document,Node:window.Node,MutationObserver:window.MutationObserver,
    CustomEvent:window.CustomEvent,console:{log(){},warn:(...a)=>warnings.push(a)},chrome:{runtime:{sendMessage}},
    requestAnimationFrame:fn=>{const id=++serial;timers.set(id,{fn,ms:0});return id;},cancelAnimationFrame:id=>timers.delete(id),
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:fn=>{intervals.push(fn);return intervals.length;}};
  const context=vm.createContext(sandbox);vm.runInContext(code,context);
  const flush=async()=>{
    for(let i=0;i<8;i++)await Promise.resolve();
    for(const [id,t]of [...timers])if(t.ms===0){timers.delete(id);t.fn();}
    for(let i=0;i<8;i++)await Promise.resolve();
  };
  const advance=async ms=>{for(const [id,t]of [...timers])if(t.ms<=ms){timers.delete(id);t.fn();}await flush();};
  return {api:sandbox.module.exports,context,window,document,timers,warnings,intervals,flush,advance};
}
const payload=(title='Ciro Adolfo',phone='573000000001')=>JSON.stringify({title,rawJid:'123456789012@lid',phoneJid:phone+'@c.us'});

test('late html bridge update resolves identity without any body mutation; disposal stops observation',async()=>{
  const e=env(domCode),changes=[];const stop=e.api.observeCurrentChat(c=>changes.push(c));await e.flush();
  assert.equal(changes.at(-1).phone,null);
  e.document.documentElement.setAttribute('data-sgc-fiber-chat',payload());await e.flush();
  assert.equal(changes.at(-1).phone,'+573000000001');
  stop();e.document.documentElement.setAttribute('data-sgc-fiber-chat','');await e.flush();
  assert.equal(changes.at(-1).phone,'+573000000001');
});
test('Ciro rejects previous phone chat and unrelated Adolfo, then accepts matching identity; closing clears it',async()=>{
  const e=env(domCode),changes=[];e.api.observeCurrentChat(c=>changes.push(c));await e.flush();
  for(const name of ['+504 8902-7514','Adolfo Vicente']){
    e.document.documentElement.setAttribute('data-sgc-fiber-chat',payload(name,'50489027514'));await e.flush();
    assert.equal(e.api.readCurrentChat().phone,null);assert.equal(e.window.remembered.length,0);
  }
  e.document.documentElement.setAttribute('data-sgc-fiber-chat',payload());await e.flush();
  assert.equal(changes.at(-1).phone,'+573000000001');
  e.document.querySelector('#main').remove();await e.flush();
  assert.equal(changes.at(-1).name,null);assert.equal(changes.at(-1).phone,null);
});
test('group bridge resolves a group without a phone',async()=>{
  const e=env(domCode),changes=[];e.api.observeCurrentChat(c=>changes.push(c));await e.flush();
  e.document.documentElement.setAttribute('data-sgc-fiber-chat',JSON.stringify({title:'Ciro Adolfo',rawJid:'123456789012@g.us'}));await e.flush();
  assert.equal(changes.at(-1).groupJid,'123456789012@g.us');assert.equal(changes.at(-1).phone,null);
});
test('bridge arriving during a header gap is not accepted until identity can be checked',async()=>{
  const e=env(domCode),changes=[];e.document.querySelector('header').remove();
  e.api.observeCurrentChat(c=>changes.push(c));await e.flush();
  e.document.documentElement.setAttribute('data-sgc-fiber-chat',payload());await e.flush();
  assert.equal(changes.at(-1).phone,null);assert.equal(e.window.remembered.length,0);
  const header=e.document.createElement('header');header.innerHTML='<span title="Ciro Adolfo">Ciro Adolfo</span>';
  e.document.querySelector('#main').appendChild(header);await e.flush();
  assert.equal(changes.at(-1).phone,'+573000000001');
});
test('refresh event does not duplicate unchanged identity notifications',async()=>{
  const e=env(domCode),changes=[];e.api.observeCurrentChat(c=>changes.push(c));await e.flush();const count=changes.length;
  e.window.dispatchEvent(new e.window.CustomEvent('sgc:refresh-chat'));await e.flush();assert.equal(changes.length,count);
});
test('negative injection reply retries; later success refreshes once',async()=>{
  let attempts=0,refreshes=0;const e=env(clientCode,async()=>++attempts===1?{ok:false,error:'worker not ready'}:{ok:true});
  e.api.installChatBridgeClient(()=>refreshes++);await e.flush();
  assert.equal(attempts,1);assert.equal(refreshes,0);await e.advance(1000);
  assert.equal(attempts,2);assert.equal(refreshes,1);assert.equal(e.document.documentElement.getAttribute('data-sgc-bridge-injection'),'ready');
  assert.equal(e.timers.size,0);
});
test('transport rejection retries at most three times and exposes failure',async()=>{
  let attempts=0;const e=env(clientCode,async()=>{attempts++;throw Error('context invalidated');});
  e.api.installChatBridgeClient(()=>{});await e.flush();await e.advance(1000);await e.advance(2000);
  assert.equal(attempts,3);assert.equal(e.warnings.length,3);assert.equal(e.document.documentElement.getAttribute('data-sgc-bridge-injection'),'error');assert.equal(e.timers.size,0);
});
test('missing response is not accepted as success',async()=>{
  const e=env(clientCode,async()=>undefined);e.api.installChatBridgeClient(()=>{});await e.flush();await e.advance(1000);await e.advance(2000);
  assert.equal(e.document.documentElement.getAttribute('data-sgc-bridge-injection'),'error');
});
test('manual retries are single flight and cleanup removes retry listener',async()=>{
  let resolve,attempts=0,refreshes=0;const e=env(clientCode,()=>{attempts++;return new Promise(r=>resolve=r);});
  const stop=e.api.installChatBridgeClient(()=>refreshes++);
  for(let i=0;i<4;i++)e.window.dispatchEvent(new e.window.CustomEvent('sgc:retry-chat-identification'));
  assert.equal(attempts,1);resolve({ok:true});await e.flush();
  e.window.dispatchEvent(new e.window.CustomEvent('sgc:retry-chat-identification'));assert.equal(attempts,2);
  stop();resolve({ok:true});await e.flush();assert.equal(refreshes,1);
  e.window.dispatchEvent(new e.window.CustomEvent('sgc:retry-chat-identification'));assert.equal(attempts,2);
});
test('hung injection times out rather than keeping UI loading forever',async()=>{
  let attempts=0;const e=env(clientCode,()=>{attempts++;return new Promise(()=>{});});
  e.api.installChatBridgeClient(()=>{});await e.advance(5000);await e.advance(1000);await e.advance(5000);await e.advance(2000);await e.advance(5000);
  assert.equal(attempts,3);assert.equal(e.document.documentElement.getAttribute('data-sgc-bridge-injection'),'error');
});
test('serialized MAIN-world reader records no-fiber, re-reads immediately on retry, and clears closed chat',async()=>{
  const e=env(bridgeCode);vm.runInContext('('+e.api.fiberBridgeMainWorld.toString()+')()',e.context);
  assert.equal(e.document.documentElement.getAttribute('data-sgc-fiber-chat'),'');assert.equal(e.document.documentElement.getAttribute('data-sgc-bridge-reader'),'no-fiber');
  const chat={id:{_serialized:'123456789012@lid'},formattedTitle:'Ciro Adolfo',contact:{phoneNumber:{_serialized:'573000000001@c.us'}}};
  e.document.querySelector('#main').__reactFiber$test={memoizedProps:{chat}};
  e.api.fiberBridgeMainWorld();assert.equal(e.intervals.length,1);
  assert.equal(JSON.parse(e.document.documentElement.getAttribute('data-sgc-fiber-chat')).phoneJid,'573000000001@c.us');
  e.document.querySelector('#main').remove();e.intervals[0]();
  assert.equal(e.document.documentElement.getAttribute('data-sgc-fiber-chat'),'');assert.equal(e.document.documentElement.getAttribute('data-sgc-bridge-reader'),'no-main');
});
