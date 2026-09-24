/** Offline component integration: real React component + route helper, synthetic data only.
 * Run: node --test scripts/test-gpt-template-routing-integration.mjs
 * Supabase, Chrome, WhatsApp, knowledge loading and prompt builders are in-memory mocks.
 * No real network, browser session, customer records, or database writes are used.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import React, { act } from 'react';

const { window } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'offline-integration-test' } });
globalThis.fetch = () => { throw new Error('Network forbidden in offline routing test'); };
const require = createRequire(import.meta.url);
const { createRoot } = require('react-dom/client');
const { Simulate } = require('react-dom/test-utils');

const common = 'const h = () => globalThis.__gptRoutingIntegration;\n';
const mocks = {
  '@/lib/sales-facts': `${common}export const loadApplicableSalesFacts = async () => ({usable:[],unavailable:[]}); export const omitTemplateSourcedFacts = s => s;`,
  './SalesFactsPanel': 'export const SalesFactsPanel = () => null;',
  '@/lib/gpt-followup': `${common}
    export const sameTask = (a,b) => JSON.stringify(a)===JSON.stringify(b);
    export const loadFollowupContext = async (_db,orgId,contactId) => ({orgId,contactId});
    export const followupPrompt = (ctx,opts) => { h().followupPrompts.push({ctx,opts}); return ''; };
    export const extractFollowup = text => { if(h().followupError) throw Error(h().followupError); return {text,decision:{title:'等待条件',reason:'离线边界替身'}}; };
    export const saveFollowup = async (_db,ctx,decision) => { h().followupSaves.push(decision); return {decision,after:null,protected:false}; };`,
  '@/lib/sales-preferences': `${common}
    export const rememberSalesPreferences = async () => {};
    export const saveSalesPreference = async () => {};`,
  '@/lib/sales-work-memory': `${common}
    export const loadSalesWorkMemory = async (_db, org, contactId) => {
      if (h().memoryError) throw Error(h().memoryError);
      return structuredClone(h().memories[contactId] ?? {contactId,scopeId:contactId,label:'当前需求',entries:[],tasks:[]});
    };
    export const loadPersonalSalesWorkMemory = loadSalesWorkMemory;
    export const saveSalesWorkEntry = async (_db, org, contactId, entry) => {
      if (h().memorySaveError) throw Error(h().memorySaveError);
      const m = h().memories[contactId] ??= {contactId,scopeId:contactId,label:'当前需求',entries:[],tasks:[]};
      h().memoryWrites.push({org,contactId,entry});
      if(entry.kind==='scope'){m.scopeId=entry.scopeId;m.label=entry.text;m.entries=[];}
      m.entries.push({...entry,at:new Date().toISOString()});
    };`,
  '@/lib/supabase': `${common}export const supabase = { from: table => h().query(table) };`,
  '@/lib/errors': 'export const stringifyError = e => e instanceof Error ? e.message : String(e);',
  '@/lib/jump-to-chat': `${common}export const jumpToChat = async () => true; export const verifyHeaderMatches = () => h().headerMatches;`,
  '@/content/whatsapp-message-snapshot': `${common}export const collectRecentChatMessages = async () => h().domMessages;`,
  './DraftFreshnessNotice': 'export const DraftFreshnessNotice = () => null;',
  '@/content/whatsapp-messages': `${common}export const waitForChatMessages = async () => h().domMessages; export const maybeLogReadFailure = () => {};`,
  '@/lib/message-sync': `${common}
    export const loadMessages = async id => h().readMessages(id);
    export const mergeDomWithDbMessages = async (messages) => messages;
    export const syncMessages = async (id, messages) => h().syncs.push({id, messages});`,
  '@/lib/gpt-prompt': `${common}
    function record(kind, args) { h().prompts.push({kind,args}); return JSON.stringify({kind,...args}); }
    export const chatHistoryEvidence = messages => messages.map(m => ({text:m.text,fromMe:m.fromMe}));
    export const buildFirstMessage = args => record('first', args);
    export const buildFollowUpMessage = args => record('followup', args);
    export const buildDiscussionMessage = args => record(args.ctx ? 'discussion-first' : 'discussion-followup', args);`,
  '@/lib/gpt-template-knowledge': `${common}
    export const loadGptApprovedKnowledge = async (_client, id, orgId) => {
      h().knowledge.push({id,orgId}); return h().knowledgeSnapshots[id] ?? 'approved-knowledge:' + id;
    };`,
  '@/content/whatsapp-compose': 'export const fillWhatsAppCompose = () => { throw new Error("Compose must never run"); };',
  '@/lib/ai-reply-attribution': 'export const recordFill = async () => { throw new Error("Fill must never run"); };',
  '@/lib/reply-progress': `${common}export const setReplyProgress = async (...args) => h().progress.push(args); export const clearReplyProgress = async () => {};`,
  '../hooks/useReplyProgress': 'export const useReplyProgress = () => ({});',
  '@/lib/ai-reply-log': `${common}export const logAiReply = async args => { h().logs.push(args); return 'offline-log'; }; export const markAiReplyFilled = async () => {};`,
  '@/lib/reply-sanitize': 'export const sanitizeReplyForCustomer = x => x; export const wasReplyDirty = () => false;',
  './ReplyCard': `import React from 'react'; export const ReplyCard = ({label,reply}) => React.createElement('div', null, label, reply);`,
  './ClientRecordCard': 'export const ClientRecordCard = () => null;',
  './GPTTemplatesModal': 'export const GPTTemplatesModal = () => null;',
  './GeneratedAtBadge': 'export const GeneratedAtBadge = () => null;',
  '@/lib/whatsapp-idb': 'export const readWhatsAppData = async () => ({chats:[],contacts:[]});',
};
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/panel/components/GPTReplySection.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'offline-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const path = args.path === './gpt-followup' ? '@/lib/gpt-followup' : args.path;
      return path in mocks ? { path, namespace: 'offline-mock' } : null;
    });
    builder.onLoad({ filter: /.*/, namespace: 'offline-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }],
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const { GPTReplySection } = loaded.exports;

const ORG = 'offline-org';
const R08_GPT = 'g-6aa7711ad9cc8191aa3d3693cfd7ad9f';
const MILES_GPT = 'g-offlinemiles123';
const miles = { id: 'template-miles', created_by: 'offline-user', org_id: ORG, name: 'Miles V2', is_default: true,
  gpt_url: `https://chatgpt.com/g/${MILES_GPT}-miles`, created_at: '2026-01-01' };
const r08 = { id: 'template-r08', created_by: 'offline-user', org_id: ORG, name: 'R08 专用 · Miles', is_default: false,
  gpt_url: `https://chatgpt.com/g/${R08_GPT}-r08`, created_at: '2026-01-02' };
const contact = id => ({ id, phone: null, name: `Synthetic ${id}`, wa_name: null,
  group_jid: null, country: null, language: 'Spanish', notes: null });
const msg = (text, n = 1) => ({ wa_message_id: `offline-${n}`, direction: 'inbound', text,
  sent_at: `2026-09-16T10:00:${String(n).padStart(2, '0')}Z` });
const conversation = (template, contactId = 'customer-a', chatUrl) => ({
  id: `conv-${contactId}-${template.id}`, contact_id: contactId, template_id: template.id,
  chat_url: chatUrl ?? `${template.gpt_url}/c/offline-existing`, last_used_at: '2026-09-16T09:00:00Z',
});

