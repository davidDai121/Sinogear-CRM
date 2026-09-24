// 精简 CRM 上下文（A/B 层）回归：docs/技能对话体验_精简上下文方案_2026-09-23.md
// 纯离线：真实 prompt/渲染代码，不调模型、不读库。Run: node --test scripts/test-gpt-context-layer.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(path) {
  const r = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const { resolveContextLayer, followupContractRequested, selectCompactHistory, compactRenderedMessages, threadEndsWithDiscussion } = await load('../src/lib/gpt-context-layer.ts');
const { buildFirstMessage, buildFollowUpMessage, buildDiscussionMessage, chatHistoryEvidence } = await load('../src/lib/gpt-prompt.ts');
const { renderSalesWorkMemory, confirmedQuoteConditions } = await load('../src/lib/sales-work-memory.ts');
const { omitTemplateSourcedFacts, compactSalesFacts } = await load('../src/lib/sales-facts.ts');

const contact = { phone: '2348012345678', group_jid: null, name: 'Test Buyer', wa_name: null, country: 'Nigeria', language: 'English', budget_usd: null, destination_port: 'Lagos', customer_stage: 'quoted', notes: null };
let n = 0;
// 时间戳晚于报价草稿 computedAt（2026-09-22T02:00Z），下面那条含总价的销售出站才算“可能已发”，否则报价规程每轮都会加载
const msg = (text, fromMe = false) => ({ id: `m${++n}`, text, fromMe, sender: null, timestamp: 1790121600000 + n * 60000 });
const EARLY_PRICE = 'Our FOB Shanghai price for the diesel 4WD is USD 17,400 per unit, payment 30/70.';
const EARLY_AD = 'Priced from $12,200! Calling all importers — RELY R08 pickup.';
const SENT_TOTAL = 'Total for two units to Lagos: USD 41,000.00 CIF, that is 20,500 each.';
const messages = [
  msg('Hello, I want the diesel pickup'), msg('Sure, which version?', true), msg(EARLY_PRICE, true), msg(EARLY_AD, true), msg(SENT_TOTAL, true),
  msg('ok noted'), msg('Any photos?'), msg('[图片]', true), msg('[图片]', true),
  ...Array.from({ length: 24 }, (_, i) => msg(i % 2 ? 'Thanks, checking.' : 'Sure, let me know.', i % 2 === 0)),
  msg('LAST_CUSTOMER_MESSAGE: when can you load them?'),
];
const knowledge = { text: 'KNOWLEDGE_TEXT 柴油 2.3T 8AT 四驱 Comfort 17,400', templateId: 'tpl-a', updatedAt: '2026-09-23T00:00:00.000Z' };
const fact = (over) => ({ id: over.id, org_id: 'org', fact_key: over.key, category: over.category ?? 'price', scope: over.scope, product_key: 'r08', contact_id: over.scope === 'order' ? 'c1' : null, scope_id: over.scope === 'order' ? 'c1' : null, status: 'approved', authority: 'owner_statement', observed_at: '2026-09-20T00:00:00Z', valid_until: null, statement: over.statement, value: {}, source: { ref: over.ref, quote: over.statement }, title: over.id, version: 1 });
const factLibrary = { usable: [
  fact({ id: 'order', key: 'price.order', scope: 'order', statement: 'ORDER_FACT_16900 本单两台特批 16,900', ref: 'crm:contact_events:x' }),
  fact({ id: 'product', key: 'price.base', scope: 'product', statement: 'PRODUCT_FACT_DUP 17,400', ref: 'crm:gpt_templates:tpl-a' }),
  fact({ id: 'org', key: 'insurance.reference', category: 'insurance', scope: 'org', statement: 'ORG_FEE_RULE 保险按总运输费用10%', ref: '/skills/quote/SKILL.md' }),
], unavailable: [] };
const workMemory = {
  contactId: 'c1', scopeId: 'c1', label: '两台柴油', tasks: [{ id: 't1', title: 'TASK_TITLE 跟进：核对两台报价', due_at: null, status: 'open' }],
  entries: [
    { id: 'e1', at: '2026-09-22T00:00:00Z', scopeId: 'c1', kind: 'sales_instruction', text: 'OWNER_EXCEPTION 本单特批：这两台按16,900给他，含到拉各斯海运，赠品保留' },
    { id: 'e2', at: '2026-09-22T01:00:00Z', scopeId: 'c1', kind: 'assistant_draft', text: '[Client Record]\nNo change\n[WhatsApp Reply]\nDRAFT_REPLY_TEXT two units at 16,900 each\n[Full Translation & Strategy]\nSTRATEGY_INTERNAL 内部策略' },
  ],
  historicalGuidance: [{ id: 'h1', payload: { schema: 'sales-history.v1', sourceAt: '2026-09-10T00:00:00Z', text: 'OLD_PROMISE 上次答应送脚垫' } }],
  quoteVersions: [{ id: 'q1', at: '2026-09-22T02:00:00Z', payload: { schema: 'quote-calculation.v1', computedAt: '2026-09-22T02:00:00Z', summary: 'two units', input: { origin: 'Shanghai', destination: 'Lagos', plans: [{ label: 'two units', model: 'R08 Diesel 4WD', quantity: 2, propulsion: 'fuel', shippingMode: 'container', containers: 1, vehicle: { basis: 'approved_fob', amount: '16900' }, freight: { kind: 'owner_estimate', source: 'owner', checkedAt: '2026-09-22T00:00:00Z' } }] }, result: [{ label: 'two units', model: 'R08 Diesel 4WD', quantity: 2, totalUsd: '41000.00', perVehicleUsd: '20500.00', oceanUsd: '6000.00', dgUsd: '0.00', insuranceUsd: '600.00', insuranceBasis: 'freight_10_percent', internalCostUsd: 'SECRET_COST_31000', internalProfitCny: 'SECRET_PROFIT' }] } }],
  factLibrary,
};
const DICTATION = '跟他说这批柴油四驱就剩五台了，要就月底前定';

