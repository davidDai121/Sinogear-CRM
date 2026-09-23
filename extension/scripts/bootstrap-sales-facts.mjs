// Build a reviewable, deterministic import from existing source snapshots.
// Default is dry-run. --apply inserts only new dedupe keys; never overwrites facts.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { build } from 'esbuild';
const env = parse(fs.readFileSync('.env'));
const dir = '../分析导出/事实库_2026-09-18';
const read = name => JSON.parse(fs.readFileSync(`${dir}/${name}`));
const { templates, vehicles } = read('模板与车源快照.json');
const events = read('销售指导与运费来源.json');
const reviewed = read('Claude候选事实.json').facts;
const compiled = await build({ entryPoints: ['src/lib/sales-history-identity.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { partitionHistoricalGuidance } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const sha = s => createHash('sha256').update(s).digest('hex');
const facts = []; const excluded = [];
function add(f) {
  const row = { org_id: env.ORG_ID, scope: 'product', product_key: 'r08', contact_id: null, scope_id: null,
    valid_until: null, status: 'approved', authority: 'approved_template', ...f };
  if (!row.source?.ref || !row.source?.quote || !row.statement || row.statement.length > 6000) throw Error(`Invalid fact ${row.title}`);
  row.dedupe_key = sha(JSON.stringify([row.source.ref, row.fact_key, row.scope, row.contact_id, row.scope_id, row.value, row.statement]));
  const hex = row.dedupe_key; row.id = `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  facts.push(row);
}
const template = name => {
  const t = templates.find(t => t.name === name);
  if (!t) throw Error(`Missing template ${name}`);
  return { ...t, metadata: JSON.parse(t.description.split('\n').slice(1).join('\n')) };
};
const r08 = template('R08 专用 · Miles'); const company = template('Miles V2');
const approved = r08.metadata.approvedKnowledge;
const source = (t, quote) => {
  if (!t.metadata.approvedKnowledge.includes(quote)) throw Error(`Quote mismatch: ${quote}`);
  return { ref: `crm:gpt_templates:${t.id}`, quote, version: t.metadata.updatedAt, kind: 'approved_template' };
};
for (const m of approved.matchAll(/^\|\s*([^|]+?)\s*\|\s*([\d,]+)\s*\|$/gm)) {
  const [line, variant, amount] = m;
  add({ fact_key: `price.r08.${sha(variant).slice(0,12)}`, category: 'price', title: `R08 ${variant} FOB参考价`,
    statement: `${variant}：USD ${amount}/台，FOB上海参考价。`, value: { amount: Number(amount.replaceAll(',', '')), currency: 'USD', unit: 'vehicle', incoterm: 'FOB', origin: 'Shanghai', variant, basis: 'approved_fob', kind: 'base_price_list' },
    source: source(r08, line), observed_at: '2026-09-16T00:00:00Z' });
}
const items = [
  [1,'quote.validity','price'], [2,'loading.r08','logistics'], [6,'warranty.coverage','warranty'],
  [8,'warranty.maintenance_pack','warranty'], [9,'warranty.parts','warranty'], [10,'warranty.remote_support','warranty'],
  [11,'price.r08.charging_accessories','price'], [13,'logistics.cif_scope','logistics'], [14,'logistics.single_unit','logistics'],
];
for (const [i, key, category] of items) {
  const f = reviewed[i];
  // Copy the actual source paragraph, not Claude's paraphrase as authority.
  const quote = approved.split('\n').find(line => line.includes(f.exactQuote))
    ?? approved.split('\n').find(line => i===8 ? line.includes('保养包按订单确认') : i===9 ? line.includes('配件')&&line.includes('成本') : i===10 ? line.includes('远程售后技术指导') : i===11 ? line.includes('1,000') : i===13 ? line.includes('可以提供 CIF') : i===14 ? line.includes('优先评估滚装') : false);
  if (!quote) throw Error(`Source paragraph not found: ${f.title}`);
  add({ fact_key:key, category, title:f.title, statement:f.text, value:f.structuredValue,
    source:source(r08,quote), observed_at:'2026-09-16T00:00:00Z' });
}
const paymentQuote = company.metadata.approvedKnowledge.split('\n').find(l => l.startsWith('1. **付款节点**'));
add({ fact_key:'payment.standard', category:'payment', scope:'org', product_key:null, title:reviewed[3].title,
  statement:paymentQuote, value:{depositPercent:30,balancePercent:70,balanceDue:'before_departure_from_China'}, source:source(company,paymentQuote), observed_at:'2026-09-16T00:00:00Z' });
// These current global owner authorizations are already reflected in the calculator.
const policyPath = '/Users/yang/.codex/skills/sino-gear-quote/SKILL.md';
const policy = fs.readFileSync(policyPath,'utf8');
for (const [key,category,title,needle,value] of [
  ['insurance.reference','insurance','CIF保险参考预算：总运输费用10%','2026-09-18最新CIF通用公式', { basis:'freight_10_percent', percent:10, destinationTaxesIncluded:false }],
  ['logistics.ground','logistics','港杂/装箱地面合并预算，只计一次','2026-09-18老板补充', { fuelCnyPerVehicle:2000, bevCnyPerVehicle:3000, phevDefault:null, alreadyIncludedDoNotAdd:true }],
  ['logistics.dg','logistics','纯电集装箱DG参考预算','老板批准纯电集装箱DG估算', { bevUsdPerContainer:1000, onlyWhenNotIncluded:true, appliesTo:'BEV container only', perVehicle:false }],
  ['logistics.origin','logistics','默认上海起运；运费按需核查','仅在本轮报价需要运费时检查', { defaultOrigin:'Shanghai', freightReuseMaxDays:7, noBackgroundResearch:true }],
]) {
  const quote=policy.split('\n').find(l=>l.startsWith(needle)); if(!quote)throw Error(needle);
  add({fact_key:key,category,scope:'org',product_key:null,title,statement:quote,value,authority:'owner_statement',
    source:{ref:policyPath,quote,kind:'recorded_owner_policy',datePrecision:'day'},observed_at:'2026-09-18T00:00:00Z'});
}
const byId = Object.fromEntries(events.map(e=>[e.id,e]));
function orderFact(id, key, category, title, statement, value) {
  const e=byId[id]; if(!e||!e.payload.text.includes(statement))throw Error(`Source mismatch ${id} ${statement}`);
  add({fact_key:key,category,scope:'order',product_key:null,contact_id:e.contact_id,scope_id:e.payload.scopeId,
    title,statement,value,authority:'owner_statement',source:{ref:`crm:contact_events:${id}`,quote:e.payload.text,kind:'owner_instruction',contactId:e.contact_id},observed_at:new Date(e.created_at).toISOString()});
}
const didace='5468a33a-726c-4aa4-896b-c0106c55f09e';
orderFact(didace,'logistics.production','logistics','Didace：2026年生产，15个工作日排产','2026年生产，排产周期15个工作日',{productionYear:2026,preparationWorkingDays:15});
orderFact(didace,'warranty.coverage','warranty','Didace：三大件清单','我们保修3大件，引擎变速箱和底盘',{components:['engine','transmission','chassis'],term:'沿用R08已批准1年店保'});
orderFact(didace,'warranty.maintenance_pack','warranty','Didace：可随车提供的保养包','我们可以随车给你保养包，包括滤芯雨刷，刹车',{items:['filters','wipers','brakes'],freeOfCharge:null});
orderFact(didace,'price.at_tire_pack','price','Didace：AT轮胎包报价','2000美金at轮胎包',{amount:2000,currency:'USD',unit:'package',brand:null,size:null,quantity:null});
orderFact('358509b9-fa67-42e4-aee3-2257c1248092','loading.r08','logistics','Didace：每柜最多两台','每个柜子只能装2台',{maxVehiclesPerContainer:2});
// A newer price list explicitly limited to José Silvano's current order.
const special=byId['95342631-51bc-46cf-a136-c3648f737896'];
for(const m of special.payload.text.matchAll(/^\|\s*(柴油[^|]*|汽油[^|]*)\|\s*([^|]+)\|\s*([^|]+)\|\s*(\d+)\s*\|$/gm)) {
  orderFact(special.id,`price.r08.order.${sha(m[1]+m[2]+m[3]).slice(0,12)}`,'price',`José Silvano本单：${m[1].trim()} ${m[2].trim()} ${m[3].trim()}`,m[0],
    {amount:Number(m[4]),currency:'USD',unit:'vehicle',incoterm:'FOB',origin:'Shanghai',variant:`${m[1].trim()} ${m[2].trim()} ${m[3].trim()}`,emissions:null,basis:'approved_fob',kind:'order_price_list',product:'r08'});
}
// Preserve source-rich history as reference/candidates, never general company rules.
const quarantined=new Set();
for(const contactId of new Set(events.map(e=>e.contact_id))) {
  const rows=events.filter(e=>e.contact_id===contactId&&e.payload.schema==='sales-history.v1');
  const result=partitionHistoricalGuidance(rows,rows[0]?.phone);
  result.quarantined.forEach(e=>{quarantined.add(e.id);excluded.push({id:e.id,reason:e.reason});});
}
const categories=[['freight',/运费|海运|freight/i],['price',/报价|价格|\bfob\b|\bcif\b|\bexw\b/i],['payment',/定金|尾款|付款|payment|deposit/i],['warranty',/保修|保养包|warrant/i]];
// Preserve route/quantity/cargo/charge scope separately from narrative reports.
// Only an exact owner source containing the same amount can make a rate approved.
for(const e of events.filter(e=>e.payload.schema==='quote-calculation.v1')) {
  for(const plan of e.payload.input?.plans??[]) {
    const f=plan.freight;if(!f?.amountUsd||!f.checkedAt)continue;
    const ownerId=String(f.source).match(/owner:([a-f0-9-]{36})/i)?.[1];
    const owner=ownerId?byId[ownerId]:null;
    const ownerApproved=owner?.contact_id===e.contact_id && owner.payload.kind==='sales_instruction'
      && new RegExp(`(^|[^0-9])${f.amountUsd}([^0-9]|$)`).test(owner.payload.text)
      && /roro|滚装/i.test(owner.payload.text) && plan.shippingMode==='roro';
    const at=new Date(ownerApproved?owner.created_at:f.checkedAt).toISOString();
    const expiry=new Date(Math.min(Date.parse(at)+7*86400000,f.validUntil?Date.parse(f.validUntil):Infinity)).toISOString();
    const origin=e.payload.input.origin, destination=e.payload.input.destination;
    const type=String(f.source).match(/\b(20GP|40HQ|40HC)\b/i)?.[1]?.toUpperCase()??null;
    add({fact_key:`freight.${sha(JSON.stringify([origin,destination,plan.propulsion,plan.shippingMode,type,plan.quantity,plan.containers])).slice(0,20)}`,
      category:'freight',scope:'order',product_key:null,contact_id:e.contact_id,scope_id:e.payload.scopeId,
      title:`${origin}→${destination} · ${plan.shippingMode==='roro'?'滚装':type??'集装箱'} · ${plan.quantity}台`,
      statement:`本单${plan.quantity}台${plan.model}，${origin}→${destination}运输参考 USD ${f.amountUsd}。${ownerApproved?'来自本单销售原话。':'源自历史核算提取，尚未独立核验报价来源。'}`,
      value:{amountUsd:f.amountUsd,currency:'USD',unit:'order_shipment',origin,destination,model:plan.model,quantity:plan.quantity,propulsion:plan.propulsion,
        shippingMode:plan.shippingMode,containerType:type,containers:plan.containers,checkedAt:at,
        dgIncluded:ownerApproved?null:f.dgIncluded,groundIncluded:ownerApproved?null:f.groundIncluded,sourceRate:f.source,kind:ownerApproved?'owner_estimate':f.kind},
      status:ownerApproved?'approved':'reference',authority:ownerApproved?'owner_statement':'model_research',observed_at:at,valid_until:expiry,
      source:{ref:`crm:contact_events:${ownerApproved?ownerId:e.id}`,quote:ownerApproved?owner.payload.text:JSON.stringify(plan.freight),
        kind:ownerApproved?'owner_instruction':'quote_extraction',contactId:e.contact_id,quoteRecordId:e.id}});
  }
}
for(const e of events) {
  if(quarantined.has(e.id))continue;
  let text=e.payload.text;
  if(e.payload.schema==='quote-calculation.v1') {
    // Model-extracted inputs are not proof of approval. Keep as a scoped reference.
    text=JSON.stringify({input:e.payload.input,result:e.payload.result});
  }
  if(typeof text!=='string'||!/[0-9]/.test(text)||text.includes('验收测试'))continue;
  const category=e.payload.kind==='freight_lookup'?'freight':e.payload.schema==='quote-calculation.v1'?'price':categories.find(([,re])=>re.test(text))?.[0];
  if(!category)continue;
  const sourceDate=e.payload.sourceAt??e.created_at;
  const at=new Date(sourceDate).toISOString();
  // Long source is retained in source.quote; the current fact itself is compact.
  add({fact_key:`history.${e.id}`,category,scope:'order',product_key:null,contact_id:e.contact_id,
    scope_id:e.payload.scopeId??`legacy-conversation:${e.payload.sourceThread}`,
    title:`${e.name||'客户'} · ${category==='freight'?'历史运费':'历史业务记录'}`,
    statement:text.length>5800?text.slice(0,5800)+'\n（完整原话见来源）':text,
    value:{sourceEventId:e.id,originalScope:e.payload.scope??'current_order',requiresSourceReview:true},
    status:e.payload.kind==='freight_lookup'?'candidate':'reference',
    authority:e.payload.kind==='freight_lookup'||e.payload.schema==='quote-calculation.v1'?'model_research':'owner_statement',
    source:{ref:`crm:contact_events:${e.id}`,quote:text,kind:e.payload.schema,chatUrl:e.payload.sourceChatUrl??e.payload.chatUrl??null,contactId:e.contact_id},observed_at:at});
}
// Inventory has no approved vehicle prices; do not turn a suspicious 0.03 into a car price.
for(const v of vehicles)if(v.base_price!=null||v.pricing_tiers?.length)excluded.push({id:v.id,reason:`车源价格字段需核对用途：${v.model} ${v.base_price??''} ${v.currency}`});
const unique=[...new Map(facts.map(f=>[f.dedupe_key,f])).values()];
fs.writeFileSync(`${dir}/事实导入计划.json`,JSON.stringify({generatedAt:new Date().toISOString(),facts:unique,excluded},null,2));
console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'dry-run',count:unique.length,
  statuses:unique.reduce((a,f)=>{a[f.status]=(a[f.status]||0)+1;return a;},{}),excluded},null,2));
if(process.argv.includes('--apply')) {
  const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=representation'};
  let inserted=0;
  for(let i=0;i<unique.length;i+=50){const r=await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/sales_facts?on_conflict=org_id,dedupe_key`,{method:'POST',headers,body:JSON.stringify(unique.slice(i,i+50))});if(!r.ok)throw Error((await r.text()).slice(0,500));inserted+=(await r.json()).length;}
  fs.writeFileSync(`${dir}/导入结果.json`,JSON.stringify({inserted,at:new Date().toISOString()},null,2));console.log({inserted});
}
