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
async function composerCase(mode, run, identity = skill) {
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
      // Current UI can show an old Skill and a plugin with the same name.
      if (identity.id.startsWith('plugin_')) {
        const legacy = document.createElement('div'); legacy.className = '__menu-item'; legacy.setAttribute('data-fill', '');
        legacy.innerHTML = '<span>sino gear r08 miles</span>';
        legacy.addEventListener('click', () => assert.fail('Selected the old same-name skill'));
        document.body.append(legacy);
      }
      for (let i = 0; i < (mode === 'duplicate' ? 2 : 1); i++) {
        const item = document.createElement('div'); item.className = '__menu-item'; item.setAttribute('data-fill', '');
        item.innerHTML = (identity.id.startsWith('plugin_') ? '<div data-testid="plugin-icon-wrapper"></div>' : '') + '<span>sino gear r08 miles</span><span>R08 回复</span>';
        item.addEventListener('click', () => {
          input.innerHTML = `<p><span data-inline-selection-pill data-symbol="${identity.id.startsWith('plugin_') ? 'ecosystemMention' : 'skillMention'}" data-id="${mode === 'wrong' ? 'a'.repeat(32) : identity.id.startsWith('plugin_') ? `plugin:${identity.id}` : identity.id}">sino gear r08 miles</span> </p>`;
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
    assert.deepEqual(await serialized(skill, prompt), { ok: true });
    assert.equal(input.querySelector('[data-symbol="skillMention"]').getAttribute('data-id'), skill.id);
    assert.equal(inserted[1], '\n' + prompt);
  });
});
for (const mode of ['missing', 'wrong', 'dropped', 'truncated']) {
  test(`composer ${mode} fails before send; missing or wrong skill never receives customer text`, async () => {
    await composerCase(mode, async ({ inserted }) => {
      const result = await fillGptSkillPrompt(skill, 'CRM 私有客户上下文与报价，本轮不能丢失。');
      assert.equal(result.ok, false); assert.ok(result.error);
      if (['missing', 'wrong'].includes(mode)) assert.ok(inserted.every(t => t.startsWith('@')));
    });
  });
}
test('same-name items are accepted only by the exact pill identity', async () => {
  await composerCase('duplicate', async ({ input }) => {
    assert.deepEqual(await fillGptSkillPrompt(skill, '上下文'), { ok: true });
    assert.equal(input.querySelectorAll('[data-symbol]').length, 1);
  });
});

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

test('Chat plugin preserves mode, exact identity and full long context without module closure', async () => {
  const plugin = { id: 'plugin_5e838f5f90dc81919776e122e642836e', name: 'Sino Gear R08 Miles' };
  assert.deepEqual(validateGptSkill(plugin), plugin);
  assert.deepEqual(decode(encode('plugin', 'knowledge', false, undefined, plugin)).skill, plugin);
  for (const mode of ['ok', 'wrong', 'missing', 'duplicate', 'dropped', 'truncated']) {
    await composerCase(mode, async ({ inserted, input }) => {
      const toggle = document.createElement('button');
      toggle.setAttribute('role', 'radio'); toggle.setAttribute('data-tpp-toggle-value', 'work');
      toggle.setAttribute('aria-checked', 'false');
      toggle.addEventListener('click', () => assert.fail('Must not switch to Work'));
      document.body.append(toggle);
      const serialized = new Function(`return (${fillGptSkillPrompt.toString()})`)();
      const prompt = 'CRM 历史客户消息与销售指令\n'.repeat(500);
      const result = await serialized(plugin, prompt);
      assert.equal(result.ok, ['ok', 'duplicate'].includes(mode));
      if (result.ok) {
        assert.equal(inserted.at(-1), '\n' + prompt);
        assert.equal(input.querySelector('[data-symbol="ecosystemMention"]').getAttribute('data-id'), `plugin:${plugin.id}`);
      } else assert.ok(result.error);
      if (['wrong', 'missing'].includes(mode)) assert.ok(inserted.every(t => t.startsWith('@')));
    }, plugin);
  }
});