test('layer is decided by CRM-known inputs only: owner request or discussion input means compact', () => {
  assert.equal(resolveContextLayer({ salesGuidance: '' }), 'full');
  assert.equal(resolveContextLayer({ salesGuidance: '   ' }), 'full');
  assert.equal(resolveContextLayer({ salesGuidance: '改成一句英文' }), 'compact');
  assert.equal(resolveContextLayer({ discussionQuestion: '怎么答？' }), 'compact');
});

test('follow-up contract: reply route always injects unless the owner declines; discuss route only on an explicit task request', () => {
  for (const reply of ['', undefined, DICTATION, '改成一句英文', '只附翻译', 'traduce al español', '帮我写一句跟进话术']) {
    assert.equal(followupContractRequested(reply, 'reply'), true, String(reply));
  }
  for (const declined of ['不要动跟进任务', '只改未发送草稿，不更新客户资料和跟进任务。', '也不安排跟进', '不用跟进', 'no follow-up this time']) {
    assert.equal(followupContractRequested(declined, 'reply'), false, declined);
    assert.equal(followupContractRequested(declined, 'discuss'), false, declined);
  }
  for (const plain of ['改成一句英文', '只附翻译', DICTATION, '你觉得他是不是嫌贵', '缩短一半', 'traduce al español']) {
    assert.equal(followupContractRequested(plain, 'discuss'), false, plain);
  }
  for (const withTask of ['安排下周跟进', '三天后提醒我催他', '什么时候再联系他合适', 'remind me to follow up on Friday', 'add a task for next week']) {
    assert.equal(followupContractRequested(withTask, 'discuss'), true, withTask);
  }
  assert.equal(followupContractRequested('安排跟进，但不要改现有任务', 'discuss'), false);
  // 复核 / 提醒措辞 / 口述里的“再联系” / 催款口径都不是任务变更
  for (const notTask of ['帮我写一句跟进话术', '跟他说我会跟进', '把上一稿改成一句跟进话术', '跟进消息缩短一点', '复核一下这句英文', '复核报价草稿', '提醒我这句怎么写', '提醒一下他费用口径', '跟他说有消息我再联系他', '催款口径怎么说', '再核一遍任务书里的价格', 'remind me how to phrase this', 'check the task sheet wording']) {
    assert.equal(followupContractRequested(notTask, 'discuss'), false, notTask);
  }
  for (const task of ['安排下周跟进', '给他建个跟进任务', '把跟进改到周五', '三天后再跟进', '明天提醒我', '三天后提醒我催他', '提醒我联系他', '给他建个任务', '把任务改到下周', '取消这个任务', '安排回访', '几天后再催一下合适', 'set a reminder for next Monday', 'move the task to Friday', 'remind me to contact him on Friday']) {
    assert.equal(followupContractRequested(task, 'discuss'), true, task);
  }
});

