// 条件加载 freight/quote 规程 + 三段输出瘦身 + 跟进证据去重（2026-09-18 第一阶段）
// 跑法：node --test scripts/test-gpt-workflow-selection.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function source(path) {
  const r = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const { selectGptWorkflows } = await source('../src/lib/gpt-workflow-selection.ts');
const { renderSalesWorkflow, SALES_WORKFLOW, SALES_WORKFLOW_CORE } = await source('../src/lib/gpt-sales-workflow.ts');
const { buildFirstMessage, buildFollowUpMessage, buildDiscussionMessage, chatHistoryEvidenceTexts } = await source('../src/lib/gpt-prompt.ts');
const { followupPrompt } = await source('../src/lib/gpt-followup.ts');

const FREIGHT_HEADER = '[Freight research — conversational, no form]';
const QUOTE_HEADER = '[CRM deterministic quote calculation]';
const NONE_NOTE = 'modules are not loaded';
const QUOTE_ONLY_NOTE = 'The freight research module is not loaded';

const contact = { phone: '+573246874685', group_jid: null, name: 'José', wa_name: null, country: 'Colombia', language: 'Spanish', budget_usd: null, destination_port: 'Buenaventura', customer_stage: 'quoted', notes: null };
const t0 = Date.parse('2026-09-18T14:00:00Z');
const msg = (text, fromMe = false, minutes = 0) => ({ id: `wa-${text.slice(0, 8)}-${minutes}`, text, fromMe, sender: null, timestamp: t0 + minutes * 60_000 });

/** 一个已有报价草稿的工作记忆（模拟 José 当前状态：1 台 R08 EV，CIF 34,320） */
function memory({ destination = 'Buenaventura, Colombia', quantity = 1, tasks = [], total = '34320.00' } = {}) {
  const computedAt = new Date(t0).toISOString();
  return {
    contactId: 'c', scopeId: 's', label: '当前需求', entries: [],
    quoteVersions: [{ id: 'q1', at: computedAt, payload: { computedAt, status: 'draft', input: { destination, plans: [{ model: 'Rely R08 EV 4x4', quantity }] }, result: [{ totalUsd: total, perVehicleUsd: total, insuranceUsd: '370.00', quantity }] } }],
    tasks,
  };
}
const SENT = msg('Para 1 unidad, la referencia CIF estimada es de USD 34,320.00.', true, 30);

test('没有任何报价信号：普通客户问题两块都不加载，只有说明段', () => {
  const sel = selectGptWorkflows({ messages: [msg('¿De qué color es?'), msg('Negro, stock actual.', true, 1), msg('Perfecto gracias', false, 2)] });
  assert.deepEqual(sel, { freight: false, quote: false, reasons: [] });
  const text = renderSalesWorkflow(sel);
  assert.ok(text.startsWith(SALES_WORKFLOW_CORE));
  assert.ok(text.includes(NONE_NOTE));
  assert.ok(!text.includes(FREIGHT_HEADER) && !text.includes(QUOTE_HEADER));
});

test('老板简短澄清"就是dg"继续报价：两块都加载（兼容既有 test-gpt-sales-workflow）', () => {
  const sel = selectGptWorkflows({ salesGuidance: '就是dg', messages: [] });
  assert.ok(sel.quote && sel.freight);
  assert.ok(sel.reasons.some((r) => r.includes('简短澄清')));
});

test('多语言问价（es/fr/en/ar）：客户未回复的问价都触发报价+运费', () => {
  for (const text of ['¿Cuál es el precio CIF a Buenaventura?', '¿Cuánto cuesta?', 'Quanto custa?', 'Quel est le prix pour Dakar ?', 'How much is it landed in Tema?', 'كم السعر؟']) {
    const sel = selectGptWorkflows({ messages: [msg('Hola', true), msg(text, false, 1)], contact });
    assert.ok(sel.quote && sel.freight, text);
  }
});

test('客户问价已被销售回复过、之后只是道谢：不算未解决需求', () => {
  const sel = selectGptWorkflows({ messages: [msg('¿Cuál es el precio?'), msg('USD 34,320 CIF', true, 1), msg('Gracias', false, 2)] });
  assert.equal(sel.quote, false);
});

