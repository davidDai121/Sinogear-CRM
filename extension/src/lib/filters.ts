import type { CustomerQuality } from './database.types';
import type { CrmContact } from '@/panel/hooks/useCrmData';
import { getBrandOverride } from './brand-overrides';

export type TodoBucket =
  | 'all'
  | 'needs_reply'
  | 'negotiating'
  | 'priority'
  | 'stalled'
  | 'new';

/**
 * 标记某客户是"重点客户"——基于真实业务信号 + 近期活跃：
 *
 * 必须同时满足：
 *   1. 有效信号之一：quality=big / 有真实预算>0 / 有 vehicle_interests / tags 含"大客户/有潜力" / WhatsApp label 同样
 *   2. **近期有活动**（排除迁过来从没沟通的）：chat 存在于 WhatsApp 缓存 + chat.t 在最近 30 天内
 *
 * quality=big 是个例外——用户手动标的高价值客户即使长期沉默也保留。
 */
const PRIORITY_TAG_PATTERNS = /(大客户|VIP|有潜力|重点|big|priority)/i;
const PRIORITY_ACTIVITY_WINDOW_SEC = 30 * 24 * 3600;

export function isPriorityContact(c: CrmContact): boolean {
  if (!c.contact) return false;
  if (c.contact.quality === 'spam') return false;

  // 用户手动标 ⭐⭐⭐ 的，无视活跃度
  if (c.contact.quality === 'big') return true;

  // 收集"有意向"信号
  const hasIntent =
    (c.contact.budget_usd != null && Number(c.contact.budget_usd) > 0) ||
    c.vehicleInterests.length > 0 ||
    c.tags.some((t) => PRIORITY_TAG_PATTERNS.test(t)) ||
    c.labels.some((l) => PRIORITY_TAG_PATTERNS.test(l.name));
  if (!hasIntent) return false;

  // 必须近期有活动（排除迁过来但从没在新系统沟通过的客户）
  if (!c.chat || c.chat.t <= 0) return false;
  const ageSec = Date.now() / 1000 - c.chat.t;
  if (ageSec > PRIORITY_ACTIVITY_WINDOW_SEC) return false;

  return true;
}

const NEGOTIATING_STAGES = new Set([
  'qualifying',
  'negotiating',
  'quoted',
]);

export type BudgetCondition = 'all' | 'new' | 'used';

export interface BudgetBucket {
  id: string;
  label: string;
  min: number;
  max: number;
}

export const BUDGET_BUCKETS_NEW: BudgetBucket[] = [
  { id: 'b1', label: '< $10k', min: 0, max: 10000 },
  { id: 'b2', label: '$10-15k', min: 10000, max: 15000 },
  { id: 'b3', label: '$15-25k', min: 15000, max: 25000 },
  { id: 'b4', label: '$25-40k', min: 25000, max: 40000 },
  { id: 'b5', label: '> $40k', min: 40000, max: Infinity },
];

export const BUDGET_BUCKETS_USED: BudgetBucket[] = [
  { id: 'u1', label: '< $5k', min: 0, max: 5000 },
  { id: 'u2', label: '$5-10k', min: 5000, max: 10000 },
  { id: 'u3', label: '$10-15k', min: 10000, max: 15000 },
  { id: 'u4', label: '$15-25k', min: 15000, max: 25000 },
  { id: 'u5', label: '> $25k', min: 25000, max: Infinity },
];

export interface FilterState {
  todoBucket: TodoBucket | null;
  stages: Set<string>;
  qualities: Set<CustomerQuality>;
  regions: Set<string>;
  countries: Set<string>;
  vehicleModels: Set<string>;
  budgetBuckets: Set<string>;
  budgetCondition: BudgetCondition;
  includeSpam: boolean;
  includeArchived: boolean;
}

export function emptyFilter(): FilterState {
  return {
    todoBucket: null,
    stages: new Set(),
    qualities: new Set(),
    regions: new Set(),
    countries: new Set(),
    vehicleModels: new Set(),
    budgetBuckets: new Set(),
    budgetCondition: 'all',
    includeSpam: false,
    includeArchived: false,
  };
}

interface SerializedFilter {
  todoBucket: TodoBucket | null;
  stages: string[];
  qualities: CustomerQuality[];
  regions: string[];
  countries: string[];
  vehicleModels: string[];
  budgetBuckets: string[];
  budgetCondition: BudgetCondition;
  includeSpam: boolean;
  includeArchived: boolean;
}

export function serializeFilter(f: FilterState): SerializedFilter {
  return {
    todoBucket: f.todoBucket,
    stages: Array.from(f.stages),
    qualities: Array.from(f.qualities),
    regions: Array.from(f.regions),
    countries: Array.from(f.countries),
    vehicleModels: Array.from(f.vehicleModels),
    budgetBuckets: Array.from(f.budgetBuckets),
    budgetCondition: f.budgetCondition,
    includeSpam: f.includeSpam,
    includeArchived: f.includeArchived,
  };
}

