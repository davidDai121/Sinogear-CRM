import type { ChatMessage } from '@/content/whatsapp-messages';

export type SuggestedField =
  | 'name'
  | 'country'
  | 'language'
  | 'budget_usd'
  | 'destination_port';

export interface FieldSuggestion {
  field: SuggestedField;
  value: string;
  confidence: number;
  evidence: string;
}

export type VehicleConditionGuess = 'new' | 'used' | null;

export interface VehicleSuggestion {
  model: string;
  condition: VehicleConditionGuess;
  target_price_usd: number | null;
  evidence: string;
}

export interface ContactSnapshot {
  name: string | null;
  country: string | null;
  language: string | null;
  budget_usd: number | null;
  destination_port: string | null;
  existingVehicleModels?: string[];
}

export interface ExtractFieldsRequest {
  type: 'EXTRACT_FIELDS';
  messages: ChatMessage[];
  contact: ContactSnapshot;
}

export interface ExtractFieldsResponse {
  ok: boolean;
  suggestions?: FieldSuggestion[];
  vehicles?: VehicleSuggestion[];
  error?: string;
}

export interface TagSuggestion {
  tag: string;
  evidence: string;
}

export interface ExtractTagsRequest {
  type: 'EXTRACT_TAGS';
  messages: ChatMessage[];
  existingTags: string[];
}

export interface ExtractTagsResponse {
  ok: boolean;
  tags?: TagSuggestion[];
  error?: string;
}

export interface TaskSuggestion {
  title: string;
  due_in_days: number | null;
  evidence: string;
}

export interface ExtractTasksRequest {
  type: 'EXTRACT_TASKS';
  messages: ChatMessage[];
  existingTitles: string[];
}

export interface ExtractTasksResponse {
  ok: boolean;
  tasks?: TaskSuggestion[];
  error?: string;
}

const VALID_FIELDS: SuggestedField[] = [
  'name',
  'country',
  'language',
  'budget_usd',
  'destination_port',
];

export function buildPrompt(messages: ChatMessage[], contact: ContactSnapshot): string {
  const transcript = messages
    .map((m) => `[${m.fromMe ? 'Sales' : 'Customer'}] ${m.text}`)
    .join('\n');

  const current = JSON.stringify(
    {
      name: contact.name,
      country: contact.country,
      language: contact.language,
      budget_usd: contact.budget_usd,
      destination_port: contact.destination_port,
      existing_vehicle_interests: contact.existingVehicleModels ?? [],
    },
    null,
    2,
  );

  return `你是汽车出口公司 CRM 的字段抽取助手。从下面的 WhatsApp 聊天里识别客户信息和车型兴趣。

# 任务 1：客户字段（只在能明确判断时返回）
- name: 客户姓名（英文，首字母大写）
- country: 客户所在国家（标准英文名，城市映射到国家：Mombasa→Kenya、Lagos→Nigeria、Dubai→UAE 等）
- language: 主要交流语言（English / French / Spanish / Arabic / Chinese / Portuguese 等）
- budget_usd: 整体预算（美元数字。"25k" → 25000；其他货币按近似换算）
- destination_port: 目的港英文名（Mombasa / Lagos / Dakar）

# 任务 2：车型兴趣（提到的所有车都列出来，不要漏）
- model: 车型完整名（品牌+型号，如 "Toyota Hilux" / "BYD Song Plus" / "坦克 500"）
- condition: "new" / "used" / null（看客户提到 brand new 还是 used）
- target_price_usd: 该车的目标价（数字，没提到就 null）

车型识别规则：
- 客户问的、销售推荐的、聊天里提到的所有具体车型都列
- 同一车的 new + used 算两条（如客户问"hilux 新车多少，二手多少"）
- 不要重复 existing_vehicle_interests 里已有的车型

# 已有数据
${current}

# 输出格式（严格 JSON，不要 markdown，不要解释）
{
  "suggestions": [
    { "field": "country", "value": "Kenya", "confidence": 0.9, "evidence": "shipping to Mombasa" }
  ],
  "vehicles": [
    { "model": "Toyota Hilux", "condition": "new", "target_price_usd": 25000, "evidence": "want hilux brand new around 25k" },
    { "model": "Toyota Hilux", "condition": "used", "target_price_usd": null, "evidence": "also asking for used hilux" }
  ]
}

# 规则
- suggestions 只返回 confidence ≥ 0.7 的
- 找不到任何字段返回 "suggestions": []
- 找不到任何车型返回 "vehicles": []
- evidence 必须是聊天里出现的原文片段，不要编造

# 聊天记录（最新在下）
${transcript}`;
}

export function validateSuggestions(raw: unknown): FieldSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { suggestions?: unknown };
  if (!Array.isArray(obj.suggestions)) return [];

  const result: FieldSuggestion[] = [];
  for (const item of obj.suggestions) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;

    const field = s.field;
    const value = s.value;
    const confidence = s.confidence;
    const evidence = s.evidence;

    if (typeof field !== 'string') continue;
    if (!VALID_FIELDS.includes(field as SuggestedField)) continue;
    if (value == null) continue;
    if (typeof confidence !== 'number') continue;

    const valueStr = String(value).trim();
    if (!valueStr) continue;

    result.push({
      field: field as SuggestedField,
      value: valueStr,
      confidence: Math.max(0, Math.min(1, confidence)),
      evidence: typeof evidence === 'string' ? evidence.slice(0, 200) : '',
    });
  }

  return result;
}