function makeHarness(options = {}) {
  const h = {
    templates: structuredClone(options.templates ?? [miles, r08]),
    conversations: structuredClone(options.conversations ?? []),
    messages: structuredClone(options.messages ?? { 'customer-a': [msg('Quiero el R08 diésel')] }),
    interests: structuredClone(options.interests ?? {}),
    knowledgeSnapshots: structuredClone(options.knowledgeSnapshots ?? {}),
    memories: structuredClone(options.memories ?? {}), memoryWrites: [], memoryError: options.memoryError, memorySaveError: options.memorySaveError,
    quoteRows: [], responseTexts: options.responseTexts, quoteSaveError: options.quoteSaveError,
    store: structuredClone(options.store ?? {}), calls: [], queries: [], writes: [], knowledge: [], prompts: [], followupPrompts: [], followupSaves: [], logs: [], progress: [], syncs: [],
    headerMatches: false, domMessages: [], returnedUrl: options.returnedUrl,
    holdRuntime: options.holdRuntime ?? false, responseText: options.responseText,
  };
  let messageReadCount = 0;
  h.readMessages = async id => {
    const rows = structuredClone(h.messages[id] ?? []);
    if (++messageReadCount === 1 && options.holdInitialRead) {
      return new Promise(resolve => { h.releaseInitialRead = () => resolve(rows); });
    }
    return rows;
  };
  h.query = table => {
    assert.ok(['gpt_templates', 'gpt_conversations', 'vehicle_interests', 'contacts', 'contact_events'].includes(table), `unexpected table ${table}`);
    const filters = []; let operation = 'select'; let payload; let single = false; let executed;
    const builder = {
      select() { return builder; },
      eq(key, value) { filters.push([key, value]); return builder; },
      order() { return builder; },
      maybeSingle() { single = true; return builder; },
      single() { single = true; return builder; },
      upsert(value) { operation = 'upsert'; payload = value; return builder; },
      insert(value) { operation = 'insert'; payload = value; return builder; },
      update(value) { operation = 'update'; payload = value; return builder; },
      delete() { throw new Error('Delete is outside this test'); },
      then(resolve, reject) {
        executed ??= Promise.resolve().then(() => {
          h.queries.push({ table, operation, filters: [...filters] });
          if(table==='contacts') return {data:{id:filters.find(([k])=>k==='id')[1]},error:null};
          if(table==='contact_events') {
            assert.equal(operation,'insert');
            if(h.quoteSaveError)return {data:null,error:{message:h.quoteSaveError}};
            h.quoteRows.push(structuredClone(payload));
            const m=h.memories[payload.contact_id]??={contactId:payload.contact_id,scopeId:payload.contact_id,label:'当前需求',entries:[],tasks:[]};
            (m.quoteVersions??=[]).push({id:payload.id,at:new Date().toISOString(),payload:payload.payload});
            return {data:null,error:null};
          }
          let rows = table === 'gpt_templates' ? h.templates : table === 'gpt_conversations'
            ? h.conversations : Object.entries(h.interests).flatMap(([id, interests]) => interests.map(x => ({ ...x, contact_id: id })));
          if (operation !== 'select') {
            assert.equal(table, 'gpt_conversations', 'only synthetic conversation saves are allowed');
            h.writes.push({ table, operation, payload: structuredClone(payload), filters: [...filters] });
            let row = operation === 'update' ? rows.find(r => filters.every(([k,v]) => r[k] === v))
              : rows.find(r => r.contact_id === payload.contact_id && r.template_id === payload.template_id);
            if (row) Object.assign(row, payload);
            else { row = { id: `saved-${h.writes.length}`, ...payload }; h.conversations.push(row); }
            return { data: single ? structuredClone(row) : [structuredClone(row)], error: null };
          }
          rows = rows.filter(r => filters.every(([k, v]) => r[k] === v));
          return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
        });
        return executed.then(resolve, reject);
      },
    };
    return builder;
  };
  return h;
}

globalThis.chrome = {
  storage: { local: {
    async get(key) { const h = globalThis.__gptRoutingIntegration; return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, h.store[k]])); },
    async set(value) { Object.assign(globalThis.__gptRoutingIntegration.store, value); },
    async remove(key) { delete globalThis.__gptRoutingIntegration.store[key]; },
  } },
  runtime: { async sendMessage(request) {
    const h = globalThis.__gptRoutingIntegration;
    if (request.type === 'GPT_RESULT') {
      (h.polls ??= []).push(request.requestId);
      return h.pollResult ?? {ok:true,responseText:'Recovered original response',chatUrl:`${r08.gpt_url}/c/offline-result`};
    }
    assert.equal(request.type, 'GPT_RUN'); h.calls.push(request);
    const result = h.runResult ?? { ok: true, responseText: h.responseTexts?.[h.calls.length-1] ?? h.responseText ?? 'Offline synthetic reply',
      chatUrl: h.returnedUrl ?? `${request.url.split('/c/')[0]}/c/offline-result` };
    if (h.holdRuntime) return new Promise(resolve => { h.releaseRuntime = () => resolve(result); });
    return result;
  } },
};

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
}
async function mount(t, options = {}, id = 'customer-a') {
  const h = makeHarness(options); globalThis.__gptRoutingIntegration = h;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async contactId => {
    await act(async () => root.render(React.createElement(GPTReplySection, { orgId: ORG, contact: {...contact(contactId),...options.contactOverride} })));
    await settle();
  };
  await render(id);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { h, container, render };
}
const button = (container, predicate) => [...container.querySelectorAll('button')].find(b => predicate(b.textContent));
async function click(node) {
  assert.ok(node, 'expected rendered action'); assert.equal(node.disabled, false, node.textContent);
  await act(async () => Simulate.click(node)); await settle();
}
async function discuss(container, text = '怎么回复这个客户？') {
  const textarea = [...container.querySelectorAll('textarea')].at(-1);
  assert.ok(textarea, 'discussion textarea');
  await act(async () => Simulate.change(textarea, { target: { value: text } })); await settle();
  await click(button(container, text => text.includes('发送讨论')));
}
async function guidance(container, text) {
  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'sales guidance textarea');
  await act(async () => Simulate.change(textarea, { target: { value: text } })); await settle();
}
function assertR08Call(h, kind, expectedUrl = r08.gpt_url, customerId = 'customer-a') {
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, expectedUrl);
  assert.deepEqual(h.knowledge, [{ id: r08.id, orgId: ORG }]);
  assert.equal(h.prompts.at(-1).kind, kind);
  assert.equal(h.prompts.at(-1).args.approvedKnowledge, `approved-knowledge:${r08.id}`);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].payload.template_id, r08.id);
  assert.equal(h.writes[0].payload.contact_id, customerId);
  assert.ok(h.queries.some(q => q.table === 'gpt_conversations' && q.filters.some(([k,v]) => k === 'template_id' && v === r08.id)), 'action rereads conversation for the resolved template');
}

test('UI automatically displays R08; generate ignores existing Miles conversation and saves R08 identity', async t => {
  const { h, container } = await mount(t, { conversations: [conversation(miles)] });
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, r08.id);
  assert.match(container.querySelector('.sgc-section-title').textContent, /R08/);
  assert.equal(button(container, text => text === '生成')?.disabled, false);
  await click(button(container, text => text === '生成'));
  assertR08Call(h, 'first');
  assert.equal(h.conversations.find(c => c.template_id === miles.id).chat_url, conversation(miles).chat_url);
});