test('compact history keeps the last 20 plus earlier price/commitment originals, never ad copy or media', () => {
  const { recent, anchors } = selectCompactHistory(messages);
  assert.equal(recent.length, 20);
  assert.equal(recent.at(-1).text, messages.at(-1).text);
  assert.deepEqual(anchors.map((m) => m.text), [EARLY_PRICE, SENT_TOTAL]);
  const rendered = compactRenderedMessages(messages);
  assert.equal(rendered[0].text, EARLY_PRICE);
  assert.equal(rendered.length, 22);
  const evidence = chatHistoryEvidence(messages, 'compact').map((m) => m.text);
  assert.ok(evidence.includes(EARLY_PRICE));
  assert.ok(evidence.includes(messages.at(-1).text));
  assert.ok(!evidence.includes(EARLY_AD));
});

test('compact first message keeps approved knowledge, owner exceptions, old promises, quote conditions and early prices; drops duplicates and internals', () => {
  const full = buildFirstMessage({ contact, messages, useCustomGpt: true, approvedKnowledge: knowledge, workMemory });
  const compact = buildFirstMessage({ contact, messages, useCustomGpt: true, approvedKnowledge: knowledge, workMemory, salesGuidance: DICTATION });
  assert.ok(compact.length < full.length, `compact ${compact.length} should be shorter than full ${full.length}`);
  for (const kept of ['KNOWLEDGE_TEXT', 'OWNER_EXCEPTION 本单特批', 'OLD_PROMISE', 'ORDER_FACT_16900', '41000.00', '20500.00', 'Lagos', 'DRAFT_REPLY_TEXT', 'TASK_TITLE', EARLY_PRICE, 'LAST_CUSTOMER_MESSAGE', DICTATION, '[Sales Workflow — current request and continuity]', '\n[Reply Language]\n', 'Recorded CRM language (fallback only)', 'output exactly three sections']) {
    assert.ok(compact.includes(kept), `compact prompt must keep: ${kept}`);
  }
  for (const dropped of ['PRODUCT_FACT_DUP', 'ORG_FEE_RULE', 'SECRET_COST_31000', 'SECRET_PROFIT', 'STRATEGY_INTERNAL', 'most recent 50 messages', 'NEVER infer the reply language']) {
    assert.ok(!compact.includes(dropped), `compact prompt must not send: ${dropped}`);
  }
  assert.match(compact, /\[Saved Customer Work — internal only, compact view\]/);
  assert.match(compact, /\[Chat History — most recent 20 messages\]/);
  assert.match(compact, /Earlier messages kept for prices, terms and commitments — 2 of the older history/);
  assert.doesNotMatch(compact, /\[CRM deterministic quote calculation\]/, 'dictation with a sent quote must not load the quote module');
  assert.ok(compact.indexOf(EARLY_PRICE) < compact.indexOf('[Chat History — most recent 20 messages]'));
  // full layer unchanged in shape
  assert.match(full, /\[Saved Customer Work — internal only\]\n/);
  assert.match(full, /most recent 50 messages/);
  assert.match(full, /NEVER infer the reply language/);
  for (const kept of ['PRODUCT_FACT_DUP', 'ORG_FEE_RULE', 'OWNER_EXCEPTION', 'STRATEGY_INTERNAL']) assert.ok(full.includes(kept), kept);
});

test('compact quote turn sends the full latest quote version and fee-rule facts because recalculation needs them', () => {
  const prompt = buildFirstMessage({ contact, messages, useCustomGpt: true, approvedKnowledge: knowledge, workMemory, salesGuidance: '按本单特批重新算两台CIF到拉各斯，集装箱' });
  assert.match(prompt, /\[CRM deterministic quote calculation\]/);
  for (const kept of ['latestQuoteVersion', 'ORG_FEE_RULE', 'ORDER_FACT_16900', 'OWNER_EXCEPTION', 'confirmedConditions']) assert.ok(prompt.includes(kept), kept);
});

