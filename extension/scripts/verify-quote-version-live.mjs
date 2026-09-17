import {config} from 'dotenv';import {createClient} from '@supabase/supabase-js';import {build} from 'esbuild';import {randomUUID} from 'node:crypto';import fs from 'node:fs';
config({path:'.env',quiet:true});
const db=createClient(process.env.VITE_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),org=process.env.ORG_ID,id='cf9834b7-0ea5-4e05-b6f8-48ef92733bd2';
const {data:c,error}=await db.from('contacts').select('id,org_id,phone').eq('id',id).eq('org_id',org).single();if(error||c.phone!=='+8613552592187')throw Error('Test identity mismatch');
console.log(JSON.stringify({dryRun:true,contact:id,phone:c.phone,actions:['create isolated demand','save two quote revisions','retry first ID without duplicate','verify scope and source readback','delete only exact test IDs','restore original scope'],noMessageOrCustomerStateWrites:true}));
if(!process.argv.includes('--apply'))process.exit();
const mod=async p=>{const b=await build({entryPoints:[p],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
const {loadSalesWorkMemory:load,saveSalesWorkEntry:save}=await mod('src/lib/sales-work-memory.ts');const {saveQuoteVersion:saveVersion}=await mod('src/lib/quote-workflow.ts');const {calculateQuote}=await mod('src/lib/quote-calculation.ts');
const before=await load(db,org,id),ids=[randomUUID(),randomUUID(),randomUUID()],scopeId=ids[0],at=new Date().toISOString();
const input={schema:'quote-input.v1',origin:'Shanghai',destination:'TEST ONLY La Guaira',fx:null,plans:[{label:'两台同柜测试',model:'R08 EV510',quantity:2,propulsion:'bev',shippingMode:'container',containers:1,loadingBasis:'隔离测试假设',vehicle:{basis:'approved_fob',amount:'25000',currency:'USD',source:'测试授权不是实际报价',groundIncluded:true},freight:{amountUsd:'11000',source:'测试模拟数据',dgIncluded:false,groundIncluded:false,checkedAt:at,validUntil:null,kind:'owner_estimate'},profit:null,groundOverride:null,insurance:null,fixedSelling:null}]};
let report;
try{
 await save(db,org,id,{id:scopeId,scopeId,kind:'scope',text:'隔离报价版本测试，完成即清理'});
 const first={schema:'quote-calculation.v1',scopeId,parentId:null,status:'draft',authority:'arithmetic_verified_inputs_require_sources',input:structuredClone(input),result:calculateQuote(input),summary:'第一版测试',chatUrl:'https://chatgpt.com/c/test-only',computedAt:at};
 await saveVersion(db,org,id,ids[1],first);await saveVersion(db,org,id,ids[1],first);
 input.plans[0].freight.amountUsd='10000';const second={...first,parentId:ids[1],input,result:calculateQuote(input),summary:'第二版测试'};await saveVersion(db,org,id,ids[2],second);
 const got=await load(db,org,id);if(got.quoteVersions.length!==2||got.quoteVersions[0].payload.result[0].totalUsd!=='62000.00'||got.quoteVersions[1].payload.result[0].totalUsd!=='61000.00'||got.quoteVersions[1].payload.parentId!==ids[1])throw Error('Version readback failed');
 report={passed:true,ids,readback:got.quoteVersions,firstRetryIdempotent:true,credentials:'bounded service-role test; does not establish authenticated RLS'};
}finally{
 console.log(JSON.stringify({cleanupExactIds:ids,contact:id}));
 const {data:rows,error:r}=await db.from('contact_events').select('id,payload').eq('contact_id',id).in('id',ids);if(r||rows.some(x=>x.payload.scopeId!==scopeId))throw Error('Cleanup identity mismatch');
 const {error:d}=await db.from('contact_events').delete().eq('contact_id',id).in('id',rows.map(x=>x.id));if(d)throw d;
 const after=await load(db,org,id);if(after.scopeId!==before.scopeId||after.quoteVersions.length!==before.quoteVersions.length)throw Error('Original scope not restored');
}
fs.mkdirSync('../分析导出/历史指导回填_2026-09-17',{recursive:true});fs.writeFileSync('../分析导出/历史指导回填_2026-09-17/报价版本真实数据库验证.json',JSON.stringify(report,null,2));console.log({passed:true,cleaned:true});
