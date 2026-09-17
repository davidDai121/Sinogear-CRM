// Only the authorized test contact; --apply performs a bounded save/read/delete test.
import {config} from 'dotenv';import {createClient} from '@supabase/supabase-js';
import {build} from 'esbuild';import {randomUUID} from 'node:crypto';import {writeFile,mkdir} from 'node:fs/promises';
config({path:'.env',quiet:true});
const db=createClient(process.env.VITE_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const org=process.env.ORG_ID;const id='cf9834b7-0ea5-4e05-b6f8-48ef92733bd2';
const {data:contact,error}=await db.from('contacts').select('id,phone,org_id').eq('id',id).eq('org_id',org).single();
if(error||contact?.phone!=='+8613552592187')throw Error('Test contact identity mismatch');
const plan={contact_id:id,phone:contact.phone,operations:['append isolated test scope','append owner instruction twice with same ID','append unapproved AI draft','read memory and tasks','delete only IDs created by this test','verify prior scope restored'],owner_instruction:'【隔离测试】本单柴油AT FOB17400美元，单台海运3000美元；客户只买一台。'};
console.log(JSON.stringify({dry_run:plan},null,2));
if(!process.argv.includes('--apply'))process.exit(0);
const bundled=await build({entryPoints:['src/lib/sales-work-memory.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {loadSalesWorkMemory:load,saveSalesWorkEntry:save,renderSalesWorkMemory:render}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const before=await load(db,org,id);const scopeId=randomUUID();const ids=[scopeId,randomUUID(),randomUUID()];let report;
try{
 await save(db,org,id,{id:ids[0],scopeId,kind:'scope',text:'隔离记忆回读测试，完成即清理'});
 const input={id:ids[1],scopeId,kind:'sales_instruction',text:plan.owner_instruction};await save(db,org,id,input);await save(db,org,id,input);
 await save(db,org,id,{id:ids[2],scopeId,kind:'assistant_draft',text:'【未批准旧AI草稿】另加4000人民币其他预留；客户可能购买两台。'});
 const memory=await load(db,org,id);
 if(memory.entries.length!==3||memory.scopeId!==scopeId||memory.entries.filter(e=>e.kind==='sales_instruction').length!==1)throw Error('Roundtrip mismatch');
 const prompt=render(memory);
 await mkdir('../分析导出/运费与客户记忆_2026-09-17',{recursive:true});
 await writeFile('../分析导出/运费与客户记忆_2026-09-17/真实回读提示.txt',prompt);
 report={passed:true,scopeId,entries:memory.entries.length,idempotent:true,taskCount:memory.tasks.length,credentials:'service role used only for bounded test contact; authenticated RLS not proven by this run'};
}finally{
 console.log(JSON.stringify({cleanup_exact_ids:ids,contact_id:id}));
 const {data:rows,error:readError}=await db.from('contact_events').select('id,payload').eq('contact_id',id).in('id',ids);
 if(readError||rows.some(r=>r.payload.schema!=='sales-work.v1'||r.payload.scopeId!==scopeId))throw Error('Cleanup identity check failed');
 if(rows.length){const {error}=await db.from('contact_events').delete().eq('contact_id',id).in('id',rows.map(r=>r.id));if(error)throw Error('Cleanup failed: '+error.message);}
 const after=await load(db,org,id);if(after.scopeId!==before.scopeId||after.entries.length!==before.entries.length)throw Error('Prior scope not restored');
 console.log('Prior test-contact memory restored. No stage, quote, task or message changed.');
}
await writeFile('../分析导出/运费与客户记忆_2026-09-17/数据库回读测试.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
