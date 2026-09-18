// lib/chat-context.ts 的单元测试 —— 全仓库第一批针对「AI 读消息 + 身份校验」
// 编排逻辑的自动化测试（2026-09-18 从四个组件抽共享模块时一起起的）。
// 跑法：npm run test:chat-context
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function source(path) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
}

const { loadChatContextWith, dbRowsToChatMessages } = await source(
  '../src/lib/chat-context.ts',
);

const target = {
  id: 'c-1',
  phone: '+2348012345678',
  name: 'Ada',
  wa_name: 'Ada 🌸',
  group_jid: null,
};

const domMsgs = [
  { id: 'm1', fromMe: false, text: 'hi', timestamp: 1, sender: null },
];
const dbRows = [
  {
    wa_message_id: 'w1',
    direction: 'outbound',
    text: 'hello',
    sent_at: '2026-09-01T00:00:00Z',
  },
  { wa_message_id: 'w2', direction: 'inbound', text: 'hey', sent_at: null },
];

/** 可覆写的 fake deps，默认走「一切正常」路径并记录调用 */
function fakeDeps(overrides = {}) {
  const calls = { jump: [], sync: [], merge: [], loadDb: [], logFail: [] };
  const deps = {
    jumpToChat: async (query, opts) => {
      calls.jump.push({ query, requireMatch: opts.requireMatch });
      return true;
    },
    verifyHeaderMatches: () => true,
    waitForChatMessages: async () => domMsgs,
    collectRecentChatMessages: async () => domMsgs,
    loadMessages: async (id, limit) => {
      calls.loadDb.push({ id, limit });
      return dbRows;
    },
    mergeDomWithDbMessages: async (dom, id, limit) => {
      calls.merge.push({ dom, id, limit });
      return dom;
    },
    syncMessages: async (id, messages) => {
      calls.sync.push({ id, count: messages.length });
      return undefined;
    },
    maybeLogReadFailure: (reason) => calls.logFail.push(reason),
    ...overrides,
  };
  return { deps, calls };
}

const baseOpts = { needsJump: true, logTag: 'test' };

test('DOM 路径：jump 带完整 requireMatch，持久化 + merge，source=dom', async () => {
  const { deps, calls } = fakeDeps();
  const out = await loadChatContextWith(deps, target, baseOpts);
  assert.equal(out.source, 'dom');
  assert.equal(calls.jump.length, 1);
  // query 是剥掉 + 的手机号
  assert.equal(calls.jump[0].query, '2348012345678');
  // 身份校验五档字段一个不能少（跨聊天污染 P0 防线）
  assert.deepEqual(calls.jump[0].requireMatch, {
    phone: target.phone,
    name: target.name,
    waName: target.wa_name,
    groupJid: null,
  });
  assert.deepEqual(calls.sync, [{ id: 'c-1', count: 1 }]);
  assert.equal(calls.merge.length, 1);
});

test('群聊（无 phone）按群名跳，requireMatch 带 groupJid', async () => {
  const { deps, calls } = fakeDeps();
  const group = {
    id: 'g-1',
    phone: null,
    name: '  尼日利亚拼车群  ',
    wa_name: null,
    group_jid: '12036302@g.us',
  };
  await loadChatContextWith(deps, group, baseOpts);
  assert.equal(calls.jump[0].query, '尼日利亚拼车群');
  assert.equal(calls.jump[0].requireMatch.groupJid, '12036302@g.us');
});

test('jump 失败 → DOM 不读，fallback 纯 DB，行映射正确', async () => {
  const { deps, calls } = fakeDeps({ jumpToChat: async () => false });
  const out = await loadChatContextWith(deps, target, baseOpts);
  assert.equal(out.source, 'db');
  assert.equal(calls.sync.length, 0);
  assert.deepEqual(out.messages, [
    {
      id: 'w1',
      fromMe: true,
      text: 'hello',
      timestamp: Date.parse('2026-09-01T00:00:00Z'),
      sender: null,
    },
    { id: 'w2', fromMe: false, text: 'hey', timestamp: null, sender: null },
  ]);
});

test('race：读完 DOM 后用户切走 WA chat → 丢弃 DOM 绝不 sync，走 DB', async () => {
  let verifyCount = 0;
  const { deps, calls } = fakeDeps({
    // 第一次 verify（needsJump=false 的读取门）过，第二次（写 DB 前 sanity）不过
    verifyHeaderMatches: () => {
      verifyCount += 1;
      return verifyCount === 1;
    },
  });
  const out = await loadChatContextWith(deps, target, {
    ...baseOpts,
    needsJump: false,
  });
  assert.equal(out.source, 'db');
  assert.equal(calls.sync.length, 0, '身份不匹配时绝不能写 messages 表');
});

test('needsJump=false 且 verify 不过 → 不读 DOM 直接 DB', async () => {
  let waited = false;
  const { deps } = fakeDeps({
    verifyHeaderMatches: () => false,
    waitForChatMessages: async () => {
      waited = true;
      return domMsgs;
    },
  });
  const out = await loadChatContextWith(deps, target, {
    ...baseOpts,
    needsJump: false,
  });
  assert.equal(waited, false);
  assert.equal(out.source, 'db');
});

test('冷启动：DB 也空，指令非空 → source=guidance 不抛错', async () => {
  const { deps } = fakeDeps({
    jumpToChat: async () => false,
    loadMessages: async () => [],
  });
  const out = await loadChatContextWith(deps, target, {
    ...baseOpts,
    guidance: '给他推 R08，强调现车',
  });
  assert.deepEqual(out, { messages: [], source: 'guidance' });
});

test('冷启动：支持指令但指令为空 → 抛错且文案含冷启动提示', async () => {
  const { deps, calls } = fakeDeps({
    jumpToChat: async () => false,
    loadMessages: async () => [],
  });
  await assert.rejects(
    loadChatContextWith(deps, target, { ...baseOpts, guidance: '  ' }),
    /销售指令/,
  );
  assert.deepEqual(calls.logFail, ['test cold-start']);
});

test('冷启动：不支持指令的调用方（Tags/Tasks）→ 抛错且文案不提销售指令', async () => {
  const { deps } = fakeDeps({
    jumpToChat: async () => false,
    loadMessages: async () => [],
  });
  await assert.rejects(
    loadChatContextWith(deps, target, baseOpts),
    (err) => !/销售指令/.test(err.message) && /导入手机聊天/.test(err.message),
  );
});

test('awaitSync：sync 失败必须抛错（GPT 跟进保存前的保证）', async () => {
  const { deps } = fakeDeps({
    syncMessages: async () => ({ error: 'RLS denied' }),
  });
  await assert.rejects(
    loadChatContextWith(deps, target, { ...baseOpts, awaitSync: true }),
    /最新消息未同步.*RLS denied/,
  );
});

test('collectRecent：verify 过时用滚动补采结果替换 DOM 消息', async () => {
  const collected = [
    ...domMsgs,
    { id: 'm0', fromMe: true, text: 'older', timestamp: 0, sender: null },
  ];
  const { deps, calls } = fakeDeps({
    collectRecentChatMessages: async () => collected,
  });
  const out = await loadChatContextWith(deps, target, {
    ...baseOpts,
    collectRecent: true,
  });
  assert.equal(out.source, 'dom');
  assert.equal(calls.sync[0].count, 2);
});

test('dbRowsToChatMessages：方向/时间戳映射', () => {
  const mapped = dbRowsToChatMessages(dbRows);
  assert.equal(mapped[0].fromMe, true);
  assert.equal(mapped[1].fromMe, false);
  assert.equal(mapped[1].timestamp, null);
});