test('只要 FOB、不涉及运输：加载报价规程但不加载运费规程', () => {
  const sel = selectGptWorkflows({ salesGuidance: '给他报 FOB 出厂价', messages: [] });
  assert.equal(sel.quote, true);
  assert.equal(sel.freight, false);
  assert.ok(renderSalesWorkflow(sel).includes(QUOTE_ONLY_NOTE));
  const cif = selectGptWorkflows({ salesGuidance: '给他报 FOB 和 CIF', messages: [] });
  assert.ok(cif.freight, '一旦提到 CIF/运输就带运费规程');
});

test('新车型 CIF 询价（草稿是 R08，客户问 Hilux）：两块都加载', () => {
  const sel = selectGptWorkflows({ messages: [SENT, msg('¿Y cuánto sería el Toyota Hilux CIF?', false, 40)], workMemory: memory(), vehicleInterests: [{ model: 'Rely R08' }, { model: 'Toyota Hilux' }], contact });
  assert.ok(sel.quote && sel.freight);
  assert.ok(sel.reasons.some((r) => r.includes('车型兴趣')));
});

test('客户用颜色/数量短答回答销售为报价问的问题：报价继续', () => {
  const color = selectGptWorkflows({ messages: [msg('Para avanzar con la cotización, ¿qué color prefieres?', true), msg('Negra', false, 1)], contact });
  assert.ok(color.quote && color.freight);
  assert.ok(color.reasons.some((r) => r.includes('回答销售为报价提出的问题')));
  const qty = selectGptWorkflows({ messages: [msg('Para la cotización a Buenaventura, ¿sería 1 unidad o 2?', true), msg('1', false, 1)], contact });
  assert.ok(qty.quote && qty.freight);
  const unrelated = selectGptWorkflows({ messages: [msg('¿Recibiste las fotos?', true), msg('Sí, muy bonitas', false, 1)], contact });
  assert.equal(unrelated.quote, false, '销售问的不是报价问题，短答不触发');
});

test('草稿已有强发送证据（真实出站、晚于核算、主总价完整出现）且客户只回 Si：纯转述不加载', () => {
  const sel = selectGptWorkflows({ messages: [msg('¿Precio?'), SENT, msg('Si', false, 40)], workMemory: memory(), contact });
  assert.deepEqual(sel, { freight: false, quote: false, reasons: [] });
});

test('"已发送"证据不足时保守加载：无时间戳 / 早于核算 / 只出现保险分项 / 金额是更长数字的一部分', () => {
  const cases = [
    { ...SENT, timestamp: null },
    msg('Para 1 unidad, la referencia CIF estimada es de USD 34,320.00.', true, -30),
    msg('El seguro es USD 370.00 aparte.', true, 30),
    msg('Referencia interna 134320.00', true, 30),
  ];
  for (const m of cases) {
    const sel = selectGptWorkflows({ messages: [m, msg('Si', false, 40)], workMemory: memory(), contact });
    assert.ok(sel.quote && sel.freight, JSON.stringify(m));
    assert.ok(sel.reasons.some((r) => r.includes('没有可靠的发送证据')));
  }
});

test('客户把数量从 1 改成 4：即使草稿已发出也重新加载两块', () => {
  const sel = selectGptWorkflows({ messages: [SENT, msg('Quiero 4 unidades', false, 40)], workMemory: memory(), contact });
  assert.ok(sel.quote && sel.freight);
  assert.ok(sel.reasons.some((r) => r.includes('数量 4')));
});

test('目的港与最新报价输入不一致：两块都加载', () => {
  const sel = selectGptWorkflows({ messages: [SENT], workMemory: memory({ destination: 'Corinto, Nicaragua' }), contact });
  assert.ok(sel.quote && sel.freight);
});

test('历史开放任务不会让已经发过的报价重新加载重型规程', () => {
  const sel = selectGptWorkflows({ messages: [SENT], workMemory: memory({ tasks: [{ id: 't', title: '跟进：核对并发送José的CIF参考报价', due_at: null, status: 'open' }] }), contact });
  assert.ok(!sel.quote && !sel.freight);
});

