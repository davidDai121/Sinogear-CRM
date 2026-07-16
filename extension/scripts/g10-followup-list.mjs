#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
config({ path: resolve(__dirname, '..', '.env') });

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ORG_ID } = process.env;
if (!VITE_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ORG_ID) {
  console.error('需要 .env 配置 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ORG_ID');
  process.exit(1);
}

const sb = createClient(VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
const outputDir = resolve(root, '分析导出');

async function fetchAllPaged(query) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function csvCell(value) {
  const text = normalizeText(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function parseMoneyHints(text) {
  const values = [];
  const patterns = [
    /(?:\$|usd|us\$)\s*([0-9][0-9,]*(?:\.[0-9]+)?)(k)?/gi,
    /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k)?\s*(?:usd|dollar|dollars|us\$|\$)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      let value = Number(String(match[1]).replaceAll(',', ''));
      if (!Number.isFinite(value)) continue;
      if (match[2]?.toLowerCase() === 'k') value *= 1000;
      if (value >= 1000 && value <= 30000) values.push(Math.round(value));
    }
  }
  return [...new Set(values)];
}

function budgetScore(budget, moneyHints) {
  const values = [];
  if (budget) values.push(Number(budget));
  values.push(...moneyHints);
  if (!values.length) return { score: 0, label: '' };

  let best = 0;
  let bestValue = values[0];
  for (const value of values) {
    let score = 0;
    if (value >= 8000 && value <= 12000) score = 35;
    else if (value >= 6500 && value < 8000) score = 27;
    else if (value > 12000 && value <= 15000) score = 28;
    else if (value >= 5000 && value < 6500) score = 16;
    else if (value > 15000 && value <= 18000) score = 14;
    if (score > best) {
      best = score;
      bestValue = value;
    }
  }
  return { score: best, label: `$${bestValue.toLocaleString('en-US')}` };
}

function pickEvidence(messages) {
  const keywordPattern =
    /budget|price|cheap|affordable|cost|cif|fob|shipping|import|interested|need|want|family|7 seat|7-seat|seven seat|mpv|van|bus|taxi|business|company|fleet|dealer|stock|available|\$|usd/i;
  const hits = messages
    .filter((m) => m.direction === 'inbound' && keywordPattern.test(m.text ?? ''))
    .slice(-3)
    .map((m) => normalizeText(m.text).slice(0, 180));
  if (hits.length) return hits;
  return messages
    .filter((m) => m.direction === 'inbound' && normalizeText(m.text))
    .slice(-2)
    .map((m) => normalizeText(m.text).slice(0, 180));
}

function whatsappLink(contact) {
  const phone = normalizeText(contact.phone).replace(/\D/g, '');
  return phone ? `https://wa.me/${phone}` : '';
}

function isChinaContact(contact) {
  const phone = normalizeText(contact.phone).replace(/\D/g, '');
  return contact.country === 'China' || phone.startsWith('86');
}

console.log('读取客户、消息、车型兴趣和标签...');
const contacts = await fetchAllPaged(
  sb
    .from('contacts')
    .select(
      'id, phone, group_jid, name, wa_name, country, language, budget_usd, customer_stage, quality, destination_port, notes, updated_at',
    )
    .eq('org_id', ORG_ID),
);

const contactById = new Map(contacts.map((c) => [c.id, c]));
const contactIds = new Set(contactById.keys());

const [messagesAll, interestsAll, tagsAll, tasksAll] = await Promise.all([
  fetchAllPaged(sb.from('messages').select('contact_id, direction, text, sent_at').order('sent_at', { ascending: true })),
  fetchAllPaged(sb.from('vehicle_interests').select('contact_id, model, year, condition, steering, target_price_usd, notes')),
  fetchAllPaged(sb.from('contact_tags').select('contact_id, tag')),
  fetchAllPaged(sb.from('tasks').select('contact_id, title, status, due_at').eq('org_id', ORG_ID)),
]);

const messagesByContact = new Map();
for (const m of messagesAll) {
  if (!contactIds.has(m.contact_id)) continue;
  if (!messagesByContact.has(m.contact_id)) messagesByContact.set(m.contact_id, []);
  messagesByContact.get(m.contact_id).push(m);
}

const interestsByContact = new Map();
for (const row of interestsAll) {
  if (!contactIds.has(row.contact_id)) continue;
  if (!interestsByContact.has(row.contact_id)) interestsByContact.set(row.contact_id, []);
  interestsByContact.get(row.contact_id).push(row);
}

const tagsByContact = new Map();
for (const row of tagsAll) {
  if (!contactIds.has(row.contact_id)) continue;
  if (!tagsByContact.has(row.contact_id)) tagsByContact.set(row.contact_id, []);
  tagsByContact.get(row.contact_id).push(row.tag);
}

const tasksByContact = new Map();
for (const row of tasksAll) {
  if (!row.contact_id || !contactIds.has(row.contact_id)) continue;
  if (!tasksByContact.has(row.contact_id)) tasksByContact.set(row.contact_id, []);
  tasksByContact.get(row.contact_id).push(row);
}

const candidates = [];
for (const contact of contacts) {
  if (contact.group_jid) continue;
  if (contact.quality === 'spam') continue;
  if (contact.customer_stage === 'won') continue;
  if (isChinaContact(contact)) continue;

  const messages = messagesByContact.get(contact.id) ?? [];
  const interests = interestsByContact.get(contact.id) ?? [];
  const tags = tagsByContact.get(contact.id) ?? [];
  const tasks = tasksByContact.get(contact.id) ?? [];
  const inboundText = normalizeText(messages.filter((m) => m.direction === 'inbound').map((m) => m.text).join(' '));
  const buyerProfileText = normalizeText(
    [
      contact.notes,
      ...tags,
      ...interests.flatMap((i) => [i.model, i.condition, i.steering, i.target_price_usd, i.notes]),
      inboundText,
      ...tasks.map((t) => t.title),
    ].join(' '),
  );
  const allText = normalizeText(
    [
      contact.name,
      contact.wa_name,
      contact.country,
      contact.language,
      contact.destination_port,
      contact.notes,
      ...tags,
      ...interests.flatMap((i) => [i.model, i.condition, i.steering, i.notes]),
      ...messages.map((m) => m.text),
      ...tasks.map((t) => t.title),
    ].join(' '),
  );

  const moneyHints = parseMoneyHints(buyerProfileText);
  for (const interest of interests) {
    if (interest.target_price_usd) moneyHints.push(Number(interest.target_price_usd));
  }
  const bScore = budgetScore(contact.budget_usd, [...new Set(moneyHints)]);
  const inbound = messages.filter((m) => m.direction === 'inbound').length;
  const outbound = messages.filter((m) => m.direction === 'outbound').length;
  const lastMessage = messages.at(-1);
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');

  let score = bScore.score;
  const reasons = [];
  if (bScore.score) reasons.push(`预算/聊天金额接近 ${bScore.label}`);

  if (contact.quality === 'big') {
    score += 18;
    reasons.push('标记为大客户');
  } else if (contact.quality === 'potential') {
    score += 10;
    reasons.push('标记为潜在客户');
  }

  if (['negotiating', 'qualifying', 'quoted'].includes(contact.customer_stage)) {
    score += 16;
    reasons.push(`阶段 ${contact.customer_stage}`);
  } else if (contact.customer_stage === 'stalled') {
    score += 8;
    reasons.push('阶段 stalled，可重新激活');
  } else if (contact.customer_stage === 'new') {
    score += 5;
    reasons.push('新客户');
  } else if (contact.customer_stage === 'lost') {
    score -= 5;
  }

  if (inbound >= 3 && outbound >= 2) {
    score += 12;
    reasons.push(`有来有回 ${inbound}/${outbound}`);
  } else if (inbound >= 1) {
    score += 5;
    reasons.push(`客户有回复 ${inbound} 条`);
  }

  const lowBudgetPattern = /budget|price|cheap|affordable|expensive|cost|too high|lower|low price|price sensitive|预算|便宜/i;
  if (lowBudgetPattern.test(buyerProfileText)) {
    score += 14;
    reasons.push('价格敏感/低预算信号');
  }

  const valuePattern = /dealer|fleet|company|business|taxi|uber|import|shipping|cif|fob|port|tema|dakar|iquique|ready|within 1 month|serious|purchase|buy|order|代理|贸易商/i;
  if (valuePattern.test(allText)) {
    score += 12;
    reasons.push('有进口/经营/采购信号');
  }

  const g10FitPattern = /7 seat|7-seat|seven seat|7 seater|mpv|van|bus|family|commercial|taxi|people carrier|mini bus|minibus|mifa|g10|g20|mivan|suv|highlander|rav4|cs75|uni-k|dashing|h6/i;
  if (g10FitPattern.test(allText)) {
    score += 10;
    reasons.push('适合推 7 座/MPV 或低价大空间替代');
  }

  if (tags.some((t) => /跟进|follow|potential|price|budget|有潜力|待成单|三日|七日/i.test(t))) {
    score += 8;
    reasons.push('标签提示值得跟进');
  }

  if (tasks.some((t) => t.status === 'open')) {
    score += 5;
    reasons.push('有未完成跟进任务');
  }

  if (!bScore.score && !/10000|10,000|10k|\$10|budget|price|cheap|affordable|低预算|预算/i.test(buyerProfileText)) continue;
  if (score < 34) continue;

  const name = normalizeText(contact.name || contact.wa_name || contact.phone || 'Unknown');
  const interestLabel = interests
    .map((i) => [i.year, i.model, i.condition, i.target_price_usd ? `$${i.target_price_usd}` : '', i.notes].filter(Boolean).join(' '))
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');

  candidates.push({
    score,
    contact,
    name,
    inbound,
    outbound,
    budget: bScore.label || (contact.budget_usd ? `$${Number(contact.budget_usd).toLocaleString('en-US')}` : ''),
    interests: interestLabel,
    tags: tags.join(', '),
    reasons: [...new Set(reasons)].slice(0, 6),
    evidence: pickEvidence(messages),
    lastMessageAt: lastMessage?.sent_at ?? '',
    lastInboundAt: lastInbound?.sent_at ?? '',
  });
}

candidates.sort((a, b) => b.score - a.score || b.inbound + b.outbound - (a.inbound + a.outbound));
const top = candidates.slice(0, 80);

mkdirSync(outputDir, { recursive: true });

const englishPitch =
  'Hi {{name}}, I have one good option for your budget: Maxus G10, 7 seats, 2.0T turbo engine, strong power and big space. It is very practical for family use, business, taxi or company transport. The price is around USD 10,000 depending on year and condition. If you want, I can send you photos, video and CIF price to your port.';

const frenchPitch =
  'Bonjour {{name}}, j’ai une bonne option pour votre budget : Maxus G10, 7 places, moteur 2.0T turbo, puissant et spacieux. C’est pratique pour famille, business, taxi ou transport d’entreprise. Le prix est autour de 10 000 USD selon l’année et l’état. Si vous voulez, je peux vous envoyer photos, vidéo et prix CIF pour votre port.';

const spanishPitch =
  'Hola {{name}}, tengo una buena opción para su presupuesto: Maxus G10, 7 plazas, motor 2.0T turbo, fuerte y con mucho espacio. Es práctico para familia, negocio, taxi o transporte de empresa. El precio está alrededor de USD 10,000 según año y condición. Si quiere, le envío fotos, video y precio CIF a su puerto.';

const md = [
  '# Maxus G10 低预算跟进名单',
  '',
  `生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
  '',
  `筛选逻辑：预算/聊天金额约 5,000-15,000 美金优先；结合价格敏感、有进口或采购信号、有来有回、客户阶段、标签和车型兴趣评分。共筛出 ${candidates.length} 人，下面展示前 ${top.length} 人。`,
  '',
  '## 推荐话术',
  '',
  '英文：',
  '',
  englishPitch,
  '',
  '法语：',
  '',
  frenchPitch,
  '',
  '西语：',
  '',
  spanishPitch,
  '',
  '## 名单',
  '',
];

for (const [index, row] of top.entries()) {
  const c = row.contact;
  md.push(
    `### ${index + 1}. ${row.name}`,
    '',
    `- 电话：${c.phone || ''}`,
    `- WhatsApp：${whatsappLink(c)}`,
    `- 国家/语言：${c.country || ''} / ${c.language || ''}`,
    `- 阶段/质量：${c.customer_stage || ''} / ${c.quality || ''}`,
    `- 预算：${row.budget || ''}`,
    `- 意向车型：${row.interests || ''}`,
    `- 标签：${row.tags || ''}`,
    `- 互动：客户 ${row.inbound} 条 / 销售 ${row.outbound} 条`,
    `- 评分：${row.score}`,
    `- 推荐理由：${row.reasons.join('；')}`,
  );
  if (row.evidence.length) {
    md.push('- 聊天证据：');
    for (const evidence of row.evidence) md.push(`  - ${evidence}`);
  }
  md.push('');
}

