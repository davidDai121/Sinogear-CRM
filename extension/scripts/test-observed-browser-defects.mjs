import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
async function load(path) {
 const b=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});
 return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
}
const messages=await load('src/content/whatsapp-messages.ts');
const dom=await load('src/content/whatsapp-message-dom.ts');
const snapshot=await load('src/content/whatsapp-message-snapshot.ts');
const preview=await load('src/lib/quote-preview.ts');
const freshness=await load('src/lib/draft-freshness.ts');
const time=await load('src/lib/phone-timezones.ts');
const follow=await load('src/lib/gpt-followup.ts');
function page(body) {
 const {window}=parseHTML(`<html><body>${body}</body></html>`);
 Object.assign(globalThis,{document:window.document,HTMLElement:window.HTMLElement,Node:window.Node,NodeFilter:{SHOW_TEXT:4},CSS:{escape:s=>s}});
 return window.document;
}
const wrap=(id,body)=>`<div data-testid="conv-msg-${id}" data-id="${id}">${body}</div>`;
const text=(s,out=false)=>`<div data-virtualized="false"><div data-testid="msg-container"><span data-icon="tail-${out?'out':'in'}"></span><div class="copyable-text" data-pre-plain-text="[下午1:23, 2026年9月18日] Test: "><span class="selectable-text">${s}</span></div></div></div>`;
const shell='<div data-virtualized="true"><div></div></div><button class="sgc-translate-btn">🌐</button>';
test('virtualized shells are not fake media or inbound messages; real photos remain',()=>{
 page('<div id="main">'+wrap('shell',shell)+wrap('photo','<span data-icon="tail-out"></span><img src="blob:photo">')+wrap('confirm',text('Oui'))+'</div>');
 const got=messages.readChatMessages(50);
 assert.deepEqual(got.map(m=>[m.id,m.text,m.fromMe]),[['photo','[图片]',true],['confirm','Oui',false]]);
});
test('mixed legacy and modern message structures keep both directions',()=>{
 page('<div id="main">'+wrap('sales','<div class="message-out">'+text('Abidjan?',true)+'</div>')+wrap('customer',text('Oui'))+'</div>');
 assert.deepEqual(messages.readChatMessages().map(m=>m.text),['Abidjan?','Oui']);
});
test('foreign translations and CRM translations removed; original Chinese and paragraphs remain',()=>{
 page('<div id="main">'+wrap('c',text('2.3T<br>车身件<font class="immersive-translate-target-wrapper">2.3吨力</font><div class="sgc-translation">身体部位</div>'))+'</div>');
 assert.equal(messages.readChatMessages()[0].text,'2.3T\n车身件');
});
test('quoted original is excluded and actual reply survives',()=>{
 page('<div id="main">'+wrap('c',text('<div data-testid="quoted-message">Old price</div>Too expensive'))+'</div>');
 assert.equal(messages.readChatMessages()[0].text,'Too expensive');
});
test('fingerprint changes for edited text, corrected direction and hydration with same IDs',()=>{
 const m={id:'m',fromMe:false,text:'Oui',timestamp:1,sender:null};
 for(const patch of [{text:'Non'},{fromMe:true},{timestamp:2}]) assert.notEqual(messages.chatFingerprint([m]),messages.chatFingerprint([{...m,...patch}]));
});
test('generation hydrates recent shells before returning a complete snapshot',async()=>{
 const doc=page('<div id="main">'+wrap('ask',shell)+wrap('confirm',text('Oui'))+'</div>');
 doc.querySelector('[data-id="ask"]').scrollIntoView=function(){this.innerHTML=text('Abidjan?',true);};
 const got=await snapshot.collectRecentChatMessages(()=>true);
 assert.deepEqual(got.map(m=>m.text),['Abidjan?','Oui']);
});
test('switching customer during hydration stops instead of returning foreign data',async()=>{
 const doc=page('<div id="main">'+wrap('ask',shell)+'</div>'); let same=true;
 doc.querySelector('[data-id="ask"]').scrollIntoView=()=>{same=false;};
 await assert.rejects(snapshot.collectRecentChatMessages(()=>same),/客户已切换/);
});
test('missing hydrated row is explicit, never silently treated as no messages',async()=>{
 const doc=page('<div id="main">'+wrap('ask',shell)+'</div>');
 doc.querySelector('[data-id="ask"]').scrollIntoView=()=>{};
 await assert.rejects(snapshot.collectRecentChatMessages(()=>true),/未加载完整/);
});
test('act gets application clock even if model omits time or invents owner timing; evidence still required',()=>{
 const ctx={evidence:[{id:'m',role:'customer',text:'Puerto río haina'}],tasks:[]};
 const d={decision:'act',title:'核对并发送报价',reason:'港口已确认，草稿待发送',dueAt:null,timeBasis:'owner',evidence:[{id:'m',quote:'Puerto río haina'}],existingTaskId:null};
 const encode=x=>'<crm_followup>'+JSON.stringify(x)+'</crm_followup>';
 const now=Date.parse('2026-09-18T18:35:42Z');
 const parsed=follow.extractFollowup(encode(d),ctx,now).decision;
 assert.equal(parsed.timeBasis,'gpt'); assert.equal(parsed.dueAt,new Date(now).toISOString());
 assert.throws(()=>follow.extractFollowup(encode({...d,evidence:[{id:'m',quote:'tomorrow'}]}),ctx,now),/真实消息/);
 assert.throws(()=>follow.extractFollowup(encode({...d,decision:'review'}),ctx,now),/时间/);
});
test('quote display uses exact conversation AND message binding, never a previous quote for a new turn',()=>{
 const doc=page('<div data-message-author-role="assistant" data-message-id="a">USD {{quote.1.totalUsd}}</div><div data-message-author-role="assistant" data-message-id="b">USD {{quote.1.totalUsd}}</div>');
 const entry={conversationId:'c',messageId:'a',reply:'USD 46,748.70',amounts:{'{{quote.1.totalUsd}}':'46,748.70'},savedAt:1};
 preview.renderQuotePreview(doc,'other',[entry]);
 assert.doesNotMatch(doc.body.textContent,/46,748/);
 preview.renderQuotePreview(doc,'c',[entry]);
 assert.match(doc.querySelector('[data-message-id="a"]').textContent,/USD 46,748.70/);
 assert.match(doc.querySelector('[data-message-id="b"]').textContent,/待CRM核算/);
 assert.match(doc.querySelector('[data-message-id="b"]').textContent,/\{\{quote/);
 preview.renderQuotePreview(doc,'c',[entry]);
 assert.equal(doc.querySelectorAll('[data-sgc-quote-preview]').length,2);
});
test('new inbound, sent photos, and same-ID edits stale the draft; missing viewport history does not',()=>{
 const m={id:'a',fromMe:false,text:'Abidjan?',timestamp:10,sender:null};const s=freshness.snapshotDraftEvidence([m]);
 assert.equal(freshness.draftHasNewEvidence(s,[]),false);
 assert.equal(freshness.draftHasNewEvidence(s,[m]),false);
 for(const x of [{...m,id:'b',text:'Oui',timestamp:11},{...m,id:'c',text:'[图片]',fromMe:true,timestamp:11},{...m,text:'Dakar'}]) assert.equal(freshness.draftHasNewEvidence(s,[x]),true);
 assert.equal(freshness.draftHasNewEvidence(s,[{...m,id:'old',timestamp:1}]),false);
});
test('confirmed Dominican country overrides Curacao phone; unknown confirmed country is not silently overridden',()=>{
 const now=new Date('2026-09-18T18:00:00Z');
 assert.equal(time.localTimeForPhone('+59995227018',now,'República Dominicana').timezone,'America/Santo_Domingo');
 assert.equal(time.localTimeForPhone('+59995227018',now).timezone,'America/Curacao');
 assert.equal(time.localTimeForPhone('+59995227018',now,'unrecognized country'),null);
});