test('plugin switches an initial Work surface to Chat, and failed switch returns a useful error', async () => {
  const plugin = { id: 'plugin_5e838f5f90dc81919776e122e642836e', name: 'Sino Gear R08 Miles' };
  for (const toggleValue of ['chatgpt', 'chat']) for (const succeeds of [true, false]) await composerCase('ok', async ({ inserted }) => {
    const chat = document.createElement('button'); chat.setAttribute('role', 'radio');
    chat.setAttribute('data-tpp-toggle-value', toggleValue); chat.setAttribute('aria-checked', 'false');
    chat.addEventListener('click', () => { if (succeeds) chat.setAttribute('aria-checked', 'true'); });
    document.body.append(chat);
    const result = await fillGptSkillPrompt(plugin, '测试上下文');
    assert.equal(result.ok, succeeds);
    if (succeeds) assert.equal(chat.getAttribute('aria-checked'), 'true');
    else { assert.match(result.error, /Chat/); assert.equal(inserted.length, 0); }
  }, plugin);
});

test('selected Work without a recognized Chat toggle blocks plugins even without fixed High', async () => {
  const plugin = { id: 'plugin_5e838f5f90dc81919776e122e642836e', name: 'Sino Gear R08 Miles' };
  await composerCase('ok', async ({ inserted }) => {
    const work = document.createElement('button');
    work.setAttribute('role', 'radio'); work.setAttribute('data-tpp-toggle-value', 'work'); work.setAttribute('aria-checked', 'true');
    document.body.append(work);
    const result = await fillGptSkillPrompt(plugin, '私有上下文');
    assert.equal(result.ok, false); assert.match(result.error, /Work/); assert.equal(inserted.length, 0);
  }, plugin);
});

test('waits for delayed surface controls before selecting a plugin', async () => {
  const plugin = { id: 'plugin_5e838f5f90dc81919776e122e642836e', name: 'Sino Gear R08 Miles' };
  await composerCase('ok', async () => {
    const previousTimer = globalThis.setTimeout;
    let mounted = false;
    let switched = false;
    globalThis.setTimeout = fn => {
      if (!mounted) {
        mounted = true;
        const chat = document.createElement('button'); chat.setAttribute('role', 'radio');
        chat.setAttribute('data-tpp-toggle-value', 'chatgpt'); chat.setAttribute('aria-checked', 'false');
        chat.addEventListener('click', () => { switched = true; chat.setAttribute('aria-checked', 'true'); });
        document.body.append(chat);
      }
      fn(); return 0;
    };
    try { assert.equal((await fillGptSkillPrompt(plugin, '上下文')).ok, true); assert.equal(switched, true); }
    finally { globalThis.setTimeout = previousTimer; }
  }, plugin);
});

 test('explicit High uses normal Chat slider and refuses missing or Pro controls', async () => {
 const plugin={id:'plugin_5e838f5f90dc81919776e122e642836e',name:'Sino Gear R08 Miles',thinkingEffort:'high'};
 assert.deepEqual(validateGptSkill(plugin),plugin);
 for(const bad of [{...plugin,thinkingEffort:'pro'},{...skill,thinkingEffort:'high'}])assert.throws(()=>validateGptSkill(bad));
 for(const mode of ['medium','instant','extra','already','missing','pro'])await composerCase('ok',async()=>{
  const old=globalThis.KeyboardEvent, oldPointer=globalThis.PointerEvent;
  globalThis.PointerEvent=window.Event;
  globalThis.KeyboardEvent=class extends window.Event{constructor(type,init){super(type,init);this.key=init.key;}};
  const effort=document.createElement('button');effort.setAttribute('aria-haspopup','menu');
  effort.textContent=mode==='already'?'High':mode==='extra'?'Extra High':mode==='instant'?'Instant':'Medium';
  document.body.append(effort);
  effort.addEventListener('click',()=>{
   if(mode==='missing')return;
   const picker=document.createElement('div');picker.setAttribute('data-testid','composer-intelligence-picker-content');
   picker.innerHTML='<div role="menuitem" aria-label="Power"><span role="slider" aria-valuemax="3" aria-valuenow="'+(mode==='extra'?3:mode==='instant'?0:1)+'"></span></div><div role="menuitemradio" aria-checked="true">'+(mode==='pro'?'Pro':'Latest')+'</div>';
   const power=picker.querySelector('[aria-label="Power"]'),slider=picker.querySelector('[role="slider"]');power.focus=()=>{};
   power.addEventListener('keydown',e=>{if(e.key.startsWith('Arrow')){const n=Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1);slider.setAttribute('aria-valuenow',n);effort.textContent=['Instant','Medium','High','Extra High'][n];}});
   document.body.append(picker);
  });
  try{const serialized=new Function('return ('+fillGptSkillPrompt.toString()+')')();const result=await serialized(plugin,'测试');assert.equal(result.ok,!['missing','pro'].includes(mode));if(result.ok)assert.equal(effort.textContent,'High');}
  finally{globalThis.KeyboardEvent=old;globalThis.PointerEvent=oldPointer;}
 },plugin);
});