const csvRows = [
  [
    'rank',
    'score',
    'name',
    'phone',
    'whatsapp_link',
    'country',
    'language',
    'stage',
    'quality',
    'budget',
    'interests',
    'tags',
    'inbound',
    'outbound',
    'reasons',
    'evidence',
    'english_pitch',
  ],
  ...top.map((row, index) => [
    index + 1,
    row.score,
    row.name,
    row.contact.phone || '',
    whatsappLink(row.contact),
    row.contact.country || '',
    row.contact.language || '',
    row.contact.customer_stage || '',
    row.contact.quality || '',
    row.budget,
    row.interests,
    row.tags,
    row.inbound,
    row.outbound,
    row.reasons.join('; '),
    row.evidence.join(' | '),
    englishPitch.replace('{{name}}', row.name.split(/\s+/)[0] || 'friend'),
  ]),
];

const mdPath = resolve(outputDir, 'maxus-g10-followup-list.md');
const csvPath = resolve(outputDir, 'maxus-g10-followup-list.csv');
writeFileSync(mdPath, `${md.join('\n')}\n`);
writeFileSync(csvPath, `${csvRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);

console.log(`筛出 ${candidates.length} 个候选，已导出前 ${top.length} 个：`);
console.log(mdPath);
console.log(csvPath);
console.log('\nTop 20:');
for (const [index, row] of top.slice(0, 20).entries()) {
  console.log(
    `${String(index + 1).padStart(2, '0')}. ${row.name} | ${row.contact.phone || ''} | ${row.contact.country || ''} | ${row.budget || '-'} | score=${row.score} | ${row.reasons.join('；')}`,
  );
}