test('discussion ignores existing Miles conversation and binds URL, knowledge and save to R08', async t => {
  const { h, container } = await mount(t, { conversations: [conversation(miles)] });
  await discuss(container); assertR08Call(h, 'discussion-first');
});

for (const action of ['generate', 'discussion']) {
  test(`${action} follows up only the matching R08 conversation`, async t => {
    const conv = conversation(r08);
    const { h, container } = await mount(t, { conversations: [conversation(miles), conv] });
    if (action === 'generate') await click(button(container, text => text === '续聊生成'));
    else await discuss(container);
    assertR08Call(h, action === 'generate' ? 'followup' : 'discussion-followup', conv.chat_url);
  });
}

test('R08 template row misbound to a Miles URL is treated as a fresh R08 conversation', async t => {
  const { h, container } = await mount(t, { conversations: [conversation(r08, 'customer-a', conversation(miles).chat_url)] });
  await click(button(container, text => text === '生成')); assertR08Call(h, 'first');
});

test('missing R08 template displays the routing error and blocks both actions', async t => {
  const { h, container } = await mount(t, { templates: [miles] });
  assert.match(container.textContent, /R08 专用模板/);
  const generate = button(container, text => text === '生成');
  assert.ok(!generate || generate.disabled, 'generate cannot silently fall back to Miles');
  const textarea = [...container.querySelectorAll('textarea')].at(-1);
  if (textarea) {
    await act(async () => Simulate.change(textarea, { target: { value: '怎么回复？' } })); await settle();
    assert.equal(button(container, text => text.includes('发送讨论'))?.disabled, true);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.knowledge.length, 0); assert.equal(h.writes.length, 0);
});

test('new customer messages at click time reroute stale Miles preview before loading knowledge', async t => {
  const { h, container } = await mount(t, { messages: { 'customer-a': [msg('Hilux please')] }, conversations: [conversation(miles)] });
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, miles.id);
  h.messages['customer-a'].push(msg('Ahora quiero el R08 diésel', 2));
  await click(button(container, text => text === '续聊生成'));
  assertR08Call(h, 'first');
});

test('discussion routes from fresh messages even if its rendered preview was Miles', async t => {
  const { h, container } = await mount(t, { messages: { 'customer-a': [msg('Hilux please')] }, conversations: [conversation(miles)] });
  h.messages['customer-a'].push(msg('Ahora quiero el R08 diésel', 2));
  await discuss(container); assertR08Call(h, 'discussion-first');
});

test('an incorrect GPT response URL is rejected instead of saving cross-template context', async t => {
  const { h, container } = await mount(t, { returnedUrl: conversation(miles).chat_url });
  await click(button(container, text => text === '生成'));
  assert.equal(h.calls[0].url, r08.gpt_url); assert.equal(h.writes.length, 0);
  assert.match(container.textContent, /会话与本次模板不匹配/);
});

test('switching customers while GPT runs cannot save or restore customer A result into B', async t => {
  const { h, container, render } = await mount(t, { holdRuntime: true,
    messages: { 'customer-a': [msg('R08 please')], 'customer-b': [msg('Hilux please')] },
    conversations: [conversation(miles, 'customer-b')],
  });
  await click(button(container, text => text === '生成'));
  assert.equal(h.calls.length, 1);
  await render('customer-b');
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, miles.id);
  await act(async () => h.releaseRuntime()); await settle();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].payload.contact_id, 'customer-a');
  assert.equal(h.writes[0].payload.template_id, r08.id);
  assert.equal(h.store['replyStatus:gpt:customer-a']?.templateId, r08.id);
  assert.equal(h.store['replyStatus:gpt:customer-b'], undefined);
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, miles.id);
});

test('fresh R08 generation remains valid after its R08 guidance is cleared; explicit new guidance invalidates it', async t => {
  const { h, container } = await mount(t, { messages: { 'customer-a': [msg('Hilux please')] } });
  await guidance(container, '这次给他报 R08 柴油四驱');
  await click(button(container, text => text === '生成'));
  assertR08Call(h, 'first');
  assert.equal(container.querySelector('textarea').value, '', 'successful generation clears guidance');
  assert.doesNotMatch(container.textContent, /旧模板生成/);
  await guidance(container, '现在换成 Hilux 报价');
  assert.match(container.textContent, /旧模板生成/);
});

test('fresh R08 discussion remains valid after question clears; manual template selection invalidates it', async t => {
  // The inferred preview already returns to Miles after this question clears.
  // Select a genuinely different option: selecting the already-selected option
  // would not dispatch a native change event in the browser.
  const another = { ...miles, id: 'template-other', name: 'Other general GPT', is_default: false,
    gpt_url: 'https://chatgpt.com/g/g-offlineother123-general' };
  const { h, container } = await mount(t, { templates: [miles, r08, another],
    messages: { 'customer-a': [msg('Hilux please')] } });
  await discuss(container, '这个客户适合 R08 吗？');
  assertR08Call(h, 'discussion-first');
  assert.equal([...container.querySelectorAll('textarea')].at(-1).value, '', 'successful discussion clears question');
  assert.doesNotMatch(container.textContent, /旧模板生成/);
  const select = container.querySelector('select[aria-label="GPT 模板"]');
  assert.equal(select.disabled, false);
  await act(async () => Simulate.change(select, { target: { value: another.id } })); await settle();
  assert.match(container.textContent, /旧模板生成/);
});

test('late initial DB preview cannot replace newer action routing context', async t => {
  const { h, container } = await mount(t, { holdInitialRead: true,
    messages: { 'customer-a': [msg('Hilux please')] },
  });
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, miles.id);
  h.messages['customer-a'].push(msg('Ahora quiero R08', 2));
  await click(button(container, text => text === '生成'));
  assertR08Call(h, 'first');
  await act(async () => h.releaseInitialRead()); await settle();
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, r08.id);
  assert.doesNotMatch(container.textContent, /旧模板生成/);
});

for (const action of ['generate', 'discussion']) {
  test(`manual R08 selection overrides another topic for ${action} and uses its own conversation`, async t => {
    const conv = conversation(r08);
    const { h, container } = await mount(t, {
      messages: { 'customer-a': [msg('Hilux please')] },
      conversations: [conversation(miles), conv],
    });
    const select = container.querySelector('select[aria-label="GPT 模板"]');
    assert.equal(select.disabled, false);
    await act(async () => Simulate.change(select, { target: { value: r08.id } })); await settle();
    assert.equal(select.value, r08.id, 'manual selection must not snap back');
    assert.match(container.textContent, /已手动选择/);
    if (action === 'generate') await click(button(container, text => text === '续聊生成'));
    else await discuss(container, '这个 Hilux 客户怎么跟进？');
    assertR08Call(h, action === 'generate' ? 'followup' : 'discussion-followup', conv.chat_url);
  });
}

