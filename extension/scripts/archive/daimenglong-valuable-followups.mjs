import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = dotenv.parse(
  await fs.readFile(path.join(__dirname, '..', '.env'), 'utf8'),
);

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error(
    'Usage: node scripts/daimenglong-valuable-followups.mjs <output.md>',
  );
}

const orgId = env.ORG_ID;
const supabaseUrl = env.VITE_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const userId = 'ecca2247-1490-41e1-b52b-8ac962df25b7';
if (!orgId || !supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing ORG_ID / VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PAGE_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 10;
const now = new Date();

async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllById(buildQuery) {
  const rows = [];
  let lastId = null;
  for (;;) {
    const { data, error } = await buildQuery(lastId);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    lastId = page.at(-1)?.id ?? null;
    if (!lastId) break;
  }
  return rows;
}

function timestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysSince(value) {
  const parsed = timestamp(value);
  if (!parsed) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / DAY_MS));
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function md(value) {
  return normalize(value).replace(/\|/g, '｜');
}

function shortText(value, max = 100) {
  const text = md(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function displayDate(value) {
  if (!value) return '无';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function stageLabel(value) {
  return (
    {
      new: '新客户',
      qualifying: '需求确认',
      negotiating: '洽谈中',
      stalled: '停滞',
      quoted: '已报价',
      won: '成交',
      lost: '流失',
    }[value] ?? value
  );
}

function groupByContact(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.contact_id) ?? [];
    current.push(row);
    grouped.set(row.contact_id, current);
  }
  return grouped;
}

const patterns = {
  payment:
    /bank|deposit|payment|transfer|receipt|invoice|\bpi\b|acompte|banque|virement|pago|banco|cuota|定金|付款|银行|回单/i,
  paymentCommitment:
    /pay(ment)? (this|next) (week|month)|ready to pay|make the (payment|transfer)|send (the )?(money|payment|deposit)|transfer (the )?(deposit|30%|money)|bank receipt|payment date|process the payment|hacer (el )?(pago|transferencia)|effectuer le virement|付款日期|准备付款|支付定金/i,
  accepted:
    /please proceed|go ahead|ready to (buy|order|pay)|confirm(ed)? (the )?order|i('ll| will) take|send (me )?(the )?invoice|next step|vamos a proceder|puede proceder|listo para (comprar|pagar)|je confirme|nous allons proc[eé]der|确认订单|可以下单/i,
  formalQuote:
    /(?:usd|us\$|\$)\s*[\d,.]{4,}|[\d,.]{4,}\s*(?:usd|us\$|dollars?)|(?:cif|fob).{0,40}(?:usd|us\$|\$|[\d,.]{4,})|(?:usd|us\$|\$|[\d,.]{4,}).{0,40}(?:cif|fob)/i,
  priceInquiry:
    /price|cost|quote|quotation|how much|precio|cu[aá]nto|cotiz|costo|prix|combien|tarif|报价|价格|多少钱/i,
  dealer:
    /dealer|distributor|sales agent|fleet|importer|resell|wholesale|container|\bb2b\b|(?:\b[2-9]|\d{2,})\s*(?:units?|cars?|vehicles?|pieces?)|concessionnaire|distributeur|代理|经销|批发|车队|(?:[2-9]|\d{2,})\s*台/i,
  buyer:
    /interested|want to buy|need (a|the|this|one|\d)|looking for|purchase|buy|order|quiero|necesito|busco|comprar|interesado|je cherche|je veux|acheter|besoin|想买|需要|采购/i,
  shipping:
    /shipping|freight|delivery|port|ship to|cif|destination|puerto|env[ií]o|flete|livraison|exp[eé]dition|港口|海运|运费/i,
  question:
    /[?？]|how much|what price|available|in stock|precio|cu[aá]nto|disponible|combien|disponibilit[eé]|多少钱|有货/i,
};

function isLeadBoilerplate(value) {
  const text = normalize(value);
  return /filled out (your|the) form|complet[eé] el formulario|logo-(facebook|instagram)|more information about your business|what is your business about|rempli (votre|le) formulaire/i.test(
    text,
  );
}

function latestMatchingMessage(messages, pattern, direction, allowBoilerplate = false) {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        (!direction || message.direction === direction) &&
        (allowBoilerplate || !isLeadBoilerplate(message.text)) &&
        pattern.test(normalize(message.text)),
    );
}

function meaningfulInbound(message) {
  const text = normalize(message?.text);
  if (!text || text === '.' || /^\[(图片|视频|文件|语音|已删除)\]$/.test(text)) {
    return false;
  }
  if (
    /^(ok(ay)?|thanks?|thank you|good|fine|noted|understood|gracias|perfecto|vale|merci|收到|好的|谢谢)[\s.!👍🙏]*$/i.test(
      text,
    )
  ) {
    return false;
  }
  if (
    isLeadBoilerplate(text) ||
    /thank.*(kindness|understanding|confirmation)|appreciate.*confirmation|wish you|will let you know|i will contact you|come back to you|think about it|when i am ready|not (ready|now|interested)|too expensive/i.test(
      text,
    )
  ) {
    return false;
  }
  return (
    patterns.question.test(text) ||
    patterns.buyer.test(text) ||
    patterns.payment.test(text) ||
    patterns.accepted.test(text) ||
    patterns.shipping.test(text) ||
    patterns.dealer.test(text)
  );
}

function inferModel(interests, messages) {
  const recorded = interests
    .map((row) => normalize(row.model))
    .filter(
      (model) =>
        model && !/^(unknown|none|null|n\/a|unspecified|not provided)$/i.test(model),
    );
  if (recorded.length > 0) return [...new Set(recorded)].slice(0, 2).join(' / ');

  const text = messages.map((row) => row.text ?? '').join(' ');
  const modelPatterns = [
    [/\bBYD\s+Sealion\s*7\b/i, 'BYD Sealion 7'],
    [/\bBYD\s+Song\s+Plus\b/i, 'BYD Song Plus'],
    [/\bBYD\s+Qin\s+Plus\b/i, 'BYD Qin Plus'],
    [/\bBYD\s+Seagull\b/i, 'BYD Seagull'],
    [/\bYangwang\s+U8\b/i, 'Yangwang U8'],
    [/\bChery\s+Rely\s+R08\b/i, 'Chery Rely R08'],
    [/\bJetour\s+T2\b/i, 'Jetour T2'],
    [/\bChangan\s+UNI[- ]?K\b/i, 'Changan UNI-K'],
    [/\bChangan\s+UNI[- ]?Z\b/i, 'Changan UNI-Z'],
    [/\b(?:GWM\s+)?Tank\s*500\b/i, 'GWM Tank 500'],
    [/\b(?:GWM\s+)?Tank\s*700\b/i, 'GWM Tank 700'],
    [/\bMaxus\s+G10\b/i, 'Maxus G10'],
    [/\bHongqi\s+HS5\b/i, 'Hongqi HS5'],
    [/\bToyota\s+Corolla\b/i, 'Toyota Corolla'],
  ];
  for (const [pattern, model] of modelPatterns) {
    if (pattern.test(text)) return model;
  }
  return '意向车型未确认';
}

const LATIN_COUNTRIES = new Set([
  'Argentina',
  'Bolivia',
  'Chile',
  'Colombia',
  'Costa Rica',
  'Dominican Republic',
  'Ecuador',
  'Mexico',
  'Panama',
  'Paraguay',
  'Peru',
  'Uruguay',
  'Venezuela',
]);
const FRENCH_COUNTRIES = new Set([
  'Benin',
  'Cameroon',
  'Congo',
  "Côte d'Ivoire",
  'Gabon',
  'Guinea',
  'Mali',
  'Senegal',
  'Togo',
]);

function languageFor(contact, inboundText) {
  const configured = normalize(contact.language).toLowerCase();
  if (
    configured.includes('span') ||
    LATIN_COUNTRIES.has(contact.country) ||
    /\b(precio|puerto|quiero|necesito|gracias|veh[ií]culo)\b/i.test(inboundText)
  ) {
    return 'es';
  }
  if (
    configured.includes('french') ||
    configured.includes('fran') ||
    FRENCH_COUNTRIES.has(contact.country) ||
    /\b(bonjour|prix|voiture|merci|banque|acompte)\b/i.test(inboundText)
  ) {
    return 'fr';
  }
  return 'en';
}

function firstName(contact) {
  const raw = normalize(contact.name || contact.wa_name || 'my friend');
  return raw.split(/\s+/)[0] || 'my friend';
}

function draftFor(item, stale) {
  const language = languageFor(item.contact, item.inboundText);
  const name = firstName(item.contact);
  const model = item.model === '意向车型未确认' ? 'the vehicle' : item.model;
  const rawPort = normalize(item.contact.destination_port);
  const port =
    rawPort && !/^(null|unknown|not provided|n\/a)$/i.test(rawPort)
      ? rawPort
      : 'your destination port';
  const topic = item.primarySignal;
  const templates = {
    en: {
      payment: `Hi ${name}, I am following up on the payment step for ${model}. Is the PI still correct for you, and on what exact date can the transfer be made? Once sent, please share the bank receipt so I can verify it and reserve the vehicle.`,
      quote: `Hi ${name}, I can update the exact CIF offer for ${model} to ${port} today, including current stock, vehicle price, freight and shipment time. Are you still buying this model, or should I quote one alternative at a lower price?`,
      general: `Hi ${name}, I am checking the current stock and price for ${model}. Are you still planning to buy, and is ${port} still the correct destination? Once you confirm, I will send one complete option with total price and delivery time.`,
    },
    es: {
      payment: `Hola ${name}, doy seguimiento al paso de pago para ${model}. ¿La PI sigue correcta y en qué fecha exacta puede hacer la transferencia? Cuando la realice, envíeme el comprobante para verificarlo y reservar el vehículo.`,
      quote: `Hola ${name}, hoy puedo actualizar la oferta CIF exacta de ${model} a ${port}, con stock actual, precio, flete y tiempo de envío. ¿Sigue comprando este modelo o prefiere que cotice una alternativa más económica?`,
      general: `Hola ${name}, estoy verificando el stock y precio actual de ${model}. ¿Todavía planea comprar y ${port} sigue siendo el destino correcto? Al confirmarlo, le enviaré una opción completa con precio total y entrega.`,
    },
    fr: {
      payment: `Bonjour ${name}, je reviens vers vous concernant le paiement pour ${model}. La PI est-elle toujours correcte et à quelle date exacte pouvez-vous effectuer le virement ? Envoyez ensuite le reçu pour vérification et réservation.`,
      quote: `Bonjour ${name}, je peux actualiser aujourd'hui l'offre CIF exacte pour ${model} vers ${port}, avec stock, prix, fret et délai. Achetez-vous toujours ce modèle ou souhaitez-vous une option moins chère ?`,
      general: `Bonjour ${name}, je vérifie le stock et le prix actuels pour ${model}. Votre projet d'achat est-il toujours actif et ${port} reste-t-il le bon port ? Je vous enverrai ensuite une offre complète avec prix total et délai.`,
    },
  };
  const type = topic === 'payment' ? 'payment' : topic === 'quote' ? 'quote' : 'general';
  return templates[language][type];
}

function evaluate(contact, messages, interests, labelNames) {
  const sortedMessages = [...messages].sort(
    (a, b) => timestamp(a.sent_at) - timestamp(b.sent_at),
  );
  const inbound = sortedMessages.filter((row) => row.direction === 'inbound');
  const outbound = sortedMessages.filter((row) => row.direction === 'outbound');
  const lastInbound = inbound.at(-1) ?? null;
  const lastOutbound = outbound.at(-1) ?? null;
  const lastMessage = sortedMessages.at(-1) ?? null;
  const inboundText = inbound
    .filter((row) => !isLeadBoilerplate(row.text))
    .map((row) => row.text ?? '')
    .join(' ');
  const outboundText = outbound.map((row) => row.text ?? '').join(' ');
  const allText = `${inboundText} ${outboundText}`;
  const daysInactive = daysSince(lastMessage?.sent_at);
  const customerWaiting =
    lastInbound != null &&
    timestamp(lastInbound.sent_at) > timestamp(lastOutbound?.sent_at) &&
    meaningfulInbound(lastInbound);

  const paymentMessage = latestMatchingMessage(inbound, patterns.payment);
  const paymentCommitmentMessage = latestMatchingMessage(
    inbound,
    patterns.paymentCommitment,
  );
  const acceptedMessage = latestMatchingMessage(inbound, patterns.accepted);
  const formalQuoteMessage =
    latestMatchingMessage(outbound, patterns.formalQuote) ||
    latestMatchingMessage(inbound, patterns.formalQuote);
  const priceInquiryMessage = latestMatchingMessage(
    inbound,
    patterns.priceInquiry,
  );
  const dealerMessage = latestMatchingMessage(inbound, patterns.dealer);
  const buyerMessage = latestMatchingMessage(inbound, patterns.buyer);
  const shippingMessage = latestMatchingMessage(inbound, patterns.shipping);
  const questionMessage = latestMatchingMessage(inbound, patterns.question);

  const signals = [];
  if (paymentCommitmentMessage) signals.push('客户承诺/准备付款');
  else if (paymentMessage) signals.push('讨论付款方式');
  if (acceptedMessage) signals.push('明确购买或继续信号');
  if (formalQuoteMessage) signals.push('出现具体金额/CIF/FOB');
  else if (priceInquiryMessage) signals.push('客户明确询价');
  if (dealerMessage) signals.push('代理/批量/经营采购');
  if (buyerMessage) signals.push('客户表达购买需求');
  if (shippingMessage) signals.push('已谈目的港/运输');
  if (customerWaiting) signals.push('客户正在等回复');

  let score = 0;
  const valueLabels = [
    ['待付款', 35],
    ['大客户', 26],
    ['重要', 22],
    ['特别关注', 20],
    ['有潜力', 15],
    ['潜在客户', 12],
  ];
  for (const [label, points] of valueLabels) {
    if (labelNames.has(label)) score += points;
  }
  if (labelNames.has('跟进')) score += 12;
  if (contact.quality === 'big') score += 18;
  else if (contact.quality === 'potential') score += 4;
  if (contact.customer_stage === 'quoted') score += 18;
  else if (contact.customer_stage === 'negotiating') score += 13;
  else if (contact.customer_stage === 'qualifying') score += 8;
  else if (contact.customer_stage === 'stalled') score += 2;
  else if (contact.customer_stage === 'lost') score -= 24;
  if (paymentMessage) score += 15;
  if (paymentCommitmentMessage) score += 18;
  if (acceptedMessage) score += 24;
  if (formalQuoteMessage) score += 20;
  else if (priceInquiryMessage) score += 8;
  if (dealerMessage) score += 16;
  if (buyerMessage) score += 10;
  if (shippingMessage) score += 7;
  if (customerWaiting) score += 14;
  if (inbound.length >= 3 && outbound.length >= 2) score += 8;
  if (inbound.length >= 8 && outbound.length >= 8) score += 5;
  if (Number(contact.budget_usd) > 0) score += 6;
  if (interests.length > 0) score += 6;
  if (daysInactive != null && daysInactive <= 10) score += 5;
  else if (daysInactive != null && daysInactive > 30 && daysInactive <= 60) score -= 5;
  else if (daysInactive != null && daysInactive > 60 && daysInactive <= 120) score -= 10;
  else if (daysInactive != null && daysInactive > 120) score -= 18;

  const highValueLabel = [...labelNames].some((name) =>
    ['待付款', '大客户', '重要', '特别关注'].includes(name),
  );
  const hasStrongEvidence = Boolean(
    paymentCommitmentMessage ||
      acceptedMessage ||
      (formalQuoteMessage &&
        (priceInquiryMessage || shippingMessage || inbound.length >= 3)) ||
      dealerMessage ||
      (buyerMessage &&
        (priceInquiryMessage || shippingMessage || inbound.length >= 3)) ||
      highValueLabel,
  );
  const hasCurrentEvidence = Boolean(
    hasStrongEvidence ||
      priceInquiryMessage ||
      (buyerMessage &&
        (shippingMessage || inferModel(interests, sortedMessages) !== '意向车型未确认')),
  );
  const evidenceMessage =
    paymentCommitmentMessage ||
    paymentMessage ||
    acceptedMessage ||
    dealerMessage ||
    questionMessage ||
    buyerMessage ||
    priceInquiryMessage ||
    lastInbound;
  const primarySignal = paymentCommitmentMessage ||
    (paymentMessage && acceptedMessage)
    ? 'payment'
    : formalQuoteMessage || priceInquiryMessage || acceptedMessage
      ? 'quote'
      : 'general';

  return {
    contact,
    messages: sortedMessages,
    inbound,
    outbound,
    inboundText,
    lastInbound,
    lastOutbound,
    lastMessage,
    daysInactive,
    customerWaiting,
    score,
    signals,
    hasStrongEvidence,
    hasCurrentEvidence,
    evidenceMessage,
    primarySignal,
    labels: [...labelNames],
    model: inferModel(interests, sortedMessages),
  };
}

function isChinaContact(contact) {
  const phone = normalize(contact.phone).replace(/\D/g, '');
  return contact.country === 'China' || phone.startsWith('86');
}

function usable(item) {
  const { contact } = item;
  return !(
    contact.group_jid ||
    contact.quality === 'spam' ||
    contact.customer_stage === 'won' ||
    isChinaContact(contact) ||
    item.messages.length === 0 ||
    item.inbound.length === 0
  );
}

function priorityFor(item, section) {
  if (item.customerWaiting) return 'P0 客户待回复';
  if (item.primarySignal === 'payment') return 'P1 付款节点';
  if (item.primarySignal === 'quote') return 'P1 报价推进';
  if (section === 'stale') {
    if ((item.daysInactive ?? 999) <= 30) return 'P1 10-30天唤醒';
    if ((item.daysInactive ?? 999) <= 60) return 'P2 31-60天唤醒';
    return 'P3 长期客户复核';
  }
  return 'P2 继续推进';
}

function nextAction(item, section) {
  const excerpt = shortText(item.evidenceMessage?.text, 72);
  if (item.customerWaiting) {
    return `先回答客户最后的问题“${shortText(item.lastInbound?.text, 60)}”，回答后只追问车型/目的港/数量中缺失的一项。`;
  }
  if (item.primarySignal === 'payment') {
    return '核对 PI、付款金额和收款账户是否仍有效，要求客户给出明确付款日期；付款后回传银行回单。';
  }
  if (item.primarySignal === 'quote') {
    return `围绕“${excerpt}”更新一次完整报价：准确版本、车价、运费、CIF/FOB 总价、库存和有效期。`;
  }
  if (section === 'stale') {
    return `用“${excerpt}”作为旧需求证据，只发一次带新库存/价格/船期的唤醒；让客户在原车型和一个替代车型中二选一。`;
  }
  return `承接“${excerpt}”，补一条可核实的新信息，并把下一步收口到确认车型、目的港或正式报价。`;
}

console.log('读取 daimenglong 客户、标签和聊天记录...');
const [handlerRows, allContacts, whatsappLabels, allMessages, allInterests] =
  await Promise.all([
    fetchAll((from, to) =>
      supabase
        .from('contact_handlers')
        .select('contact_id, last_seen_at, contacts!inner(org_id)')
        .eq('user_id', userId)
        .eq('contacts.org_id', orgId)
        .order('contact_id', { ascending: true })
        .range(from, to),
    ),
    fetchAll((from, to) =>
      supabase
        .from('contacts')
        .select(
          'id, phone, group_jid, wa_name, name, country, language, budget_usd, destination_port, customer_stage, quality, notes, created_at, updated_at',
        )
        .eq('org_id', orgId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAll((from, to) =>
      supabase
        .from('whatsapp_labels')
        .select('id, name, synced_at')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllById((lastId) => {
      let query = supabase
        .from('messages')
        .select('id, contact_id, direction, text, sent_at, ai_source')
        .order('id', { ascending: true })
        .limit(PAGE_SIZE);
      if (lastId) query = query.gt('id', lastId);
      return query;
    }),
    fetchAllById((lastId) => {
      let query = supabase
        .from('vehicle_interests')
        .select('id, contact_id, model, year, condition, steering, target_price_usd, notes')
        .order('id', { ascending: true })
        .limit(PAGE_SIZE);
      if (lastId) query = query.gt('id', lastId);
      return query;
    }),
  ]);

const labelIds = whatsappLabels.map((row) => row.id);
const labelAssociations = labelIds.length
  ? await fetchAllById((lastId) => {
      let query = supabase
        .from('contact_whatsapp_labels')
        .select('id, contact_id, whatsapp_label_id')
        .in('whatsapp_label_id', labelIds)
        .order('id', { ascending: true })
        .limit(PAGE_SIZE);
      if (lastId) query = query.gt('id', lastId);
      return query;
    })
  : [];

const handlerContactIds = new Set(handlerRows.map((row) => row.contact_id));
const labelById = new Map(whatsappLabels.map((row) => [row.id, row.name]));
const labelsByContact = new Map();
for (const row of labelAssociations) {
  const labelName = labelById.get(row.whatsapp_label_id);
  if (!labelName) continue;
  const names = labelsByContact.get(row.contact_id) ?? new Set();
  names.add(labelName);
  labelsByContact.set(row.contact_id, names);
}

const scopeContacts = allContacts.filter(
  (contact) =>
    handlerContactIds.has(contact.id) || labelsByContact.has(contact.id),
);
const scopeIds = new Set(scopeContacts.map((contact) => contact.id));
const messagesByContact = groupByContact(
  allMessages.filter((row) => scopeIds.has(row.contact_id)),
);
const interestsByContact = groupByContact(
  allInterests.filter((row) => scopeIds.has(row.contact_id)),
);

const analyzed = scopeContacts.map((contact) =>
  evaluate(
    contact,
    messagesByContact.get(contact.id) ?? [],
    interestsByContact.get(contact.id) ?? [],
    labelsByContact.get(contact.id) ?? new Set(),
  ),
);

const jiajia = analyzed
  .filter(
    (item) =>
      usable(item) &&
      item.labels.includes('佳佳在跟') &&
      item.score >= 30 &&
      item.hasCurrentEvidence,
  )
  .map((item) => ({ ...item, section: 'jiajia' }));
const jiajiaIds = new Set(jiajia.map((item) => item.contact.id));

const current = analyzed
  .filter(
    (item) =>
      usable(item) &&
      !jiajiaIds.has(item.contact.id) &&
      !item.labels.includes('佳佳在跟') &&
      item.daysInactive != null &&
      item.daysInactive < STALE_DAYS &&
      item.score >= 34 &&
      item.hasCurrentEvidence,
  )
  .map((item) => ({ ...item, section: 'current' }));
const currentIds = new Set(current.map((item) => item.contact.id));

const stale = analyzed
  .filter(
    (item) =>
      usable(item) &&
      !item.labels.includes('佳佳在跟') &&
      !item.labels.includes('跟进') &&
      !jiajiaIds.has(item.contact.id) &&
      !currentIds.has(item.contact.id) &&
      item.daysInactive != null &&
      item.daysInactive >= STALE_DAYS &&
      item.daysInactive <= 180 &&
      item.score >= 52 &&
      item.hasStrongEvidence,
  )
  .map((item) => ({ ...item, section: 'stale' }));

const priorityOrder = new Map([
  ['P0 客户待回复', 0],
  ['P1 付款节点', 1],
  ['P1 报价推进', 2],
  ['P1 10-30天唤醒', 3],
  ['P2 31-60天唤醒', 4],
  ['P2 继续推进', 5],
  ['P3 长期客户复核', 6],
]);

function sortItems(items) {
  items.sort((a, b) => {
    const aPriority = priorityOrder.get(priorityFor(a, a.section)) ?? 99;
    const bPriority = priorityOrder.get(priorityFor(b, b.section)) ?? 99;
    return (
      aPriority - bPriority ||
      b.score - a.score ||
      (a.daysInactive ?? 9999) - (b.daysInactive ?? 9999)
    );
  });
}
sortItems(jiajia);
sortItems(current);
sortItems(stale);

function customerCell(contact) {
  const name = contact.name || contact.wa_name || contact.phone || '未命名';
  const digits = normalize(contact.phone).replace(/\D/g, '');
  if (!digits) return md(name);
  return `[${md(name)}](https://wa.me/${digits})<br>${md(contact.phone)}`;
}

function tableSection(title, intro, items, startIndex) {
  const lines = [`## ${title}`, '', intro, ''];
  if (items.length === 0) {
    lines.push('本次没有筛出符合条件的客户。', '');
    return { lines, nextIndex: startIndex };
  }
  lines.push(
    '| # | 优先级 | 客户 | 国家/阶段 | 最近互动 | 为什么值得跟 | 需求证据 | 下一步 | 建议话术 |',
    '|---:|---|---|---|---|---|---|---|---|',
  );
  let index = startIndex;
  for (const item of items) {
    const activity = item.lastMessage
      ? `${displayDate(item.lastMessage.sent_at)}<br>${item.daysInactive ?? 0} 天前<br>${
          item.customerWaiting ? '**客户待回复**' : '销售最后发言/已接续'
        }`
      : '无记录';
    const labels = item.labels
      .filter((name) =>
        ['待付款', '大客户', '重要', '特别关注', '有潜力', '潜在客户'].includes(
          name,
        ),
      )
      .slice(0, 3);
    const reason = [...item.signals.slice(0, 4), ...labels.map((x) => `标签:${x}`)]
      .slice(0, 5)
      .join('；');
    const evidence = item.evidenceMessage
      ? `“${shortText(item.evidenceMessage.text, 92)}”`
      : item.model;
    lines.push(
      `| ${index} | ${priorityFor(item, item.section)} | ${customerCell(
        item.contact,
      )} | ${md(item.contact.country || '未填写')}<br>${stageLabel(
        item.contact.customer_stage,
      )} | ${activity} | ${md(reason || '有持续业务沟通')} | ${md(
        item.model,
      )}<br>${md(evidence)} | ${md(nextAction(item, item.section))} | ${md(
        draftFor(item, item.section === 'stale'),
      )} |`,
    );
    index += 1;
  }
  lines.push('');
  return { lines, nextIndex: index };
}

const followLabelCount = analyzed.filter((item) =>
  item.labels.includes('跟进'),
).length;
const jiajiaLabelCount = analyzed.filter((item) =>
  item.labels.includes('佳佳在跟'),
).length;
const noHistoryCount = analyzed.filter((item) => item.messages.length === 0).length;
const syncedMessageCount = analyzed.reduce(
  (sum, item) => sum + item.messages.length,
  0,
);
const latestLabelSync = whatsappLabels
  .map((row) => row.synced_at)
  .filter(Boolean)
  .sort()
  .at(-1);

const report = [
  '# 佳佳 + daimenglong 有价值客户跟进清单',
  '',
  `生成时间：${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(now)}`,
  '',
  `范围：daimenglong 账号下 ${scopeContacts.length.toLocaleString(
    'en-US',
  )} 位 CRM 客户；WhatsApp 标签最近同步于 ${displayDate(latestLabelSync)}。`,
  '',
  `⚠ 联系天数按 CRM 已同步的 ${syncedMessageCount.toLocaleString(
    'en-US',
  )} 条聊天计算，不代表 WhatsApp 完整历史。${noHistoryCount.toLocaleString(
    'en-US',
  )} 位没有 CRM 聊天记录的人未进入价值判断。`,
  '',
  '## 结果摘要',
  '',
  `- WhatsApp “佳佳在跟”标签共 ${jiajiaLabelCount} 人，本次保留有具体业务证据的 ${jiajia.length} 人。`,
  `- WhatsApp “跟进”标签目前只关联 ${followLabelCount} 人，不能代表实际在跟名单；因此以最近 ${STALE_DAYS} 天内存在有效业务互动为准，排除与佳佳重复后保留 ${current.length} 人。`,
  `- 佳佳名单和最近互动名单之外，筛出至少 ${STALE_DAYS} 天未互动、但仍有具体金额/CIF/FOB、付款、明确购买、代理/批量或多轮购车需求证据的 ${stale.length} 人。`,
  `- 最终清单 ${jiajia.length + current.length + stale.length} 人，三组已去重。`,
  '',
  '## 今天怎么用',
  '',
  '1. 先处理所有“P0 客户待回复”，这是客户已经把球交过来的订单机会。',
  '2. 再处理付款节点和报价推进；每次必须给明确金额、库存、有效期或付款日期。',
  '3. 10 天以上客户只做一次带新信息的唤醒，不重新寒暄，不连续催问。',
  '4. 话术是可直接修改的草稿；发送前核对车型、目的港、价格和库存。',
  '',
];

let nextIndex = 1;
for (const section of [
  tableSection(
    `佳佳在跟：有价值客户（${jiajia.length}）`,
    '只保留有付款、报价、采购、代理/批量、明确购买需求或高价值人工标签证据的客户。',
    jiajia,
    nextIndex,
  ),
  tableSection(
    `daimenglong 最近正在跟：有价值客户（${current.length}）`,
    `最近 ${STALE_DAYS} 天内有有效业务互动，并排除了已经归入“佳佳在跟”的客户；不依赖当前仅有 1 人的“跟进”标签。`,
    current,
    nextIndex + jiajia.length,
  ),
  tableSection(
    `${STALE_DAYS} 天以上未互动：可重新激活的有价值客户（${stale.length}）`,
    `不在“佳佳在跟”中，也不属于最近 ${STALE_DAYS} 天有效互动；必须有真实聊天业务证据，按价值和沉默时间排序。`,
    stale,
    nextIndex + jiajia.length + current.length,
  ),
]) {
  report.push(...section.lines);
  nextIndex = section.nextIndex;
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${report.join('\n')}\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      outputPath,
      scopeContacts: scopeContacts.length,
      handlerContacts: handlerContactIds.size,
      syncedMessages: syncedMessageCount,
      noHistory: noHistoryCount,
      labels: {
        jiajia: jiajiaLabelCount,
        following: followLabelCount,
      },
      selected: {
        jiajia: jiajia.length,
        current: current.length,
        stale10: stale.length,
        total: jiajia.length + current.length + stale.length,
      },
    },
    null,
    2,
  ),
);
