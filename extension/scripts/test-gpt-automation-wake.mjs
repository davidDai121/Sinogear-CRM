// 后台 GPT 标签冻结/节流 → 有限唤醒 + 结果保留（2026-09-18）
// 跑法：node --test scripts/test-gpt-automation-wake.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
async function load(file) { const r = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' }); return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64')); }
const { waitForCompletedGptResponse: wait } = await load('src/lib/gpt-response-wait.ts');
const { resumeGptRun, createWakePlanner, GptResultUnsavedError, WAKE_STALLED_AFTER_MS } = await load('src/lib/gpt-automation.ts');

const frame = (content, generating = false, hasCopyBtn = true) => ({ content, generating, hasCopyBtn });

test('completion wait reports a stall only while nothing changes, once per stall window', async () => {
  let time = 0; const stalls = [];
  const done = frame('[Client Record]\nNo change\n\n[WhatsApp Reply]\nHola\n\n[Full Translation & Strategy]\n你好');
  const result = await wait(async () => time < 130_000 ? frame('', true, false) : done,
    { now: () => time, sleep: async ms => { time += ms; }, stalledAfterMs: 60_000, onStalled: async info => { stalls.push([time, info.stalledMs]); } });
  assert.equal(result, done.content);
  assert.equal(stalls.length, 2, '60s 和 120s 各一次');
  assert.ok(stalls[0][0] >= 60_000 && stalls[0][0] < 62_000);
  assert.ok(stalls[1][0] >= 120_000 && stalls[1][0] < 122_000);
});

test('a stream that keeps growing is never reported as stalled', async () => {
  let time = 0; let stalls = 0;
  await wait(async () => time < 100_000 ? frame(`streaming ${Math.floor(time / 5000)}`, true, false) : frame('final'),
    { now: () => time, sleep: async ms => { time += ms; }, stalledAfterMs: 60_000, onStalled: async () => { stalls++; } });
  assert.equal(stalls, 0);
});

test('wake planner: at most two attempts, at least 60s apart', () => {
  let time = 0;
  const p = createWakePlanner({ now: () => time });
  assert.equal(p.claim(), 1);
  time = 30_000; assert.equal(p.claim(), 0, '间隔不够');
  time = 61_000; assert.equal(p.claim(), 2);
  time = 300_000; assert.equal(p.claim(), 0, '超过上限');
});

/** 假 chrome：按注入函数的源码特征分发，时间由 _timing 驱动 */
function fakeChrome({ snapshotAt, tabId = 42 }) {
  const calls = { removed: [], windowsCreated: [], tabUpdates: [], order: [] };
  let time = 0; let activeTab = 99;
  const timing = { now: () => time, sleep: async ms => { time += ms; } };
  globalThis.chrome = {
    tabs: {
      get: async id => ({ id, url: 'https://chatgpt.com/c/abc-123', windowId: 7 }),
      update: async (id, props) => { calls.tabUpdates.push([id, props]); if (props.active) activeTab = id; return {}; },
      remove: async id => { calls.removed.push(id); calls.order.push('remove'); },
      query: async () => [{ id: activeTab, windowId: 7 }],
    },
    windows: {
      getLastFocused: async () => ({id:7,focused:true}),
      create: async data => { calls.windowsCreated.push(data); return { id: 55 }; },
      update: async () => ({}),
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        const src = func.toString();
        if (src.includes('hasCopyBtn')) return [{ result: snapshotAt(time) }];
        if (src.includes('lastUserId')) return [{ result: { lastAssistantId: 'msg-new', lastUserId: 'u1', generating: false } }];
        // 出现迹象检查：baseline 之后已有新 turn
        return [{ result: args[0] !== 'msg-new' }];
      },
    },
  };
  return { calls, timing, tabId };
}
const finalText = '[Client Record]\nNo change\n\n[WhatsApp Reply]\nHola José\n\n[Full Translation & Strategy]\n你好';
const stalledThenDone = t => t < WAKE_STALLED_AFTER_MS + 15_000 ? frame('', true, false) : frame(finalText);
const baseline = { lastAssistantId: 'msg-old', lastUserId: 'u0', generating: false };