test('auto R08 leaves selector enabled; manual Miles and restore automatic both work', async t => {
  const { container, render } = await mount(t, {
    messages: { 'customer-a': [msg('R08 please')], 'customer-b': [msg('R08 please')] },
  });
  let select = container.querySelector('select[aria-label="GPT 模板"]');
  assert.equal(select.value, r08.id);
  assert.equal(select.disabled, false);
  await act(async () => Simulate.change(select, { target: { value: miles.id } })); await settle();
  assert.equal(select.value, miles.id);
  await click(button(container, text => text === '恢复自动匹配'));
  assert.equal(select.value, r08.id);
  await act(async () => Simulate.change(select, { target: { value: miles.id } })); await settle();
  await render('customer-b');
  select = container.querySelector('select[aria-label="GPT 模板"]');
  assert.equal(select.value, r08.id, 'manual choice must not leak across customers');
  await render('customer-a');
  assert.equal(container.querySelector('select[aria-label="GPT 模板"]').value, miles.id, 'manual choice survives switching away and back');
});

for (const action of ['generate', 'discussion']) {
  for (const existing of [false, true]) {
    test(`skill ${action} ${existing ? 'continuation' : 'first turn'} carries current skill identity and saves only a bound conversation`, async t => {
      const skill = { id: '6aabac4c1240819193bc311372c9d2ab', name: 'sino gear r08 miles' };
      const encoded = 'SGC_GPT_TEMPLATE_CONFIG\n' + JSON.stringify({ schema: 'sinogear.gpt-template', version: 2,
        description: 'skill test', approvedKnowledge: '最新知识', updatedAt: '2026-09-17T08:00:00.000Z', skill });
      const specialist = { ...r08, id: 'template-skill', gpt_url: 'https://chatgpt.com/', description: encoded };
      const bound = `https://chatgpt.com/c/offline-skill#sgc_skill=${skill.id}`;
      const { h, container } = await mount(t, { templates: [miles, specialist], returnedUrl: bound,
        knowledgeSnapshots: { [specialist.id]: { text: '最新知识', templateId: specialist.id, updatedAt: '2026-09-17T08:00:00.000Z', skill } },
        conversations: [conversation(specialist, 'customer-a', existing ? bound : 'https://chatgpt.com/c/unbound-old')],
      });
      if (action === 'generate') await click(button(container, text => text === (existing ? '续聊生成' : '生成')));
      else await discuss(container);
      assert.equal(h.calls.length, 1);
      assert.deepEqual(h.calls[0].skill, skill);
      assert.equal(h.calls[0].url, existing ? bound : specialist.gpt_url);
      assert.equal(h.writes.length, 1);
      assert.equal(h.writes[0].payload.chat_url, bound);
      assert.equal(h.writes[0].payload.template_id, specialist.id);
    });
  }
}

test('owner instructions survive cleared guidance and a fresh conversation', async t => {
  const {h,container:c}=await mount(t);
  await guidance(c,'本单地面费2000；先内部核算');
  await click(button(c,x=>x==='生成'));
  assert.equal(h.memoryWrites[0].entry.kind,'sales_instruction');
  assert.equal(h.memoryWrites[1].entry.kind,'assistant_draft');
  h.conversations.length=0;
  await click(button(c,x=>x==='续聊生成'||x==='生成'));
  const memory=h.prompts.at(-1).args.workMemory;
  assert.equal(memory.entries.filter(x=>x.kind==='sales_instruction').length,1);
  assert.ok(memory.entries.some(x=>x.text==='本单地面费2000；先内部核算'));
  assert.equal(h.prompts.at(-1).kind,'first');
});
test('memory read failure stops generation instead of silently forgetting approvals', async t => {
 const {h,container:c}=await mount(t,{memoryError:'读取客户工作记录失败'});
 await click(button(c,x=>x==='生成'));
 assert.equal(h.calls.length,0);assert.ok(c.textContent.includes('读取客户工作记录失败'));
});
test('owner-input save failure preserves instructions and does not invoke model', async t => {
 const {h,container:c}=await mount(t,{memorySaveError:'保存客户工作记录失败'});
 await guidance(c,'本单批准运费3000');await click(button(c,x=>x==='生成'));
 assert.equal(h.calls.length,0);assert.equal(c.querySelector('textarea').value,'本单批准运费3000');
});
test('new demand keeps previous conditions out of next prompt and starts fresh chat', async t => {
 const prior={contactId:'customer-a',scopeId:'customer-a',label:'旧单',entries:[{id:'old',at:'2026-01-01',scopeId:'customer-a',kind:'sales_instruction',text:'赠品ALPHA'}],tasks:[]};
 const {h,container:c}=await mount(t,{conversations:[conversation(r08)],memories:{'customer-a':prior}});
 const input=c.querySelector('input[aria-label="另一笔需求名称"]');
 await act(async()=>Simulate.change(input,{target:{value:'第二批'}}));await settle();
 await click(button(c,x=>x==='开始另一笔需求'));
 await click(button(c,x=>x==='续聊生成'||x==='生成'));
 assert.equal(h.prompts.at(-1).kind,'first');assert.equal(h.prompts.at(-1).args.workMemory.label,'第二批');
 assert.ok(!JSON.stringify(h.prompts.at(-1).args.workMemory).includes('ALPHA'));
});

for (const action of ['generate','discussion']) {
 test(`${action} saves conversational freight research automatically without a freight form`,async t=>{
  const raw='[Client Record]\n\n[WhatsApp Reply]\n\n[Full Translation & Strategy]\n内部估算结论\n<freight_research>Shanghai → Tema；最高可比参考4000美元/柜；https://example.com/rate；非正式报价</freight_research>';
  const {h,container}=await mount(t,{responseText:raw});
  assert.equal(container.querySelector('[aria-label="运费目的港"]'),null);
  if(action==='generate')await click(button(container,x=>x==='生成'));else await discuss(container);
  const research=h.memoryWrites.find(w=>w.entry.kind==='freight_lookup');
  assert.ok(research);assert.equal(research.contactId,'customer-a');
  const record=JSON.parse(research.entry.text);assert.equal(record.status,'model_research_unverified');assert.equal(record.bindingQuote,false);
  assert.match(record.raw,/最高可比参考4000/);assert.doesNotMatch(h.logs[0].response,/<freight_research>/);
  assert.equal(h.memoryWrites.filter(w=>w.entry.kind==='assistant_draft').length,1);
 });
}

