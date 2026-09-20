import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
async function bundle(path) {
 const b=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});
 return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
}
const {classifySalesPreferences:classify,resolveSalesPreferences:resolve,loadSalesPreferences:load,rememberSalesPreferences:remember,saveSalesPreference:save,renderSalesPreferences:render}=await bundle('src/lib/sales-preferences.ts');
const {partitionHistoricalGuidance:partition}=await bundle('src/lib/sales-history-identity.ts');
const base={id:'p1',at:'2026-09-18T01:00:00Z',orgId:'org',userId:'user',contactId:'a',scopeId:'order-a',scope:'order',topic:'length',text:'回复简短',sourceText:'回复简短',sourceEntryId:'source',active:true};
test('mixed guidance learns style without turning today’s quote into permanent policy',()=>{
 assert.deepEqual(classify('以后回复简短，今天报4台，车价14000美元'),[{scope:'personal',topic:'length',text:'以后回复简短'}]);
 assert.deepEqual(classify('这个客户直接报价别绕'),[{scope:'customer',topic:'quote-style',text:'这个客户直接报价别绕'}]);
 assert.equal(classify('直接报价别绕')[0].scope,'order');
 assert.equal(classify('这个客户以后每次回复都简短')[0].scope,'customer');
});
test('one-off commands, quoted customer wishes, and business facts do not become preferences',()=>{
 for(const source of ['这次简短一点','先别问','改短','你确定吗','保修3年','运费11000美元','客户说，以后回复英文','客户要求以后都用英语','翻译：以后回复简短']) assert.deepEqual(classify(source),[],source);
 assert.equal(classify('这个客户叫 my friend')[0].topic,'address');
 assert.equal(classify('别用危险品这个词')[0].topic,'cargo-wording');
});
test('scope and actor filtering: new demand retains customer/personal but not old order',()=>{
 const rows=[base,{...base,id:'p2',scope:'customer',topic:'tone'},{...base,id:'p3',scope:'personal',topic:'address'}];
 assert.equal(resolve(rows,'a','order-a').length,3);
 assert.equal(resolve(rows,'a','new').length,2);
 assert.equal(resolve(rows,'b','new').length,1);
 const off={...base,id:'p4',at:'2026-09-18T02:00:00Z',active:false};
 assert.equal(resolve([...rows,off],'a','order-a').find(p=>p.topic==='length').active,false);
 assert.match(render([off]),/"active":false/);
});
function dbStore(){
 const tables={contacts:[{id:'a',org_id:'org'},{id:'b',org_id:'other'}],contact_events:[]};
 const db={tables,user:'user',fail:false,auth:{async getUser(){return {data:{user:{id:db.user}},error:null};}},from(table){let filters=[],one=false,range=[0,Infinity],insert;
 const q={select(){return q;},eq(k,v){filters.push(r=>k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]]===v : r[k]===v);return q;},contains(k,v){filters.push(r=>Object.keys(v).every(key=>r[k]?.[key]===v[key]));return q;},order(){return q;},range(a,b){range=[a,b];return q;},single(){one=true;return q;},insert(x){insert=x;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
 if(db.fail)return {data:null,error:{message:'offline'}};
 if(insert){tables[table].push({...structuredClone(insert),created_at:new Date(1700000000000+tables[table].length*1000).toISOString()});return {error:null};}
 const rows=tables[table].filter(r=>filters.every(f=>f(r))).slice(range[0],range[1]+1);return {data:structuredClone(one?rows[0]??null:rows),error:null};
 }).then(resolve,reject);}};return q;}};return db;
}
test('database persistence, revocation and duplicate original instruction survive a new read',async()=>{
 const db=dbStore();const ctx={orgId:'org',userId:'user',contactId:'a',scopeId:'a',sourceText:'以后回复简短',sourceEntryId:'entry1'};
 await remember(db,ctx,[]);let p=await load(db,'org','user','a','a');assert.equal(p.length,1);assert.equal(p[0].scope,'personal');
 await remember(db,ctx,p);assert.equal(db.tables.contact_events.length,1);
 const {id,at,...value}=p[0];await save(db,{...value,active:false});p=await load(db,'org','user','a','a');assert.equal(p[0].active,false);
 await remember(db,ctx,p);assert.equal(db.tables.contact_events.length,2);
 assert.equal((await load(db,'org','other-user','a','a')).length,0);
 assert.equal((await load(db,'other-org','user','a','a')).length,0);
 await remember(db,{...ctx,sourceEntryId:'entry2'},p);assert.equal((await load(db,'org','user','a','a'))[0].active,true);
 db.user='other-user';await assert.rejects(save(db,value),/身份/);
 db.user='user';await assert.rejects(save(db,{...value,contactId:'b'}),/所属/);
 db.fail=true;await assert.rejects(load(db,'org','user','a','a'),/读取/);
});
const row=(id,text,thread='t',at=id)=>({id,payload:{text,sourceThread:thread,sourceAt:at}});
test('foreign customer introduction isolates its follow-on quotes, never a mere foreign phone or port',()=>{
 const rows=[row('1','我有个委内瑞拉的客户，电话+58 412-2611301'),row('2','上海到委内瑞拉，运费11000USD'),row('3','车价14000，直接出cif'),row('4','货代电话+58 412-2611301','other')];
 const p=partition(rows,'+573246874685');assert.deepEqual(p.quarantined.map(x=>x.id),['1','2','3']);assert.deepEqual(p.accepted.map(x=>x.id),['4']);
 assert.equal(partition([row('1','这个客户的收货人电话+58 412-2611301')],'+573246874685').quarantined.length,0);
 assert.equal(partition([row('1','目的港La Guaira，电话+58 412-2611301')],'+573246874685').quarantined.length,0);
 assert.equal(partition(rows,null).quarantined.length,0);
 assert.equal(partition(rows,'+584122611301').quarantined.length,0);
});
test('explicit identity switch ends quarantine; archive import timestamp alone does nothing',()=>{
 const rows=[row('1','我有个别的客户，电话+58 412-2611301'),row('2','现在的客户电话+57 3246874685'),row('3','请直接报价')];
 const p=partition(rows,'+573246874685');assert.equal(p.quarantined.length,1);assert.equal(p.accepted.length,2);
 assert.equal(partition([row('1','回复简短')],'+573246874685').accepted.length,1);
});
