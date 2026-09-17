import fs from 'node:fs';
import {build} from 'esbuild';
import dotenv from 'dotenv';
import {createClient} from '@supabase/supabase-js';
dotenv.config({quiet:true});
const db=createClient(process.env.VITE_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const contactId='cf9834b7-0ea5-4e05-b6f8-48ef92733bd2',orgId=process.env.ORG_ID;
const dir='../分析导出/GPT跟进验收_2026-09-17';
const {data:contact,error}=await db.from('contacts').select('id,org_id,phone,name,country,language,budget_usd,customer_stage,quality,destination_port,notes').eq('id',contactId).eq('org_id',orgId).single();
if(error||contact.phone.replace(/\D/g,'')!=='8613552592187')throw Error('Test identity mismatch');
async function all(table,select,extra){const out=[];for(let from=0;;from+=200){let q=db.from(table).select(select).eq('contact_id',contactId).order('id').range(from,from+199);if(extra)q=extra(q);const r=await q;if(r.error)throw r.error;out.push(...r.data);if(r.data.length<200)return out;}}
const [events,tasks,conversations]=await Promise.all([all('contact_events','id,event_type,payload,created_at'),all('tasks','*',q=>q.eq('org_id',orgId)),all('gpt_conversations','*')]);
if(process.argv.includes('--snapshot')){const path=dir+'/before.json';if(fs.existsSync(path))throw Error('Snapshot exists');fs.writeFileSync(path,JSON.stringify({at:new Date().toISOString(),contact,events,tasks,conversations},null,2));console.log(JSON.stringify({testContact:contact.phone,events:events.length,tasks:tasks.length,action:'只允许通过测试号CRM界面新增隔离需求和跟进任务；不发送WhatsApp，最后按新增scope/taskID精确清理'},null,2));}
else{const before=JSON.parse(fs.readFileSync(dir+'/before.json'));const added=events.filter(x=>!before.events.some(b=>b.id===x.id));fs.writeFileSync(dir+'/readback.json',JSON.stringify({at:new Date().toISOString(),contact,added,tasks,conversations},null,2));console.log(JSON.stringify({sameContact:JSON.stringify(contact)===JSON.stringify(before.contact),added:added.map(e=>({id:e.id,scope:e.payload.scopeId,schema:e.payload.schema,kind:e.payload.kind,decision:e.payload.decision,phase:e.payload.phase,taskId:e.payload.taskId,text:e.payload.text?.slice(0,900)})),tasks},null,2));}

if(process.argv.includes('--protection')) {
 const b=await build({entryPoints:['src/lib/gpt-followup.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const f=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
 const task=tasks.find(t=>t.id==='11aafe93-d008-5b13-a9de-c88c0e1b6428');
 if(!task || task.status!=='open' || task.due_at!=='2026-09-25T19:00:00+00:00')throw Error('先通过测试号任务界面手动改期到约定测试日期');
 db.auth.getUser=async()=>({data:{user:{id:task.created_by}},error:null}); // service-role integration harness; no auth session is modified
 const ctx=await f.loadFollowupContext(db,orgId,contactId);
 if(ctx.scopeId!=='5f318488-6b44-4522-b4cf-993165b5c361'||ctx.previous?.decision.decision!=='stop')throw Error('自动到期结束尚未通过');
 const decision=f.extractFollowup('<crm_followup>'+JSON.stringify(ctx.previous.decision)+'</crm_followup>',ctx).decision;
 const plan=f.projectFollowup(ctx,decision,ctx.previous.templateId,ctx.previous.chatUrl);
 if(!plan.protected || !f.sameTask(plan.after,task))throw Error('人工保护未通过，禁止写入');
 const dry={orgId,contactId,scopeId:ctx.scopeId,taskId:task.id,stateKey:ctx.stateKey,task,plan,action:'调用真实保存模块两次，记录模型建议；人工改期后的任务保持原样，不新增第二个任务，不发送消息'};
 if(!process.argv.includes('--apply')){fs.writeFileSync(dir+'/protection-dry-run.json',JSON.stringify(dry,null,2));console.log(JSON.stringify(dry,null,2));}
 else {
  const expected=JSON.parse(fs.readFileSync(dir+'/protection-dry-run.json'));
  if(expected.stateKey!==ctx.stateKey)throw Error('dry-run后状态变化，重新核对');
  for(let i=0;i<2;i++){const c=await f.loadFollowupContext(db,orgId,contactId);await f.saveFollowup(db,c,decision,c.previous.templateId,c.previous.chatUrl);}
  const after=await all('tasks','*',q=>q.eq('org_id',orgId));
  if(after.length!==tasks.length||JSON.stringify(after)!==JSON.stringify(tasks))throw Error('任务发生非预期变化');
  fs.writeFileSync(dir+'/protection-result.json',JSON.stringify({at:new Date().toISOString(),passed:true,before:tasks,after,decision},null,2));console.log('真实库人工改期保护、重复保存去重通过');
 }
}
if(process.argv.includes('--cleanup')) {
 const before=JSON.parse(fs.readFileSync(dir+'/before.json'));
 const scopeId='5f318488-6b44-4522-b4cf-993165b5c361', taskId='11aafe93-d008-5b13-a9de-c88c0e1b6428';
 const remove=events.filter(e=>e.payload.scopeId===scopeId && ['sales-work.v1','gpt-followup.v1'].includes(e.payload.schema));
 if(remove.some(e=>before.events.some(b=>b.id===e.id)))throw Error('原记录不得清理');
 const task=tasks.find(t=>t.id===taskId);
 if(!task||task.title!=='人工接管测试：保持9月25日安排'||task.status!=='open'||task.due_at!=='2026-09-25T19:00:00+00:00')throw Error('测试任务已变化');
 const templateId='73bd63c7-44c4-4c16-b6f9-259fd2e68cc8';
 const original=before.conversations.find(c=>c.template_id===templateId);
 const current=conversations.find(c=>c.template_id===templateId);
 if(!original||current?.id!==original.id||!current.chat_url.startsWith('https://chatgpt.com/c/6aac3fdb-cd90-83ea-b351-86ef173c56f6'))throw Error('测试会话已被其他操作改变');
 const plan={contact,orgId,scopeId,task,remove,original,current};
 if(!process.argv.includes('--apply')) {
  fs.writeFileSync(dir+'/cleanup-plan.json',JSON.stringify(plan,null,2));
  console.log(JSON.stringify({action:'只清理本次测试范围，恢复测试号原GPT会话',contactId,orgId,task,eventIds:remove.map(e=>e.id),restoreChat:original.chat_url,baselineEvents:before.events.length},null,2));
 } else {
  const dry=JSON.parse(fs.readFileSync(dir+'/cleanup-plan.json'));
  if(JSON.stringify(dry)!==JSON.stringify(plan))throw Error('清理dry-run后状态变化');
  let r=await db.from('tasks').delete().eq('id',taskId).eq('org_id',orgId).eq('contact_id',contactId).eq('title',task.title).eq('status',task.status).eq('due_at',task.due_at).select('id');
  if(r.error||r.data?.length!==1)throw Error('测试任务清理失败');
  r=await db.from('gpt_conversations').update({chat_url:original.chat_url,last_used_at:original.last_used_at}).eq('id',original.id).eq('contact_id',contactId).eq('template_id',templateId).eq('chat_url',current.chat_url).select('id');
  if(r.error||r.data?.length!==1)throw Error('原会话恢复失败');
  r=await db.from('contact_events').delete().eq('contact_id',contactId).in('id',remove.map(e=>e.id)).contains('payload',{scopeId}).select('id');
  if(r.error||r.data?.length!==remove.length)throw Error('测试记录清理失败');
  const [remaining,finalTasks,finalConversations]=await Promise.all([all('contact_events','id,event_type,payload,created_at'),all('tasks','*',q=>q.eq('org_id',orgId)),all('gpt_conversations','*')]);
  if(before.events.some(b=>!remaining.some(e=>JSON.stringify(e)===JSON.stringify(b))))throw Error('原事件回读不一致');
  if(JSON.stringify(finalTasks)!==JSON.stringify(before.tasks)||JSON.stringify(finalConversations)!==JSON.stringify(before.conversations))throw Error('任务/会话恢复不一致');
  const result={at:new Date().toISOString(),passed:true,removedEventIds:remove.map(e=>e.id),removedTaskId:taskId,remainingEventCount:remaining.length,baselineEventCount:before.events.length,restoredConversations:finalConversations,finalTasks};
  fs.writeFileSync(dir+'/cleanup-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }
}