// 2026-09-25 ChatGPT markup observed in the browser: no #prompt-textarea, a
// "Composer mode" button group, mention buttons without plugin markers, plugins
// insert [app-mention-path], and a same-name custom GPT becomes a footer chip.
const v2 = { id: 'plugin_bd1c07b572d08191882a68116ab63a17', name: 'Sino Gear Miles V2', thinkingEffort: 'high' };
async function currentComposerCase(items, run, { work = false, chatSwitches = true, effort = 'Medium', modelTag = '', compact = false } = {}) {
  const { window } = parseHTML(`<html><body><div role="group" aria-label="Composer mode">
    <button aria-pressed="${!work}">Chat</button><button aria-pressed="${work}">Work</button></div>
    <form><div class="ProseMirror" contenteditable="true" role="textbox"></div><div id="footer"></div>
    <button type="button" aria-haspopup="menu" id="radix-1"><span class="sr-only">Thinking effort</span>${modelTag ? `<span>${modelTag}</span> ` : ''}<span>${effort}</span></button></form></body></html>`);
  const { document } = window;
  const old = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, now: Date.now,
    KeyboardEvent: globalThis.KeyboardEvent, PointerEvent: globalThis.PointerEvent };
  Object.assign(globalThis, { window, document });
  globalThis.PointerEvent = window.Event;
  globalThis.KeyboardEvent = class extends window.Event { constructor(type, init) { super(type, init); this.key = init.key; } };
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  const input = document.querySelector('.ProseMirror');
  const [chat, work2] = document.querySelectorAll('[aria-label="Composer mode"] button');
  chat.addEventListener('click', () => { if (chatSwitches) { chat.setAttribute('aria-pressed', 'true'); work2.setAttribute('aria-pressed', 'false'); } });
  const effortBtn = document.querySelector('#radix-1');
  effortBtn.addEventListener('pointerdown', () => {
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-labelledby', 'radix-1');
    const level = ['Instant', 'Medium', 'High', 'Extra High'].indexOf(effortBtn.lastElementChild.textContent);
    const models = '<div role="menuitemradio" aria-checked="true">Latest</div>';
    menu.innerHTML = `<div role="menuitem" data-model-picker-view-toggle="true">${effortBtn.lastElementChild.textContent}</div><div role="menuitem" aria-label="Power"></div><span role="slider" aria-valuemax="3" aria-valuenow="${level}"></span>${compact ? '' : models}`;
    menu.querySelector('[data-model-picker-view-toggle]').addEventListener('click', () => menu.insertAdjacentHTML('beforeend', models));
    const power = menu.querySelector('[aria-label="Power"]'), slider = menu.querySelector('[role="slider"]'); power.focus = () => {};
    power.addEventListener('keydown', e => {
      if (e.key.startsWith('Arrow')) {
        const n = Number(slider.getAttribute('aria-valuenow')) + (e.key === 'ArrowRight' ? 1 : -1);
        slider.setAttribute('aria-valuenow', n); effortBtn.lastElementChild.textContent = ['Instant', 'Medium', 'High', 'Extra High'][n];
      } else if (e.key === 'Enter') menu.remove();
    });
    document.body.append(menu);
  });
  let collapsed = false;
  document.createRange = () => ({ selectNodeContents() { collapsed = false; }, collapse() { collapsed = true; } });
  window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  input.focus = () => {};
  const inserted = [];
  const chips = () => document.querySelectorAll('#footer button');
  document.execCommand = (_cmd, _ui, text) => {
    inserted.push(text);
    if (collapsed) { input.append(document.createTextNode(text)); return true; }
    input.innerHTML = `<p>${text}</p>`;
    document.querySelector('[data-mention-list-scroll-area]')?.remove();
    const list = document.createElement('div'); list.setAttribute('data-mention-list-scroll-area', '');
    for (const kind of items) {
      const item = document.createElement('button'); item.setAttribute('data-list-navigation-item', 'true');
      item.innerHTML = '<div><span></span><span><span><span class="shrink-0">Sino Gear Miles V2</span><span>描述</span></span></span></div>';
      item.addEventListener('click', () => {
        list.remove();
        if (kind === 'chip') {
          const chip = document.createElement('button'); chip.setAttribute('aria-label', 'Remove Sino Gear Miles V2');
          chip.addEventListener('click', () => chip.remove());
          document.querySelector('#footer').append(chip); input.innerHTML = '<p></p>';
        } else {
          const id = kind === 'wrong' ? 'plugin_' + 'a'.repeat(32) : kind === 'upper' ? v2.id.replace('plugin_', 'Plugin_') : v2.id;
          input.innerHTML = `<p><span app-mention-path="app://${id}" contenteditable="false"><span>Sino Gear Miles V2</span></span> </p>`;
        }
      });
      list.append(item);
    }
    document.body.append(list);
    return true;
  };
  let time = 0;
  Date.now = () => time += 250;
  globalThis.setTimeout = fn => { fn(); return 0; };
  try { await run({ input, inserted, chips, effortBtn, chat }); }
  finally {
    Object.assign(globalThis, { window: old.window, document: old.document, setTimeout: old.setTimeout,
      KeyboardEvent: old.KeyboardEvent, PointerEvent: old.PointerEvent });
    Date.now = old.now;
  }
}
const serializedFill = () => new Function(`return (${fillGptSkillPrompt.toString()})`)();