for(const action of ['generate','discussion']) {
 test(`${action} computes quote, composes in same chat and saves append-only input/result version`,async t=>{
   const plan={label:'两台',model:'EV510',quantity:2,propulsion:'bev',shippingMode:'container',containers:1,loadingBasis:'测试一柜两台',vehicle:{basis:'approved_fob',amount:'25000',currency:'USD',source:'批准价',groundIncluded:true},freight:{amountUsd:'11000',source:'测试运费',dgIncluded:false,groundIncluded:false,checkedAt:new Date().toISOString(),validUntil:null,kind:'owner_estimate'},profit:null,groundOverride:null,insurance:null,fixedSelling:null};
   const input={schema:'quote-input.v1',origin:'Shanghai',destination:'La Guaira',fx:null,plans:[plan]};
   const first='[WhatsApp Reply]\n\n[Full Translation & Strategy]\n<quote_input>'+JSON.stringify(input)+'</quote_input>';
   const final='[WhatsApp Reply]USD 62,000.00 total, USD 31,000.00 per car.\n[Full Translation & Strategy]保险未含';
   const prior={contactId:'customer-a',scopeId:'customer-a',label:'本单',entries:[],tasks:[],quoteVersions:[{id:'previous-version',at:'2026-09-17T00:00:00Z',payload:{summary:'旧版'}}]};
   const {h,container}=await mount(t,{responseTexts:[first,final],memories:{'customer-a':prior}});
   if(action==='generate')await click(button(container,x=>x==='生成'));else await discuss(container);
   assert.equal(h.calls.length,2);assert.equal(h.logs[0].metrics.requests,2);assert.equal(h.logs[0].metrics.inputChars,h.calls.reduce((n,c)=>n+c.prompt.length,0));assert.equal(h.calls[1].url,`${r08.gpt_url}/c/offline-result`);assert.match(h.calls[1].prompt,/62000.00/);
   assert.equal(h.quoteRows.length,1);assert.equal(h.quoteRows[0].contact_id,'customer-a');assert.equal(h.quoteRows[0].payload.status,'draft');assert.equal(h.quoteRows[0].payload.parentId,'previous-version');assert.equal(h.quoteRows[0].payload.result[0].dgUsd,'1000.00');
   assert.equal(h.memoryWrites.filter(x=>x.entry.kind==='assistant_draft').length,1);assert.doesNotMatch(h.logs[0].response,/quote_input/);assert.match(container.textContent,/报价核算历史/);
 });
}
for(const action of ['generate','discussion']) {
 test(`${action} completes PHEV CIF draft with one GPT call and persists substituted prices`,async t=>{
   const plan={label:'一台',model:'ZEEKR 9X Hyper 70kWh',quantity:1,propulsion:'phev',shippingMode:'container',containers:1,loadingBasis:'测试一柜一台',vehicle:{basis:'approved_fob',amount:'106300',currency:'USD',source:'本单批准价',groundIncluded:true},freight:{amountUsd:'11000',source:'海运10000和老板确认DG1000已含',dgIncluded:true,groundIncluded:true,checkedAt:new Date().toISOString(),validUntil:null,kind:'owner_estimate'},profit:null,groundOverride:null,insurance:{basis:'freight_10_percent',source:'老板总运费x1.1'},fixedSelling:null};
   const input={schema:'quote-input.v1',origin:'Shanghai',destination:'Caucedo',fx:null,plans:[plan]};
   const first='[WhatsApp Reply]\nCIF reference: USD {{quote.1.totalUsd}}.\n[Full Translation & Strategy]\nCIF参考{{quote.1.totalUsd}}美元，保险预算{{quote.1.insuranceUsd}}美元。\n<quote_input>'+JSON.stringify(input)+'</quote_input>';
   const {h,container}=await mount(t,{responseTexts:[first]});
   if(action==='generate')await click(button(container,x=>x==='生成'));else await discuss(container);
   assert.equal(h.calls.length,1);
   assert.equal(h.logs[0].metrics.requests,1);
   assert.equal(h.logs[0].metrics.inputChars,h.calls[0].prompt.length);
   assert.equal(h.logs[0].metrics.outputChars,first.length);
   assert.equal(h.quoteRows.length,1);assert.equal(h.quoteRows[0].payload.result[0].totalUsd,'118400.00');
   assert.equal(h.quoteRows[0].payload.input.plans[0].propulsion,'phev');
   assert.match(h.logs[0].response,/USD 118,400.00/);assert.doesNotMatch(h.logs[0].response,/\{\{|quote_input/);
   assert.equal(h.memoryWrites.filter(x=>x.entry.kind==='assistant_draft').length,1);
 });
}
test('failed quote version write does not display a falsely saved/sendable quote',async t=>{
 const input={schema:'quote-input.v1',origin:'Shanghai',destination:'Tema',fx:null,plans:[{label:'一台',model:'柴油',quantity:1,propulsion:'fuel',shippingMode:'roro',containers:null,loadingBasis:'滚装',vehicle:{basis:'approved_fob',amount:'10000',currency:'USD',source:'本单批准',groundIncluded:true},freight:{amountUsd:'2000',source:'测试',dgIncluded:false,groundIncluded:false,checkedAt:new Date().toISOString(),validUntil:null,kind:'owner_estimate'},profit:null,groundOverride:null,insurance:null,fixedSelling:null}]};
 const {h,container}=await mount(t,{quoteSaveError:'offline',responseTexts:['[WhatsApp Reply]\n[Full Translation & Strategy]<quote_input>'+JSON.stringify(input)+'</quote_input>','[WhatsApp Reply]USD 12000.00\n[Full Translation & Strategy]参考']});
 await click(button(container,x=>x==='生成'));assert.equal(h.calls.length,2);assert.equal(h.quoteRows.length,0);assert.equal(h.memoryWrites.filter(x=>x.entry.kind==='assistant_draft').length,0);assert.match(container.textContent,/报价版本保存失败/);
});

for (const action of ['generate','discussion']) {
 test(`${action} delivers missing-followup draft in one web call`,async t=>{
  const raw='[Client Record]\nNo change\n[WhatsApp Reply]\nMy friend, send your company details for the PI.\n[Full Translation & Strategy]\n请提供开票资料。';
  const {h,container}=await mount(t,{responseText:raw});
  h.followupError='GPT未返回唯一的跟进判断，未创建任务';
  if(action==='generate')await click(button(container,x=>x==='生成'));else await discuss(container,'怎么回复这个客户？顺便安排一下跟进');
  assert.equal(h.calls.length,1);
  assert.equal(h.logs[0].metrics.requests,1);
  const draft=h.memoryWrites.find(w=>w.entry.kind==='assistant_draft');
  assert.match(draft.entry.text,/send your company details for the PI/);
  assert.match(container.querySelector('[role="status"]').textContent,/未追加GPT调用/);
 });
 test(`${action} preserves draft and displays warning if follow-up metadata fails`,async t=>{
  const raw='[Client Record]\n\n[WhatsApp Reply]\n\nMy friend, both cars use the same container option.\n\n[Full Translation & Strategy]\n继续核查其他运输方式。\n<crm_followup>{incomplete';
  const {h,container}=await mount(t,{responseText:raw});
  h.followupError='GPT未返回唯一的跟进判断，未创建任务';
  if(action==='generate')await click(button(container,x=>x==='生成'));else await discuss(container,'怎么回复这个客户？顺便安排一下跟进');
  assert.equal(h.calls.length,1);
  const draft=h.memoryWrites.find(w=>w.entry.kind==='assistant_draft');
  assert.match(draft.entry.text,/My friend, both cars/);
  assert.doesNotMatch(draft.entry.text,/<crm_followup/);
  assert.match(container.querySelector('[role="status"]').textContent,/正文已保留/);
  assert.equal(h.writes.length,1,'the conversation remains resumable');
 });
}

for (const action of ['generate','discussion']) {
 test(`${action} group continuation keeps long notes in the follow-up context`,async t=>{
  const notes='群聊人工安排：下周再联系，尚未授权新折扣。'.repeat(30);
  const {h,container}=await mount(t,{contactOverride:{group_jid:'synthetic@g.us',notes},conversations:[conversation(r08)]});
  if(action==='generate')await click(button(container,x=>x==='续聊生成'));else await discuss(container,'怎么回复这个客户？顺便安排一下跟进');
  assert.equal(h.calls.length,1);
  assert.equal(h.followupPrompts[0].opts.includedCustomerNotes,null);
 });
 test(`${action} individual continuation can reference notes already in customer context`,async t=>{
  const notes='保留本单原话。'.repeat(100);
  const {h,container}=await mount(t,{contactOverride:{notes},conversations:[conversation(r08)]});
  if(action==='generate')await click(button(container,x=>x==='续聊生成'));else await discuss(container,'怎么回复这个客户？顺便安排一下跟进');
  assert.equal(h.followupPrompts[0].opts.includedCustomerNotes,notes);
 });
}

for (const mode of ['reply','discuss']) test(`${mode}: refresh recovers original request without sending again or crossing customer`, async t => {
  const {h,container,render} = await mount(t,{holdRuntime:true});
  if(mode==='reply') await click(button(container,text=>text==='生成'));
  else await discuss(container);
  const key=`gpt.pendingAction:${ORG}:customer-a`;
  assert.equal(h.store[key].requestId,h.calls[0].requestId);
  assert.equal(h.store[key].contactId,'customer-a');
  assert.equal(h.store[key].template.id,r08.id);
  await render('customer-b');
  assert.equal(button(container,text=>text==='取回生成结果'),undefined);
  await render('customer-a');
  await click(button(container,text=>text==='取回生成结果'));
  assert.equal(h.calls.length,1,'no second GPT_RUN');
  assert.deepEqual(h.polls,[h.calls[0].requestId]);
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].payload.contact_id,'customer-a');
  assert.equal(h.store[key],undefined);
  assert.match(h.store['replyStatus:gpt:customer-a'].text,/^Recovered original response/);
  assert.equal(h.store['replyStatus:gpt:customer-a'].mode,mode);
  h.releaseRuntime();
  await settle();
  assert.equal(h.writes.length,1,'late original receiver cannot save a second time');
  assert.equal(h.memoryWrites.filter(w=>w.entry.kind==='assistant_draft').length,1);
  assert.equal(button(container,text=>/^(续聊)?生成$/.test(text)).disabled,false);
});
test('failed recovered task releases the stale generating lock without resubmission',async t=>{
  const {h,container,render}=await mount(t,{holdRuntime:true});
  await click(button(container,text=>text==='生成'));
  h.pollResult={ok:false,error:'发送阶段被中断'};
  await render('customer-b');await render('customer-a');
  await click(button(container,text=>text==='取回生成结果'));
  assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);
  assert.equal(h.store[`gpt.pendingAction:${ORG}:customer-a`],undefined);
  assert.equal(button(container,text=>/^(续聊)?生成$/.test(text)).disabled,false);
  assert.match(container.textContent,/发送阶段被中断/);
});
test('recovery rejects changed template before polling or saving',async t=>{
  const {h,container,render}=await mount(t,{holdRuntime:true});
  await click(button(container,text=>text==='生成'));
  h.templates.find(t=>t.id===r08.id).description='new configuration';
  await render('customer-b');await render('customer-a');
  await click(button(container,text=>text==='取回生成结果'));
  assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);assert.equal(h.polls,undefined);
  assert.match(container.textContent,/原生成模板已变化/);
  const original=h.store[`gpt.pendingAction:${ORG}:customer-a`];
  await click(button(container,text=>text==='保留原记录并解除等待'));
  assert.equal(h.store[`gpt.pendingAction:${ORG}:customer-a`],undefined);
  assert.equal(h.store[`gpt.archivedAction:${original.requestId}`].requestId,original.requestId);
  assert.equal(h.calls.length,1);
  assert.equal(button(container,text=>text==='生成').disabled,false);
});

