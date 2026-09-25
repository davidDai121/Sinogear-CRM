/** ClientRecordCard must not write the profile while the same GPT run is still saving its follow-up. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import React, { act } from 'react';
const { window } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'offline-record-test' } });
globalThis.fetch = () => { throw Error('Network forbidden'); };
const require = createRequire(import.meta.url);
const { createRoot } = require('react-dom/client');
const offline = {
  name: 'offline',
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/(supabase|events-log)$/ }, a => ({ path: a.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, a => ({ loader: 'js', contents: a.path.endsWith('supabase')
      ? 'export const supabase = { from: t => globalThis.__recordHarness.query(t) };'
      : 'export const logContactEvent = (...args) => globalThis.__recordHarness.events.push(args);' }));
  },
};
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/panel/components/ClientRecordCard.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], plugins: [offline], alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const { ClientRecordCard } = loaded.exports;
async function settle() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setImmediate(r)); }); }

test('profile auto-save waits for autoApply, then writes the record exactly once', async t => {
  const h = { updates: [], events: [], query(table) {
    const q = { select() { return q; }, eq() { return q; }, upsert() { return q; },
      update(patch) { h.updates.push({ table, patch }); return q; },
      then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } };
    return q;
  } };
  globalThis.__recordHarness = h;
  const contact = { id: 'c1', name: 'David', country: 'China', language: 'English', destination_port: null, budget_usd: null, customer_stage: 'new' };
  const record = { destinationPort: 'Conakry, Guinea' };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = autoApply => act(async () => root.render(React.createElement(ClientRecordCard, { record, contact, source: 'gpt', autoApply })));
  await render(false); await settle();
  assert.equal(h.updates.length, 0, 'no profile write while the follow-up is still saving');
  await render(true); await settle();
  assert.deepEqual(h.updates, [{ table: 'contacts', patch: { destination_port: 'Conakry, Guinea' } }]);
  await render(true); await settle();
  assert.equal(h.updates.length, 1, 'the same record is not written twice');
});

test('without the prop the card keeps its old immediate auto-save', async t => {
  const h = { updates: [], events: [], query(table) {
    const q = { select() { return q; }, eq() { return q; }, upsert() { return q; },
      update(patch) { h.updates.push({ table, patch }); return q; },
      then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } };
    return q;
  } };
  globalThis.__recordHarness = h;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(React.createElement(ClientRecordCard, { record: { country: 'Guinea' },
    contact: { id: 'c2', country: null, destination_port: null, customer_stage: 'new' } })));
  await settle();
  assert.deepEqual(h.updates, [{ table: 'contacts', patch: { country: 'Guinea' } }]);
});
