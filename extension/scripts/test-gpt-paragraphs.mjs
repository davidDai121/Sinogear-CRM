import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import ts from 'typescript';

// Compile the real source without a build, browser session, or customer data.
async function loadTs(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const { readGptResponseSnapshot } = await loadTs('../src/lib/gpt-response-dom.ts');
const { parseClaudeResponse } = await loadTs('../src/lib/claude-parser.ts');
const { sanitizeReplyForCustomer } = await loadTs('../src/lib/reply-sanitize.ts');

function fixture(body, previous = '') {
  return parseHTML(`<html><body>${previous}<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="new">${body}</div><button data-testid="copy-turn-action-button">Copy</button></article></body></html>`).document;
}

function snapshot(document, prevId = 'old') {
  // Mirror executeScript's serialization boundary: no imported module closures.
  return vm.runInNewContext(`(${readGptResponseSnapshot.toString()})(${JSON.stringify(prevId)})`, { document, URL });
}

test('paragraph boundaries survive DOM extraction, parsing and customer sanitizing', () => {
  const document = fixture('<p>[Client Record]</p><p>Language: Spanish</p><p>[WhatsApp Reply]</p><p>Hola, el R08 cuesta USD 17,400 FOB Shanghái.</p><p>¿A qué puerto lo enviaríamos?</p><p>[Full Translation &amp; Strategy]</p><p>中文翻译：询问客户目的港。</p>');
  const detachedText = document.querySelector('[data-message-author-role="assistant"]').cloneNode(true).textContent;
  assert.ok(detachedText.includes('Shanghái.¿A qué'), 'textContent fallback reproduces the lost paragraph');
  const state = snapshot(document);
  const parsed = parseClaudeResponse(state.content);
  assert.equal(sanitizeReplyForCustomer(parsed.reply), 'Hola, el R08 cuesta USD 17,400 FOB Shanghái.\n\n¿A qué puerto lo enviaríamos?');
  assert.equal(parsed.clientRecord.language, 'Spanish');
  assert.ok(parsed.translation.includes('中文翻译'));
  assert.equal(state.hasCopyBtn, true);
});

test('observed writing-block header is excluded while its sibling editor keeps the three response sections', () => {
  const document = fixture(`
    <p>[Client Record]</p><p>Language: Spanish</p><p>[WhatsApp Reply]</p>
    <div class="relative z-[1]">
      <div data-testid="writing-block-header-sticky-container">
        <div data-testid="writing-block-header-surface">
          <div data-writing-block-fullscreen-header-chrome="true">
            <div class="min-w-0 truncate">Comparativo R08 y proceso de compra</div>
            <button>Copy</button>
          </div>
        </div>
      </div>
    </div>
    <div class="writing-block-editor markdown-new-styling">
      <p>Claro, Fernando.</p><p>Estas son las dos opciones.</p>
    </div>
    <p>[Full Translation &amp; Strategy]</p><p>中文翻译：当然，Fernando。</p>
  `);
  const state = snapshot(document);
  const parsed = parseClaudeResponse(state.content);
  assert.equal(sanitizeReplyForCustomer(parsed.reply), 'Claro, Fernando.\n\nEstas son las dos opciones.');
  assert.equal(parsed.clientRecord.language, 'Spanish');
  assert.equal(parsed.translation, '中文翻译：当然，Fernando。');
  assert.ok(!state.content.includes('Comparativo R08 y proceso de compra'));
  assert.equal(document.querySelector('.truncate').textContent, 'Comparativo R08 y proceso de compra', 'the live header remains untouched');
});

test('multiple writing blocks retain real h1/h2 and paragraphs without their surface or fullscreen chrome', () => {
  const document = fixture(`
    <p>[Client Record]</p><p>Name: QA</p><p>[WhatsApp Reply]</p>
    <p>Primero, una comparación.</p>
    <div>
      <div data-testid="writing-block-header-surface"><div>Editor title one</div></div>
      <div class="writing-block-editor markdown-new-styling">
        <h1>Comparativo R08 y proceso de compra</h1><p>Versión manual.</p>
      </div>
    </div>
    <div>
      <div data-writing-block-fullscreen-header-chrome="true"><div>Editor title two</div></div>
      <div class="writing-block-editor markdown-new-styling">
        <h2>Versión automática</h2><p>Segunda opción.</p><p>¿Cuál prefiere?</p>
      </div>
    </div>
    <p>[Full Translation &amp; Strategy]</p><p>中文说明。</p>
  `);
  const state = snapshot(document);
  const parsed = parseClaudeResponse(state.content);
  assert.equal(sanitizeReplyForCustomer(parsed.reply), 'Primero, una comparación.\n\nComparativo R08 y proceso de compra\n\nVersión manual.\n\nVersión automática\n\nSegunda opción.\n\n¿Cuál prefiere?');
  assert.equal(parsed.clientRecord.name, 'QA');
  assert.equal(parsed.translation, '中文说明。');
  assert.ok(!state.content.includes('Editor title'));
});

test('an empty writing editor cannot turn ASK_BOSS into a customer reply through its header', () => {
  const document = fixture(`
    <p>[Client Record]</p><p>Language: Spanish</p><p>[WhatsApp Reply]</p>
    <div data-testid="writing-block-header-sticky-container"><div>Draft awaiting confirmation</div></div>
    <div class="writing-block-editor markdown-new-styling"></div>
    <p>[Full Translation &amp; Strategy]</p><p>处理决定：ASK_BOSS</p><p>待老板问题：请确认保险金额。</p>
  `);
  const parsed = parseClaudeResponse(snapshot(document).content);
  assert.equal(parsed.reply, null);
  assert.ok(parsed.translation.includes('ASK_BOSS'));
  assert.ok(parsed.translation.includes('请确认保险金额'));
});

test('soft breaks, list items, links and code keep separate lines', () => {
  const document = fixture('<p>Hola <strong>José</strong>.<br>Estas son las opciones:</p><ul><li>Diésel: USD 17,400</li><li>EV: USD 25,000</li></ul><p><a href="https://example.com">Ficha técnica</a></p><pre><code>VIN:\n  pendiente\n\nPuerto:\n  pendiente</code><button>Copy code</button></pre>');
  const { content } = snapshot(document);
  assert.equal(content, 'Hola José.\nEstas son las opciones:\n\n- Diésel: USD 17,400\n- EV: USD 25,000\n\nFicha técnica: https://example.com\n\nVIN:\n  pendiente\n\nPuerto:\n  pendiente');
});

test('customer product links retain their absolute destination, query and hash through parsing and sanitizing', () => {
  const url = 'https://www.sinogear-auto.com/vehicles/chery-rely-r08-pickup-export?utm_source=chatgpt.com&lang=es#configuraciones';
  const document = fixture(`
    <p>[Client Record]</p><p>Language: Spanish</p><p>[WhatsApp Reply]</p>
    <p>Puede revisar el producto aquí:</p>
    <p><a class="decorated-link" href="${url.replaceAll('&', '&amp;')}">Ver <strong>RELY R08</strong> en Sino Gear</a></p>
    <p>Después podemos comparar las versiones.</p>
    <p>[Full Translation &amp; Strategy]</p><p>中文翻译：可以先查看产品。</p>
  `);
  const parsed = parseClaudeResponse(snapshot(document).content);
  assert.equal(sanitizeReplyForCustomer(parsed.reply), `Puede revisar el producto aquí:\n\nVer RELY R08 en Sino Gear: ${url}\n\nDespués podemos comparar las versiones.`);
  assert.equal(parsed.clientRecord.language, 'Spanish');
  assert.equal(parsed.translation, '中文翻译：可以先查看产品。');
  assert.equal(document.querySelector('a').getAttribute('href'), url, 'reading does not alter the source link');
});

test('plain URLs and anchors already showing their destination are not duplicated', () => {
  const url = 'https://example.com/r08?lang=es#specs';
  for (const body of [`<p>${url}</p>`, `<p><a href="${url}">${url}</a></p>`]) {
    assert.equal(snapshot(fixture(body)).content, url);
  }
  assert.equal(snapshot(fixture('<p><a href="https://example.com/">https://example.com</a></p>')).content, 'https://example.com');
  assert.equal(snapshot(fixture('<p><a href="http://example.com/r08">Product page</a></p>')).content, 'Product page: http://example.com/r08');
});

test('URL labels with omitted tracking or a different address export only the real destination', () => {
  const visible = 'https://www.sinogear-auto.com/es/vehicles/chery-rely-r08-pickup-export';
  const actual = `${visible}?utm_source=chatgpt.com`;
  assert.equal(snapshot(fixture(`<p><a class="decorated-link" href="${actual}">${visible}</a></p>`)).content, actual);

  const differentTarget = 'https://example.com/actual?lang=es#specs';
  assert.equal(snapshot(fixture(`<p><a href="${differentTarget}">https://other.example/product</a></p>`)).content, differentTarget);
  assert.equal(snapshot(fixture(`<p><a href="${differentTarget}">mailto:sales@example.com</a></p>`)).content, `mailto:sales@example.com: ${differentTarget}`);
});

test('web citation pills and their duplicated animated labels stay out of customer links', () => {
  const document = fixture(`
    <p>[Client Record]</p><p>Language: Spanish</p><p>[WhatsApp Reply]</p>
    <p>Puede revisar el producto.<span data-testid="webpage-citation-pill"><a href="https://citation.example/source"><span>Sino Gear +2</span><span>Sino Gear +2</span></a></span></p>
    <p><a class="decorated-link" href="https://example.com/r08">Ver RELY R08</a></p>
    <p>[Full Translation &amp; Strategy]</p><p>中文说明。</p>
  `);
  const state = snapshot(document);
  assert.equal(sanitizeReplyForCustomer(parseClaudeResponse(state.content).reply), 'Puede revisar el producto.\n\nVer RELY R08: https://example.com/r08');
  assert.ok(!state.content.includes('Sino Gear +2'));
  assert.ok(!state.content.includes('citation.example'));
  assert.ok(document.querySelector('[data-testid="webpage-citation-pill"]'), 'the live citation UI remains untouched');
});

test('relative, fragment, non-web and malformed href targets are not exported or resolved', () => {
  const document = fixture('<p><a href="/vehicles/r08">Relative product</a></p><p><a href="//example.com/r08">Protocol-relative product</a></p><p><a href="#specs">Specifications</a></p><p><a href="javascript:alert(1)">Action</a></p><p><a href="mailto:sales@example.com">Email</a></p><p><a href="https://">Unavailable</a></p>');
  assert.equal(snapshot(document).content, 'Relative product\n\nProtocol-relative product\n\nSpecifications\n\nAction\n\nEmail\n\nUnavailable');
});

test('thinking panels and controls are excluded without mutating the live DOM', () => {
  const document = fixture('<div data-testid="thinking-panel">private reasoning</div><p>Bonjour.</p><div aria-hidden="true">hidden</div><div role="toolbar">tools</div><p>Quel port ?</p>');
  const { content } = snapshot(document);
  assert.equal(content, 'Bonjour.\n\nQuel port ?');
  assert.ok(document.querySelector('[data-testid="thinking-panel"]'));
});

test('old assistant turn is never returned and old copy buttons do not complete a new turn', () => {
  const document = fixture('<p>Current response.</p>');
  assert.equal(snapshot(document, 'new').content, '');
  document.querySelector('article button').remove();
  document.body.insertAdjacentHTML('afterbegin', '<article><button data-testid="copy-turn-action-button">Old copy</button></article>');
  assert.equal(snapshot(document).hasCopyBtn, false);
});

test('legacy prose fallback and streaming stop signal still work', () => {
  const { document } = parseHTML('<html><body><div class="markdown prose"><p>Uno.</p><p>Dos.</p></div><button data-testid="stop-button">Stop</button></body></html>');
  assert.equal(snapshot(document).content, 'Uno.\n\nDos.');
  assert.equal(snapshot(document).generating, true);
  assert.equal(snapshot(document, 'prose:1').content, '');
});

test('ASK_BOSS leaves an empty customer reply while retaining the internal question', () => {
  const document = fixture('<p>[Client Record]</p><p>Language: Spanish</p><p>[WhatsApp Reply]</p><p>[Full Translation &amp; Strategy]</p><p>处理决定：ASK_BOSS</p><p>待老板问题：三台每台 USD 16,000 是否可以？</p>');
  const parsed = parseClaudeResponse(snapshot(document).content);
  assert.equal(parsed.reply, null);
  assert.ok(parsed.translation.includes('ASK_BOSS\n\n待老板问题'));
  assert.equal(sanitizeReplyForCustomer(parsed.reply ?? ''), '');
});

test('sanitizer removes internal strategy without collapsing customer paragraphs', () => {
  assert.equal(sanitizeReplyForCustomer('Hola.\n\nUSD 17,400 FOB Shanghái.\n\n¿Puerto?\n\n[Full Translation & Strategy]\nInternal notes'), 'Hola.\n\nUSD 17,400 FOB Shanghái.\n\n¿Puerto?');
});