test('failed original generation reports error after releasing its pending record',async t=>{
  const {h,container}=await mount(t);
  h.runResult={ok:false,error:'GPT发送失败'};
  await click(button(container,text=>text==='生成'));
  assert.equal(h.store[`gpt.pendingAction:${ORG}:customer-a`],undefined);
  assert.equal(h.writes.length,0);
  assert.match(container.textContent,/GPT发送失败/);
  assert.equal(button(container,text=>text==='生成').disabled,false);
});

test('draft survives auxiliary save failure; retry reuses checkpoint without another GPT call',async t=>{
 const raw='[Client Record]\nNo change\n[WhatsApp Reply]\nHello Carlos, please confirm the plan.\n[Full Translation & Strategy]\n等待确认';
 const {h,container}=await mount(t,{responseText:raw});
 h.memorySaveError='Draft save offline';
 await click(button(container,x=>x==='生成'));
 const key=`gpt.pendingAction:${ORG}:customer-a`;
 assert.equal(h.calls.length,1);assert.ok(h.store[key].prepared);assert.ok(h.store[key].savedWork);
 assert.equal(h.store['replyStatus:gpt:customer-a'].kind,'done');
 assert.match(h.store['replyStatus:gpt:customer-a'].text,/Hello Carlos/);
 assert.match(container.textContent,/保存未完成/);
 h.memorySaveError=null;
 await click(button(container,x=>x==='取回生成结果'));
 assert.equal(h.calls.length,1);assert.equal(h.polls,undefined,'completed checkpoint needs no background polling');
 assert.equal(h.store[key],undefined);assert.equal(h.memoryWrites.filter(x=>x.entry.kind==='assistant_draft').length,1);
});

const yangMiles = {...miles,id:'yang-miles',name:'Miles · Yang',is_default:false,gpt_url:'https://chatgpt.com/g/g-offlineyang'};
const menglongR08 = {...r08,id:'menglong-r08',name:'R08 · Menglong',gpt_url:'https://chatgpt.com/g/g-6aaff2e20f848191a17b81f6786cdebe'};
const browserKey = `gptBrowserBinding:${ORG}:offline-user`;
for(const [label,binding,general,specialist] of [
 ['Yang',{defaultTemplateId:yangMiles.id,r08TemplateId:r08.id},yangMiles,r08],
 ['Menglong',{defaultTemplateId:miles.id,r08TemplateId:menglongR08.id},miles,menglongR08],
]) for(const topic of ['R08','Hilux']) for(const mode of ['generate','discuss']) {
 test(`${label} browser ${mode} ${topic} uses its own URL/knowledge despite old manual selection and shared DB defaults`,async t=>{
   const expected=topic==='R08'?specialist:general;
   const {h,container:c}=await mount(t,{templates:[miles,menglongR08,r08,yangMiles],
     messages:{'customer-a':[msg('I want '+topic)]},
     store:{[browserKey]:binding,[`gptManualTemplate:${ORG}:customer-a`]:menglongR08.id},
     conversations:[conversation(miles),conversation(menglongR08)],
   });
   assert.equal(c.querySelector('select[aria-label="GPT 模板"]').value,expected.id);
   assert.equal(c.querySelector('select[aria-label="GPT 模板"]').querySelectorAll('option').length,2);
   if(mode==='generate')await click(button(c,s=>s==='生成'||s==='续聊生成'));else await discuss(c);
   assert.equal(h.calls.length,1);assert.ok(h.calls[0].url.startsWith(expected.gpt_url));
   assert.equal(h.knowledge[0].id,expected.id);assert.equal(h.writes[0].payload.template_id,expected.id);
 });
}
test('missing browser template fails closed instead of taking another account default',async t=>{
 const {h,container:c}=await mount(t,{store:{[browserKey]:{defaultTemplateId:'removed',r08TemplateId:r08.id}}});
 assert.match(c.textContent,/本浏览器保存的 GPT 入口已不可用/);
 assert.equal(button(c,s=>s==='生成'||s==='续聊生成').disabled,true);
 assert.equal(h.calls.length,0);
});
test('browser configuration is isolated from a different CRM user',async t=>{
 const {h,container:c}=await mount(t,{messages:{'customer-a':[msg('Hilux')]},store:{[`gptBrowserBinding:${ORG}:other-user`]:{defaultTemplateId:'removed',r08TemplateId:r08.id}}});
 await click(button(c,s=>s==='生成'||s==='续聊生成'));assert.equal(h.calls[0].url,miles.gpt_url);
});
test('corrupt browser configuration blocks generation with actionable error',async t=>{
 const {h,container:c}=await mount(t,{store:{[browserKey]:{defaultTemplateId:miles.id}}});
 assert.match(c.textContent,/本浏览器 GPT 配置损坏/);assert.equal(h.calls.length,0);
});
test('manual selection is remembered inside its browser pair, then automatic routing resumes',async t=>{
 const binding={defaultTemplateId:yangMiles.id,r08TemplateId:r08.id};
 const manualKey=`gptManualTemplate:${ORG}:customer-a:${yangMiles.id}:${r08.id}`;
 const {h,container:c}=await mount(t,{templates:[miles,menglongR08,r08,yangMiles],store:{[browserKey]:binding,[manualKey]:yangMiles.id}});
 assert.equal(c.querySelector('select[aria-label="GPT 模板"]').value,yangMiles.id);
 await click(button(c,s=>s==='恢复自动匹配'));
 assert.equal(c.querySelector('select[aria-label="GPT 模板"]').value,r08.id);
 assert.equal(h.store[manualKey],undefined);
});
test('changing the browser pair from another tab blocks stale generation and reloads the route',async t=>{
 const {h,container:c}=await mount(t,{templates:[miles,menglongR08,r08,yangMiles]});
 h.store[browserKey]={defaultTemplateId:yangMiles.id,r08TemplateId:r08.id};
 await click(button(c,s=>s==='生成'));
 assert.equal(h.calls.length,0);assert.match(c.textContent,/入口已改变/);
 await click(button(c,s=>s==='生成'));
 assert.equal(h.calls.length,1);assert.ok(h.calls[0].url.startsWith(r08.gpt_url));
});

