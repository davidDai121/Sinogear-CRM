interface AliasRule {
  match: RegExp;
  canonical: string;
}

// Step 1: noise patterns — aggressively stripped before matching
const NOISE_PATTERNS: RegExp[] = [
  /\b20\d{2}\s*年?\s*款?\b/gi,
  /\b\d+\s*km\b/gi,
  /\b\d+(\.\d+)?\s*[lt]d?\b/gi,
  /\b\d+(\.\d+)?\s*升\b/g,
  /\b[24]\s*wd\b/gi,
  /\bxwd\b/gi,
  /\bawd\b/gi,
  /\b4x4\b/gi,
  /\bhi4[- ]?[atz]\b/gi,
  /\b(dm[- ]?i|dmi|dm[- ]?p|dmp|phev|hev|hybrid|ev|bev|mhev)\b/gi,
  /\b(混动|插混|插电|纯电|电动)\b/g,
  /\bhibrido\b|\bhíbrido\b/gi,
  /\b(luxury|premium|pioneer|standard|basic|entry|top|high|elite|regular|royal|champion|冠军)\s*(version|edition|spec|trim|level|model)?\b/gi,
  /\b(version|edition|spec|trim|level|trim\s*level|model)\b/gi,
  /\b(sedan|suv|crossover|hatchback|wagon|coupé|coupe|roadster|bus|pickup)\b/gi,
  /\b(lengthened|long\s*wheelbase|extended)\b/gi,
  /\b\d+\s*(plazas|seats|seater|座)\b/gi,
  /\b(manual|automatic|auto|mt|at(?!\w))\b/gi,
  /\b(faw|gac|saic|dongfeng|chana|fang\s*cheng\s*bao|方程豹)\b/gi,
  /\b(rongfang|荣放)\b/gi,
  /\bwhite\s+interior\s+black\b/gi,
  /\bblack\s+interior\b/gi,
  /\bwhite\s+interior\b/gi,
  /\bflying\s+edition\b/gi,
  /\bsmart\s+driving\b/gi,
  /\bvitality\s+edition\b/gi,
  /\bintelligent\s+driving\b/gi,
  /\bnew\s+energy\b/gi,
  /\bmountain\s+edition\b/gi,
  /\bdiscover\s+edition\b/gi,
  /\bconqueror\s*\+?\b/gi,
  /\bexplore\s*\+?\s*edition\b/gi,
  /\bexplorer\s*edition\b/gi,
  /\bjmk\b/gi,
  /\bstar\s*(guardian|defender|stargazer)\b/gi,
  /\bstargazer\b/gi,
  /\btraveller\b|\btraveler\b/gi,
  /\bultra\b/gi,
];

