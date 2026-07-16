import fs from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = dotenv.parse(
  await fs.readFile(path.join(__dirname, '..', '.env'), 'utf8'),
);

const runtimeArgs = globalThis.__analyzeWhatsAppLabelArgs ?? {
  target: globalThis.process?.argv?.[2],
  outputPath: globalThis.process?.argv?.[3],
};
const { target, outputPath } = runtimeArgs;
if (!target || !outputPath) {
  console.error(
    'Usage: node scripts/analyze-whatsapp-label.mjs <label|handler:user_id[:display_name]> <output.md>',
  );
  throw new Error('Missing target or output path');
}

function parseTarget(value) {
  const raw = String(value);
  if (!raw.startsWith('handler:')) {
    return { kind: 'label', value: raw, name: raw };
  }
  const [, userId, ...nameParts] = raw.split(':');
  if (!userId) throw new Error('Missing handler user_id');
  return {
    kind: 'handler',
    value: userId,
    name: nameParts.join(':') || userId,
  };
}

const targetSpec = parseTarget(target);
const targetName = targetSpec.name;

const orgId = env.ORG_ID;
const supabaseUrl = env.VITE_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!orgId || !supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing ORG_ID / VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PAGE_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

function chunksOf(items, size = 100) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchForContactIds(table, columns, contactIds) {
  const rows = [];
  for (const ids of chunksOf(contactIds)) {
    const chunkRows = await fetchAll((from, to) =>
      supabase
        .from(table)
        .select(columns)
        .in('contact_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    );
    rows.push(...chunkRows);
  }
  return rows;
}

async function fetchTagsForContactIds(contactIds) {
  const rows = [];
  for (const ids of chunksOf(contactIds)) {
    const chunkRows = await fetchAll((from, to) =>
      supabase
        .from('contact_tags')
        .select('contact_id, tag')
        .in('contact_id', ids)
        .order('contact_id', { ascending: true })
        .order('tag', { ascending: true })
        .range(from, to),
    );
    rows.push(...chunkRows);
  }
  return rows;
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

function timestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysSince(value) {
  const t = timestamp(value);
  if (!t) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

function shortText(value, max = 90) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '｜')
    .trim();
  if (!normalized) return '';
  return normalized.length > max
    ? `${normalized.slice(0, max - 1)}…`
    : normalized;
}

function md(value) {
  return String(value ?? '')
    .replace(/\|/g, '｜')
    .replace(/\r?\n/g, ' ')
    .trim();
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

function stageLabel(stage) {
  return (
    {
      new: '新客户',
      qualifying: '需求确认',
      negotiating: '洽谈中',
      stalled: '停滞',
      quoted: '已报价',
      won: '成交',
      lost: '流失',
    }[stage] ?? stage
  );
}

function qualityLabel(quality) {
  return (
    {
      big: '重点',
      potential: '潜力',
      normal: '普通',
      spam: '无效',
    }[quality] ?? quality
  );
}

function statusLabel(status) {
  return (
    {
      draft: '草稿',
      sent: '已发送',
      accepted: '已接受',
      rejected: '已拒绝',
    }[status] ?? status
  );
}

function usefulInterests(interests) {
  const seen = new Set();
  return interests.filter((interest) => {
    const model = String(interest.model ?? '').trim();
    if (!model || /^(unknown|null|unspecified|n\/a|none)$/i.test(model)) {
      return false;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isActionableInbound(message) {
  const text = String(message?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text === '.' || /^\[(已删除|图片|视频|文件|语音)\]$/.test(text)) {
    return false;
  }
  if (
    /^(hi|hello|good (morning|afternoon|evening)).*how are you/i.test(text) ||
    /thank.*(understanding|confirmation|kindness)|appreciate.*confirmation|wish you a happy/i.test(
      text,
    )
  ) {
    return false;
  }
  if (
    /[?？]|price|cost|quote|cif|fob|datasheet|specification|how |what |when |where |which |do you|can you|could you|need |want |interested|precio|cu[aá]nto|cotiz|ficha t[eé]cnica|costo|combustible|kilometraje|destination|port|付款|价格|报价|配置|参数/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /^(ok(ay)?|thanks?|thank you|appreciate|muy bueno|good|fine|understood|noted|gracias|perfecto|vale|收到|好的|谢谢)[\s.!👍🙏]*$/i.test(
      text,
    )
  ) {
    return false;
  }
  return text.length >= 24;
}

function missingFields(contact, interests) {
  const validInterests = usefulInterests(interests);
  const missing = [];
  if (!contact.country) missing.push('国家');
  if (!contact.language) missing.push('语言');
  if (!contact.budget_usd) missing.push('预算');
  if (!contact.destination_port) missing.push('目的港');
  if (validInterests.length === 0) missing.push('车型');
  return missing;
}

const LATIN_COUNTRIES = new Set([
  'Argentina',
  'Bolivia',
  'Chile',
  'Colombia',
  'Costa Rica',
  'Cuba',
  'Dominican Republic',
  'Ecuador',
  'El Salvador',
  'Guatemala',
  'Honduras',
  'Mexico',
  'Nicaragua',
  'Panama',
  'Paraguay',
  'Peru',
  'Puerto Rico',
  'Spain',
  'Uruguay',
  'Venezuela',
]);

const FRENCH_COUNTRIES = new Set([
  'Benin',
  'Cameroon',
  'Congo',
  "Côte d'Ivoire",
  'Djibouti',
  'Gabon',
  'Guinea',
  'Mali',
  'Senegal',
  'Togo',
]);

function conversationLanguage(contact, inbound) {
  const configured = String(contact.language ?? '').toLowerCase();
  const sample = inbound
    .slice(-4)
    .map((row) => row.text ?? '')
    .join(' ')
    .toLowerCase();
  if (
    configured.includes('span') ||
    LATIN_COUNTRIES.has(contact.country) ||
    /\b(precio|puerto|cotizaci[oó]n|quiero|necesito|gracias|veh[ií]culo)\b/i.test(
      sample,
    )
  ) {
    return 'es';
  }
  if (
    configured.includes('french') ||
    configured.includes('fran') ||
    FRENCH_COUNTRIES.has(contact.country) ||
    /\b(bonjour|prix|port|voiture|merci|acompte|banque)\b/i.test(sample)
  ) {
    return 'fr';
  }
  return 'en';
}

function detectTopic(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return 'none';
  if (
    /bank|deposit|payment|transfer|receipt|financ|installment|acompte|banque|virement|pago|banco|cuota/i.test(
      value,
    )
  ) {
    return 'payment';
  }
  if (
    /price|cost|quote|cif|fob|precio|cu[aá]nto|cotiz|costo|prix|combien|tarif/i.test(
      value,
    )
  ) {
    return 'price';
  }
  if (
    /datasheet|spec|configuration|ficha t[eé]cnica|configuraci[oó]n|fiche technique|caract[eé]ristique/i.test(
      value,
    )
  ) {
    return 'spec';
  }
  if (/photo|picture|video|imagen|foto|vid[eé]o/i.test(value)) return 'media';
  if (
    /shipping|ship|port|freight|delivery|transit|puerto|env[ií]o|embarque|livraison|exp[eé]dition/i.test(
      value,
    )
  ) {
    return 'shipping';
  }
  if (
    /year|model|mileage|kilometr|fuel|diesel|gasoline|electric|año|combustible|ann[eé]e|carburant|stock|available|disponible/i.test(
      value,
    )
  ) {
    return 'vehicle';
  }
  if (/compare|another supplier|other offer|competitor|compar|otro proveedor/i.test(value)) {
    return 'comparison';
  }
  return 'other';
}

function commercialSignalFor(item) {
  const inboundText = item.inbound.map((row) => row.text ?? '').join('\n');
  const outboundText = item.outbound.map((row) => row.text ?? '').join('\n');
  const allText = `${inboundText}\n${outboundText}`;
  const paymentReceived =
    /payment received|deposit received|received (the )?(payment|deposit)|order confirmed|receipt confirmed|付款已收到|收到(了)?定金|定金到账|paiement reçu|acompte reçu|reçu bancaire confirmé/i.test(
      allText,
    );
  const accepted =
    /please proceed|go ahead|next steps to complete the order|i('ll| will) take|confirm the order|ready to order|vamos a proceder|puede proceder|je confirme|nous allons proc[eé]der/i.test(
      inboundText,
    );
  const paymentPending =
    /bank|deposit|payment|transfer|receipt|acompte|banque|virement|banco|pago/i.test(
      inboundText,
    ) && !paymentReceived;
  const quotedInChat =
    /(?:usd|us\$|\$)\s*[\d,.]{4,}|(?:cif|fob)\s+[A-Za-zÀ-ÿ]|precio\s+(?:cif|fob)|prix\s+(?:cif|fob)/i.test(
      outboundText,
    );

  if (paymentReceived) {
    return { kind: 'payment_received', label: '聊天中有付款/订单确认信号' };
  }
  if (accepted && paymentPending) {
    return { kind: 'payment_pending', label: '客户接受方案，等待付款/定金' };
  }
  if (accepted) {
    return { kind: 'accepted', label: '客户表示继续，尚无到账证据' };
  }
  if (paymentPending) {
    return { kind: 'payment_pending', label: '付款或银行环节仍未闭环' };
  }
  if (quotedInChat) {
    return { kind: 'quoted_in_chat', label: '聊天中出现正式价格/CIF/FOB' };
  }
  return { kind: 'qualifying', label: '尚未形成可验证的报价或付款信号' };
}

function inferredModelFromMessages(messages) {
  const text = messages
    .map((row) => row.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ');
  const patterns = [
    [/\bBYD\s+Sealion\s*7(?:\s+EV)?/i, 'BYD Sealion 7 EV'],
    [/\bYangwang\s+U8\b/i, 'Yangwang U8'],
    [/\bChery\s+Rely\s+R08\b/i, 'Chery Rely R08'],
    [/\bJetour\s+T2\b/i, 'Jetour T2'],
    [/\bBYD\s+Qin\s+Plus\b/i, 'BYD Qin Plus'],
    [/\bBYD\s+Song\s+Plus\b/i, 'BYD Song Plus'],
    [/\bBYD\s+Seagull\b/i, 'BYD Seagull'],
    [/\bChangan\s+UNI-K\b/i, 'Changan UNI-K'],
    [/\bChangan\s+UNI-Z\b/i, 'Changan UNI-Z'],
    [/\bChangan\s+X5\s+Plus\b/i, 'Changan X5 Plus'],
    [/\b(?:GWM\s+)?Tank\s*700\b/i, 'GWM Tank 700'],
    [/\bHongqi\s+HS5\b/i, 'Hongqi HS5'],
    [/\bHonda\s+Fit\b/i, 'Honda Fit'],
  ];
  for (const [pattern, model] of patterns) {
    if (pattern.test(text)) return model;
  }
  return null;
}

function modelTextFor(item) {
  const models = usefulInterests(item.interests)
    .slice(0, 2)
    .map((row) => row.model);
  if (models.length > 0) return models.join(' / ');
  return inferredModelFromMessages(item.messages) ?? '意向车型';
}

function firstName(contact) {
  const value = String(
    contact.name || contact.wa_name || 'my friend',
  ).trim();
  return value.split(/\s+/)[0] || 'my friend';
}

function askField(missing, language) {
  const field = missing.find((value) =>
    ['车型', '目的港', '预算'].includes(value),
  );
  const labels = {
    en: { 车型: 'the exact model/year', 目的港: 'the destination port', 预算: 'your target budget' },
    es: { 车型: 'el modelo y año exactos', 目的港: 'el puerto de destino', 预算: 'su presupuesto objetivo' },
    fr: { 车型: "le modèle et l'année exacts", 目的港: 'le port de destination', 预算: 'votre budget cible' },
  };
  return labels[language][field] ?? {
    en: 'the purchase quantity',
    es: 'la cantidad que desea comprar',
    fr: 'la quantité souhaitée',
  }[language];
}

function draftFor(item, topic, modelText, missing) {
  const language = conversationLanguage(item.contact, item.inbound);
  const name = firstName(item.contact);
  const model = modelText === '意向车型' ? '[exact model]' : modelText;
  const port = item.contact.destination_port || '[destination port]';
  const ask = askField(missing, language);

  const templates = {
    en: {
      payment: `Hi ${name}, I understand the remaining point is the payment/bank process for ${model}. Please confirm the exact date the transfer can be made. Once it is sent, share the bank receipt here so I can verify it and reserve the vehicle immediately.`,
      price: `Hi ${name}, regarding ${model}, I will prepare the exact CIF/FOB breakdown instead of giving you a rough number. Please confirm ${ask}. I will send the vehicle price, shipping cost, total, stock status and quotation validity separately.`,
      spec: `Hi ${name}, I will answer your specification question with the exact data for ${model} and attach the correct specification sheet. I am checking the year, version, mileage/condition and fuel type now. After you review it, shall I prepare the price to ${port}?`,
      media: `Hi ${name}, I will send actual photos and video of the available ${model}, including exterior, interior, dashboard and vehicle identification details. After you check the real unit, shall I calculate the CIF price to ${port}?`,
      shipping: `Hi ${name}, for shipment of ${model} to ${port}, I will confirm the route, freight, estimated departure and transit time. Please confirm ${ask}, then I will send one complete CIF breakdown.`,
      vehicle: `Hi ${name}, I am checking the exact ${model} unit for your question. I will confirm the model year, version, condition/mileage, fuel type and current stock before quoting. Please also confirm ${ask}.`,
      comparison: `Hi ${name}, I understand you are comparing suppliers. I will make the comparison easy: exact ${model} version, CIF total to ${port}, delivery time, payment terms and what is included. Which point is most important for your decision: price, specification or delivery time?`,
      other: `Hi ${name}, regarding ${model}, I want to move this forward with one clear next step. Please confirm ${ask}; then I will send the matching vehicle option, exact price basis and availability.`,
    },
    es: {
      payment: `Hola ${name}, entiendo que el punto pendiente es el pago o el banco para ${model}. Confírmeme la fecha exacta en que puede hacer la transferencia. Cuando la realice, envíeme aquí el comprobante para verificarlo y reservar el vehículo.`,
      price: `Hola ${name}, sobre ${model}, voy a preparar el desglose exacto CIF/FOB, no un precio aproximado. Confírmeme ${ask}. Le enviaré por separado el precio del vehículo, flete, total, disponibilidad y vigencia de la cotización.`,
      spec: `Hola ${name}, voy a responder su consulta con los datos exactos de ${model} y la ficha técnica correcta. Confirmaré año, versión, kilometraje/estado y combustible. Después de revisarlo, ¿preparo también el precio para ${port}?`,
      media: `Hola ${name}, le enviaré fotos y video reales del ${model} disponible: exterior, interior, tablero e identificación del vehículo. Después de revisar la unidad real, ¿calculo el precio CIF para ${port}?`,
      shipping: `Hola ${name}, para enviar ${model} a ${port}, confirmaré ruta, flete, salida estimada y tiempo de tránsito. Confírmeme ${ask} y le enviaré un desglose CIF completo.`,
      vehicle: `Hola ${name}, estoy verificando la unidad exacta de ${model}. Confirmaré año, versión, estado/kilometraje, combustible y disponibilidad antes de cotizar. Confírmeme también ${ask}.`,
      comparison: `Hola ${name}, entiendo que está comparando proveedores. Le enviaré una comparación clara: versión exacta de ${model}, total CIF a ${port}, plazo de entrega, forma de pago y qué incluye. ¿Qué pesa más en su decisión: precio, configuración o entrega?`,
      other: `Hola ${name}, sobre ${model}, quiero avanzar con un paso concreto. Confírmeme ${ask}; después le enviaré la opción correcta, la base exacta del precio y la disponibilidad.`,
    },
    fr: {
      payment: `Bonjour ${name}, je comprends que le point restant concerne la banque ou le paiement pour ${model}. Confirmez-moi la date exacte du virement. Dès qu'il est effectué, envoyez le reçu ici pour vérification et réservation du véhicule.`,
      price: `Bonjour ${name}, pour ${model}, je vais préparer un détail CIF/FOB exact, pas un prix approximatif. Confirmez-moi ${ask}. Je vous enverrai séparément le prix du véhicule, le fret, le total, le stock et la validité de l'offre.`,
      spec: `Bonjour ${name}, je vais répondre avec les données exactes de ${model} et la bonne fiche technique. Je vérifie l'année, la version, le kilométrage/état et le carburant. Après vérification, dois-je aussi préparer le prix pour ${port} ?`,
      media: `Bonjour ${name}, je vais envoyer des photos et vidéos réelles du ${model} disponible : extérieur, intérieur, tableau de bord et identification. Après contrôle, dois-je calculer le prix CIF pour ${port} ?`,
      shipping: `Bonjour ${name}, pour expédier ${model} vers ${port}, je vais confirmer la route, le fret, le départ estimé et le délai. Confirmez-moi ${ask}, puis je vous enverrai un calcul CIF complet.`,
      vehicle: `Bonjour ${name}, je vérifie l'unité exacte de ${model}. Je confirmerai l'année, la version, l'état/kilométrage, le carburant et le stock avant le devis. Confirmez-moi aussi ${ask}.`,
      comparison: `Bonjour ${name}, je comprends que vous comparez plusieurs fournisseurs. Je vais clarifier : version exacte de ${model}, total CIF vers ${port}, délai, paiement et éléments inclus. Quel point décide votre choix : prix, configuration ou délai ?`,
      other: `Bonjour ${name}, concernant ${model}, je propose une prochaine étape claire. Confirmez-moi ${ask}; je vous enverrai ensuite l'option adaptée, la base de prix exacte et la disponibilité.`,
    },
  };
  return templates[language][topic] ?? templates[language].other;
}

function priorityFor(item) {
  const {
    contact,
    needsReply,
    customerLastSpoke,
    daysInactive,
    latestQuote,
    openTasks,
    overdueTasks,
    messages,
    commercialSignal,
  } = item;
  let score = 0;

  if (needsReply) score += daysInactive != null && daysInactive <= 3 ? 50 : 38;
  else if (customerLastSpoke) score += 18;
  if (contact.quality === 'big') score += 26;
  else if (contact.quality === 'potential') score += 16;
  else if (contact.quality === 'spam') score -= 60;

  if (contact.customer_stage === 'quoted') score += 26;
  else if (contact.customer_stage === 'negotiating') score += 21;
  else if (contact.customer_stage === 'qualifying') score += 12;
  else if (contact.customer_stage === 'stalled') score -= 3;
  else if (contact.customer_stage === 'won') score -= 18;
  else if (contact.customer_stage === 'lost') score -= 35;

  if (latestQuote?.status === 'sent') score += 16;
  else if (latestQuote?.status === 'accepted') score += 22;
  else if (latestQuote?.status === 'draft') score += 8;
  if (commercialSignal.kind === 'payment_received') score += 30;
  else if (commercialSignal.kind === 'payment_pending') score += 24;
  else if (commercialSignal.kind === 'accepted') score += 20;
  else if (commercialSignal.kind === 'quoted_in_chat') score += 10;

  if (Number(contact.budget_usd) > 0) score += 8;
  if (usefulInterests(item.interests).length > 0) score += 8;
  if (overdueTasks.length > 0) score += 14;
  else if (openTasks.length > 0) score += 6;
  if (messages.length === 0) score -= 6;
  if (daysInactive != null && daysInactive <= 3) score += 7;
  else if (daysInactive != null && daysInactive > 30) score -= 7;

  let priority;
  if (contact.quality === 'spam') {
    priority = 'P4 清理';
  } else if (needsReply) {
    priority = 'P0 立即回复';
  } else if (
    contact.customer_stage === 'lost' &&
    !customerLastSpoke &&
    (daysInactive == null || daysInactive >= 14)
  ) {
    priority = 'P4 清理';
  } else if (
    ['payment_received', 'payment_pending', 'accepted'].includes(
      commercialSignal.kind,
    ) ||
    score >= 38
  ) {
    priority = 'P1 重点推进';
  } else if (
    customerLastSpoke ||
    messages.length === 0 ||
    (daysInactive != null && daysInactive >= 3)
  ) {
    priority = 'P2 今日跟进';
  } else if (contact.customer_stage === 'won') {
    priority = 'P3 成交维护';
  } else {
    priority = 'P3 持续培育';
  }
  return { score, priority };
}

function recommendationFor(item) {
  const {
    contact,
    interests,
    messages,
    lastInbound,
    lastOutbound,
    needsReply,
    customerLastSpoke,
    daysInactive,
    latestQuote,
    openTasks,
    overdueTasks,
    commercialSignal,
  } = item;
  const modelText = modelTextFor(item);
  const missing = missingFields(contact, interests);
  const inboundExcerpt = shortText(lastInbound?.text, 80);
  const outboundExcerpt = shortText(lastOutbound?.text, 60);
  const task = overdueTasks[0] ?? openTasks[0];
  const topic = detectTopic(
    customerLastSpoke ? lastInbound?.text : lastOutbound?.text,
  );
  const mismatch =
    contact.customer_stage === 'won' &&
    commercialSignal.kind !== 'payment_received'
      ? 'CRM 标成成交，但已同步聊天里没有定金/付款到账证据。'
      : '';
  const evidence = customerLastSpoke
    ? `客户最后说：“${inboundExcerpt || '媒体/简短回应'}”。`
    : lastOutbound
      ? `销售最后发出：“${outboundExcerpt || '媒体/文档'}”。`
      : 'CRM 没有可用聊天记录。';
  const missingText =
    missing.length > 0 ? `缺少 ${missing.slice(0, 3).join('、')}。` : '';
  const diagnosis = `${commercialSignal.label}。${mismatch}${evidence}${missingText}`;

  let action;
  if (contact.quality === 'spam') {
    action = '核实是否为真实询盘；没有车型、预算或进口计划就移出名单，不再占用跟进时间。';
  } else if (messages.length === 0) {
    action = '先打开 WhatsApp 核对并补同步历史；数据补齐前不要把此客户计入报价、成交或流失统计。';
  } else if (
    contact.customer_stage === 'won' &&
    commercialSignal.kind !== 'payment_received'
  ) {
    action =
      '先向财务或聊天附件核对定金回单、PI 和订单号。没有到账证据就把阶段改回“洽谈/已报价”，再按付款节点跟进。';
  } else if (commercialSignal.kind === 'payment_pending') {
    action =
      '确认 PI 是否仍有效、银行具体卡点和承诺付款日期；要求付款后只回传银行回单。逾期 48 小时仍无回单则降为停滞。';
  } else if (commercialSignal.kind === 'accepted') {
    action =
      '今天补齐 PI、配置、CIF 包含项和付款节点，给客户一个明确的定金截止时间；“口头同意”不能计为成交。';
  } else if (overdueTasks.length > 0) {
    action = `先完成逾期任务“${shortText(
      task.title,
      45,
    )}”，并把结果、下一节点和截止日期写回 CRM。`;
  } else if (topic === 'price') {
    action = contact.destination_port
      ? `按 ${modelText} 到 ${contact.destination_port} 做正式 CIF/FOB 拆分：车价、海运、总价、库存、有效期；一次发完整。`
      : `先锁定车型/年款、数量和目的港，再做正式 CIF/FOB 报价；不要继续只发裸车价。`;
  } else if (topic === 'spec') {
    action =
      '查清客户问到的具体参数，附正确版本配置表；正文直接列出年款、版本、里程/车况、燃料和库存，再问是否报价。';
  } else if (topic === 'media') {
    action =
      '发送对应现车的实拍外观、内饰、仪表、铭牌/VIN 和短视频，说明是否为同一台车；随后用“是否按此车报价”收口。';
  } else if (topic === 'shipping') {
    action =
      '核对目的港、船期、海运费和预计航程，明确 CIF 包含/不包含项目；把运输信息和车价放在同一份报价里。';
  } else if (topic === 'vehicle') {
    action =
      '先从车源或供应商确认准确年款、版本、里程/车况、燃料和库存，不凭印象回复；确认后再推进报价。';
  } else if (topic === 'comparison') {
    action =
      '做一张只含关键差异的对比：准确版本、CIF 总价、交期、付款条款和售后文件；追问客户最终决策权重。';
  } else if (contact.customer_stage === 'lost' || (daysInactive ?? 0) >= 14) {
    action =
      `只做最后一次有证据的唤醒：提供一个真实库存/价格/船期变化，并给两个选项。72 小时无回复就移出“${targetName}”。`;
  } else if (customerLastSpoke) {
    action =
      '不要重新寒暄；承接客户最后一句，补一个具体信息，然后只问一个能推进到报价的问题。';
  } else {
    action = `销售已发消息，先等到第 ${Math.max(
      3,
      (daysInactive ?? 0) + 2,
    )} 天；再次联系时必须带库存、价格或交期中的一项新信息。`;
  }

  const draft =
    messages.length === 0 || contact.quality === 'spam'
      ? '先补齐记录，不建议现在生成发送话术。'
      : draftFor(
          item,
          contact.customer_stage === 'won' &&
            commercialSignal.kind !== 'payment_received'
            ? 'payment'
            : topic,
          modelText,
          missing,
        );
  return `**判断：**${diagnosis}<br>**动作：**${action}<br>**建议话术：**${draft}`;
}

async function resolveTargetContacts() {
  if (targetSpec.kind === 'label') {
    const { data: labelRows, error: labelError } = await supabase
      .from('whatsapp_labels')
      .select('id, name, synced_at')
      .eq('org_id', orgId)
      .eq('name', targetSpec.value)
      .eq('is_active', true);
    if (labelError) throw labelError;
    if (!labelRows?.length) {
      throw new Error(`Active WhatsApp label not found: ${targetSpec.value}`);
    }

    const labelIds = labelRows.map((row) => row.id);
    const associations = await fetchAll((from, to) =>
      supabase
        .from('contact_whatsapp_labels')
        .select('id, contact_id, whatsapp_label_id')
        .in('whatsapp_label_id', labelIds)
        .order('id', { ascending: true })
        .range(from, to),
    );

    return {
      contactIds: [...new Set(associations.map((row) => row.contact_id))],
      freshness: labelRows
        .map((row) => row.synced_at)
        .sort()
        .at(-1),
      scopeText: `CRM 中已关联 WhatsApp 标签“${targetName}”`,
    };
  }

  const handlerRows = await fetchAll((from, to) =>
    supabase
      .from('contact_handlers')
      .select('contact_id, user_id, last_seen_at, contacts!inner(org_id)')
      .eq('contacts.org_id', orgId)
      .eq('user_id', targetSpec.value)
      .order('last_seen_at', { ascending: false })
      .range(from, to),
  );

  return {
    contactIds: [...new Set(handlerRows.map((row) => row.contact_id))],
    freshness: handlerRows
      .map((row) => row.last_seen_at)
      .sort()
      .at(-1),
    scopeText: `CRM 中主理人是“${targetName}”`,
  };
}

const targetContacts = await resolveTargetContacts();
const contactIds = targetContacts.contactIds;

const contacts = [];
for (const ids of chunksOf(contactIds)) {
  const { data, error } = await supabase
    .from('contacts')
    .select(
      'id, phone, wa_name, name, country, language, budget_usd, customer_stage, quality, destination_port, notes, created_at, updated_at',
    )
    .in('id', ids);
  if (error) throw error;
  contacts.push(...(data ?? []));
}

const messages = await fetchForContactIds(
  'messages',
  'id, contact_id, direction, text, sent_at, ai_source',
  contactIds,
);
const interests = await fetchForContactIds(
  'vehicle_interests',
  'id, contact_id, model, year, condition, steering, target_price_usd, notes',
  contactIds,
);
const quotes = await fetchForContactIds(
  'quotes',
  'id, contact_id, vehicle_model, price_usd, sent_at, status, notes, created_at',
  contactIds,
);
const tasks = await fetchForContactIds(
  'tasks',
  'id, contact_id, title, due_at, status, created_at',
  contactIds,
);
const tags = await fetchTagsForContactIds(contactIds);

const messagesByContact = groupByContact(messages);
const interestsByContact = groupByContact(interests);
const quotesByContact = groupByContact(quotes);
const tasksByContact = groupByContact(tasks);
const tagsByContact = groupByContact(tags);

const analyzed = contacts.map((contact) => {
  const contactMessages = (messagesByContact.get(contact.id) ?? []).sort(
    (a, b) => timestamp(a.sent_at) - timestamp(b.sent_at),
  );
  const inbound = contactMessages.filter((row) => row.direction === 'inbound');
  const outbound = contactMessages.filter((row) => row.direction === 'outbound');
  const lastInbound = inbound.at(-1) ?? null;
  const lastOutbound = outbound.at(-1) ?? null;
  const lastMessage = contactMessages.at(-1) ?? null;
  const needsReply =
    lastInbound != null &&
    timestamp(lastInbound.sent_at) > timestamp(lastOutbound?.sent_at);
  const customerLastSpoke = needsReply;
  const actionableReply = customerLastSpoke && isActionableInbound(lastInbound);
  const contactInterests = interestsByContact.get(contact.id) ?? [];
  const contactQuotes = (quotesByContact.get(contact.id) ?? []).sort(
    (a, b) =>
      timestamp(a.sent_at ?? a.created_at) -
      timestamp(b.sent_at ?? b.created_at),
  );
  const contactTasks = tasksByContact.get(contact.id) ?? [];
  const openTasks = contactTasks.filter((row) => row.status === 'open');
  const overdueTasks = openTasks.filter(
    (row) => row.due_at && timestamp(row.due_at) < now.getTime(),
  );
  const baseItem = {
    contact,
    messages: contactMessages,
    inbound,
    outbound,
    lastInbound,
    lastOutbound,
    lastMessage,
    needsReply: actionableReply,
    customerLastSpoke,
    daysInactive: daysSince(lastMessage?.sent_at),
    interests: contactInterests,
    quotes: contactQuotes,
    latestQuote: contactQuotes.at(-1) ?? null,
    tasks: contactTasks,
    openTasks,
    overdueTasks,
    tags: (tagsByContact.get(contact.id) ?? []).map((row) => row.tag),
  };
  const item = {
    ...baseItem,
    commercialSignal: commercialSignalFor(baseItem),
  };
  return {
    ...item,
    ...priorityFor(item),
    recommendation: recommendationFor(item),
  };
});

const priorityOrder = new Map([
  ['P0 立即回复', 0],
  ['P1 重点推进', 1],
  ['P2 今日跟进', 2],
  ['P3 持续培育', 3],
  ['P3 成交维护', 4],
  ['P4 清理', 5],
]);
analyzed.sort(
  (a, b) =>
    (priorityOrder.get(a.priority) ?? 99) -
      (priorityOrder.get(b.priority) ?? 99) ||
    b.score - a.score ||
    (a.daysInactive ?? 9999) - (b.daysInactive ?? 9999),
);

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const priorities = countBy(analyzed, (row) => row.priority);
const stages = countBy(analyzed, (row) => stageLabel(row.contact.customer_stage));
const qualities = countBy(analyzed, (row) => qualityLabel(row.contact.quality));
const countries = countBy(analyzed, (row) => row.contact.country || '未填写');
const needsReplyCount = analyzed.filter((row) => row.needsReply).length;
const customerLastSpokeCount = analyzed.filter(
  (row) => row.customerLastSpoke,
).length;
const noHistoryCount = analyzed.filter((row) => row.messages.length === 0).length;
const stale14Count = analyzed.filter(
  (row) => row.daysInactive != null && row.daysInactive >= 14,
).length;
const openTaskCount = analyzed.reduce((sum, row) => sum + row.openTasks.length, 0);
const overdueTaskCount = analyzed.reduce(
  (sum, row) => sum + row.overdueTasks.length,
  0,
);
const quoteTableCount = analyzed.filter((row) => row.quotes.length > 0).length;
const vehicleKnownCount = analyzed.filter(
  (row) => usefulInterests(row.interests).length > 0,
).length;
const budgetKnownCount = analyzed.filter(
  (row) => Number(row.contact.budget_usd) > 0,
).length;
const freshnessAt = targetContacts.freshness;
const messageCounts = analyzed
  .map((row) => row.messages.length)
  .sort((a, b) => a - b);
const medianMessageCount =
  messageCounts[Math.floor(messageCounts.length / 2)] ?? 0;
const signalCounts = countBy(analyzed, (row) => row.commercialSignal.kind);
const signalCountMap = new Map(signalCounts);
const crmWon = analyzed.filter(
  (row) => row.contact.customer_stage === 'won',
);
const crmQuoted = analyzed.filter(
  (row) => row.contact.customer_stage === 'quoted',
);
const wonWithoutEvidence = crmWon.filter(
  (row) => row.commercialSignal.kind !== 'payment_received',
);

const lines = [
  `# “${targetName}”客户分析与逐客跟进建议`,
  '',
  `生成时间：${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(now)}`,
  '',
  `数据范围：${targetContacts.scopeText}的 ${analyzed.length} 位客户。最近主理/标签同步时间：${displayDate(
    freshnessAt,
  )}。`,
  '',
  `⚠ 数据完整性：本报告读取的是 Supabase 中已同步的 ${messages.length.toLocaleString(
    'en-US',
  )} 条消息，不是 WhatsApp 完整历史；每位客户消息中位数仅 ${medianMessageCount} 条。没有聊天证据时，报告只给核查动作，不判定成交。`,
  '',
  '## 管理结论',
  '',
  `- **客户最后发言：${customerLastSpokeCount} 人**，其中 **${needsReplyCount} 人有明确问题或需求**，应排在泛跟进之前；其余多为确认、感谢或简短回应。`,
  `- **14 天以上无互动：${stale14Count} 人**；**没有 CRM 聊天历史：${noHistoryCount} 人**。这两类要分别做“价值唤醒”和“补同步/核实”，不能混成普通催单。`,
  `- CRM 阶段写着 **已报价 ${crmQuoted.length} 人、成交 ${crmWon.length} 人**，但 quotes 表只有 **${quoteTableCount} 人**有记录；聊天文本识别到 **${signalCountMap.get('quoted_in_chat') ?? 0} 人出现正式价格/CIF/FOB**、**${(signalCountMap.get('accepted') ?? 0) + (signalCountMap.get('payment_pending') ?? 0)} 人接受方案或进入付款环节**。`,
  `- CRM 标成成交的 ${crmWon.length} 人中，**${wonWithoutEvidence.length} 人在已同步聊天里没有到账确认**：${wonWithoutEvidence
    .map((row) => row.contact.name || row.contact.wa_name || row.contact.phone)
    .join('、')}。必须先查财务回单再定状态。`,
  `- **已有车型信息：${vehicleKnownCount} 人**；**已有预算：${budgetKnownCount} 人**。资料完整度仍不足，不能把“聊过价格”直接算成有效报价。`,
  `- **开放任务：${openTaskCount} 条，其中逾期 ${overdueTaskCount} 条**。逾期任务已被提到对应客户的建议中。`,
  '',
  '### 今日行动分层',
  '',
  '| 层级 | 人数 | 动作 |',
  '|---|---:|---|',
  ...priorities.map(([priority, count]) => {
    const action =
      {
        'P0 立即回复': '先处理客户最后发来的问题',
        'P1 重点推进': '报价、付款或高价值需求向下一节点推进',
        'P2 今日跟进': '今天完成一次有新信息的有效触达',
        'P3 持续培育': '控制频率，按计划补充库存/价格信息',
        'P3 成交维护': '付款、单证、物流和复购维护',
        'P4 清理': '低成本唤醒后移出无效名单',
      }[priority] ?? '';
    return `| ${priority} | ${count} | ${action} |`;
  }),
  '',
  '### 客户结构',
  '',
  `- 阶段：${stages.map(([name, count]) => `${name} ${count}`).join('；')}`,
  `- 质量：${qualities.map(([name, count]) => `${name} ${count}`).join('；')}`,
  `- 主要国家：${countries
    .slice(0, 10)
    .map(([name, count]) => `${name} ${count}`)
    .join('；')}`,
  '',
  '## 每个客户的跟进建议',
  '',
  '说明：最近消息时间和天数以 CRM 已同步消息为准；“明确待回复”表示客户最后发言包含问题或具体需求，“客户最后发言”表示需要接续推进但不一定紧急。',
  '',
];

let currentPriority = '';
let rowNumber = 0;
for (const row of analyzed) {
  if (row.priority !== currentPriority) {
    currentPriority = row.priority;
    lines.push(`### ${currentPriority}`, '');
    lines.push(
      '| # | 客户 | 国家 | CRM 阶段 | 最近互动 | 需求 | 聊天业务信号 | 诊断、动作与建议话术 |',
      '|---:|---|---|---|---|---|---|---|',
    );
  }
  rowNumber += 1;
  const contact = row.contact;
  const name = contact.name || contact.wa_name || contact.phone || '未命名';
  const phoneDigits = String(contact.phone ?? '').replace(/\D/g, '');
  const customerCell = phoneDigits
    ? `[${md(name)}](https://wa.me/${phoneDigits})<br>${md(contact.phone)}`
    : md(name);
  const activity = row.lastMessage
    ? `${displayDate(row.lastMessage.sent_at)}<br>${
        row.needsReply
          ? '**明确待回复**'
          : row.customerLastSpoke
            ? '客户最后发言'
            : `距今 ${row.daysInactive ?? 0} 天`
      }`
    : '无聊天历史';
  const inferredModels = modelTextFor(row);
  const models = inferredModels === '意向车型' ? '' : inferredModels;
  const quote = row.latestQuote
    ? `${row.latestQuote.vehicle_model} $${Number(
        row.latestQuote.price_usd,
      ).toLocaleString('en-US')}（${statusLabel(row.latestQuote.status)}）`
    : '';
  const demand = [models, quote].filter(Boolean).join('<br>') || '车型/报价未记录';
  lines.push(
    `| ${rowNumber} | ${customerCell} | ${md(contact.country || '未填写')} | ${stageLabel(
      contact.customer_stage,
    )}<br>${qualityLabel(contact.quality)} | ${activity} | ${md(
      demand,
    )} | ${md(row.commercialSignal.label)} | ${md(row.recommendation)} |`,
  );
}

lines.push(
  '',
  '## 执行建议',
  '',
  '1. 先完成 P0，再做 P1；不要先群发沉默客户，导致真正等回复的人继续等待。',
  '2. P2 跟进必须带一条新信息，例如现车、价格变化、交期、配置差异或运输方案。',
  `3. P4 客户只做一次低成本唤醒；无回应就移出“${targetName}”，让名单保持真实。`,
  '4. 每次有效沟通后补齐预算、车型和目的港，后续建议才会越来越准确。',
  '',
);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      outputPath,
      total: analyzed.length,
      needsReply: needsReplyCount,
      customerLastSpoke: customerLastSpokeCount,
      stale14: stale14Count,
      noHistory: noHistoryCount,
      priorities: Object.fromEntries(priorities),
      stages: Object.fromEntries(stages),
      qualities: Object.fromEntries(qualities),
      topCountries: Object.fromEntries(countries.slice(0, 10)),
    },
    null,
    2,
  ),
);