test('CRM generation opens the selected template without any model routing', async t => {
  const {h,container} = await mount(t);
  await guidance(container,'只翻译这句，不报价');
  await click(button(container,t=>t==='生成'));
  assert.equal(h.calls[0].modelRouting,undefined);
  assert.equal(h.calls[0].url,r08.gpt_url);
});

test('a structured revision from discussion exposes the customer draft separately from internal analysis', async t => {
 const {container}=await mount(t, {responseText:'[Client Record]\nNo change\n[WhatsApp Reply]\nHello David. Which Land Cruiser model do you need?\n[Full Translation & Strategy]\n你好 David。你需要哪款兰德酷路泽？'});
 await discuss(container, '把上一稿改成两句');
 assert.ok(container.textContent.includes('Hello David. Which Land Cruiser model do you need?'));
 assert.ok(container.textContent.includes('给客户的回复'));
 assert.ok(!container.textContent.includes('🧠 GPT 的分析'));
});
test('an unstructured discussion remains internal and has no customer fill action', async t => {
 const {container}=await mount(t, {responseText:'客户已经说明预算，下一步先确认车型。'});
 await discuss(container, '分析一下下一步');
 assert.ok(container.textContent.includes('🧠 GPT 的分析'));
 assert.ok(!button(container, text => text.includes('填入聊天框')));
});

