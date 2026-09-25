// 微信货代报价 → 审查清单（只读，不写库）
// 跑法：node scripts/freight-quote-review.mjs <导出的 JSON> [--forwarder 美艳小老太] > 审查清单.md
//
// 输入是「微信消息读取命令行工具」(~/Desktop/weixin/wx quotes) 的导出（2026-09-24 两个会话约定的格式）。
// 每条货代报价解读成一行：航线、方式、柜型/装几台、普货/危险品、全包价（我的解读 + 依据）、不含项、有效期。
// 老板核对「读得对不对」，确认后才写 freight_calibrations —— 这个脚本不写库。
//
// 解读规则（群里货代的报价格式很固定）：
//   集装箱：「合计/预计 约 T USD」取 T；「X+Y」取 X+Y（Y 是内装港杂）；「全包/包干/含：海运费、订舱、THC…」取主价；
//           只写海运费 + 人民币内装/港杂的，按当日汇率折美元相加。小柜=20GP，大柜=40HQ，电车/危险品=dg。
//   滚装：N USD/CBM（或 /方）+ 每票固定费（文件费 300美金/票、+300usd、港杂电放 370 美金）；写了「含港杂」的标出来。
//   散杂船、笼车、铁路：不是我们的运输方式，列出不解读。
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const fwdArg = args.includes('--forwarder') ? args[args.indexOf('--forwarder') + 1] : '美艳小老太';
if (!file) { console.error('用法：node scripts/freight-quote-review.mjs <导出的 JSON> [--forwarder 名字片段]'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const FX = 6.7227; // 2026-09-24 open.er-api.com；只用于把人民币杂费折美元做参考

const PORTS = [
  [/海纳|haina/i, 'DORHA', '海纳'], [/考塞多|caucedo/i, 'DOCAU', '考塞多'],
  [/库拉索|curacao|curaçao|威廉斯塔德|willemstad/i, 'ANCUR', '库拉索'],
  [/太子港|port.?au.?prince/i, 'HTPAP', '太子港'],
  [/达喀尔|dakar/i, 'SNDAK', '达喀尔'], [/特马|tema/i, 'GHTEM', '特马'],
  [/拉各斯|阿帕帕|lagos|apapa|tin\s*can|lekki/i, 'NGLAG', '拉各斯'],
  [/阿比让|abidjan/i, 'CIABI', '阿比让'], [/科纳克里|conakry/i, 'GNCON', '科纳克里'],
  [/布埃纳文图拉|buenaventura/i, 'COBUE', '布埃纳文图拉'], [/卡塔赫纳|cartagena/i, 'COCTA', '卡塔赫纳'],
  [/科林托|corinto/i, 'NICOR', '科林托'], [/蒙巴萨|mombasa/i, 'KEMOM', '蒙巴萨'],
  [/达累|dar\s*es\s*salaam/i, 'TZDAR', '达累斯萨拉姆'],
];
const OUR = new Set(PORTS.map(p => p[1]));
const matchPort = (s) => { for (const [re, code, name] of PORTS) if (re.test(s ?? '')) return { code, name }; return null; };

const tz = (doc.timezone ?? 'Asia/Shanghai').split(' ')[0];
function beijingDate(localIso) {
  if (!localIso) return null;
  const [d, t = '00:00'] = localIso.split('T');
  const [y, mo, da] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const utc = guess - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utc));
}

