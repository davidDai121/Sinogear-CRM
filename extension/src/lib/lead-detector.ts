/**
 * Facebook 广告 lead 表单消息识别 + 解析。
 *
 * 一条 lead 长这样：
 *   Bonjour ! J'ai rempli votre formulaire et j'aimerais en savoir plus sur votre entreprise.
 *
 *   what_is_your_purpose_for_buying?: Personal Use
 *   full_name: Birama Diop
 *   this_qin_plus_dmi_fob_price_is_usd_7,900_per_unit._is_this_within_your_target_budget?: Yes
 *   company_name: bd consult
 *   when_are_you_planning_to_import_this_car?: Within 1 Month
 *   phone_number: +221774730404
 *
 * 字段固定 snake_case，问号可有可无，冒号后是答案。多种语言的问候开头都能搭配。
 */

const FIELD_MARKERS: RegExp[] = [
  /\bphone_number\s*:/i,
  /\bfull_name\s*:/i,
  /\bwhat_is_your_purpose_for_buying/i,
  /\bwhen_are_you_planning_to_import/i,
  /\bcompany_name\s*:/i,
  /\bis_this_within_your_target_budget/i,
  /\bcontact_email\s*:/i,
];

export interface LeadFields {
  fullName?: string;
  phone?: string;
  purpose?: string;
  companyName?: string;
  importTimeframe?: string;
  budgetAnswer?: string;
  /** 从 this_<car_name>_..._target_budget 这种 question key 反解出来的车型片段，未必标准化 */
  vehicleHint?: string;
  /** 原始 lead 文本，便于排队后存档 */
  raw: string;
}

/** 至少命中 2 个关键 marker 才认是 lead。1 个不够（容易误判普通消息含 phone_number 字样）。 */
export function isLeadMessage(text: string): boolean {
  if (!text || text.length < 40) return false;
  let hits = 0;
  for (const re of FIELD_MARKERS) {
    if (re.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * 把 lead 文本拆成结构化字段。容错：未识别字段会被忽略，至少有 vehicleHint / phone 就有用。
 */
export function parseLeadFields(text: string): LeadFields {
  const result: LeadFields = { raw: text };
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    // 匹配 "field_name?: value" 或 "field_name: value"，key 是 snake_case_alnum
    const m = line.match(/^\s*([a-z][a-z0-9_]*?)\s*\??\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!key || !value) continue;

    if (key === 'full_name') {
      result.fullName = value;
    } else if (key === 'phone_number') {
      result.phone = normalizeLeadPhone(value);
    } else if (key === 'what_is_your_purpose_for_buying') {
      result.purpose = value;
    } else if (key === 'company_name') {
      result.companyName = value;
    } else if (key === 'when_are_you_planning_to_import_this_car') {
      result.importTimeframe = value;
    } else if (/^this_.+_target_budget$|^is_this_within_your_target_budget$/i.test(key)) {
      result.budgetAnswer = value;
      // key 里 this_<vehicle>_fob_price_... 提车型片段
      const v = extractVehicleHintFromKey(key);
      if (v && !result.vehicleHint) result.vehicleHint = v;
    } else if (key === 'contact_email') {
      // ignore — 暂不需要
    }
  }

  // 如果 key 路径没拿到，再从全文找一次 this_<car>_..._price 模式
  if (!result.vehicleHint) {
    const m = text.match(/this_([a-z0-9_]+?)_(?:fob|cif|fcl|price|dmi|dmp|usd)/i);
    if (m) result.vehicleHint = m[1].replace(/_/g, ' ').trim();
  }

  return result;
}

/**
 * 从 "this_qin_plus_dmi_fob_price_is_usd_7,900_per_unit._is_this_within_your_target_budget"
 * 里取出 "qin plus dmi" 这段车型片段。
 *
 * 切掉常见的尾巴：fob_/cif_/dmi_/price/usd/per_unit/is_this_within/target/budget 等
 */
function extractVehicleHintFromKey(key: string): string | null {
  if (!key.startsWith('this_')) return null;
  // 去掉 this_ 前缀
  let core = key.slice(5);
  // 切到第一个明显的尾标记
  const stops = [
    '_fob_',
    '_cif_',
    '_price',
    '_is_this',
    '_within',
    '_target',
    '_budget',
    '_per_unit',
    '_usd',
  ];
  for (const stop of stops) {
    const idx = core.indexOf(stop);
    if (idx > 0) {
      core = core.slice(0, idx);
      break;
    }
  }
  const hint = core.replace(/_/g, ' ').trim();
  return hint.length >= 2 ? hint : null;
}

/**
 * lead 表单里的 phone 字段可能是 "+221 77 473 04 04" 这样带空格，统一成 +221774730404
 */
function normalizeLeadPhone(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (!cleaned) return raw.trim();
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}
