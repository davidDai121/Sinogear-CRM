import assert from 'node:assert/strict';import test from 'node:test';import {build} from 'esbuild';import {parseHTML} from 'linkedom';
const r=await build({entryPoints:['src/content/whatsapp-expand-messages.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {expandRenderedMessages:expand}=await import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64'));
test('expands numbered long inquiry before capture without clicking ordinary links or unrelated controls',async()=>{
 const {document}=parseHTML('<main><button>Read more</button><div data-testid="conv-msg-1"><span class="text">1. Year 2. Spec 3. Docs</span><span role="button">查看更多</span><a>Read more</a></div></main>');
 const main=document.querySelector('main');let count=0;const more=main.querySelector('[role=button]');more.onclick=()=>{count++;main.querySelector('.text').textContent+=' 4. Handling 5. Freight 6. Insurance 7. Warranty 8. AT tires';more.remove()};
 main.querySelector('button').onclick=()=>{throw Error('outside message')};main.querySelector('a').onclick=()=>{throw Error('customer link')};
 await expand(main,()=>{},async()=>{});assert.equal(count,1);assert.match(main.querySelector('.text').textContent,/8. AT tires/);
});
test('blocked expansion fails instead of returning incomplete content',async()=>{
 const {document}=parseHTML('<main><div data-testid="conv-msg-1"><button>Read more</button></div></main>');await assert.rejects(expand(document.querySelector('main'),()=>{},async()=>{}),/尚未展开完整/);
});
test('customer switching interrupts expansion before any click',async()=>{
 const {document}=parseHTML('<main><div data-testid="conv-msg-1"><button>Leer más</button></div></main>');let clicks=0;document.querySelector('button').onclick=()=>clicks++;
 await assert.rejects(expand(document.querySelector('main'),()=>{throw Error('changed')},async()=>{}),/changed/);assert.equal(clicks,0);
});
test('supports rendered bubble containers and directional marks without conv-msg ancestry',async()=>{
 const {document}=parseHTML('<main><div data-id="message-real-id"><span tabindex="0" role="button">…\u200e查看更多\u200f</span></div></main>');let clicked=0;const btn=document.querySelector('[role=button]');btn.onclick=()=>{clicked++;btn.remove()};await expand(document.querySelector('main'),()=>{},async()=>{});assert.equal(clicked,1);
});
test('current WhatsApp caption-read-more-button is recognized by stable testid',async()=>{
 const {document}=parseHTML('<main><div data-testid="conv-msg-real"><div role="button" tabindex="0" data-testid="caption-read-more-button" class="read-more-button">\u200b查看更多\u200b</div></div></main>');let clicked=0;const btn=document.querySelector('[role=button]');btn.onclick=()=>{clicked++;btn.remove()};await expand(document.querySelector('main'),()=>{},async()=>{});assert.equal(clicked,1);
});