test('stalled background tab is moved to an unfocused window once, then result delivered before the tab closes', async () => {
  const { calls, timing, tabId } = fakeChrome({ snapshotAt: stalledThenDone });
  const progress = [];
  const result = await resumeGptRun({ tabId, baseline, url: 'https://chatgpt.com/', _timing: timing,
    onProgress: e => progress.push(e), beforeClose: async r => { calls.order.push(`deliver:${r.responseText.length}`); } });
  assert.equal(result.responseText, finalText);
  assert.equal(result.tabId, tabId);
  assert.equal(result.chatUrl, 'https://chatgpt.com/c/abc-123');
  assert.equal(calls.windowsCreated.length, 1, '停滞一次只挪一次窗口');
  assert.deepEqual(calls.windowsCreated[0], { tabId, focused: false, type: 'normal', width: 520, height: 420 });
  assert.ok(calls.tabUpdates.some(([id, p]) => id === tabId && p.autoDiscardable === false), '防 Memory Saver 丢弃');
  assert.ok(!calls.tabUpdates.some(([, p]) => p.active === true), '窗口模式不抢焦点');
  assert.deepEqual(calls.order, [`deliver:${finalText.length}`, 'remove'], '先交付再关标签');
  assert.deepEqual(progress.map(e => e.phase), ['woken', 'completed']);
  assert.equal(progress[0].method, 'window');
});

test('delivery failure keeps the tab open and carries the result on the error', async () => {
  const { calls, timing, tabId } = fakeChrome({ snapshotAt: () => frame(finalText) });
  await assert.rejects(
    resumeGptRun({ tabId, baseline, url: 'https://chatgpt.com/', _timing: timing, wake: 'none', beforeClose: async () => { throw new Error('storage quota'); } }),
    err => err instanceof GptResultUnsavedError && err.result.responseText === finalText && err.result.tabId === tabId && /storage quota/.test(err.message),
  );
  assert.deepEqual(calls.removed, [], '结果未交付时不关标签');
  assert.equal(calls.windowsCreated.length, 0, 'wake=none 不唤醒');
});

test('activate mode briefly focuses the GPT tab and restores the previous tab', async () => {
  const { calls, timing, tabId } = fakeChrome({ snapshotAt: stalledThenDone });
  await resumeGptRun({ tabId, baseline, url: 'https://chatgpt.com/', _timing: timing, wake: 'activate' });
  assert.equal(calls.windowsCreated.length, 0);
  const activations = calls.tabUpdates.filter(([, p]) => p.active === true).map(([id]) => id);
  assert.deepEqual(activations, [tabId, 99], '激活 GPT 标签后切回原标签');
  assert.deepEqual(calls.removed, [tabId]);
});

test('old assistant turn is never taken as the new result while resuming', async () => {
  const { timing, tabId } = fakeChrome({ snapshotAt: () => frame(finalText) });
  // baseline 已经是页面最后一条：迹象检查永远不成立 → 按超时/未开始回复处理，不返回旧内容
  await assert.rejects(
    resumeGptRun({ tabId, baseline: { ...baseline, lastAssistantId: 'msg-new' }, url: 'https://chatgpt.com/', _timing: timing, wake: 'none', responseTimeoutMs: 200_000 }),
    /未开始回复/,
  );
});

 test('user changing focus during wake is respected', async () => {
  const {calls,timing,tabId}=fakeChrome({snapshotAt:stalledThenDone});
  const sleep=timing.sleep;
  timing.sleep=async ms=>{await sleep(ms);if(ms===4000)globalThis.chrome.tabs.query=async()=>[{id:123,windowId:8}];};
  await resumeGptRun({tabId,baseline,url:'https://chatgpt.com/',_timing:timing,wake:'activate'});
  assert.deepEqual(calls.tabUpdates.filter(([,p])=>p.active).map(([id])=>id),[tabId]);
});

test('wake restoration does not bring Chrome back over another app',async()=>{
 const {calls,timing,tabId}=fakeChrome({snapshotAt:stalledThenDone});
 globalThis.chrome.windows.getLastFocused=async()=>({id:7,focused:false});
 await resumeGptRun({tabId,baseline,url:'https://chatgpt.com/',_timing:timing,wake:'activate'});
 assert.deepEqual(calls.tabUpdates.filter(([,p])=>p.active).map(([id])=>id),[tabId]);
});
