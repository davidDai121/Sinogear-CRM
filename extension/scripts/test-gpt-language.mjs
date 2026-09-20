/** Offline prompt regression checks. Run: node scripts/test-gpt-language.mjs */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Use the extension's existing Vite/esbuild toolchain; no browser, DB or model calls.
const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/gpt-prompt.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const { buildFirstMessage, buildFollowUpMessage, buildDiscussionMessage } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const contact = {
  phone: '15550000000', group_jid: null, name: 'Test Customer', wa_name: null,
  country: 'Ecuador', language: 'English', budget_usd: null, destination_port: null,
  customer_stage: 'new', notes: null,
};
let nextId = 0;
const msg = (text, fromMe = false, sender = null) => ({
  id: `test-${nextId++}`, text, fromMe, sender, timestamp: 1700000000000 + nextId * 1000,
});
const languageBlock = (prompt) => prompt.slice(prompt.indexOf('\n[Reply Language]\n') + 1)
  .split('\nReminder: output exactly three sections')[0];
const evidence = (prompt) => {
  const block = languageBlock(prompt);
  const jsonStart = block.indexOf('\n[\n');
  return jsonStart < 0 ? [] : JSON.parse(block.slice(jsonStart));
};
const cases = [];
const check = (label, fn) => { fn(); cases.push(label); };

check('Spanish inbound remains the language evidence despite English CRM and Sales history', () => {
  const spanish = 'Hola, ¿cuánto cuesta la R08 diésel automática 4x4?';
  const prompt = buildFirstMessage({ contact, messages: [msg(spanish), ...Array.from({ length: 30 }, () => msg('Hello, here is our pickup offer.', true))] });
  assert.deepEqual(evidence(prompt).map((m) => m.text), [spanish]);
  assert.match(languageBlock(prompt), /actual customer wording takes precedence/);
  assert.match(languageBlock(prompt), /Spanish customer messages require a fully Spanish/);
  assert.doesNotMatch(prompt, /^Language: English$/m);
});

