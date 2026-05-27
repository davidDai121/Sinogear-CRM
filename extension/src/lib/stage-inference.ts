// AI 自动推断 customer_stage —— 用 LLM 看聊天内容判断客户当前漏斗位置
//
// 设计取舍：
//   - 只输出 5 个内容驱动的 stage：qualifying / negotiating / quoted / won / lost
//   - 不输出 new（无消息时琐碎判断，hook 层做）
//   - 不输出 stalled（沉默时长，chat-classifier 已经管，不是 AI 的活）
//   - 输出 confidence < 0.8 由 hook 决定丢弃 —— AI 自己也会保守，但门槛在 hook
//   - 不做 won/lost 防降级：hook 层处理"已成交不能 AI 降回议价"硬规则
//
// 上下文成本：典型聊天 20-30 条消息 ~2-3k tokens，GLM-4-flash 免费档不限频

import type { ChatMessage } from '@/content/whatsapp-messages';

export type InferableStage =
  | 'qualifying'
  | 'negotiating'
  | 'quoted'
  | 'won'
  | 'lost';

export interface StageInference {
  stage: InferableStage | null; // null = AI 也不确定，跳过
  confidence: number; // 0-1
  reasoning: string; // 简短理由，用于日志和 UI 显示
}

export interface InferStageRequest {
  type: 'INFER_STAGE';
  messages: ChatMessage[];
  currentStage: string; // CRM 当前 stage（参考用，AI 可能维持也可能变）
}

export interface InferStageResponse {
  ok: boolean;
  inference?: StageInference;
  error?: string;
}

export function buildStagePrompt(
  messages: ChatMessage[],
  currentStage: string,
): string {
  const transcript = messages
    .map((m) => `[${m.fromMe ? 'Sales' : 'Customer'}] ${m.text}`)
    .join('\n');

  return `你是汽车出口公司 CRM 的销售漏斗分析助手。看下面的 WhatsApp 聊天，判断客户当前处于销售漏斗的哪个阶段。

# 可选的 stage 值（只能选一个）
- "qualifying"：客户表达了真实购车意向，但还没进入议价（问车型、问配置、说自己想买什么）
- "negotiating"：客户在跟销售讨论价格、付款方式、运输条款等具体交易细节
- "quoted"：销售已经发出**正式书面报价**（PI、Proforma Invoice、formal quotation、报价单、详细价格清单）
- "won"：客户**明确同意购买**（付定金、确认订单、"I'll take it"、"成交"、"go ahead with payment"、客户发付款截图/凭证）
- "lost"：客户**明确表示放弃**（"not interested"、"found another supplier"、"cancel"、"算了"、"不要了"、"too expensive 不考虑了"）

# 当前 CRM 阶段（参考，可能过时）
${currentStage}

# 输出格式（严格 JSON，不要 markdown）
{
  "stage": "<五个值之一，不确定就 null>",
  "confidence": 0.85,
  "reasoning": "<10-30 字中文理由，引用聊天关键句>"
}

# 关键规则
- **聊天内容没有强证据时返回 stage=null**（宁缺勿滥）
- 客户只是打招呼或问候 → stage=null
- 没看到客户消息或聊天太少（少于 3 条往返） → stage=null
- **不要根据聊天沉默时长推断**（那是另一个系统的活，专注内容）
- **多语言识别**：客户可能用英语 / 西班牙语 / 阿拉伯语 / 法语 / 葡萄牙语等
  - "I'll take it" / "Lo compro" / "أوافق" / "Je le prends" / "Vou levar" 都算 won 信号
  - 看到客户发付款金额、银行截图、转账凭证 = won 强信号
  - "not interested" / "no me interesa" / "لست مهتما" / "pas intéressé" = lost
- **判 quoted 需要看到销售真发了报价**（具体 USD 数字 + 车型，PI / Proforma 关键词）
  - 客户问"多少钱" 不是 quoted，是 negotiating（议价中）
  - 销售说"我帮你查一下" 不是 quoted
- **判 won 需要客户主动确认**，不是销售自己说"已成交"
- confidence 0.9+：有明确关键句证据
- confidence 0.7-0.9：合理推断但有歧义
- confidence < 0.7：不要返回这个 stage，给 null

# 反例（别犯）
- 销售发广告说"价格优惠 $11,000" → 不是 quoted（这是营销话术）
- 客户说"有报价单吗" → 不是 quoted（在问，不是收到）
- 客户问"how much" → negotiating 而不是 qualifying（已开始价格谈判）
- 客户长时间不回 → 不要降级（那是 stalled 的事，不是你的事）

# 聊天记录（最新在下）
${transcript}`;
}

const VALID_STAGES: InferableStage[] = [
  'qualifying',
  'negotiating',
  'quoted',
  'won',
  'lost',
];

export function validateInference(raw: unknown): StageInference {
  const fallback: StageInference = {
    stage: null,
    confidence: 0,
    reasoning: 'AI 输出无效或为空',
  };

  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;

  let stage: InferableStage | null = null;
  if (typeof obj.stage === 'string' && VALID_STAGES.includes(obj.stage as InferableStage)) {
    stage = obj.stage as InferableStage;
  }

  let confidence = 0;
  if (typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)) {
    confidence = Math.max(0, Math.min(1, obj.confidence));
  }

  const reasoning =
    typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 200) : '';

  return { stage, confidence, reasoning };
}