export function deserializeFilter(raw: unknown): FilterState {
  const base = emptyFilter();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<SerializedFilter>;
  return {
    todoBucket: s.todoBucket ?? null,
    stages: new Set(s.stages ?? []),
    qualities: new Set(s.qualities ?? []),
    regions: new Set(s.regions ?? []),
    countries: new Set(s.countries ?? []),
    vehicleModels: new Set(s.vehicleModels ?? []),
    budgetBuckets: new Set(s.budgetBuckets ?? []),
    budgetCondition: s.budgetCondition ?? 'all',
    includeSpam: s.includeSpam ?? false,
    includeArchived: s.includeArchived ?? false,
  };
}

export function isFilterEmpty(f: FilterState): boolean {
  return (
    f.todoBucket == null &&
    f.stages.size === 0 &&
    f.qualities.size === 0 &&
    f.regions.size === 0 &&
    f.countries.size === 0 &&
    f.vehicleModels.size === 0 &&
    f.budgetBuckets.size === 0
  );
}

function matchTodoBucket(c: CrmContact, bucket: TodoBucket): boolean {
  if (bucket === 'all') return true;
  const cls = c.classification;
  if (!cls) return false;
  if (bucket === 'needs_reply') return cls.needsReply;
  if (bucket === 'negotiating') {
    return (
      c.contact != null && NEGOTIATING_STAGES.has(c.contact.customer_stage)
    );
  }
  if (bucket === 'priority') return isPriorityContact(c);
  if (bucket === 'stalled') return cls.autoStage === 'stalled';
  if (bucket === 'new') return cls.autoStage === 'new';
  return false;
}

function matchBudget(
  c: CrmContact,
  budgetBuckets: Set<string>,
  condition: BudgetCondition,
  buckets: BudgetBucket[],
): boolean {
  const relevantBuckets = buckets.filter((b) => budgetBuckets.has(b.id));
  if (!relevantBuckets.length) return true;

  const prices: Array<{ price: number; condition: string | null }> = [];
  for (const v of c.vehicleInterests) {
    if (v.target_price_usd != null) {
      prices.push({ price: Number(v.target_price_usd), condition: v.condition });
    }
  }
  if (c.contact?.budget_usd != null) {
    prices.push({ price: Number(c.contact.budget_usd), condition: null });
  }
  if (!prices.length) return false;

  const filtered = prices.filter((p) => {
    if (condition === 'all') return true;
    if (p.condition == null) return true;
    return p.condition === condition;
  });

  return filtered.some((p) =>
    relevantBuckets.some((b) => p.price >= b.min && p.price < b.max),
  );
}

