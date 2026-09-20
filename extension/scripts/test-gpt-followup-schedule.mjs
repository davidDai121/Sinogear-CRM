import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const b = await build({ entryPoints: ['src/lib/gpt-followup-schedule.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { installFollowupSchedule, FOLLOWUP_REVIEW_SETTING: key, FOLLOWUP_ALARM: name } = await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
const flush = () => new Promise(resolve => setImmediate(resolve));
test('background review defaults off, clears legacy alarm, and needs explicit opt-in after startup', async () => {
  const events = {};
  const event = kind => ({ addListener(fn) { (events[kind] ??= []).push(fn); } });
  const emit = (kind, ...args) => events[kind]?.forEach(fn => fn(...args));
  let enabled;
  let alarm = { name, periodInMinutes: 1 }; // Existing installations had this alarm.
  let calls = 0;
  globalThis.chrome = {
    runtime: { onStartup: event('startup'), onInstalled: event('installed') },
    storage: { local: { async get() { return { [key]: enabled }; } }, onChanged: event('storage') },
    alarms: { onAlarm: event('alarm'), async get() { return alarm; }, async clear(n) { assert.equal(n, name); alarm = undefined; }, async create(n, opts) { alarm = { name: n, ...opts }; } },
  };
  installFollowupSchedule(async () => { calls++; });
  await flush(); assert.equal(alarm, undefined);
  emit('startup'); emit('installed'); emit('alarm', { name });
  await flush(); assert.equal(calls, 0); assert.equal(alarm, undefined);
  enabled = 'true'; emit('alarm', { name }); await flush(); assert.equal(calls, 0);
  enabled = true; emit('storage', { [key]: { newValue: true } }, 'local');
  await flush(); assert.equal(alarm.periodInMinutes, 1); assert.equal(calls, 0);
  emit('alarm', { name: 'unrelated-alarm' }); await flush(); assert.equal(calls, 0);
  emit('alarm', { name }); await flush(); assert.equal(calls, 1);
  enabled = false; emit('storage', { [key]: { newValue: false } }, 'local');
  emit('alarm', { name }); emit('startup');
  await flush(); assert.equal(calls, 1); assert.equal(alarm, undefined);
  delete globalThis.chrome;
});