check('Custom GPT receives the same language contract even without the default role', () => {
  const prompt = buildFirstMessage({ contact, useCustomGpt: true, messages: [msg('Necesito una camioneta para Ecuador.')] });
  assert.doesNotMatch(prompt, /# Role & Identity/);
  assert.match(languageBlock(prompt), /Choose the customer-facing language for THIS reply/);
  assert.equal(evidence(prompt)[0].text, 'Necesito una camioneta para Ecuador.');
});

check('Continuing an old GPT thread reasserts language from new customer messages', () => {
  const prompt = buildFollowUpMessage({ contact, newMessages: [msg('Can I send our catalog?', true), msg('Sí, envíame los precios por favor.')] });
  assert.deepEqual(evidence(prompt).map((m) => m.text), ['Sí, envíame los precios por favor.']);
  assert.match(languageBlock(prompt), /your earlier replies/);
});

check('Media, removed messages and inbound Facebook advertising cannot set the language', () => {
  const prompt = buildFirstMessage({ contact, messages: [
    msg('Hola, necesito precio.'), msg('[图片]'), msg('[已删除]'),
    msg('IMG-20260913-WA0001.jpg (文件附件)'), msg(''),
    msg('logo-facebook-round R08 Priced from $9000 Calling all car dealers'),
    msg('We export these vehicles.', true),
  ] });
  assert.deepEqual(evidence(prompt).map((m) => m.text), ['Hola, necesito precio.']);
});

check('Explicit customer language choice is preserved even when written in another language', () => {
  const prompt = buildFollowUpMessage({ contact, newMessages: [msg('Hola, quiero la R08.'), msg('Please reply in English.')] });
  assert.equal(evidence(prompt).at(-1).text, 'Please reply in English.');
  assert.match(languageBlock(prompt), /most recent explicit language preference/);
  assert.match(languageBlock(prompt), /Keep that preference until the customer clearly changes it/);
});

check('Short acknowledgements do not reset an established Spanish conversation', () => {
  const prompt = buildFollowUpMessage({ contact, newMessages: [msg('Quiero saber el precio y el envío.'), msg('OK')] });
  assert.deepEqual(evidence(prompt).map((m) => m.text), ['Quiero saber el precio y el envío.', 'OK']);
  assert.match(languageBlock(prompt), /A short "OK".*does not change an established Spanish conversation to English/);
});

check('Salesperson can explicitly choose a language without Chinese guidance forcing Chinese', () => {
  const guidance = '用阿拉伯语回复，语气简短';
  const prompt = buildFollowUpMessage({ contact, salesGuidance: guidance, newMessages: [msg('Hola')] });
  assert.match(prompt, /\[Sales Guidance — TOP PRIORITY\]/);
  assert.ok(prompt.includes(guidance));
  assert.match(languageBlock(prompt), /1\. An explicit reply-language instruction from the salesperson/);
  assert.match(languageBlock(prompt), /language the salesperson used to write that guidance is NOT itself a language instruction/);
});

check('Other customer languages remain original evidence rather than forcing Spanish globally', () => {
  for (const text of ['Bonjour, quel est le prix du modèle électrique ?', 'Olá, qual é o preço da picape?', 'ما هو سعر السيارة؟']) {
    const prompt = buildFirstMessage({ contact: { ...contact, language: 'Spanish' }, messages: [msg(text)] });
    assert.equal(evidence(prompt)[0].text, text);
    assert.match(languageBlock(prompt), /Apply the same rule to every other language/);
  }
});

check('Latest group asker is identifiable and no single-customer language is fabricated', () => {
  const prompt = buildFirstMessage({ contact: { ...contact, group_jid: 'test@g.us' }, messages: [msg('What is the price?', false, 'Alice'), msg('¿Incluye el envío?', false, 'Carlos')] });
  assert.equal(evidence(prompt).at(-1).member, 'Carlos');
  assert.match(languageBlock(prompt), /most recent customer\/member you are answering/);
  assert.match(languageBlock(prompt), /Language as Unknown when there is no single customer language/);
});

check('Cold start and empty follow-up retain an explicit fallback without inventing English', () => {
  for (const prompt of [
    buildFirstMessage({ contact: { ...contact, language: 'Spanish' }, messages: [] }),
    buildFollowUpMessage({ contact: { ...contact, language: null }, newMessages: [] }),
  ]) {
    assert.deepEqual(evidence(prompt), []);
    assert.match(languageBlock(prompt), /No usable customer text in this request/);
    assert.match(languageBlock(prompt), /do not invent English/);
  }
});

check('Language evidence retains only recent inbound text without mutating chat order', () => {
  const messages = Array.from({ length: 12 }, (_, i) => msg(`Consulta número ${i}`));
  const original = JSON.stringify(messages);
  const prompt = buildFirstMessage({ contact, messages });
  assert.deepEqual(evidence(prompt).map((m) => m.text), messages.slice(-6).map((m) => m.text));
  assert.equal(JSON.stringify(messages), original);
});

check('Discussion mode remains internal Chinese without a customer-language output contract', () => {
  for (const prompt of [
    buildDiscussionMessage({ ctx: { contact, messages: [msg('Hola')] }, question: '怎么跟进？' }),
    buildDiscussionMessage({ contact, newMessages: [msg('Hola')], question: '怎么跟进？' }),
  ]) {
    assert.match(prompt, /Reply in Chinese \(中文\)/);
    assert.doesNotMatch(prompt, /\n\[Reply Language\]\n/);
  }
});

check('Long inbound stays complete once; language excerpt points to its exact source including trailing preference', () => {
  const text='Confirm each of these vehicle details. '.repeat(200)+'Please reply in Spanish, not English.';
  const m=msg(text);
  const prompt=buildFollowUpMessage({contact,newMessages:[m]});
  assert.equal(prompt.split(text).length-1,1);
  assert.equal(evidence(prompt)[0].text,text.slice(0,240));
  assert.equal(evidence(prompt)[0].fullTextRef,`message:${m.id}`);
  assert.ok(prompt.includes(`[source ${JSON.stringify(`message:${m.id}`)}]`));
  assert.match(languageBlock(prompt),/including at its end/);
});

check('Long language evidence absent from the rendered last 50 is never reduced to a dangling reference', () => {
  const text='Necesito información sobre estos vehículos. '.repeat(100);
  const prompt=buildFirstMessage({contact,messages:[msg(text),...Array.from({length:55},()=>msg('Sales note',true))]});
  assert.equal(evidence(prompt)[0].text,text);
  assert.equal(evidence(prompt)[0].fullTextRef,undefined);
});

console.log(`PASS ${cases.length} GPT language prompt regression cases.`);
console.log('These checks validate prompt evidence and routing, not live model language compliance.');