export function applyFilter(
  contacts: CrmContact[],
  f: FilterState,
): CrmContact[] {
  const buckets =
    f.budgetCondition === 'used' ? BUDGET_BUCKETS_USED : BUDGET_BUCKETS_NEW;

  return contacts.filter((c) => {
    if (c.chat?.archive && !f.includeArchived) return false;
    if (c.contact?.quality === 'spam' && !f.includeSpam) return false;

    if (f.todoBucket && !matchTodoBucket(c, f.todoBucket)) return false;

    if (f.qualities.size && c.contact) {
      if (!f.qualities.has(c.contact.quality)) return false;
    } else if (f.qualities.size && !c.contact) {
      return false;
    }

    if (f.stages.size && c.contact) {
      if (!f.stages.has(c.contact.customer_stage)) return false;
    } else if (f.stages.size && !c.contact) {
      return false;
    }

    if (f.regions.size && !f.regions.has(c.region)) return false;
    if (f.countries.size) {
      if (!c.contact?.country) return false;
      if (!f.countries.has(c.contact.country)) return false;
    }

    if (f.vehicleModels.size) {
      const models = new Set(c.vehicleInterests.map((v) => v.model));
      let any = false;
      for (const m of f.vehicleModels) {
        if (models.has(m)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }

    if (f.budgetBuckets.size) {
      if (!matchBudget(c, f.budgetBuckets, f.budgetCondition, buckets))
        return false;
    }

    return true;
  });
}

export function todoCounts(contacts: CrmContact[]): Record<TodoBucket, number> {
  const counts: Record<TodoBucket, number> = {
    all: 0,
    needs_reply: 0,
    negotiating: 0,
    priority: 0,
    stalled: 0,
    new: 0,
  };
  for (const c of contacts) {
    if (c.chat?.archive) continue;
    if (c.contact?.quality === 'spam') continue;
    counts.all++;
    if (!c.classification) continue;
    if (c.classification.needsReply) counts.needs_reply++;
    if (c.contact && NEGOTIATING_STAGES.has(c.contact.customer_stage)) {
      counts.negotiating++;
    }
    if (isPriorityContact(c)) counts.priority++;
    if (c.classification.autoStage === 'stalled') counts.stalled++;
    if (c.classification.autoStage === 'new') counts.new++;
  }
  return counts;
}

export function brandOf(model: string): string {
  const override = getBrandOverride(model);
  if (override) return override;
  const m = model.toLowerCase();
  if (/\b(denza|腾势)\b/.test(m)) return '腾势 Denza';
  if (/\b(byd|song|dolphin|atto|seal|han|yuan|tang|qin|bz3x?|bz4x|leopard|豹|shark|seagull|海鸥|f0|tai\s*7)\b/.test(m))
    return '比亚迪 BYD';
  if (/\b(toyota|corolla|hilux|land\s*cruiser|landcruiser|rav4|prado|camry|vios|yaris|fortuner|hiace|sienna|4runner|bz4x|crown|highlander)\b/.test(m))
    return '丰田 Toyota';
  if (/\b(tank|坦克|haval|哈弗|gwm|poer|pao|jolion|h6|h9)\b/.test(m))
    return '长城 GWM';
  if (/\b(geely|boyue|coolray|emgrand|okavango|tugella|monjaro|radar|博越|银河)\b/.test(m))
    return '吉利 Geely';
  if (/\b(honda|civic|crv|cr-v|hr-v|accord|city|fit|jazz|e:np\d?)\b/.test(m))
    return '本田 Honda';
  if (/\b(nissan|sunny|sentra|x-trail|patrol|navara|sylphy|altima)\b/.test(m))
    return '日产 Nissan';
  if (/\b(tesla|model\s*[y3sx])\b/.test(m)) return 'Tesla';
  if (/\b(chery|奇瑞|tiggo|rely|r0?8|icar|cs55|jaecoo)\b/.test(m)) return '奇瑞 Chery';
  if (/\b(deepal|深蓝|g318|nevo|s0?7|s0?5)\b/.test(m)) return '深蓝 Deepal';
  if (/\b(avatr|阿维塔)\b/.test(m)) return '阿维塔 Avatr';
  if (/\b(nammi)\b/.test(m)) return 'Nammi';
  if (/\b(changan|长安|cs\d+|qiyuan)\b/.test(m)) return '长安 Changan';
  if (/\b(hongqi|红旗|hs\d|h\d )\b/.test(m)) return '红旗 Hongqi';
  if (/\b(mg|roewe|荣威)\b/.test(m)) return 'MG/荣威';
  if (/\b(mazda|马自达|cx-\d|axela|atenza)\b/.test(m)) return '马自达 Mazda';
  if (/\b(jetour|捷途|dashing|t1|t2|g700|x70|x90|traveller|traveler)\b/.test(m))
    return '捷途 Jetour';
  if (/\b(baic|北汽|bj\d+)\b/.test(m)) return '北汽 BAIC';
  if (/\b(li\s*auto|理想|lixiang)\b/.test(m)) return '理想 Li Auto';
  if (/\b(nio|蔚来|es\d|et\d)\b/.test(m)) return '蔚来 NIO';
  if (/\b(xpeng|小鹏|p\d|g\d\b)\b/.test(m)) return '小鹏 XPeng';
  if (/\b(zeekr|极氪|x9|001|007|009)\b/.test(m)) return '极氪 Zeekr';
  if (/\b(isuzu|五十铃|d-?max)\b/.test(m)) return '五十铃 Isuzu';
  if (/\b(mitsubishi|l200|triton|pajero|三菱)\b/.test(m)) return '三菱 Mitsubishi';
  if (/\b(ford|ranger|f-?150|explorer|focus)\b/.test(m)) return '福特 Ford';
  if (/\b(lexus|雷克萨斯|lx\d|rx\d|nx\d|es\d|ls\d)\b/.test(m)) return '雷克萨斯 Lexus';
  if (/\b(lincoln|林肯|nautilus|aviator|navigator)\b/.test(m)) return '林肯 Lincoln';
  if (/\b(mercedes|benz|奔驰|g\d{2,3}|c\d{2,3}|e\d{2,3}|s\d{2,3})\b/.test(m))
    return '奔驰 Mercedes';
  if (/\b(bmw|宝马|ix\d|x\d\b|i\d)\b/.test(m)) return '宝马 BMW';
  if (/\baudi|奥迪|q\d\b|a\d\b/.test(m)) return '奥迪 Audi';
  if (/\b(volkswagen|vw|大众|id\.?\d|tiguan|passat|lavida|sagitar)\b/.test(m))
    return '大众 VW';
  if (/\b(suzuki|铃木|jimny|swift|vitara)\b/.test(m)) return '铃木 Suzuki';
  if (/\b(range\s*rover|路虎|land\s*rover|velar|evoque|discovery)\b/.test(m))
    return '路虎 Land Rover';
  if (/\b(mini|宝马\s*mini)\b/.test(m)) return 'MINI';
  if (/\b(rox|洛轲|极石)\b/.test(m)) return '极石 Rox';
  if (/\b(foton|福田)\b/.test(m)) return '福田 Foton';

  // Auto-fallback: use first word as brand if it looks like a proper brand name
  const firstWord = model.trim().split(/\s+/)[0];
  if (
    firstWord &&
    firstWord.length >= 2 &&
    !/^\d+$/.test(firstWord) &&
    /^[A-Za-z\u4e00-\u9fa5]/.test(firstWord) &&
    !['the', 'this', 'and', 'or', 'with'].includes(firstWord.toLowerCase())
  ) {
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
  }
  return '其他';
}
