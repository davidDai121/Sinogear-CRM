import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/filter-valuable-report.mjs input.md output.md');
}

const source = await fs.readFile(inputPath, 'utf8');
const lines = source.split(/\r?\n/);

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function rowLine(cells) {
  return `| ${cells.join(' | ')} |`;
}

function isCustomerRow(line) {
  return /^\|\s*\d+\s*\|/.test(line);
}

function normalize(value) {
  return String(value ?? '').replace(/<br>/g, ' ').replace(/\*\*/g, '').trim();
}

const rows = [];
let currentPriority = '';
let header = null;

for (const line of lines) {
  const heading = line.trim().match(/^###\s+(P\d\s+.+)$/);
  if (heading) {
    currentPriority = heading[1];
    continue;
  }
  if (line.startsWith('| # |')) {
    header = tableCells(line);
    continue;
  }
  if (!isCustomerRow(line)) continue;

  const cells = tableCells(line);
  if (cells.length < 8) continue;
  rows.push({
    priority: currentPriority,
    cells,
    customer: normalize(cells[1]),
    country: normalize(cells[2]),
    stage: normalize(cells[3]),
    activity: normalize(cells[4]),
    demand: normalize(cells[5]),
    signal: normalize(cells[6]),
    advice: normalize(cells[7]),
  });
}

const kept = rows.filter(
  (row) =>
    (row.priority.startsWith('P0 ') || row.priority.startsWith('P1 ')) &&
    !row.activity.includes('无聊天历史'),
);

const paymentRows = kept.filter(
  (row) =>
    row.signal.includes('付款或银行环节') ||
    row.signal.includes('订单确认') ||
    row.signal.includes('接受方案') ||
    row.signal.includes('客户表示继续') ||
    /CRM 标成成交/.test(row.advice),
);
const paymentSet = new Set(paymentRows);
const quoteRows = kept.filter(
  (row) =>
    !paymentSet.has(row) &&
    (/正式价格|CIF|FOB/.test(row.signal) || /已报价/.test(row.stage)),
);
const quoteSet = new Set(quoteRows);
const inquiryRows = kept.filter((row) => !paymentSet.has(row) && !quoteSet.has(row));

function priorityCounts(items) {
  const counts = new Map();
  for (const row of items) counts.set(row.priority, (counts.get(row.priority) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => `${name} ${count}`)
    .join('；');
}

function section(title, items, startIndex) {
  const out = [`### ${title}`, ''];
  if (items.length === 0) {
    out.push('无。', '');
    return { lines: out, nextIndex: startIndex };
  }

  out.push(
    rowLine(
      header ?? [
        '#',
        '客户',
        '国家',
        'CRM 阶段',
        '最近互动',
        '需求',
        '聊天业务信号',
        '诊断、动作与建议话术',
      ],
    ),
  );
  out.push('|---:|---|---|---|---|---|---|---|');

  let index = startIndex;
  for (const row of items) {
    const cells = [...row.cells];
    cells[0] = String(index);
    out.push(rowLine(cells));
    index += 1;
  }
  out.push('');
  return { lines: out, nextIndex: index };
}

const generatedAt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'long',
  timeStyle: 'short',
}).format(new Date());

const output = [
  '# wanglincheng 有价值客户清单',
  '',
  `生成时间：${generatedAt}`,
  '',
  '数据来源：原始 wanglincheng 客户分析报告。这里只保留 P0/P1 且已有 CRM 聊天历史的客户。',
  '',
  '## 筛选结果',
  '',
  `- 原报告客户：${rows.length} 人`,
  `- 本清单保留：${kept.length} 人（${priorityCounts(kept)}）`,
  `- 付款/接受/成交核查：${paymentRows.length} 人`,
  `- 已报价或价格信号：${quoteRows.length} 人`,
  `- 明确询价待回复：${inquiryRows.length} 人`,
  `- 已剔除：${rows.length - kept.length} 人，主要是清理类、普通培育类、无聊天历史客户`,
  '',
  '## 处理顺序',
  '',
  '1. 先处理“付款/接受/成交核查”，这里最接近订单，但也最容易被 CRM 旧阶段误导。',
  '2. 再处理“已报价或价格信号”，重点补完整 CIF/FOB、有效期、库存和付款节点。',
  '3. 最后处理“明确询价待回复”，只问一个推进问题，不要重新寒暄。',
  '',
];

let nextIndex = 1;
for (const part of [
  section('付款/接受/成交核查', paymentRows, nextIndex),
  section('已报价或价格信号', quoteRows, nextIndex + paymentRows.length),
  section(
    '明确询价待回复',
    inquiryRows,
    nextIndex + paymentRows.length + quoteRows.length,
  ),
]) {
  output.push(...part.lines);
  nextIndex = part.nextIndex;
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${output.join('\n')}\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      outputPath,
      sourceRows: rows.length,
      kept: kept.length,
      payment: paymentRows.length,
      quote: quoteRows.length,
      inquiry: inquiryRows.length,
    },
    null,
    2,
  ),
);
