import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64');
const statusUrl = compile(await readFile(new URL('../src/lib/ad-lead-status.ts', import.meta.url), 'utf8'));
const { isUncontactedAdLead, hasMessageEvidence, LEAD_HANDLED_TAG, LEAD_NO_WHATSAPP_TAG } = await import(statusUrl);
const filterSource = (await readFile(new URL('../src/lib/filters.ts', import.meta.url), 'utf8'))
  .replace("from './ad-lead-status'", `from '${statusUrl}'`)
  .replace("import { getBrandOverride } from './brand-overrides';", 'const getBrandOverride = () => undefined;');
const filters = await import(compile(filterSource));

function lead(overrides = {}) {
  return { contact: {id:'test', customer_stage:'new',quality:'potential'}, chat:null,
    isAdLead:true,hasMessageHistory:false,lastOutboundT:null,tags:[],labels:[],vehicleInterests:[],
    region:'other',classification:null,pinned:false, ...overrides };
}

test('name characters do not determine contact history', () => {
  for(const name of ['Normal Name','@homotru','S@MU3L','customer@example.com','🌸客户']) {
    assert.equal(isUncontactedAdLead(lead({displayName:name})),true);
    assert.equal(isUncontactedAdLead(lead({displayName:name,hasMessageHistory:true})),false);
  }
});

test('history without a local chat, including undated media and inbound-only, stays out', () => {
  assert.equal(isUncontactedAdLead(lead({hasMessageHistory:true,lastOutboundT:null})),false);
  assert.equal(isUncontactedAdLead(lead({lastOutboundT:1780000000})),false);
  assert.equal(hasMessageEvidence({inboundCount:1,outboundCount:0,lastInboundT:null,lastOutboundT:null}),true);
  assert.equal(hasMessageEvidence({inboundCount:0,outboundCount:1,lastInboundT:null,lastOutboundT:null}),true);
  assert.equal(hasMessageEvidence({inboundCount:0,outboundCount:0,lastInboundT:null,lastOutboundT:null}),false);
  assert.equal(hasMessageEvidence(undefined),false);
});

test('manual handling persists across serialization and is reversible without deleting details', () => {
  for(const tag of [LEAD_HANDLED_TAG,LEAD_NO_WHATSAPP_TAG]) {
    const saved=JSON.parse(JSON.stringify(lead({tags:['BYD',tag]})));
    assert.equal(isUncontactedAdLead(saved),false);
    saved.tags=saved.tags.filter(t=>t!==tag);
    assert.equal(isUncontactedAdLead(saved),true);
    assert.deepEqual(saved.tags,['BYD']);
  }
});

test('existing sales progress, spam, non-ad contacts and matched chats stay out', () => {
  for(const stage of ['qualifying','negotiating','quoted','won','lost','stalled'])
    assert.equal(isUncontactedAdLead(lead({contact:{customer_stage:stage,quality:'potential'}})),false);
  assert.equal(isUncontactedAdLead(lead({chat:{t:0}})),false);
  assert.equal(isUncontactedAdLead(lead({isAdLead:false})),false);
  assert.equal(isUncontactedAdLead(lead({contact:{customer_stage:'new',quality:'spam'}})),false);
});

test('sidebar count and filtered rows agree after handling and restoration', () => {
  const rows=[lead(),lead({hasMessageHistory:true}),lead({tags:[LEAD_NO_WHATSAPP_TAG]}),
    lead({tags:[LEAD_HANDLED_TAG]}),lead({contact:{customer_stage:'quoted',quality:'potential'}})];
  const state=filters.emptyFilter();
  state.todoBucket='ad_lead';
  assert.equal(filters.todoCounts(rows).ad_lead,1);
  assert.equal(filters.applyFilter(rows,state).length,1);
  rows[0].tags.push(LEAD_NO_WHATSAPP_TAG);
  assert.equal(filters.todoCounts(rows).ad_lead,0);
  assert.equal(filters.applyFilter(rows,state).length,0);
  rows[0].tags=[];
  assert.equal(filters.todoCounts(rows).ad_lead,1);
});