test('2026-09-25 composer: skips a same-name GPT chip, keeps exact plugin pill, sets High', async () => {
  await currentComposerCase(['chip', 'pill'], async ({ input, inserted, chips, effortBtn }) => {
    const prompt = 'CRM 客户上下文\n'.repeat(300);
    assert.deepEqual(await serializedFill()(v2, prompt), { ok: true });
    assert.equal(input.querySelector('[app-mention-path]').getAttribute('app-mention-path'), `app://${v2.id}`);
    assert.equal(chips().length, 0);
    assert.equal(inserted.filter(t => !t.startsWith('@')).length, 1);
    assert.equal(inserted.at(-1), '\n' + prompt);
    assert.equal(effortBtn.lastElementChild.textContent, 'High');
  });
});

for (const items of [['chip'], ['wrong'], ['wrong', 'chip'], []]) {
  test(`2026-09-25 composer [${items}] fails closed without customer text`, async () => {
    await currentComposerCase(items, async ({ inserted, chips }) => {
      const result = await serializedFill()(v2, '私有客户上下文');
      assert.equal(result.ok, false);
      assert.match(result.error, items.length ? /不匹配/ : /未找到已安装技能/);
      assert.ok(inserted.every(t => t.startsWith('@')));
      assert.equal(chips().length, 0);
    });
  });
}

test('2026-09-25 composer: wrong plugin then the right one', async () => {
  await currentComposerCase(['wrong', 'pill'], async ({ input }) => {
    assert.equal((await serializedFill()(v2, '上下文')).ok, true);
    assert.equal(input.querySelectorAll('[app-mention-path]').length, 1);
  });
});

