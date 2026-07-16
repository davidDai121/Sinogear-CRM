import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/markdown-report-to-html.mjs input.md output.html');
}

const source = await fs.readFile(inputPath, 'utf8');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(value) {
  return escapeHtml(value)
    .replace(/&lt;br&gt;/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isDivider(line) {
  return /^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim());
}

const lines = source.split(/\r?\n/);
const body = [];
let i = 0;
let listType = null;
let currentPriority = '';

function closeList() {
  if (!listType) return;
  body.push(`</${listType}>`);
  listType = null;
}

while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  if (!trimmed) {
    closeList();
    i += 1;
    continue;
  }

  if (trimmed.startsWith('|')) {
    closeList();
    const rows = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      if (!isDivider(lines[i])) rows.push(tableCells(lines[i]));
      i += 1;
    }
    if (rows.length > 0) {
      const priorityClass = currentPriority
        ? ` priority-${currentPriority.toLowerCase()}`
        : '';
      body.push(`<div class="table-wrap${priorityClass}"><table>`);
      body.push(
        `<thead><tr>${rows[0]
          .map((cell) => `<th>${inline(cell)}</th>`)
          .join('')}</tr></thead>`,
      );
      body.push('<tbody>');
      for (const row of rows.slice(1)) {
        body.push(
          `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`,
        );
      }
      body.push('</tbody></table></div>');
    }
    continue;
  }

  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    closeList();
    const level = heading[1].length;
    const text = heading[2];
    const priority = text.match(/^(P[0-4])\b/);
    currentPriority = priority?.[1] ?? '';
    body.push(`<h${level}>${inline(text)}</h${level}>`);
    i += 1;
    continue;
  }

  const unordered = trimmed.match(/^-\s+(.+)$/);
  if (unordered) {
    if (listType !== 'ul') {
      closeList();
      body.push('<ul>');
      listType = 'ul';
    }
    body.push(`<li>${inline(unordered[1])}</li>`);
    i += 1;
    continue;
  }

  const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
  if (ordered) {
    if (listType !== 'ol') {
      closeList();
      body.push('<ol>');
      listType = 'ol';
    }
    body.push(`<li>${inline(ordered[1])}</li>`);
    i += 1;
    continue;
  }

  closeList();
  if (trimmed.startsWith('⚠')) {
    body.push(`<div class="warning">${inline(trimmed)}</div>`);
  } else {
    body.push(`<p>${inline(trimmed)}</p>`);
  }
  i += 1;
}
closeList();

const title = source.match(/^#\s+(.+)$/m)?.[1] ?? 'Sino Gear CRM 客户分析';
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17212b;
      --muted: #5f6f7a;
      --line: #dfe5e7;
      --soft: #f5f7f8;
      --green: #087966;
      --green-soft: #eaf7f3;
      --amber: #9a6700;
      --red: #b42318;
      --blue: #175cd3;
    }
    * { box-sizing: border-box; }
    html { background: #eef2f3; }
    body {
      margin: 0 auto;
      max-width: 1580px;
      min-height: 100vh;
      padding: 40px clamp(18px, 4vw, 64px) 72px;
      color: var(--ink);
      background: #fff;
      font: 14px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 30px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    h2 {
      margin: 36px 0 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid var(--ink);
      font-size: 20px;
      letter-spacing: 0;
    }
    h3 {
      margin: 28px 0 10px;
      color: var(--green);
      font-size: 16px;
      letter-spacing: 0;
    }
    p { margin: 7px 0; color: var(--muted); }
    .warning {
      margin: 18px 0 22px;
      padding: 12px 14px;
      border: 1px solid #f0c36d;
      border-left: 4px solid var(--amber);
      border-radius: 6px;
      color: #6b4700;
      background: #fff8e8;
      font-weight: 600;
    }
    ul, ol { margin: 8px 0 14px; padding-left: 24px; }
    li { margin: 5px 0; }
    strong { color: var(--ink); }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .table-wrap {
      width: 100%;
      margin: 10px 0 22px;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    table {
      width: 100%;
      min-width: 900px;
      border-collapse: collapse;
      background: #fff;
    }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      border-right: 1px solid #edf0f1;
      text-align: left;
      vertical-align: top;
    }
    th:last-child, td:last-child { border-right: 0; }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      color: #344054;
      background: var(--soft);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    tbody tr:nth-child(even) { background: #fafbfb; }
    tbody tr:hover { background: var(--green-soft); }
    tbody tr:last-child td { border-bottom: 0; }
    td:first-child { width: 42px; color: var(--muted); }
    td:nth-child(2) { min-width: 170px; }
    td:nth-child(7) { min-width: 190px; }
    td:last-child { min-width: 520px; }
    .priority-p0 { border-left: 4px solid var(--red); }
    .priority-p1 { border-left: 4px solid var(--amber); }
    .priority-p2 { border-left: 4px solid var(--blue); }
    .priority-p3 { border-left: 4px solid var(--green); }
    .priority-p4 { border-left: 4px solid #667085; }
    @media (max-width: 720px) {
      body { padding: 24px 14px 48px; }
      h1 { font-size: 24px; }
      h2 { margin-top: 28px; }
      table { min-width: 1080px; }
    }
    @media print {
      html { background: #fff; }
      body { max-width: none; padding: 12mm; font-size: 10px; }
      a { color: var(--ink); }
      .table-wrap { overflow: visible; break-inside: auto; }
      table { min-width: 0; }
      th { position: static; }
      tr { break-inside: avoid; }
      h2, h3 { break-after: avoid; }
    }
  </style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, html, 'utf8');
console.log(outputPath);