test('follow-up and discussion routes use the same compact rendering; discussion defaults to compact', () => {
  const follow = buildFollowUpMessage({ contact, newMessages: messages, salesGuidance: '改成一句英文', approvedKnowledge: knowledge, workMemory });
  assert.match(follow, /compact view/);
  assert.match(follow, /Recent Chat History — last 20 messages/);
  assert.ok(follow.includes(EARLY_PRICE) && follow.includes('OWNER_EXCEPTION') && follow.includes('KNOWLEDGE_TEXT'));
  const plain = buildFollowUpMessage({ contact, newMessages: messages, approvedKnowledge: knowledge, workMemory });
  assert.match(plain, /last 50 messages/);
  assert.doesNotMatch(plain, /compact view/);
  for (const discuss of [
    buildDiscussionMessage({ ctx: { contact, messages, useCustomGpt: true }, question: '他是不是嫌贵？', approvedKnowledge: knowledge, workMemory }),
    buildDiscussionMessage({ contact, newMessages: messages, question: '他是不是嫌贵？', approvedKnowledge: knowledge, workMemory }),
  ]) {
    assert.match(discuss, /compact view/);
    assert.ok(discuss.includes('OWNER_EXCEPTION') && discuss.includes(EARLY_PRICE) && discuss.includes('KNOWLEDGE_TEXT'));
    assert.doesNotMatch(discuss, /\n\[Reply Language\]\n/);
  }
});

test('compact group context renders history the same way', () => {
  const group = { ...contact, phone: null, group_jid: 'g@g.us', name: 'Buyers group' };
  const prompt = buildFirstMessage({ contact: group, messages, useCustomGpt: true, groupMemberNames: ['A', 'B'], salesGuidance: DICTATION });
  assert.match(prompt, /\[Chat History — most recent 20 messages\]/);
  assert.ok(prompt.includes(EARLY_PRICE));
  assert.match(prompt, /For this group, follow the most recent customer\/member/);
});

test('fact filtering: template-sourced duplicates are omitted on load; compact keeps customer/order facts, quote turns keep all', () => {
  const noDup = omitTemplateSourcedFacts(factLibrary, 'tpl-a');
  assert.deepEqual(noDup.usable.map((f) => f.id), ['order', 'org']);
  assert.deepEqual(omitTemplateSourcedFacts(factLibrary, 'tpl-other').usable.map((f) => f.id), ['order', 'product', 'org']);
  assert.deepEqual(compactSalesFacts(factLibrary, { quote: false }).usable.map((f) => f.id), ['order']);
  assert.deepEqual(compactSalesFacts(factLibrary, { quote: true }).usable.map((f) => f.id), ['order', 'product', 'org']);
  assert.equal(factLibrary.usable.length, 3, 'original selection untouched');
});

test('confirmed conditions summarize the latest quote without internal cost; oversized ledgers still fail loudly', () => {
  const c = confirmedQuoteConditions(workMemory);
  assert.equal(c.destination, 'Lagos');
  assert.equal(c.plans[0].totalUsd, '41000.00');
  assert.equal(c.plans[0].quantity, 2);
  assert.ok(!JSON.stringify(c).includes('SECRET'));
  assert.equal(confirmedQuoteConditions({ ...workMemory, quoteVersions: [] }), null);
  const compact = renderSalesWorkMemory(workMemory, { quote: false, freight: false }, 'compact');
  assert.ok(!compact.includes('SECRET_COST_31000'));
  assert.ok(compact.includes('OWNER_EXCEPTION'));
  assert.throws(() => renderSalesWorkMemory({ ...workMemory, entries: [{ id: 'big', at: 'now', scopeId: 'c1', kind: 'sales_instruction', text: 'a'.repeat(100000) }] }, undefined, 'compact'), /过长/);
});