// 2026-09-23 精简上下文：老板有要求的轮次（生成框指令 / 讨论框任何输入）默认不注入跟进契约，
// 只有要求明确提到跟进/任务/安排才注入；不注入的轮次保存走 preserveExisting，任务表原样。
test('discussion injects the follow-up contract only on an explicit request; reply turns always carry it unless declined',async t=>{
 const raw='[Client Record]\nNo change\n[WhatsApp Reply]\nHello David. Which model?\n[Full Translation & Strategy]\n你好 David。需要哪款？\n<crm_followup>{"decision":"act"}</crm_followup>';
 for(const q of ['怎么回复这个客户？','改成一句英文']){
  const {h,container}=await mount(t,{responseText:raw});
  await discuss(container,q);
  assert.equal(h.followupPrompts.length,0,q);
  assert.equal(h.followupSaves.length,0,q);
  assert.ok(h.calls[0].prompt.includes('[Current owner scope] This turn must not create or modify follow-up tasks'),q);
  assert.ok(container.textContent.includes('Hello David. Which model?'));
  assert.ok(!container.textContent.includes('[GPT跟进安排]'));
 }
 {
  const {h,container}=await mount(t,{responseText:raw.replace('<crm_followup>{"decision":"act"}</crm_followup>','')});
  await guidance(container,'跟他说柴油四驱就剩五台了');
  await click(button(container,x=>x==='生成'));
  assert.equal(h.followupPrompts.length,1,'owner dictation in the generate box still lets the skill decide on a follow-up');
  assert.equal(h.followupPrompts[0].opts.compact,true,'compact turn carries the slim ledger');
  assert.ok(h.calls[0].prompt.includes('[GPT follow-up decision — internal only]')||h.followupPrompts.length===1);
 }
 {
  const {h,container}=await mount(t,{responseText:raw.replace('<crm_followup>{"decision":"act"}</crm_followup>','')});
  await click(button(container,x=>x==='生成'));
  assert.equal(h.followupPrompts.length,1,'generate without owner request keeps the full layer and its contract');
  assert.ok(!h.followupPrompts[0].opts.compact);
 }
 {
  const {h,container}=await mount(t,{responseText:raw.replace('<crm_followup>{"decision":"act"}</crm_followup>','')});
  await discuss(container,'安排下周跟进');
  assert.equal(h.followupPrompts.length,1,'an explicit follow-up request injects the contract');
 }
});
// 续聊 / 讨论续聊把完整消息交给构造函数：compact 层的价格/承诺锚点要从 50 条之前的历史取，先切 50 会丢
for (const action of ['generate','discussion']) {
 test(`${action} continuation hands the complete history to the prompt builder, not only the last 50`,async t=>{
  const OLD_DEAL='R08 deal confirmed: USD 16,900 per unit, deposit 30%, gift floor mats included.';
  const history=[msg(OLD_DEAL,1),...Array.from({length:70},(_,i)=>msg(i%2?'ok':'sure',i+2)),msg('Can you confirm the old R08 deal?',80)];
  const conv=conversation(r08);
  const {h,container}=await mount(t,{messages:{'customer-a':history},conversations:[conv]});
  if(action==='generate'){await guidance(container,'改成一句英文');await click(button(container,x=>x==='续聊生成'));}
  else await discuss(container,'他说的老价格是哪句？');
  assertR08Call(h,action==='generate'?'followup':'discussion-followup',conv.chat_url);
  const args=h.prompts.at(-1).args;
  assert.equal(args.newMessages.length,history.length,'complete history reaches the builder');
  assert.equal(args.newMessages[0].text,OLD_DEAL);
  assert.equal(args.layer,'compact');
  assert.equal(h.followupPrompts.length,action==='generate'?1:0,'reply turns carry the contract; discussion without a follow-up request does not');
 });
}
// 2026-09-23 Jaycee "Right" 复测：判断类讨论 → 末尾提醒 2–4 句先判断；不写客户话术、不建任务
test('a judgment question in the discussion box gets the short-answer default and no task contract',async t=>{
 const q='Jaycee 刚回了 Right。我感觉现在不用再推了，你怎么看？先和我讨论判断，不要写给客户的新消息，也不要安排跟进任务。';
 const {h,container}=await mount(t,{responseText:'不用再推了。他刚确认了对比，等他自己消化；现在追问只会显得急。'});
 await discuss(container,q);
 assert.equal(h.calls.length,1);
 const prompt=h.calls[0].prompt;
 assert.ok(prompt.includes('[Current request — answer this now]\n'+q));
 assert.ok(prompt.includes('If this is a judgment or advice question, keep the 2–4 sentence default above: verdict first, then the key reason.'));
 assert.ok(prompt.includes('[Current owner scope] This turn must not create or modify follow-up tasks'));
 assert.equal(h.followupPrompts.length,0);
 assert.equal(h.followupSaves.length,0);
 assert.ok(container.textContent.includes('不用再推了'));
});
// 2026-09-23 第二轮复测 bug：“不安排跟进”没有“任务”二字 → 契约仍注入 → 模型照老板要求不返回块 → 保存报“未返回跟进判断”并追加 [GPT跟进状态]
test('a discussion that declines follow-up saves quietly: no contract, no warning, no task write',async t=>{
 const q='Right 是真认同我们，还是只是礼貌附和？你会怎么判断？不要写客户回复，也不安排跟进。';
 const answer='更像礼貌确认。一个词看不出接受了哪一点，只能说他没反对；真认同一般会接着问价格或时间。';
 const {h,container}=await mount(t,{responseText:answer});
 h.followupError='GPT未返回唯一的跟进判断，未创建任务';
 await discuss(container,q);
 assert.equal(h.calls.length,1);
 assert.ok(h.calls[0].prompt.includes('[Current owner scope] This turn must not create or modify follow-up tasks'));
 assert.equal(h.followupPrompts.length,0);
 assert.equal(h.followupSaves.length,0);
 assert.ok(container.textContent.includes(answer));
 assert.ok(!container.textContent.includes('跟进安排未确认保存'));
 assert.ok(!container.textContent.includes('[GPT跟进状态]'));
 assert.ok(!container.textContent.includes('未返回跟进判断'));
 const draft=h.memoryWrites.find(w=>w.entry.kind==='assistant_draft');
 assert.equal(draft.entry.text,answer);
});
// 2026-09-23 Jaycee 实测：讨论“不要写客户回复，也不安排跟进”后点续聊生成，模型继续讨论。上一轮是讨论的会话不续用，另起新会话并覆盖保存。
test('generation after a discussion turn starts a fresh thread with full context and rebinds the conversation',async t=>{
 const conv=conversation(r08);
 const draft={id:'d1',at:'2026-09-23T19:00:00Z',scopeId:'customer-a',kind:'assistant_draft',text:'更像礼貌确认。',chatUrl:conv.chat_url};
 const afterDiscussion={contactId:'customer-a',scopeId:'customer-a',label:'当前需求',tasks:[],entries:[{id:'q1',at:'2026-09-23T18:59:00Z',scopeId:'customer-a',kind:'sales_discussion',text:'Right 是真认同还是礼貌附和？不要写客户回复，也不安排跟进。'},draft]};
 const {h,container}=await mount(t,{memories:{'customer-a':afterDiscussion},conversations:[conv],returnedUrl:`${r08.gpt_url}/c/fresh-thread`});
 await click(button(container,x=>x==='续聊生成'));
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].url,r08.gpt_url,'does not reuse the discussion thread');
 assert.equal(h.prompts.at(-1).kind,'first','full first-message context');
 assert.equal(h.followupPrompts.length,1,'normal generation carries the follow-up contract');
 const saved=h.writes.find(w=>w.table==='gpt_conversations');
 assert.ok(saved&&JSON.stringify(saved).includes('/c/fresh-thread'),'new thread replaces the saved conversation');
 // 对照：上一轮是生成的会话照常续聊
 // 对照组的上一轮是正常生成：草稿有三段
 const properDraft={...draft,text:'[Client Record]\nNo change\n[WhatsApp Reply]\nOnly 5 diesel 4WD units left.\n[Full Translation & Strategy]\n柴油四驱只剩五台。'};
 const afterGeneration={...afterDiscussion,entries:[{id:'i1',at:'2026-09-23T18:59:00Z',scopeId:'customer-a',kind:'sales_instruction',text:'跟他说柴油四驱就剩五台了'},properDraft]};
 const again=await mount(t,{memories:{'customer-a':afterGeneration},conversations:[conv]});
 await click(button(again.container,x=>x==='续聊生成'));
 assert.equal(again.h.calls[0].url,conv.chat_url);assert.equal(again.h.prompts.at(-1).kind,'followup');
});
// 真实失败路径：讨论 → 普通生成失败（同一旧 URL 存了无三段的草稿，没有 sales_instruction）→ 再次普通生成
test('generation retried after a failed post-discussion generation still leaves the polluted thread',async t=>{
 const conv=conversation(r08);
 const entries=[
  {id:'q1',at:'2026-09-23T18:59:00Z',scopeId:'customer-a',kind:'sales_discussion',text:'Right 是真认同还是礼貌附和？不要写客户回复，也不安排跟进。'},
  {id:'d1',at:'2026-09-23T19:00:00Z',scopeId:'customer-a',kind:'assistant_draft',text:'更像礼貌确认。',chatUrl:conv.chat_url},
  {id:'d2',at:'2026-09-23T19:20:00Z',scopeId:'customer-a',kind:'assistant_draft',text:'我的判断是：Right 更像礼貌附和……（长篇中文，无三段、无 crm_followup）',chatUrl:conv.chat_url},
 ];
 const {h,container}=await mount(t,{memories:{'customer-a':{contactId:'customer-a',scopeId:'customer-a',label:'当前需求',tasks:[],entries}},conversations:[conv],returnedUrl:`${r08.gpt_url}/c/fresh-thread-2`});
 await click(button(container,x=>x==='续聊生成'));
 assert.equal(h.calls[0].url,r08.gpt_url,'retry does not reuse the polluted thread either');
 assert.equal(h.prompts.at(-1).kind,'first');
 assert.equal(h.followupPrompts.length,1);
 assert.ok(JSON.stringify(h.writes.find(w=>w.table==='gpt_conversations')).includes('/c/fresh-thread-2'));
});
test('explicit discussion opt-out keeps the draft while suppressing task prompts and writes',async t=>{
 const q='把上一稿改成两句，不创建或调整跟进任务。';
 const {h,container}=await mount(t,{responseText:'[Client Record]\nNo change\n[WhatsApp Reply]\nHello David. Which model?\n[Full Translation & Strategy]\n你好 David。需要哪款？\n<crm_followup>{"decision":"act"}</crm_followup>'});
 await discuss(container,q);
 assert.equal(h.followupPrompts.length,0);
 assert.equal(h.followupSaves.length,0);
 assert.ok(h.calls[0].prompt.includes('[Current request — answer this now]\n'+q));
 assert.ok(container.textContent.includes('Hello David. Which model?'));
 assert.ok(!container.textContent.includes('[GPT跟进安排]'));
});