const firstLine = (t) => (t ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
// 航线行：跳过「滚装」「@滚装船」「滚装 9.27」这类标题行，取第一行像「太仓-厄瓜多尔 曼塔港」的
const routeLine = (t) => (t ?? '').split('\n').map(s => s.trim())
  .find(s => s && !/^@?滚装(船)?\s*[\d.]*$/.test(s) && /[-－—一/到]/.test(s.slice(0, 12))) ?? firstLine(t);
// 目的港优先看「目的港：」那一行（避免把中转港当目的港，比如经布埃纳文图拉中转去科林托）
const podText = (t, g) => ((t.match(/目的港[：:]\s*([^\n（(]+)/) ?? [])[1]?.trim()) || g.pod_text || routeLine(t);
const polOf = (t, g) => (g.pol || (t.match(/(上海|宁波|太仓|南沙|深圳|连云港|天津|日照|青岛)/) ?? [])[1] || '?');
// 滚装：写了「滚装」，或用的是滚装模板（按立方计 / 免堆期 10 天 / 地面费）
const isRoro = (t, g) => g.mode === 'roro' || /滚装|滚裝|ro-?ro/i.test(t)
  || /\d+\s*(USD|美金)?\s*\/\s*(CBM|方|立方|WM)|免堆期为10天|USD\d+\/USD\+地面费/i.test(t);
const isOther = (t) => /散杂|笼车|铁路|郑州-华沙|霍尔果斯/.test(t);
const cargoOf = (t, a) => a?.cargo ?? (/危险品|电车|DG/i.test(t) ? 'dg' : 'general');
const carsOf = (t, a) => a?.cars_per_container ?? ({ 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 }[(t.match(/一装([一两二三四])/) ?? [])[1]] ?? null);
const ctOf = (t, a) => a?.container ?? (/小柜|20GP|20DG/i.test(t) ? '20GP' : /大柜|40HQ|40DG|40HC/i.test(t) ? '40HQ'
  : ({ 1: '20GP(按一装一)', 2: '40HQ(按一装二)' }[carsOf(t, a)] ?? '?'));
const validOf = (t, g) => g.valid_until || (t.match(/(有效期[：:]?\s*[\d./-]+|价格(?:用)?到[\d./]+|[\d.]+号前|到\s?\d+号)/) ?? [])[1] || '';

function interpretContainer(it) {
  const t = it.text, g = it.guess ?? {};
  const am = (g.amounts ?? []).filter(a => typeof a.value === 'number');
  const usd = am.filter(a => (a.currency ?? '').toUpperCase() === 'USD' && !a.item);
  const out = [];
  // 1) 合计 / 预计 约 T USD（纯美元）；「…=12118」「4650+550=5200」
  const total = [...t.matchAll(/(?:预计|合计[:：]?\s*约?|约)\s*(\d{3,6})\s*USD/gi), ...t.matchAll(/=\s*(\d{4,6})/g)].map(m => +m[1]);
  if (total.length) {
    out.push({ price: Math.max(...total), basis: '按「合计/预计/=」', a: usd[0] });
    return out;
  }
  // 2) 文本里的「X+Y+Z」（主价 + 内装港杂 / DG 附加 / 地面包干），guess 没拆出来时兜底
  const plus = t.match(/(\d{4,5})(?:\s*USD)?(?:\s*\/\s*(?:20GP|40HQ|20DG|40DG))?((?:\s*[+＋]\s*(?:[A-Z]{2,4}\s*)?\d{2,4}(?:\s*USD)?)+)/i);
  if (plus && !(g.fixed_fee ?? []).length) {
    const extras = [...plus[2].matchAll(/\d{2,4}/g)].map(m => +m[0]);
    return [{ price: +plus[1] + extras.reduce((s, x) => s + x, 0), basis: `${plus[1]} + ${extras.join(' + ')}`, a: usd[0] }];
  }
  // 3) 包干价 / 全包 T USD
  const pkg = t.match(/(?:包干价|全包)\s*(\d{4,5})\s*(?:USD|美金)|(\d{4,5})\s*(?:USD|美金)\s*全包/i);
  if (pkg && !usd.length) return [{ price: +(pkg[1] ?? pkg[2]), basis: '包干/全包', a: null }];
  // 2) 多个柜型/货类各一个价（布埃纳文图拉 9/14、委内瑞拉 9/16）
  const perCt = usd.filter(a => a.unit === 'per_container');
  const fixedUsd = (g.fixed_fee ?? []).filter(f => (f.currency ?? 'USD').toUpperCase() === 'USD').reduce((s, f) => s + (f.value ?? 0), 0);
  const allInWords = /全包|包干|含：海运费|含:海运费/.test(t);
  if (perCt.length > 1 && !fixedUsd) {
    for (const a of perCt) out.push({ price: a.value, basis: allInWords ? '全包（多个柜型分列）' : '多个柜型分列', a });
    return out;
  }
  const main = perCt[0] ?? usd[0];
  if (!main) return [{ price: null, basis: '没读出美元主价，要人工看' }];
  // 「会贵 100 美金」「塞港费 60 美金」这类补充说明不是运价
  if (main.value < 1000) return [{ price: null, basis: `补充说明，不是运价（${main.value}）`, skip: true }];
  // 3) X + Y（Y 是内装港杂 / DG 附加 / 地面包干）
  if (fixedUsd) return [{ price: main.value + fixedUsd, basis: `主价 ${main.value} + 附加 ${fixedUsd}`, a: main }];
  // 4) 海运费 + 人民币内装/港杂
  const rmb = am.filter(a => a.item && /内装|装箱|港杂|落箱|进提|地面/.test(a.item) && (a.currency ?? 'RMB').toUpperCase() !== 'USD')
    .reduce((s, a) => s + a.value, 0);
  const usdItems = am.filter(a => a.item && /内装|港杂/.test(a.item) && (a.currency ?? '').toUpperCase() === 'USD').reduce((s, a) => s + a.value, 0);
  if (rmb || usdItems) return [{ price: Math.round(main.value + usdItems + rmb / FX), basis: `海运 ${main.value}${usdItems ? ` + ${usdItems} USD` : ''}${rmb ? ` + ¥${rmb}（折 ${Math.round(rmb / FX)}）` : ''}`, a: main }];
  return [{ price: main.value, basis: allInWords ? '全包' : '只有一个价，没写全包，要确认', a: main }];
}

function interpretRoro(it) {
  const t = it.text, g = it.guess ?? {};
  const am = (g.amounts ?? []).filter(a => typeof a.value === 'number' && (a.currency ?? 'USD').toUpperCase() === 'USD');
  const perCbm = am.find(a => a.unit === 'per_cbm') ?? am.find(a => /cbm|方|立方|WM|CB/i.test(a.raw ?? '')) ?? am[0];
  let fixed = (g.fixed_fee ?? []).filter(f => (f.currency ?? 'USD').toUpperCase() === 'USD').reduce((s, f) => s + (f.value ?? 0), 0);
  if (!fixed && /文件费[：:]\s*300美金/.test(t)) fixed = 300;
  const docTelex = t.match(/港杂电放\s*(\d+)\s*美金|文件电放\s*(\d+)\s*美金/);
  if (!fixed && docTelex) fixed = +(docTelex[1] ?? docTelex[2]);
  const rmbGround = /人民币|RMB|地面费|港杂[：:]?\s*RMB|港杂\d+\/方/.test(t) && !/含港杂/.test(t);
  return {
    perCbm: perCbm?.value ?? null, fixed,
    basis: `${perCbm?.value ?? '?'} USD/立方${fixed ? ` + ${fixed} USD/票` : ''}${/含港杂/.test(t) ? '，含港杂' : ''}${rmbGround ? '，另有人民币地面费（见原文）' : ''}`,
  };
}

// 去重：同一发送者、同一时间、正文去空白标点后相同
const norm = (s) => (s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
const seen = new Set();
const container = [], roro = [], other = [], askers = new Map();
for (const it of doc.items ?? []) {
  if (it.has_image && !it.text?.replace('[图片]', '').trim()) continue;
  if (!(it.sender ?? '').includes(fwdArg)) { askers.set(it.sender, (askers.get(it.sender) ?? 0) + 1); continue; }
  const key = `${it.sender}|${it.sent_at}|${norm(it.text)}`;
  if (seen.has(key)) continue; seen.add(key);
  const t = it.text ?? '', g = it.guess ?? {};
  if (!(g.amounts ?? []).length && !/\d{4,5}\s*(USD|美金)/i.test(t)) continue;
  const date = it.date_known ? beijingDate(it.sent_at) : null;
  const pod = podText(t, g);
  const port = matchPort(pod) ?? matchPort(routeLine(t));
  const base = { date, pol: polOf(t, g), pod: pod.slice(0, 24), port, carrier: g.carrier ?? '', valid: validOf(t, g),
    excl: (g.excluded ?? []).join('、') || (/不含电放保险/.test(t) ? '电放、保险' : ''), raw: firstLine(t).slice(0, 40) };
  if (isOther(t)) { other.push({ ...base, text: t.replace(/\n/g, ' / ').slice(0, 80) }); continue; }
  if (isRoro(t, g)) { roro.push({ ...base, ...interpretRoro(it) }); continue; }
  for (const r of interpretContainer(it)) {
    container.push({ ...base, ...r, ct: ctOf(t, r.a), cars: carsOf(t, r.a), cargo: cargoOf(t, r.a) });
  }
}

const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const md = [];
md.push(`# 货代报价审查清单：${doc.chat}`);
md.push(`来源：${file.split('/').pop()}；只收「${fwdArg}」的报价（${seen.size} 条），日期已换成北京时间。汇率按 ${FX} 折算人民币杂费。`);
md.push('请核对「我读的全包价」一列对不对；有错直接在最后一列写对的数。**确认后才入库。**\n');
const cars = (n) => n ? `一装${{ 1: '一', 2: '二', 3: '三', 4: '四' }[n] ?? n}` : '';
const sortRows = (a, b) => (b.port && OUR.has(b.port.code) ? 1 : 0) - (a.port && OUR.has(a.port.code) ? 1 : 0) || (a.pod > b.pod ? 1 : -1) || (a.date > b.date ? 1 : -1);
container.sort(sortRows); roro.sort(sortRows);
md.push(`## 集装箱（${container.length} 条，我们在跑的航线排前面）\n`);
md.push('| 日期 | 起运 | 目的港 | 船公司 | 柜型 | 货类 | 我读的全包价 USD | 依据 | 不含 | 有效期/船期 | 确认 |');
md.push('|---|---|---|---|---|---|---:|---|---|---|---|');
for (const r of container) {
  md.push(`| ${r.date ?? '?'} | ${r.pol} | ${r.port ? `**${r.port.name}**` : esc(r.pod)} | ${r.carrier} | ${r.ct} ${cars(r.cars)} | ${r.cargo === 'dg' ? '危险品' : '普货'} | ${r.price ?? '?'} | ${esc(r.basis)} | ${r.excl} | ${esc(r.valid)} | |`);
}
md.push(`\n## 滚装（${roro.length} 条）\n`);
md.push('| 日期 | 起运 | 目的港 | 每立方 USD | 每票固定 USD | 依据 | R08 单台约（20 立方） | 有效期/船期 | 确认 |');
md.push('|---|---|---|---:|---:|---|---:|---|---|');
for (const r of roro) {
  const est = r.perCbm ? Math.round(r.perCbm * 20 + (r.fixed ?? 0)) : '';
  md.push(`| ${r.date ?? '?'} | ${r.pol} | ${r.port ? `**${r.port.name}**` : esc(r.pod)} | ${r.perCbm ?? '?'} | ${r.fixed || ''} | ${esc(r.basis)} | ${est} | ${esc(r.valid)} | |`);
}
if (other.length) {
  md.push(`\n## 其他运输方式（${other.length} 条，散杂船/笼车/铁路，不入库）\n`);
  for (const r of other) md.push(`- ${r.date} ${esc(r.text)}`);
}
md.push(`\n## 不入库的发送者（我方询价等）\n`);
for (const [s, n] of askers) md.push(`- ${s}：${n} 条`);
console.log(md.join('\n'));