test('主 prompt 三个入口按选择注入；SALES_WORKFLOW 常量仍是完整版', () => {
  assert.ok(SALES_WORKFLOW.includes(FREIGHT_HEADER) && SALES_WORKFLOW.includes(QUOTE_HEADER));
  const plain = buildFirstMessage({ contact, messages: [msg('¿De qué color es?')], useCustomGpt: true });
  assert.ok(plain.includes(SALES_WORKFLOW_CORE.split('\n')[0]));
  assert.ok(!plain.includes(QUOTE_HEADER) && plain.includes(NONE_NOTE));
  const quoting = buildFollowUpMessage({ contact, newMessages: [msg('¿Cuál es el precio CIF?')], salesGuidance: '报价' });
  assert.ok(quoting.includes(QUOTE_HEADER) && quoting.includes(FREIGHT_HEADER));
  const discussing = buildDiscussionMessage({ contact, newMessages: [msg('Hola')], question: '怎么跟进？' });
  assert.ok(!discussing.includes(QUOTE_HEADER) && discussing.includes(NONE_NOTE));
  const discussQuote = buildDiscussionMessage({ ctx: { contact, messages: [msg('Hola')], useCustomGpt: true }, question: '成本重算给他报价' });
  assert.ok(discussQuote.includes(QUOTE_HEADER));
});

test('输出契约：三段头保留，Client Record 只写变化，策略限短', () => {
  const p = buildFirstMessage({ contact, messages: [msg('Hola')], useCustomGpt: true });
  assert.match(p, /output exactly three sections in this order — \[Client Record\], \[WhatsApp Reply\], \[Full Translation & Strategy\]/);
  assert.match(p, /If nothing changed, write a single line "No change"/);
  assert.match(p, /at most 5 short lines/);
  assert.match(p, /\[WhatsApp Reply\] is the main product/);
});

test('followupPrompt 默认完整；传 includedEvidenceTexts 时只缩写同文长消息，老板指令永不缩写', () => {
  const long = 'Thank you for the revised quotation and for the additional USD 200 reduction per vehicle. I have noted the final FOB price of USD 14,900 per vehicle. Before we proceed with the order, I need you to confirm a few important points in writing: that these are brand-new 2026 production vehicles, that the specification can legally be exported to Senegal, and the complete official technical specification sheet.';
  const ctx = {
    orgId: 'o', contactId: 'c', scopeId: 's', taskId: 't', userId: 'u', customer: {}, tasks: [], previous: null, inputKey: 'k', stateKey: 'k',
    evidence: [
      { id: 'message:1', role: 'customer', text: long, at: '2026-09-18T14:54:00Z' },
      { id: 'message:2', role: 'sales', text: 'Si', at: null },
      { id: 'owner:3', role: 'owner', text: `老板指令：${long}`, at: null },
    ],
  };
  const full = followupPrompt(ctx);
  assert.ok(full.includes(JSON.stringify(long)));
  assert.ok(!full.includes('abbreviated'));

  const rendered = chatHistoryEvidenceTexts([msg(`  ${long.replace(' I have', '\n I have')} `), msg('[图片]'), msg('Si', true)]);
  assert.deepEqual(rendered, [long, 'Si']);
  const slim = followupPrompt(ctx, { includedEvidenceTexts: rendered });
  const payload = JSON.parse(slim.slice(slim.lastIndexOf('\n') + 1));
  assert.equal(payload.evidence[0].text, `${long.slice(0, 60)}…[full text in Chat History above]`);
  assert.equal(payload.evidence[0].id, 'message:1', '原证据 id 保留');
  assert.equal(payload.evidence[0].at, '2026-09-18T14:54:00Z', '时间保留');
  assert.equal(payload.evidence[0].role, 'customer', '角色保留');
  assert.equal(payload.evidence[1].text, 'Si', '短消息不缩写');
  assert.equal(payload.evidence[2].text, `老板指令：${long}`, '老板指令永不缩写');
  assert.ok(slim.includes('are abbreviated because the same message appears in full in [Chat History]'));
  assert.ok(slim.length < full.length);

  const unmatched = followupPrompt(ctx, { includedEvidenceTexts: ['completely different text'] });
  assert.equal(JSON.parse(unmatched.slice(unmatched.lastIndexOf('\n') + 1)).evidence[0].text, long, '无法证明同文就不去重');
});
