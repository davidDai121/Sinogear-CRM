// supabase/functions/freight-rate-lookup/estimate.ts 的单元测试（2026-09-24 运费估算上线时起的）。
// 跑法：npm run test:freight-estimate
// 数据用 2026-09-24 实测：物流巴巴上海→海纳。默认规则 = 平台最高价 + 每柜 $400（0049，按老板「比实际贵但别超 1,000」选）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = await build({
  entryPoints: [fileURLToPath(new URL('../supabase/functions/freight-rate-lookup/estimate.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const FX = 6.7227;
const today = '2026-09-24';
const sur = (gp20, hq40) => [
  { name: '打单费', '20GP': 50, '40HQ': 50, currency: 'CNY' },
  { name: '文件费', '20GP': 450, '40HQ': 450, currency: 'CNY' },
  { name: '封条费', '20GP': 50, '40HQ': 50, currency: 'CNY' },
  { name: '订舱费', '20GP': 294, '40HQ': 316, currency: 'CNY' },
  { name: '码头吊柜费', '20GP': gp20, '40HQ': hq40, currency: 'CNY' },
];
const haina = [
  { carrier: 'EMC', pol_code: 'CNYAN', price_20gp: 8080, price_40hq: 9070, surcharges: sur(620, 930), valid_until: '2026-10-07', fetched_at: today },
  { carrier: 'HPL', pol_code: 'CNWGQ', price_20gp: 8590, price_40hq: 10515, surcharges: sur(809, 1538), valid_until: '2026-10-07', fetched_at: today },
  { carrier: 'CMA', pol_code: 'CNWGQ', price_20gp: 9640, price_40hq: 9920, surcharges: sur(665, 990), valid_until: '2026-10-07', fetched_at: today },
  { carrier: 'OLD', pol_code: 'CNSHA', price_20gp: 5000, price_40hq: 6000, surcharges: [], valid_until: '2026-09-01', fetched_at: today },
];
const settings = { buffer_pct: 5, buffer_min_usd: 500, uncalibrated_buffer_pct: 0, container_addon_usd: 400, default_dg_premium_usd: 600 };
const maxBase20 = m.platformBase(haina[2], '20GP', FX).base; // CMA 9640 + ¥1509
const maxBase40 = m.platformBase(haina[1], '40HQ', FX).base; // HPL 10515 + ¥2404

test('装柜：单台 20GP，两台一个 40HQ，三台 40HQ+20GP', () => {
  assert.deepEqual(m.containerPlan(1), [{ container: '20GP', count: 1 }]);
  assert.deepEqual(m.containerPlan(2), [{ container: '40HQ', count: 1 }]);
  assert.deepEqual(m.containerPlan(5), [{ container: '40HQ', count: 2 }, { container: '20GP', count: 1 }]);
  assert.throws(() => m.containerPlan(0));
});

test('港杂按人民币折美元', () => {
  const s = m.surchargesUsd(sur(620, 930), '20GP', FX);
  assert.equal(s.usd, Math.round(1464 / FX * 100) / 100);
  assert.deepEqual(s.unknown, []);
  assert.deepEqual(m.surchargesUsd([{ name: 'X', '20GP': 10, currency: 'EUR' }], '20GP', FX).unknown, ['X 10 EUR']);
});

test('只看有效期内的价，过期的不算；最高/最低都给', () => {
  const r = m.validRates(haina, '20GP', FX, today);
  assert.equal(r.lowest.row.carrier, 'EMC');
  assert.equal(r.highest.row.carrier, 'CMA');
  assert.equal(r.carriers, 3);
});

test('默认规则：单台燃油 = 平台最高价 + 每柜 400，不另加缓冲', () => {
  const e = m.estimate({ quantity: 1, cargo: 'general', rows: haina, calibrations: [], settings, cnyPerUsd: FX, today });
  assert.equal(e.ok, true);
  assert.equal(e.confidence, 'forwarder_rule');
  const c = e.containers[0];
  assert.equal(c.carrier, 'CMA');
  assert.equal(c.buffer_usd, 0);
  assert.equal(e.total_usd, Math.ceil(maxBase20 + 400));
});

test('默认规则：纯电加默认危险品差价 600', () => {
  const g = m.estimate({ quantity: 1, cargo: 'general', rows: haina, calibrations: [], settings, cnyPerUsd: FX, today });
  const d = m.estimate({ quantity: 1, cargo: 'dg', rows: haina, calibrations: [], settings, cnyPerUsd: FX, today });
  assert.equal(d.containers[0].dg_premium_usd, 600);
  assert.ok(Math.abs(d.total_usd - g.total_usd - 600) <= 1);
});

test('默认规则：两台一个 40HQ，按柜加 400、不按台', () => {
  const e = m.estimate({ quantity: 2, cargo: 'general', rows: haina, calibrations: [], settings, cnyPerUsd: FX, today });
  const c = e.containers[0];
  assert.equal(c.container, '40HQ');
  assert.equal(c.cars, 2);
  assert.equal(c.addon_usd, 400);
  assert.equal(e.total_usd, Math.ceil(maxBase40 + c.addon_usd));
  assert.equal(e.per_vehicle_usd, e.total_usd / 2);
});

test('有同周货代价：按差额校准 + 5% 缓冲', () => {
  // 假设 9/24 当周货代报海纳 20GP 普货全包 9,500，同周平台最高价 maxBase20 → 差额 9,500 − maxBase20
  const cals = [{ container: '20GP', cargo: 'general', all_in_usd: 9500, quoted_on: today, quoted_on_known: true, platform_base_usd: maxBase20 }];
  const e = m.estimate({ quantity: 1, cargo: 'general', rows: haina, calibrations: cals, settings, cnyPerUsd: FX, today });
  assert.equal(e.confidence, 'calibrated');
  const c = e.containers[0];
  assert.equal(Math.round(c.base_usd + c.addon_usd), 9500);
  assert.equal(c.buffer_usd, 500); // 9,500 × 5% = 475，不足最低 500
  assert.equal(e.total_usd, 10000);
});

test('同日普货/危险品两条：危险品差价按实际价差', () => {
  const cals = [
    { container: '20GP', cargo: 'general', all_in_usd: 9500, quoted_on: today, quoted_on_known: true, platform_base_usd: maxBase20 },
    { container: '20GP', cargo: 'dg', all_in_usd: 9900, quoted_on: today, quoted_on_known: true, platform_base_usd: maxBase20 },
  ];
  const e = m.estimate({ quantity: 1, cargo: 'dg', rows: haina, calibrations: cals, settings, cnyPerUsd: FX, today });
  assert.equal(e.containers[0].dg_premium_usd, 400);
});

test('日期不准或没有同周平台价的货代价不参与校准（海纳 9/3 那条就是这样）', () => {
  const base = { container: '20GP', cargo: 'general', all_in_usd: 10800, quoted_on: '2026-09-03' };
  for (const c of [{ ...base, quoted_on_known: false, platform_base_usd: maxBase20 }, { ...base, quoted_on_known: true, platform_base_usd: null }]) {
    const e = m.estimate({ quantity: 1, cargo: 'general', rows: haina, calibrations: [c], settings, cnyPerUsd: FX, today });
    assert.equal(e.calibrated, false);
  }
});

test('平台没有有效价 / 没有汇率：明确失败，不编数', () => {
  assert.equal(m.estimate({ quantity: 1, cargo: 'general', rows: [haina[3]], calibrations: [], settings, cnyPerUsd: FX, today }).ok, false);
  assert.equal(m.estimate({ quantity: 1, cargo: 'general', rows: haina, calibrations: [], settings, cnyPerUsd: null, today }).ok, false);
});

test('各船公司差价过大：标出来要人核实', () => {
  const rows = [
    { carrier: 'MSC', price_20gp: 2836, price_40hq: 3500, surcharges: [], valid_until: '2026-10-07', fetched_at: today },
    { carrier: 'CMA', price_20gp: 7565, price_40hq: 8000, surcharges: [], valid_until: '2026-10-07', fetched_at: today },
  ];
  const e = m.estimate({ quantity: 1, cargo: 'general', rows, calibrations: [], settings, cnyPerUsd: FX, today });
  assert.equal(e.containers[0].carrier, 'CMA');
  assert.equal(e.needs_review, true);
  const h = m.estimate({ quantity: 1, cargo: 'general', rows: haina, calibrations: [], settings, cnyPerUsd: FX, today });
  assert.equal(h.needs_review, false);
});
