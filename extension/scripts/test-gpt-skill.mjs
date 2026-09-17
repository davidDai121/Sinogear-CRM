import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { fileURLToPath } from 'node:url';

async function source(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { validateGptSkill, bindSkillConversation, fillGptSkillPrompt, R08_SKILL_ID } = await source('../src/lib/gpt-skill.ts');
const { encodeGptTemplateDescription: encode, decodeGptTemplateDescription: decode } = await source('../src/lib/gpt-template-knowledge.ts');
const { resolveGptTemplateRoute: route, isConversationForGptTemplate: matches } = await source('../src/lib/gpt-template-routing.ts');
const { readGptResponseSnapshot } = await source('../src/lib/gpt-response-dom.ts');
const skill = { id: R08_SKILL_ID, name: 'sino gear r08 miles' };
const description = encode('技能试点', '批准知识', false, '2026-09-17T08:00:00.000Z', skill);
const template = { id: 'skill-template', name: 'R08 技能', gpt_url: 'https://chatgpt.com/', is_default: false, description };

test('v2 retains skill identity; legacy stays v1; unknown and malformed config fail closed', () => {
  assert.deepEqual(decode(description).skill, skill);
  assert.equal(decode(encode('旧模板', '知识')).skill, undefined);
  for (const bad of [{ ...skill, id: 'g-123' }, { ...skill, script: true }, { ...skill, name: '@anything' }]) {
    assert.throws(() => validateGptSkill(bad));
  }
  assert.throws(() => decode(description.replace('"version": 2', '"version": 3')));
  assert.throws(() => decode(description.replace(R08_SKILL_ID, 'invalid')));
});

test('route uses immutable skill ID; conversation must match contact, template and skill', () => {
  const other = { ...template, id: 'other', description: null, is_default: true };
  assert.equal(route([other, template], 'other', { messages: [], vehicleInterests: [{ model: 'R08' }] }).template.id, template.id);
  assert.equal(route([other, template], 'other', { messages: [], vehicleInterests: [{ model: 'R08' }], manualTemplateId: 'other' }).template.id, 'other');
  const conv = { contact_id: 'a', template_id: template.id, chat_url: bindSkillConversation('https://chatgpt.com/c/test-chat', skill) };
  assert.equal(matches(conv, 'a', template), true);
  assert.equal(matches(conv, 'b', template), false);
  assert.equal(matches({ ...conv, chat_url: 'https://chatgpt.com/c/test-chat' }, 'a', template), false);
  assert.equal(matches({ ...conv, chat_url: conv.chat_url.replace(R08_SKILL_ID, 'wrong') }, 'a', template), false);
  assert.throws(() => bindSkillConversation('https://chatgpt.com/g/g-other/c/test', skill));
  assert.throws(() => bindSkillConversation('https://example.com/c/test', skill));
});

// Real picker/pill DOM shape observed in the browser. Only native editing,
// layout and time are simulated; no browser/account/network or customer writes.
async function composerCase(mode, run) {
  const { window } = parseHTML('<html><body><div id="prompt-textarea" contenteditable="true"></div></body></html>');
  const { document } = window;
  const old = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, now: Date.now };
  Object.assign(globalThis, { window, document });
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  const input = document.querySelector('#prompt-textarea');
  let collapsed = false;
  document.createRange = () => ({ selectNodeContents() { collapsed = false; }, collapse() { collapsed = true; } });
  window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  input.focus = () => {};
  const inserted = [];
  document.execCommand = (_cmd, _ui, text) => {
    inserted.push(text);
    if (!collapsed) {
      input.textContent = text;
      if (mode === 'missing') return true;
      for (let i = 0; i < (mode === 'duplicate' ? 2 : 1); i++) {
        const item = document.createElement('div'); item.className = '__menu-item'; item.setAttribute('data-fill', '');
        item.innerHTML = '<span>sino gear r08 miles</span><span>R08 回复</span>';
        item.addEventListener('click', () => {
          input.innerHTML = `<p><span data-inline-selection-pill data-symbol="skillMention" data-id="${mode === 'wrong' ? 'a'.repeat(32) : skill.id}">sino gear r08 miles</span> </p>`;
          item.remove();
        });
        document.body.append(item);
      }
    } else if (mode === 'dropped') input.textContent = text;
    else input.append(document.createTextNode(mode === 'truncated' ? text.slice(0, 12) : text));
    return true;
  };
  let time = 0;
  Date.now = () => time += 250;
  globalThis.setTimeout = fn => { fn(); return 0; };
  try { await run({ input, inserted }); }
  finally { Object.assign(globalThis, { window: old.window, document: old.document, setTimeout: old.setTimeout }); Date.now = old.now; }
}
test('selects a real pill, preserves full long prompt, serialized function needs no module closure', async () => {
  await composerCase('ok', async ({ input, inserted }) => {
    const serialized = new Function(`return (${fillGptSkillPrompt.toString()})`)();
    const prompt = 'CRM 客户上下文\n\n'.repeat(500);
    await serialized(skill, prompt);
    assert.equal(input.querySelector('[data-symbol="skillMention"]').getAttribute('data-id'), skill.id);
    assert.equal(inserted[1], '\n' + prompt);
  });
});
for (const mode of ['missing', 'wrong', 'duplicate', 'dropped', 'truncated']) {
  test(`composer ${mode} fails before send; missing or wrong skill never receives customer text`, async () => {
    await composerCase(mode, async ({ inserted }) => {
      await assert.rejects(fillGptSkillPrompt(skill, 'CRM 私有客户上下文与报价，本轮不能丢失。'));
      if (['missing', 'wrong', 'duplicate'].includes(mode)) assert.equal(inserted.length, 1);
    });
  });
}