function prenormalize(model: string): string {
  let s = model.trim();
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');
  return s
    .replace(/[_]/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Step 2: rules map to single canonical base model per (brand × line)
const RULES: AliasRule[] = [
  // ─────── BYD ───────
  { match: /\b(byd\s*)?qin\s*plus\b|\b秦\s*plus\b/i, canonical: 'BYD Qin Plus' },
  { match: /\b(byd\s*)?qin\b(?!\s*plus)/i, canonical: 'BYD Qin' },
  { match: /\b(byd\s*)?song\s*plus\b|\b宋\s*plus\b/i, canonical: 'BYD Song Plus' },
  { match: /\b(byd\s*)?song\s*pro\b/i, canonical: 'BYD Song Pro' },
  { match: /\b(byd\s*)?song\s*l\b/i, canonical: 'BYD Song L' },
  { match: /\byuan\s*plus\b|\batto\s*3\b|\b元\s*plus\b/i, canonical: 'BYD Atto 3 (Yuan Plus)' },
  { match: /\byuan\s*up\b|\b元\s*up\b/i, canonical: 'BYD Yuan Up' },
  { match: /\bseagull\b|\b海鸥\b|\bdolphin\s*surf\b/i, canonical: 'BYD Seagull' },
  { match: /\b(byd\s*)?dolphin\b/i, canonical: 'BYD Dolphin' },
  { match: /\b(byd\s*)?tang\s*l\b/i, canonical: 'BYD Tang' }, // Tang L merged into Tang
  { match: /\b(byd\s*)?tang\b/i, canonical: 'BYD Tang' },
  { match: /\bdenza\b|\b腾势\b/i, canonical: 'Denza' }, // own brand
  { match: /\b(byd\s*)?seal\s*0?6\b|\bseal\s*6\b/i, canonical: 'BYD Seal' }, // Seal 06 merged
  { match: /\b(byd\s*)?seal\s*u\b/i, canonical: 'BYD Seal' }, // Seal U merged
  { match: /\b(byd\s*)?seal\b/i, canonical: 'BYD Seal' },
  { match: /\b(byd\s*)?han\b/i, canonical: 'BYD Han' },
  { match: /\bleopard\s*5\b|\b豹\s*5\b|\bbao\s*5\b/i, canonical: 'BYD Leopard 5' },
  { match: /\bleopard\s*8\b|\b豹\s*8\b|\bbao\s*8\b/i, canonical: 'BYD Leopard 8' },
  { match: /\bleopard\b/i, canonical: 'BYD Leopard' },
  { match: /\b(byd\s*)?shark\b/i, canonical: 'BYD Shark' },
  { match: /\b(byd\s*)?f0\b/i, canonical: 'BYD F0' },
  { match: /\bbz3x\b|\bb3x\b/i, canonical: 'BYD BZ3X' },
  { match: /\bbz3\b/i, canonical: 'BYD BZ3' },
  { match: /\bbz4x\b/i, canonical: 'BYD BZ4X' },

  // ─────── Toyota ───────
  { match: /\bcorolla\s*cross\b|\btoyota\s*cross\b/i, canonical: 'Toyota Corolla Cross' },
  { match: /\b(toyota\s*)?corolla\b(?!\s*cross)|\b卡罗拉\b/i, canonical: 'Toyota Corolla' },
  { match: /\b(toyota\s*)?rav\s*4\b/i, canonical: 'Toyota RAV4' },
  { match: /\bland\s*cruiser\s*prado\b|\blandcruiser\s*prado\b|\b(toyota\s*)?prado\b|\b普拉多\b/i, canonical: 'Toyota Prado' },
  { match: /\bland\s*cruiser\b|\blandcruiser\b|\blc\s*\d{2,3}\b|\blc\s*j\d+\b|\b兰德酷路泽\b|\b陆巡\b/i, canonical: 'Toyota Land Cruiser' },
  { match: /\b(toyota\s*)?4\s*runner\b/i, canonical: 'Toyota 4Runner' },
  { match: /\b(toyota\s*)?crown\s*kluger\b|\b皇冠陆放\b/i, canonical: 'Toyota Crown Kluger' },
  { match: /\b(toyota\s*)?highlander\b/i, canonical: 'Toyota Highlander' },
  { match: /\b(toyota\s*)?yaris\s*cross\b/i, canonical: 'Toyota Yaris Cross' },
  { match: /\b(toyota\s*)?yaris\b/i, canonical: 'Toyota Yaris' },
  { match: /\b(toyota\s*)?hiace\b/i, canonical: 'Toyota Hiace' },
  { match: /\b(toyota\s*)?sienna\b/i, canonical: 'Toyota Sienna' },
  { match: /\b(toyota\s*)?hilux\b|\b海拉克斯\b/i, canonical: 'Toyota Hilux' },
  { match: /\b(toyota\s*)?fortuner\b/i, canonical: 'Toyota Fortuner' },
  { match: /\b(toyota\s*)?camry\b|\b凯美瑞\b/i, canonical: 'Toyota Camry' },
  { match: /\b(toyota\s*)?bz4x\b/i, canonical: 'Toyota bZ4X' },

  // ─────── Honda ───────
  { match: /\b(honda\s*)?cr[- ]?v\b/i, canonical: 'Honda CR-V' },
  { match: /\b(honda\s*)?civic\b|\b思域\b/i, canonical: 'Honda Civic' },
  { match: /\b(honda\s*)?accord\b|\b雅阁\b/i, canonical: 'Honda Accord' },
  { match: /\b(honda\s*)?e:?np2\b|\be-np2\b/i, canonical: 'Honda e:NP2' },
  { match: /\b(honda\s*)?hr[- ]?v\b/i, canonical: 'Honda HR-V' },

  // ─────── GWM / Tank / Haval ───────
  { match: /\b(gwm\s*)?tank\s*300\b|\b坦克\s*300\b/i, canonical: 'GWM Tank 300' },
  { match: /\b(gwm\s*)?tank\s*500\b|\b坦克\s*500\b/i, canonical: 'GWM Tank 500' },
  { match: /\b(gwm\s*)?tank\s*700\b|\b坦克\s*700\b/i, canonical: 'GWM Tank 700' },
  { match: /\b(haval\s*)?h6\b|\b哈弗\s*h6\b/i, canonical: 'Haval H6' },
  { match: /\b(haval\s*)?jolion\b/i, canonical: 'Haval Jolion' },
  { match: /\b(gwm\s*)?poer\b|\bpao\s*pickup\b/i, canonical: 'GWM Poer' },

  // ─────── Jetour 捷途 ───────
  { match: /\bjetour.*g700\b/i, canonical: 'Jetour G700' },
  { match: /\bjetour.*dashing\b/i, canonical: 'Jetour Dashing' },
  { match: /\bjetour.*t1\b/i, canonical: 'Jetour T1' },
  { match: /\bjetour.*x70\s*plus\b/i, canonical: 'Jetour X70 Plus' },
  { match: /\bjetour.*x\d+\b/i, canonical: 'Jetour X' },
  { match: /\bjetour.*t2\b|\bt2\s*traveller\b/i, canonical: 'Jetour T2' },
  { match: /^jetour$/i, canonical: 'Jetour' },

  // ─────── Chery / Rely 奇瑞 ───────
  { match: /\b(chery.*)?rely\s*r0?8\b|\bthis[_\s]*rely\b|\b(chery\s*)?r0?8\b|\bchery.*rely\b|\brely\b/i, canonical: 'Chery Rely R08' },
  { match: /\bchery.*tiggo\s*8\s*pro\b/i, canonical: 'Chery Tiggo 8 Pro' },
  { match: /\bchery.*tiggo\s*\d+\b/i, canonical: 'Chery Tiggo' },
  { match: /\bchery.*cs55\s*plus\b/i, canonical: 'Chery CS55 Plus' },
  { match: /\bchery.*hunter\b/i, canonical: 'Chery Hunter' },
  { match: /\bchery.*icar\s*0?3\b|\bicar\s*0?3\b/i, canonical: 'iCar 03' },

  // ─────── Li Auto 理想 ───────
  { match: /\bli\s*auto\s*l\s*(\d)\b/i, canonical: 'Li Auto L$1' },
  { match: /\b理想\s*l(\d)\b/i, canonical: 'Li Auto L$1' },

  // ─────── Geely 吉利 ───────
  { match: /\bgeely.*boyue\b|\b博越\b/i, canonical: 'Geely Boyue' },
  { match: /\bgeely.*radar.*rd\s*6\b|\bradar.*rd\s*6\b|\bradar\s*ev\b|\bradar\b/i, canonical: 'Geely Radar RD6' },
  { match: /\bgeely.*radar.*em[- ]?p\b/i, canonical: 'Geely Radar EM-P' },
  { match: /\bgeely.*monjaro\b/i, canonical: 'Geely Monjaro' },

  // ─────── Changan 长安 ───────
  // UNI 系列是 Changan 独有品牌，市面上没有同名其他车，可省 "changan/长安" 前缀
  // —— 实际客户写法多样："长安unik" / "长安 UNI-K" / "UNIK" / "Changan UNI K" 各种
  { match: /(?:changan|长安)?\s*uni[-_ ]?k\b/i, canonical: 'Changan UNI-K' },
  { match: /(?:changan|长安)?\s*uni[-_ ]?t\b/i, canonical: 'Changan UNI-T' },
  { match: /(?:changan|长安)?\s*uni[-_ ]?v\b/i, canonical: 'Changan UNI-V' },
  { match: /(?:changan|长安)?\s*uni[-_ ]?s\b/i, canonical: 'Changan UNI-S' },
  // CS 系列 / 其他车型：因为 Chery 也有 CS55 Plus / Hunter（见上方 Chery 段），
  // 这些必须带 changan/长安 前缀来锚定品牌，避免误归 Chery
  { match: /(?:changan|长安).*cs75\s*plus\b/i, canonical: 'Changan CS75 Plus' },
  { match: /(?:changan|长安).*cs75\b/i, canonical: 'Changan CS75' },
  { match: /(?:changan|长安).*cs55\s*plus\b/i, canonical: 'Changan CS55 Plus' },
  { match: /(?:changan|长安).*cs55\b/i, canonical: 'Changan CS55' },
  { match: /\bchangan.*cs35\s*plus\b/i, canonical: 'Changan CS35 Plus' },
  { match: /(?:changan|长安).*cs35\b/i, canonical: 'Changan CS35' },
  { match: /(?:changan|长安).*hunter\b/i, canonical: 'Changan Hunter' },
  { match: /(?:changan|长安).*eado\b/i, canonical: 'Changan Eado' },
  { match: /(?:changan|长安).*alsvin\b/i, canonical: 'Changan Alsvin' },
  { match: /(?:changan|长安).*lumin\b/i, canonical: 'Changan Lumin' },
  { match: /(?:changan|长安).*raeton\b/i, canonical: 'Changan Raeton' },
  { match: /\bchangan.*qiyuan\s*a05\b/i, canonical: 'Changan Qiyuan A05' },
  { match: /(?:changan|长安).*qiyuan\s*a07\b/i, canonical: 'Changan Qiyuan A07' },
  { match: /(?:changan|长安).*qiyuan\s*q05\b/i, canonical: 'Changan Qiyuan Q05' },

  // ─────── BAIC / Isuzu / Deepal / Avatr / Zeekr / Ford / Suzuki / Nammi / Mitsubishi ───────
  { match: /\bbaic.*bj40\b|\bbj40\b/i, canonical: 'BAIC BJ40' },
  { match: /\bisuzu.*d[- ]?max\b/i, canonical: 'Isuzu D-Max' },
  { match: /\bdeepal.*g318\b|\bg318\b/i, canonical: 'Deepal G318' },
  { match: /\bavatr.*12\b/i, canonical: 'Avatr 12' },
  { match: /\bzeekr.*x9\b/i, canonical: 'Zeekr X9' },
  { match: /\bford.*ranger\b/i, canonical: 'Ford Ranger' },
  { match: /\bford.*explorer\b/i, canonical: 'Ford Explorer' },
  { match: /\bford.*f[- ]?150\b/i, canonical: 'Ford F-150' },
  { match: /\bsuzuki.*jimny\b/i, canonical: 'Suzuki Jimny' },
  { match: /\bmitsubishi.*l200\b/i, canonical: 'Mitsubishi L200' },
  { match: /\bmitsubishi\b/i, canonical: 'Mitsubishi' },
  { match: /\blexus.*lx\s*600\b/i, canonical: 'Lexus LX600' },
  { match: /\blincoln.*nautilus\b/i, canonical: 'Lincoln Nautilus' },
  { match: /\brange\s*rover.*velar\b/i, canonical: 'Range Rover Velar' },
  { match: /\bmercedes.*g63\b/i, canonical: 'Mercedes-Benz G63' },
  { match: /\bbmw.*ix3\b/i, canonical: 'BMW iX3' },
  { match: /^bmw$/i, canonical: 'BMW' },
  { match: /^audi$/i, canonical: 'Audi' },
  { match: /\brox\s*0?1\b/i, canonical: 'Rox 01' },
  { match: /\b(mini|宝马\s*mini)\b/i, canonical: 'MINI' },
  { match: /\bvw.*id\.?4\b/i, canonical: 'VW ID.4' },
  { match: /\bid\.?6\b/i, canonical: 'VW ID.6' },
  { match: /\bnammi.*0?1\b/i, canonical: 'Nammi 01' },
  { match: /\bjaecoo.*j8\b/i, canonical: 'Jaecoo J8' },
  { match: /\bfoton\b/i, canonical: 'Foton' },
  { match: /\btai\s*7\b/i, canonical: 'BYD Tai 7' },

  // ─────── Very generic fallbacks ───────
  { match: /^byd$/i, canonical: 'BYD (unspecified)' },
  { match: /^toyota$/i, canonical: 'Toyota (unspecified)' },
  { match: /^(changan)$/i, canonical: 'Changan (unspecified)' },
];

const NOISE_MODEL_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^electric\s+double\s+cab\s+pickup\s*$/i,
  /^jmk\s*$/i,
  /^premium\s*(model)?\s*$/i,
  /^sporty\s*(car)?\s*$/i,
  /^[24]\s*wd\s*(manual|automatic|auto|vehicle|top\s*trim)?\s*$/i,
  /^star\s*(defender|guardian|stargazer)\s*$/i,
  /^(byd|toyota|jetour|changan|chery|rely|honda|geely|gwm|haval|tank)\s*$/i,
  /^this[_\s]+rely\s*$/i,
  /^2026\s*$/i,
  /^(new|used)\s*$/i,
];

export function isNoiseModel(model: string): boolean {
  const s = model.trim();
  if (!s) return true;
  return NOISE_MODEL_PATTERNS.some((p) => p.test(s));
}

export function canonicalizeModel(model: string): string {
  if (!model) return model;
  const cleaned = prenormalize(model);
  if (!cleaned) return model;
  for (const rule of RULES) {
    const m = cleaned.match(rule.match);
    if (m) {
      return rule.canonical.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
    }
  }
  return cleaned
    .split(/\s+/)
    .map((w) => {
      if (/^\d+$/.test(w)) return w;
      return w[0]?.toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}
