// 运费全包估算 —— 纯计算，不连网、不碰数据库，node --test 直接测（scripts/test-freight-estimate.mjs）。
//
// 默认规则（2026-09-25 按老板标准「比实际贵、但别超 1,000」选的）：全包 ≈ 平台当前「最高」有效价（海运 + 起运港杂）+ 每柜 $400
//   用群里货代 9/10–9/21 的 9 条全包价检验：7 条落在 [0, +1000]，没有低估；超的两条是布埃纳文图拉大柜 +1,124、
//   科林托 +2,861（这家货代在科林托的价比平台最低价还低）。货代说的「最高价 + 装箱每台 ¥2,000」只命中 4 条——
//   一柜装多台时按台加装箱费加多了（库拉索一装四超 1,217），实际全包价按柜涨、不按台涨。
// 有本航线校准时：全包 = 当前最高价 + 差额（货代全包价 − 报价当周的平台最高价）+ 缓冲。
//   海运价变化很快（海纳 EMC 20GP：6 月 8,210 → 7–8 月 10,925 → 9 月 9,320 → 9/24 8,080），
//   所以只认「同一周」的货代价和平台价，过期的货代价不能直接当运费用。
//
// 装柜：单台 20GP；两台一个 40HQ；多台按 2+2+…+1。不拼柜（老板 2026-09-24）。

export type Container = '20GP' | '40HQ';
export type Cargo = 'general' | 'dg';

export interface Surcharge {
  code?: string; name?: string; name_en?: string;
  '20GP'?: number | string | null; '40GP'?: number | string | null; '40HQ'?: number | string | null;
  currency?: string; remark?: string;
}
export interface RateRow {
  carrier: string; pol_code?: string | null;
  price_20gp: number | string | null; price_40hq: number | string | null;
  surcharges: Surcharge[]; valid_until: string | null;
  departure_date?: string | null; transit_days?: number | null; transshipment?: string | null;
  fetched_at: string;
}
export interface Calibration {
  container: Container; cargo: Cargo; all_in_usd: number | string;
  quoted_on: string | null; quoted_on_known: boolean;
  platform_base_usd: number | string | null;   // 报价当周平台「最高」有效价（海运 + 起运港杂）
  carrier?: string | null; forwarder?: string | null;
}
export interface Settings {
  buffer_pct: number | string; buffer_min_usd: number | string; uncalibrated_buffer_pct: number | string;
  container_addon_usd: number | string; default_dg_premium_usd: number | string;
}
export interface ContainerQuote {
  container: Container; count: number; cars: number; carrier: string; pol_code: string | null;
  ocean_usd: number; surcharges_usd: number; base_usd: number;
  addon_usd: number; dg_premium_usd: number; buffer_usd: number; all_in_usd: number;
  valid_until: string | null; departure_date: string | null; transit_days: number | null;
  range: { min: number; max: number; carriers: number };
}
export interface Estimate {
  ok: true; quantity: number; cargo: Cargo; containers: ContainerQuote[];
  total_usd: number; per_vehicle_usd: number;
  calibrated: boolean; confidence: 'calibrated' | 'forwarder_rule';
  needs_review: boolean;
  method: string; notes: string[];
}
export interface EstimateFailure { ok: false; reason: string }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
export const CARS_PER: Record<Container, number> = { '20GP': 1, '40HQ': 2 };

export function containerPlan(quantity: number): { container: Container; count: number }[] {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantity must be a positive integer');
  const plan: { container: Container; count: number }[] = [];
  const hq = Math.floor(quantity / 2), gp = quantity % 2;
  if (hq) plan.push({ container: '40HQ', count: hq });
  if (gp) plan.push({ container: '20GP', count: gp });
  return plan;
}

/** 起运港附加费折美元。币种不认识的不猜，记进 unknown 让调用方标注。 */
export function surchargesUsd(list: Surcharge[], ct: Container, cnyPerUsd: number | null) {
  let usd = 0; const unknown: string[] = [];
  for (const s of list ?? []) {
    const v = num(s[ct]);
    if (!v) continue;
    const cur = (s.currency ?? 'USD').toUpperCase();
    if (cur === 'USD') usd += v;
    else if (cur === 'CNY' && cnyPerUsd) usd += v / cnyPerUsd;
    else unknown.push(`${s.name ?? s.code ?? '?'} ${v} ${cur}`);
  }
  return { usd: round2(usd), unknown };
}

export function platformBase(row: RateRow, ct: Container, cnyPerUsd: number | null) {
  const ocean = num(ct === '20GP' ? row.price_20gp : row.price_40hq);
  if (!ocean || ocean <= 0) return null;
  const s = surchargesUsd(row.surcharges, ct, cnyPerUsd);
  return { ocean, surcharges: s.usd, base: round2(ocean + s.usd), unknown: s.unknown };
}

/** 有效期内、该柜型有价的平台价，按全包成本从低到高排；max 是货代规则用的「最高运费」。 */
export function validRates(rows: RateRow[], ct: Container, cnyPerUsd: number | null, today: string) {
  const valid = rows
    .filter(r => !r.valid_until || r.valid_until >= today)
    .map(r => ({ row: r, p: platformBase(r, ct, cnyPerUsd) }))
    .filter((x): x is { row: RateRow; p: NonNullable<ReturnType<typeof platformBase>> } => !!x.p)
    .sort((a, b) => a.p.base - b.p.base);
  if (!valid.length) return null;
  return { lowest: valid[0], highest: valid[valid.length - 1], min: valid[0].p.base, max: valid[valid.length - 1].p.base,
    carriers: new Set(valid.map(v => v.row.carrier)).size };
}