test('2026-09-25 composer: switches Work to Chat, or refuses when it stays on Work', async () => {
  await currentComposerCase(['pill'], async ({ chat }) => {
    assert.equal((await serializedFill()(v2, '上下文')).ok, true);
    assert.equal(chat.getAttribute('aria-pressed'), 'true');
  }, { work: true });
  await currentComposerCase(['pill'], async ({ inserted }) => {
    const result = await serializedFill()(v2, '上下文');
    assert.equal(result.ok, false); assert.match(result.error, /Chat/); assert.equal(inserted.length, 0);
  }, { work: true, chatSwitches: false });
});

test('2026-09-25 response markup: reads only the new assistant body, not code-block chrome', () => {
  const { document } = parseHTML(`<html><body>
    <div data-turn-key="t1"><div data-chatgpt-search-unit-key="t1:0:user" data-chatgpt-search-message-ids="u1"><div data-user-message-bubble="true">客户问题</div></div>
    <div data-chatgpt-search-unit-key="t1:1:assistant"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>
    <div data-chatgpt-selection-message-id="old"><div data-markdown-text-style="assistant-message"><p>旧结果</p></div></div></div>
    <button aria-label="Copy"></button></div>
    <div data-turn-key="t2"><div data-chatgpt-search-unit-key="t2:1:assistant"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>
    <div data-chatgpt-selection-message-id="new"><div data-markdown-text-style="assistant-message"><p>[WhatsApp Reply]</p><p>Hello friend</p>
    <div data-markdown-copy="code-block"><div data-markdown-copy="exclude">python<button aria-label="Copy"></button></div><pre>x = 1</pre></div></div></div></div>
    <button aria-label="Rate response"></button><button aria-label="Regenerate response"></button></div></body></html>`);
  const previous = globalThis.document; globalThis.document = document;
  try {
    const result = readGptResponseSnapshot('old');
    assert.equal(result.hasCopyBtn, true);
    assert.equal(result.content, '[WhatsApp Reply]\n\nHello friend\n\nx = 1');
    assert.equal(readGptResponseSnapshot('new').content, '');
    for (const b of document.querySelectorAll('[data-turn-key="t2"] > button')) b.remove();
    assert.equal(readGptResponseSnapshot('old').hasCopyBtn, false);
  } finally { globalThis.document = previous; }
});

test('uploaded plugins report app://Plugin_<id>; the same hex ID still matches', async () => {
  await currentComposerCase(['upper'], async ({ input }) => {
    assert.equal((await serializedFill()(v2, '上下文')).ok, true);
    assert.equal(input.querySelector('[app-mention-path]').getAttribute('app-mention-path'), v2.id.replace('plugin_', 'app://Plugin_'));
  });
});

test("Yang's R08 plugin is an R08 template; Yang's Miles V2 plugin is not", () => {
  const yangR08 = { id: 'yang-r08', name: 'R08 专用 · Yang', gpt_url: 'https://chatgpt.com/', is_default: false,
    description: encode('R08', '知识', false, '2026-09-25T00:00:00.000Z', { id: 'plugin_be083c80ae4c81919339c7e557170738', name: 'Sino Gear R08 Miles', thinkingEffort: 'high' }) };
  const yangV2 = { ...yangR08, id: 'yang-v2', description: encode('V2', '知识', false, '2026-09-25T00:00:00.000Z', { id: 'plugin_7edc4c03db008191ad89a1001756c10b', name: 'Sino Gear Miles V2', thinkingEffort: 'high' }) };
  const routed = route([yangV2, yangR08], 'yang-v2', { messages: [], vehicleInterests: [{ model: 'R08' }], browserBinding: { defaultTemplateId: 'yang-v2', r08TemplateId: 'yang-r08' } });
  assert.equal(routed.error, null);
  assert.equal(routed.template.id, 'yang-r08');
  assert.equal(route([yangV2, yangR08], 'yang-v2', { messages: [], vehicleInterests: [], browserBinding: { defaultTemplateId: 'yang-v2', r08TemplateId: 'yang-r08' } }).template.id, 'yang-v2');
});