test('Work skill response markup preserves empty NO_REPLY body and detects only current completion', () => {
  const { document } = parseHTML(`<html><body>
    <section data-testid="conversation-turn-4"><div data-message-author-role="assistant" data-message-id="old">旧结果</div><button aria-label="Copy response"></button></section>
    <section data-testid="conversation-turn-6" data-turn="assistant"><div data-conversation-screenshot-content>
    <div data-message-author-role="assistant" data-message-id="new"><div class="markdown prose"><p>[Client Record]<br>Phone: 13552592187</p><p>[WhatsApp Reply]</p><p>[Full Translation &amp; Strategy]<br>处理决定：NO_REPLY</p></div></div>
    <button aria-label="Copy response"></button></div></section></body></html>`);
  const previous = globalThis.document; globalThis.document = document;
  try {
    const result = readGptResponseSnapshot('old');
    assert.equal(result.hasCopyBtn, true); assert.equal(result.generating, false);
    assert.match(result.content, /\[WhatsApp Reply\]\n\n\[Full Translation & Strategy\]/);
    assert.equal(readGptResponseSnapshot('new').content, '');
    document.querySelector('section[data-turn] button').remove();
    assert.equal(readGptResponseSnapshot('old').hasCopyBtn, false);
  } finally { globalThis.document = previous; }
});

test('visible full URL survives Work anchors that omit href; no URL is invented from filenames', () => {
  const url = 'https://res.cloudinary.com/example/raw/upload/reference.pdf';
  const { document } = parseHTML(`<html><body><section data-testid="conversation-turn-2">
    <div data-message-author-role="assistant" data-message-id="new"><p>[WhatsApp Reply]</p><p><a class="decorated-link">${url}</a></p><p><a class="decorated-link">reference.pdf</a></p></div>
    <button aria-label="Copy response"></button></section></body></html>`);
  const previous = globalThis.document; globalThis.document = document;
  try {
    const result = readGptResponseSnapshot(null);
    assert.equal(result.hasCopyBtn, true);
    assert.ok(result.content.includes(url));
    assert.equal(result.content.match(/https:\/\//g).length, 1);
    assert.ok(result.content.includes('reference.pdf'));
  } finally { globalThis.document = previous; }
});

test('Chat landing switches to Work before selecting the skill; failed switch sends no context', async () => {
  for(const works of [true,false])await composerCase('ok',async({inserted})=>{
    const toggle=document.createElement('button');toggle.setAttribute('role','radio');toggle.setAttribute('data-tpp-toggle-value','work');toggle.setAttribute('aria-checked','false');toggle.textContent='Work';
    let switched=false;toggle.addEventListener('click',()=>{switched=true;if(works)toggle.setAttribute('aria-checked','true');});document.body.append(toggle);
    const original=document.execCommand;document.execCommand=(...args)=>{assert.equal(toggle.getAttribute('aria-checked'),'true');return original(...args)};
    if(works){await fillGptSkillPrompt(skill,'测试上下文');assert.equal(switched,true);assert.equal(inserted.length,2);}
    else{await assert.rejects(fillGptSkillPrompt(skill,'测试上下文'),/Work/);assert.equal(inserted.length,0);}
  });
});