/** 本航线最近一条能对上同周平台价的货代全包价 → 差额（每柜，可正可负）。 */
export function deriveOffset(cals: Calibration[], settings: Settings) {
  const usable = cals
    .filter(c => c.quoted_on_known && num(c.platform_base_usd) !== null && num(c.all_in_usd) !== null)
    .sort((a, b) => (b.quoted_on ?? '').localeCompare(a.quoted_on ?? ''));
  const pick = usable.find(c => c.cargo === 'general') ?? usable[0];
  if (!pick) return null;
  const dgDefault = num(settings.default_dg_premium_usd) ?? 0;
  // 危险品价里含危险品差价，换算成普货差额，估算时再按需要加回去
  const offset = num(pick.all_in_usd)! - num(pick.platform_base_usd)! - (pick.cargo === 'dg' ? dgDefault : 0);
  const pair = usable.find(c => c !== pick && c.quoted_on === pick.quoted_on && c.container === pick.container && c.cargo !== pick.cargo);
  const dgPremium = pair ? Math.abs(num(pair.all_in_usd)! - num(pick.all_in_usd)!) : dgDefault;
  return {
    offset: round2(offset), dgPremium: round2(dgPremium), container: pick.container,
    source: `货代全包 ${pick.all_in_usd}（${pick.container}${pick.cargo === 'dg' ? ' 危险品' : ''}，${pick.quoted_on}${pick.forwarder ? ` ${pick.forwarder}` : ''}）− 同周平台最高价 ${pick.platform_base_usd}`,
  };
}

export function estimate(input: {
  quantity: number; cargo: Cargo; rows: RateRow[]; calibrations: Calibration[];
  settings: Settings; cnyPerUsd: number | null; today: string;
}): Estimate | EstimateFailure {
  const { quantity, cargo, rows, calibrations, settings, cnyPerUsd, today } = input;
  if (!cnyPerUsd) return { ok: false, reason: '缺少人民币汇率，无法折算装箱费和港杂' };
  const plan = containerPlan(quantity);
  const cal = deriveOffset(calibrations, settings);
  const perContainer = num(settings.container_addon_usd) ?? 400;
  const pct = num(cal ? settings.buffer_pct : settings.uncalibrated_buffer_pct) ?? 0;
  const minBuffer = pct > 0 ? (num(settings.buffer_min_usd) ?? 0) : 0;
  const dgDefault = num(settings.default_dg_premium_usd) ?? 0;
  const notes: string[] = [];
  if (!cal) notes.push(`平台最高价 + 每柜 $${perContainer}${pct ? `，另加 ${pct}% 缓冲` : ''}（按近期货代实价检验，多数比实际高 0–1,000）`);
  else if (cal.container !== plan[0].container) notes.push(`校准用的是 ${cal.container} 的差额，${plan.map(p => p.container).join('/')} 按同一差额近似`);

  const containers: ContainerQuote[] = [];
  for (const { container, count } of plan) {
    const r = validRates(rows, container, cnyPerUsd, today);
    if (!r) return { ok: false, reason: `平台没有有效的 ${container} 运价` };
    const ref = r.highest;
    if (ref.p.unknown.length) notes.push(`未计入的附加费（币种不明）：${ref.p.unknown.join('；')}`);
    if (r.carriers > 1 && r.min < r.max * 2 / 3) {
      notes.push(`${container} 各船公司差价很大（${Math.round(r.min)}–${Math.round(r.max)}），按最高价 ${ref.row.carrier} 估算可能偏高很多`);
    }
    const cars = CARS_PER[container];
    const addon = cal ? cal.offset : perContainer;
    const dgPremium = cargo === 'dg' ? (cal ? cal.dgPremium : dgDefault) : 0;
    const beforeBuffer = ref.p.base + addon + dgPremium;
    const buffer = pct > 0 ? round2(Math.max(minBuffer, beforeBuffer * pct / 100)) : 0;
    containers.push({
      container, count, cars, carrier: ref.row.carrier, pol_code: ref.row.pol_code ?? null,
      ocean_usd: ref.p.ocean, surcharges_usd: ref.p.surcharges, base_usd: ref.p.base,
      addon_usd: addon, dg_premium_usd: dgPremium, buffer_usd: buffer,
      all_in_usd: Math.ceil(beforeBuffer + buffer),
      valid_until: ref.row.valid_until, departure_date: ref.row.departure_date ?? null,
      transit_days: ref.row.transit_days ?? null,
      range: { min: r.min, max: r.max, carriers: r.carriers },
    });
  }
  const total = containers.reduce((s, c) => s + c.all_in_usd * c.count, 0);
  return {
    ok: true, quantity, cargo, containers, total_usd: total, per_vehicle_usd: round2(total / quantity),
    calibrated: !!cal, confidence: cal ? 'calibrated' : 'forwarder_rule',
    needs_review: notes.some(n => n.includes('差价很大') || n.includes('币种不明')),
    method: cal ? cal.source : `平台最高价 + 每柜 $${perContainer}`,
    notes,
  };
}