export function buildTagPrompt(
  messages: ChatMessage[],
  existingTags: string[],
): string {
  const transcript = messages
    .map((m) => `[${m.fromMe ? 'Sales' : 'Customer'}] ${m.text}`)
    .join('\n');

  return `你是汽车出口公司 CRM 的客户标签建议助手。从下面的 WhatsApp 聊天里抽取 3-5 个对销售有用的客户特征标签。

# 标签类型（举例，按需选用）
- 支付方式：TT 转账 / 信用卡 / 信用证 / CIA
- 业务类型：批发商 / 零售 / 个人自用 / 经销商
- 紧急度：急单 / 月底前 / 不急
- 决策阶段：对比中 / 已决定 / 等老板批 / 在询价
- 客户特征：老客户 / 首次合作 / 朋友介绍 / 大客户
- 关注重点：低价优先 / 品质优先 / 售后优先 / 物流优先
- 反对信号：嫌贵 / 嫌慢 / 担心售后 / 沟通困难
- 竞品：对比奇瑞 / 对比丰田 / 对比比亚迪

# 不要生成（已被其他字段覆盖）
- 国家、语言、预算金额、目的港、车型、品牌兴趣

# 已有标签（不要重复，不要冲突）
${existingTags.length ? existingTags.join('、') : '（无）'}

# 输出格式（严格 JSON，不要 markdown）
{
  "tags": [
    { "tag": "急单", "evidence": "需要月底前发货" },
    { "tag": "对比奇瑞", "evidence": "也在和奇瑞经销商聊" }
  ]
}

# 规则
- 中文标签，每个不超过 8 字
- evidence 是聊天里的原文片段，不要编造
- 找不到合适的就返回 "tags": []
- 不要把客户姓名、车型、品牌当标签
- 不要重复已有标签

# 聊天记录（最新在下）
${transcript}`;
}

export function buildTaskPrompt(
  messages: ChatMessage[],
  existingTitles: string[],
): string {
  const transcript = messages
    .map((m) => `[${m.fromMe ? 'Sales' : 'Customer'}] ${m.text}`)
    .join('\n');

  return `你是汽车出口公司 CRM 的销售跟进助手。看下面的 WhatsApp 聊天，给销售经理提 0-3 条**下一步具体动作**任务建议。

# 任务示例（动词开头，简短具体）
- "发 Hilux 二手报价"
- "确认客户预算上限"
- "下周三回访 Jose"
- "整理 BYD 车型 PDF 发客户"
- "跟进船期确认"
- "找供应商查 Toyota Prado 库存"

# 已有任务（不要重复）
${existingTitles.length ? existingTitles.join('、') : '（无）'}

# 输出格式（严格 JSON，不要 markdown）
{
  "tasks": [
    { "title": "发 Hilux 报价", "due_in_days": 1, "evidence": "客户问 hilux 多少钱" },
    { "title": "确认目的港", "due_in_days": 3, "evidence": "ship to ?" }
  ]
}

# 规则
- 中文 title，动词开头，**12 字以内**
- due_in_days 整数（0=今天，1=明天，3=三天后；不确定就给 3）
- evidence 必须是聊天原文片段，不要编造
- 没有明确"销售要做的事"就返回 "tasks": []
- 不要把"等客户回复"当任务（销售无需主动行动）
- 不要重复已有任务的语义

# 聊天记录（最新在下）
${transcript}`;
}

export function validateTasks(raw: unknown): TaskSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { tasks?: unknown };
  if (!Array.isArray(obj.tasks)) return [];

  const result: TaskSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of obj.tasks) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;

    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (!title || title.length > 50) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let due_in_days: number | null = null;
    if (typeof t.due_in_days === 'number' && Number.isFinite(t.due_in_days)) {
      const d = Math.round(t.due_in_days);
      if (d >= 0 && d <= 365) due_in_days = d;
    }

    result.push({
      title,
      due_in_days,
      evidence: typeof t.evidence === 'string' ? t.evidence.slice(0, 200) : '',
    });
  }
  return result;
}

export function validateTags(raw: unknown): TagSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { tags?: unknown };
  if (!Array.isArray(obj.tags)) return [];

  const result: TagSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of obj.tags) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;

    const tag = typeof t.tag === 'string' ? t.tag.trim() : '';
    if (!tag || tag.length > 16) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      tag,
      evidence: typeof t.evidence === 'string' ? t.evidence.slice(0, 200) : '',
    });
  }
  return result;
}

export function validateVehicles(raw: unknown): VehicleSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { vehicles?: unknown };
  if (!Array.isArray(obj.vehicles)) return [];

  const result: VehicleSuggestion[] = [];
  for (const item of obj.vehicles) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;

    const model = typeof v.model === 'string' ? v.model.trim() : '';
    if (!model) continue;

    let condition: VehicleConditionGuess = null;
    if (v.condition === 'new' || v.condition === 'used') {
      condition = v.condition;
    }

    let target_price_usd: number | null = null;
    if (typeof v.target_price_usd === 'number' && v.target_price_usd > 0) {
      target_price_usd = v.target_price_usd;
    }

    result.push({
      model,
      condition,
      target_price_usd,
      evidence: typeof v.evidence === 'string' ? v.evidence.slice(0, 200) : '',
    });
  }

  return result;
}