test('a thread whose last turn was a discussion is not continued for generation; generation and no-instruction turns are', () => {
  const url = 'https://chatgpt.com/g/g-x/c/thread-1';
  const THREE = '[Client Record]\nNo change\n[WhatsApp Reply]\nHello\n[Full Translation & Strategy]\n你好';
  const DISCUSS_TEXT = '更像礼貌确认。一个词看不出接受了哪一点。';
  const e = (kind, chatUrl, text = kind === 'assistant_draft' ? THREE : 'x') => ({ id: `${kind}-${Math.random()}`, at: '', scopeId: 'c', kind, text, ...(chatUrl ? { chatUrl } : {}) });
  assert.equal(threadEndsWithDiscussion([e('sales_discussion'), e('assistant_draft', url, DISCUSS_TEXT)], url), true);
  assert.equal(threadEndsWithDiscussion([e('sales_discussion'), e('assistant_draft', url + '#frag', DISCUSS_TEXT)], url), true);
  assert.equal(threadEndsWithDiscussion([e('sales_instruction'), e('assistant_draft', url)], url), false);
  assert.equal(threadEndsWithDiscussion([e('assistant_draft', url)], url), false, 'no-instruction generation');
  assert.equal(threadEndsWithDiscussion([e('sales_discussion'), e('assistant_draft', url, DISCUSS_TEXT), e('sales_instruction'), e('assistant_draft', url)], url), false, 'later generation resets');
  assert.equal(threadEndsWithDiscussion([e('sales_discussion'), e('assistant_draft', 'https://chatgpt.com/c/other', DISCUSS_TEXT)], url), false, 'other thread');
  assert.equal(threadEndsWithDiscussion([e('sales_discussion')], url), false, 'discussion without a saved draft cannot be attributed');
  assert.equal(threadEndsWithDiscussion([], null), false);
  // 真实失败路径：讨论 → 无指令普通生成失败（模型继续讨论，草稿无三段）→ 再次普通生成，仍要另起会话
  const failedGeneration = [e('sales_discussion'), e('assistant_draft', url, DISCUSS_TEXT), e('assistant_draft', url, '长篇中文判断，没有三段也没有 crm_followup。')];
  assert.equal(threadEndsWithDiscussion(failedGeneration, url), true, 'failed generation after a discussion still counts as a discussion thread');
  // 无指令但成功产出三段的生成：往前跳过同会话草稿，仍以最近输入为准；换了新会话后旧会话的草稿不再牵连
  assert.equal(threadEndsWithDiscussion([e('sales_instruction'), e('assistant_draft', url), e('assistant_draft', url)], url), false);
  const fresh = 'https://chatgpt.com/g/g-x/c/thread-2';
  assert.equal(threadEndsWithDiscussion([e('sales_discussion'), e('assistant_draft', url, DISCUSS_TEXT), e('assistant_draft', fresh)], fresh), false, 'new thread with a proper draft is clean');
  assert.equal(threadEndsWithDiscussion([e('sales_discussion'), e('assistant_draft', url, DISCUSS_TEXT), e('assistant_draft', url)], url), true, 'a proper draft inside the still-polluted old thread stays conservative');
});

test('an earlier discussion request is rendered as turn-scoped history in both layers and flagged in the follow-up ledger', async () => {
  const DISCUSSION = 'Right 是真认同还是礼貌附和？不要写客户回复，也不安排跟进。';
  const memory = { contactId: 'c1', scopeId: 'c1', label: 'x', tasks: [], entries: [
    { id: 'q1', at: '2026-09-23T18:59:00Z', scopeId: 'c1', kind: 'sales_discussion', text: DISCUSSION },
    { id: 'i1', at: '2026-09-22T00:00:00Z', scopeId: 'c1', kind: 'sales_instruction', text: 'OWNER_EXCEPTION 本单特批 16,900' },
    { id: 'd1', at: '2026-09-23T19:00:00Z', scopeId: 'c1', kind: 'assistant_draft', text: '更像礼貌确认。', chatUrl: 'https://chatgpt.com/c/t' },
  ] };
  for (const layer of ['full', 'compact']) {
    const text = renderSalesWorkMemory(memory, { quote: false, freight: false }, layer);
    const json = JSON.parse(text.slice(text.indexOf('Business data (JSON):\n') + 'Business data (JSON):\n'.length));
    const discussions = json.pastDiscussions;
    assert.equal(discussions.length, 1, layer);
    assert.equal(discussions[0].text, DISCUSSION);
    assert.equal(discussions[0].turnScoped, true);
    const instructions = layer === 'compact' ? json.ownerInstructions : json.salesHistory;
    assert.deepEqual(instructions.map((e) => e.id), ['i1'], `${layer}: discussion is not listed as an instruction`);
    assert.match(text, /PastDiscussions are earlier internal questions the owner asked the assistant/);
    assert.match(text, /"do not schedule follow-up".*applied only to that earlier turn and is NOT an instruction for this turn/);
  }
  const { followupPrompt } = await load('../src/lib/gpt-followup.ts');
  const ctx = { orgId: 'o', contactId: 'c1', scopeId: 'c1', taskId: 't', userId: 'u', customer: {}, tasks: [], previous: null, inputKey: 'k', stateKey: 's',
    evidence: [{ id: 'message:m1', role: 'customer', text: 'Right', at: null }, { id: 'owner:q1', role: 'owner', text: DISCUSSION, at: null }, { id: 'owner:i1', role: 'owner', text: 'OWNER_EXCEPTION 本单特批 16,900', at: null }] };
  const contract = followupPrompt(ctx, { includedWorkMemory: memory });
  assert.match(contract, /Owner entries \["owner:q1"\] are earlier internal discussion questions/);
  assert.match(contract, /must not decide this turn's follow-up/);
  assert.doesNotMatch(followupPrompt(ctx), /earlier internal discussion questions/, 'without the rendered memory the ledger is unchanged');
});
