/** Offline routing checks; no customer, database, or browser writes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/gpt-template-routing.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
});
const { resolveGptTemplateRoute, isConversationForGptTemplate, mentionsR08, R08_GPT_ID, MENGLONG_R08_GPT_ID } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const miles = { id: 'miles', name: 'Miles V2', is_default: true, gpt_url: 'https://chatgpt.com/g/g-6a2f7081d85c8191babfad41e1131be6-sino-gear-miles-v2' };
const r08 = { id: 'r08', name: 'R08 专用 · Miles', is_default: false, gpt_url: `https://chatgpt.com/g/${R08_GPT_ID}-sino-gear-r08-miles` };
const templates = [miles, r08];
let time = 1000;
const msg = (text, fromMe = false, timestamp = ++time) => ({ text, fromMe, timestamp });
const resolve = (ctx = {}, selected = miles.id, choices = templates) => resolveGptTemplateRoute(choices, selected, { messages: [], vehicleInterests: [], ...ctx });
const conv = (template, overrides = {}) => ({
  contact_id: 'customer-a', template_id: template.id, chat_url: `${template.gpt_url}/c/test-conversation`, ...overrides,
});

test('R08 Spanish customer overrides the general default and selects its own knowledge identity', () => {
  const route = resolve({ messages: [msg('Quiero saber el precio de la R08 diésel.')] });
  assert.equal(route.template.id, r08.id);
  assert.equal(route.isR08, true);
  assert.equal(route.error, null);
});

test('Menglong R08 copy routes automatically but cannot reuse the other account GPT conversation', () => {
  const copy = { ...r08, gpt_url: `https://chatgpt.com/g/${MENGLONG_R08_GPT_ID}-sino-gear-r08-miles` };
  const route = resolve({ messages: [msg('Quiero R08 diésel')] }, miles.id, [miles, copy]);
  assert.equal(route.template, copy);
  assert.equal(route.isR08, true);
  assert.equal(route.error, null);
  assert.equal(isConversationForGptTemplate(conv(r08), 'customer-a', copy), false);
  assert.equal(isConversationForGptTemplate(conv(copy), 'customer-a', r08), false);
  assert.equal(isConversationForGptTemplate(conv(copy), 'customer-a', copy), true);
  assert.equal(resolve({ messages: [msg('Now show me Hilux')] }, copy.id, [miles, copy]).template, miles);
});

test('strict model matching accepts common separators/Chinese adjacency and RELY R8', () => {
  for (const text of ['R08', 'r-08', 'R 08', 'R_08', 'R08柴油四驱', '想看R08', 'RELY R8', 'Chery R8', 'this_rely_r08_ev']) assert.equal(mentionsR08(text), true, text);
  for (const text of ['Audi R8', 'R8', 'I rely on you', 'R080', 'TR08A', 'r08abcdef', 'ER08']) assert.equal(mentionsR08(text), false, text);
});

test('non-model follow-up preserves earlier explicit customer R08 topic', () => {
  const route = resolve({ messages: [msg('R08 4WD'), msg('¿Cuánto cuesta la automática?')] });
  assert.equal(route.template.id, r08.id);
});

test('vehicle interests route a context-only follow-up', () => {
  assert.equal(resolve({ vehicleInterests: [{ model: 'Chery Rely R08' }], messages: [msg('Engine brand?')] }).template.id, r08.id);
});

test('latest definite different model supersedes old R08 history and interest', () => {
  for (const model of ['Hilux', 'RD6', 'Audi R8', 'BYD Shark']) {
    const route = resolve({ vehicleInterests: [{ model: 'R08' }], messages: [msg('R08 please'), msg(`Now show me ${model}`), msg('How much?')] }, r08.id);
    assert.equal(route.template.id, miles.id, model);
    assert.equal(route.isR08, false);
  }
});

test('comparison mentioning R08 still uses the R08 specialist', () => {
  assert.equal(resolve({ messages: [msg('Compare R08 with Hilux')] }).template.id, r08.id);
});

test('explicit whole-model rejection differs from comparisons and version changes', () => {
  for (const text of ['不要 R08，我要 Hilux', 'No quiero R08, busco Hilux', "I do not want the R08. Show me RD6", '不买R08。', 'No me interesa el R08.']) {
    assert.equal(resolve({ vehicleInterests: [{ model: 'R08' }], messages: [msg(text)] }).template.id, miles.id, text);
  }
  for (const text of ['No quiero R08 gasolina, quiero diésel', '不要R08汽油，给我柴油', 'No quiero R08 2WD, quiero R08 4WD']) {
    assert.equal(resolve({ messages: [msg(text)] }).template.id, r08.id, text);
  }
});

test('unrelated outbound pitch does not overwrite a definite customer topic', () => {
  assert.equal(resolve({ messages: [msg('Tell me about Hilux'), msg('Our R08 offer', true)] }).template.id, miles.id);
  assert.equal(resolve({ messages: [msg('I want R08'), msg('Here is another Hilux', true)] }).template.id, r08.id);
});

test('sales R08 product message supplies context when customer never named a model', () => {
  assert.equal(resolve({ messages: [msg('Here are RELY R08 specifications', true), msg('Engine brand?')] }).template.id, r08.id);
});

test('current sales guidance and discussion both participate in routing', () => {
  const messages = [msg('Hilux')];
  assert.equal(resolve({ messages, salesGuidance: '给他报 R08 柴油四驱' }).template.id, r08.id);
  assert.equal(resolve({ messages, discussionQuestion: '这个客户适合 R08 吗？' }).template.id, r08.id);
  assert.equal(resolve({ messages: [msg('R08')], salesGuidance: '这次报 Hilux' }).template.id, miles.id);
});

test('R08 cannot fall back to Miles when specialist is absent or only its name matches', () => {
  const ctx = { messages: [msg('R08')] };
  for (const choices of [[miles], [{ ...miles, name: 'R08 专用 · Miles' }], []]) {
    const route = resolve(ctx, miles.id, choices);
    assert.equal(route.template, null);
    assert.equal(route.isR08, true);
    assert.match(route.error, /R08 专用模板/);
  }
});

test('specialist lookup survives a display rename and does not require its DB UUID', () => {
  const renamed = { ...r08, id: 'new-row-id', name: 'Pickup expert' };
  assert.equal(resolve({ messages: [msg('R08')] }, miles.id, [miles, renamed]).template.id, 'new-row-id');
});

test('ad evidence is only a fallback and cannot seize a different current topic', () => {
  const ad = () => msg('logo-facebook-round R08 Priced from $9000 Calling all dealers');
  assert.equal(resolve({ messages: [msg('Hilux'), ad()] }).template.id, miles.id);
  assert.equal(resolve({ messages: [ad(), msg('Hello')] }).template.id, r08.id);
});

test('missing timestamps never place old R08 text ahead of current RD6 question', () => {
  assert.equal(resolve({ messages: [msg('RD6 please'), msg('R08', false, null)] }).template.id, miles.id);
});

test('ordinary language/media/removed messages do not create vehicle topics', () => {
  for (const text of ['I rely on your advice', 'D’accord', 'mini budget', '[图片]', '[已删除]']) {
    assert.equal(resolve({ messages: [msg(text)] }).template.id, miles.id, text);
  }
});

test('no R08 conversation means new thread despite a Miles thread for the same contact', () => {
  assert.equal(isConversationForGptTemplate(conv(miles), 'customer-a', r08), false);
});

test('only same customer, same template and same GPT identity can be continued', () => {
  assert.equal(isConversationForGptTemplate(conv(r08), 'customer-a', r08), true);
  assert.equal(isConversationForGptTemplate(conv(r08), 'customer-b', r08), false);
  assert.equal(isConversationForGptTemplate(conv(miles, { template_id: r08.id }), 'customer-a', r08), false);
  assert.equal(isConversationForGptTemplate(conv(r08, { chat_url: r08.gpt_url }), 'customer-a', r08), false);
});

test('conversation URL must be a genuine ChatGPT conversation on the proper GPT', () => {
  for (const chat_url of [
    `https://chatgpt.com.evil.test/g/${R08_GPT_ID}/c/test`,
    `https://example.com/g/${R08_GPT_ID}/c/test`,
    `http://chatgpt.com/g/${R08_GPT_ID}/c/test`,
    'https://chatgpt.com/c/test',
    'javascript:alert(1)',
  ]) assert.equal(isConversationForGptTemplate(conv(r08, { chat_url }), 'customer-a', r08), false, chat_url);
  assert.equal(isConversationForGptTemplate(conv(r08, { chat_url: `https://chatgpt.com/g/${R08_GPT_ID}-new-title/c/test?foo=1` }), 'customer-a', r08), true);
});

test('ordinary non-custom GPT templates can retain their ordinary conversations', () => {
  const plain = { ...miles, gpt_url: 'https://chatgpt.com/?model=gpt-5-thinking' };
  assert.equal(isConversationForGptTemplate(conv(plain, { chat_url: 'https://chatgpt.com/c/abcd' }), 'customer-a', plain), true);
  assert.equal(isConversationForGptTemplate(conv(r08, { template_id: plain.id }), 'customer-a', plain), false);
  assert.equal(isConversationForGptTemplate(conv(plain, { chat_url: 'https://chatgpt.com/c/abcd' }), 'customer-a', { ...plain, gpt_url: 'https://example.com/' }), false);
});