test('Extra High is a valid plugin preference and moves the slider to its last step', async () => {
  const v2x = { ...v2, thinkingEffort: 'extra_high' };
  assert.deepEqual(validateGptSkill(v2x), v2x);
  assert.throws(() => validateGptSkill({ ...skill, thinkingEffort: 'extra_high' }));
  assert.throws(() => validateGptSkill({ ...v2, thinkingEffort: 'xhigh' }));
  for (const start of ['Instant', 'Medium', 'High', 'Extra High']) {
    await currentComposerCase(['pill'], async ({ effortBtn }) => {
      assert.deepEqual(await serializedFill()(v2x, '上下文'), { ok: true });
      assert.equal(effortBtn.lastElementChild.textContent, 'Extra High');
    }, { effort: start });
  }
});

test('GPT-5.6 Sol prefixes the effort label with its version; the level is still read and set', async () => {
  const v2x = { ...v2, thinkingEffort: 'extra_high' };
  await currentComposerCase(['pill'], async ({ effortBtn }) => {
    assert.deepEqual(await serializedFill()(v2x, '上下文'), { ok: true });
    assert.equal(effortBtn.lastElementChild.textContent, 'Extra High');
  }, { modelTag: '5.6' });
});

test('compact effort picker is expanded to confirm the model before setting Extra High', async () => {
  const v2x = { ...v2, thinkingEffort: 'extra_high' };
  await currentComposerCase(['pill'], async ({ effortBtn }) => {
    assert.deepEqual(await serializedFill()(v2x, '上下文'), { ok: true });
    assert.equal(effortBtn.lastElementChild.textContent, 'Extra High');
  }, { compact: true });
});

test('2026-09-25 writing card: its title bar is not reply text and its Copy is not completion', () => {
  const card = `<div data-turn-key="t1"><div data-chatgpt-search-unit-key="t1:1:assistant"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>
    <div data-chatgpt-selection-message-id="new"><div data-markdown-text-style="assistant-message"><p>[Client Record]<br>No change</p><p>[WhatsApp Reply]</p>
    <div><div aria-hidden="true"></div><div><header><div><span><button aria-label="Add to library"></button><span>WhatsApp Reply</span></span></div>
    <div><button aria-label="Copy"></button><button aria-label="Open editor"></button></div></header>
    <div><div data-markdown-copy-content="true"><div contenteditable="true"><p>The Corolla Cross is popular there.</p></div></div></div></div></div>
    <p>[Full Translation &amp; Strategy]<br>中文翻译</p></div></div></div>__BAR__</div>`;
  const previous = globalThis.document;
  try {
    globalThis.document = parseHTML(`<html><body>${card.replace('__BAR__', '')}</body></html>`).document;
    const streaming = readGptResponseSnapshot(null);
    assert.equal(streaming.hasCopyBtn, false);
    assert.equal(streaming.content, '[Client Record]\nNo change\n\n[WhatsApp Reply]\n\nThe Corolla Cross is popular there.\n\n[Full Translation & Strategy]\n中文翻译');
    globalThis.document = parseHTML(`<html><body>${card.replace('__BAR__', '<button aria-label="Copy"></button>')}</body></html>`).document;
    assert.equal(readGptResponseSnapshot(null).hasCopyBtn, true);
  } finally { globalThis.document = previous; }
});

test('2026-09-25 citation chips are not read into the reply or strategy', () => {
  const { document } = parseHTML(`<html><body><div data-turn-key="t1"><h4 data-conversation-role="assistant"></h4>
    <div data-chatgpt-selection-message-id="new"><div data-markdown-text-style="assistant-message">
    <p>[WhatsApp Reply]</p><p>Freight is a reference rate. <span data-state="closed"><span data-search-result-target=""><a data-testid="chatgpt-citation" href="https://truckingrates.org/x"><span><span><span>TruckingRates.org</span></span></span><span aria-hidden="true"><span>+2</span></span></a></span></span></p>
    </div></div><button aria-label="Copy"></button></div></body></html>`);
  const previous = globalThis.document; globalThis.document = document;
  try { assert.equal(readGptResponseSnapshot(null).content, '[WhatsApp Reply]\n\nFreight is a reference rate.'); }
  finally { globalThis.document = previous; }
});
