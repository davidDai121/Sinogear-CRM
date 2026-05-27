/**
 * GPT-5 Thinking 模式的 prompt 构造。
 *
 * 设计哲学（跟 claude-prompt.ts 完全不同）:
 *   - "You are Miles" 第一人称强角色（不是 "writing assistant for Miles"）
 *   - 6 类买家 adaptive rhythm detection，不是 40 条硬规则堆砌
 *   - 没有 [Need from Sales Rep] 机制 —— 交易是博弈，AI 应大胆拍板估算
 *   - 没有 STYLE_ANCHORS 历史成单回复 —— 让 GPT 自由发挥语气
 *   - 输出三段：[Client Record] / [WhatsApp Reply] / [Full Translation & Strategy]
 *     —— 跟用户自建 Gem prompt 完全一致，UI 不用改解析
 *
 * 数据沿用（事实型，不是教条）:
 *   - VEHICLE_KNOWLEDGE（车型库 + 价格 + 卖点）从 claude-prompt 导入
 *   - GHANA_MARKET_PLAYBOOK（加纳市场 framing / 关税 / 报价档）从 claude-prompt 导入
 *   - customer-signals（英语水平 / 温度 / 沉默天数）
 */

import type { ChatMessage } from '@/content/whatsapp-messages';
import type { Database } from './database.types';
import { isSalesPitch } from './sales-pitch';
import { collapseMediaRuns } from './chat-media-utils';
// customer-signals 注入 GPT prompt 已去掉（feedback_gpt_skip_reference_data.md）—
// 仅 Claude 继续保留信号注入

// 故意不 import VEHICLE_KNOWLEDGE / GHANA_MARKET_PLAYBOOK / isGhanaContext
// —— GPT-5 Thinking 自己能联网查市场数据 + 推理报价（2026-05-20 用户实测），
// 喂老 playbook 反而误导。Claude 那边继续用（claude-prompt.ts 不变）。

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];

export interface GptPromptContext {
  contact: Pick<
    ContactRow,
    | 'phone'
    | 'group_jid'
    | 'name'
    | 'wa_name'
    | 'country'
    | 'language'
    | 'budget_usd'
    | 'destination_port'
    | 'customer_stage'
    | 'notes'
  >;
  vehicleInterests?: Pick<
    VehicleInterestRow,
    'model' | 'year' | 'condition' | 'steering' | 'target_price_usd'
  >[];
  messages: ChatMessage[];
  groupMemberNames?: string[];
  /** 销售自定义指令（textarea，可选） */
  salesGuidance?: string;
  /** true = 走用户自建的 Custom GPT（system prompt 已是 Miles 角色），跳过 ROLE_PROMPT 避免重复 */
  useCustomGpt?: boolean;
}

/**
 * 首次对话 —— prompt：(角色) + 销售指令 + 客户档案 + 聊天历史
 *
 * 故意不发 VEHICLE_KNOWLEDGE / GHANA_MARKET_PLAYBOOK —— 2026-05-20 用户实测：
 * GPT-5 Thinking 自己能联网查市场价 + 推理报价，效果优于喂老 playbook 数据
 * （playbook 是某个时间点定的，CIF 价格 / 关税档随时间漂移，喂老数据反而误导）。
 * Claude 没联网才需要参考数据；GPT 让它自己查 + 推理。
 */
export function buildFirstMessage(ctx: GptPromptContext): string {
  const isGroup = !!ctx.contact.group_jid;
  const sections: string[] = [];

  // 用户自建 Custom GPT 时跳过 ROLE_PROMPT（Custom GPT 的 instructions 里已有同样内容，重发反而稀释）
  if (!ctx.useCustomGpt) {
    sections.push(ROLE_PROMPT);
  }

  // 销售自定义指令 —— 最高优先级
  if (ctx.salesGuidance?.trim()) {
    sections.push(
      '',
      `[Sales Guidance — TOP PRIORITY]`,
      ctx.salesGuidance.trim(),
      `The guidance above OVERRIDES default behavior. Apply it strictly to the [WhatsApp Reply].`,
    );
  }

  // 当前时间 — 紧贴客户上下文，让 GPT 准确判断"今天/昨天/几天前"
  sections.push('', formatCurrentTimeBlock());

  // 客户上下文
  sections.push('', isGroup ? buildGroupContext(ctx) : buildIndividualContext(ctx));

  // 最后再强调一次输出格式（GPT 容易忘记三段格式，结尾重申比开头有效）
  sections.push('', OUTPUT_REMINDER);

  return sections.join('\n');
}

/**
 * 续聊 —— 已有 chat URL，不重复客户档案
 */
export function buildFollowUpMessage(opts: {
  newMessages?: ChatMessage[];
  isGroup?: boolean;
  salesGuidance?: string;
  /**
   * 续聊也带精简版客户档案 —— 老 GPT thread 跑久了 / context 被截断后，
   * 客户 anchor（预算、国家、stage）容易丢；每次续聊重申一遍才稳。
   * 群聊不带（group_jid 模式下 [Customer Context] 无意义）。
   */
  contact?: GptPromptContext['contact'];
  vehicleInterests?: GptPromptContext['vehicleInterests'];
}): string {
  const sections: string[] = [];

  // 续聊每次都注入当前时间 — GPT 对话 thread 不知道唤起时刻
  sections.push(formatCurrentTimeBlock(), '');

  if (opts.salesGuidance?.trim()) {
    sections.push(
      `[Sales Guidance — TOP PRIORITY]`,
      opts.salesGuidance.trim(),
      `Apply it strictly to the [WhatsApp Reply].`,
      '',
    );
  }

  // 续聊也带客户档案（个人聊天才有意义；群聊跳过）
  if (opts.contact && !opts.isGroup) {
    sections.push(buildSlimCustomerContext(opts.contact, opts.vehicleInterests), '');
  }

  if (opts.newMessages && opts.newMessages.length > 0) {
    // 标题诚实化：之前叫 [New Messages Since Last Reply] 是骗 GPT — 实际是最近 50 条整段，
    // 含上次已看过的内容。改成准确的描述。
    sections.push(`[Recent Chat History — last 50 messages, may overlap with what you've already seen in this thread]`);
    const collapsed = collapseMediaRuns(opts.newMessages).slice(-50);
    for (const m of collapsed) {
      sections.push(formatMessage(m, opts.isGroup ?? false));
    }
    sections.push('');
  }

  sections.push(OUTPUT_REMINDER);
  return sections.join('\n');
}

/**
 * 讨论模式 —— 跟 GPT 商量这个客户怎么办，不出客户回复，破开三段输出格式。
 * 第一条带客户上下文 + Miles 的问题；续聊补发最近 50 条 + 问题。
 *
 * 续聊为什么也要带消息：GPT 那边 chat thread 看到的只是上一次 generate
 * 时的历史快照，之后客户陆续发的新消息没人喂给它（典型：客户给了预算 /
 * 改车型）。续聊不主动补，GPT 就基于过时上下文给建议。
 */
export function buildDiscussionMessage(opts: {
  /** 第一条 discuss 才传，附带客户档案 + 聊天历史 */
  ctx?: GptPromptContext;
  /** 续聊 discuss 才传，补发最近 50 条让 GPT 看到新消息 */
  newMessages?: ChatMessage[];
  isGroup?: boolean;
  /** Miles 想问 GPT 的话 */
  question: string;
  /** 续聊 discuss 也带精简客户档案（同 buildFollowUpMessage） */
  contact?: GptPromptContext['contact'];
  vehicleInterests?: GptPromptContext['vehicleInterests'];
}): string {
  const sections: string[] = [];

  // 当前时间 — 首条 / 续聊都注入
  sections.push(formatCurrentTimeBlock(), '');

  if (opts.ctx) {
    // 第一条 discuss — 角色 + 客户档案 + 历史（同 buildFirstMessage 哲学：不喂车型/市场参考数据）
    const isGroup = !!opts.ctx.contact.group_jid;

    if (!opts.ctx.useCustomGpt) {
      sections.push(ROLE_PROMPT, '');
    }

    sections.push(
      isGroup ? buildGroupContext(opts.ctx) : buildIndividualContext(opts.ctx),
      '',
    );
  } else {
    // 续聊 discuss：精简客户档案（个人聊天）+ 最近 50 条
    if (opts.contact && !opts.isGroup) {
      sections.push(buildSlimCustomerContext(opts.contact, opts.vehicleInterests), '');
    }
    if (opts.newMessages && opts.newMessages.length > 0) {
      sections.push(`[Recent Chat History — last 50 messages, may overlap with what you've already seen in this thread]`);
      const collapsed = collapseMediaRuns(opts.newMessages).slice(-50);
      for (const m of collapsed) {
        sections.push(formatMessage(m, opts.isGroup ?? false));
      }
      sections.push('');
    }
  }

  sections.push(
    `[Discussion — NOT a customer reply request]`,
    opts.question.trim(),
    '',
    `This is Miles asking you for tactical advice or analysis, NOT a request to draft a customer reply.`,
    `Reply in Chinese (中文) with concrete tactical analysis. Be direct, give your read on the customer, suggest a move.`,
    `For THIS discussion message ONLY, you may break the standard [Client Record] / [WhatsApp Reply] / [Full Translation & Strategy] output format — just give a useful Chinese answer.`,
    `When Miles next asks for a customer reply, return to the standard three-section format.`,
  );

  return sections.join('\n');
}

// ── ROLE_PROMPT —— 极简版：只留 Role + 6 类买家 + 输出格式 ──
//
// 用户明确要求："限制太多反而不会回复" — 删掉所有 hard rules / operating principles
// / decisiveness rule / margin floor 等约束清单，让 GPT 自由发挥。
// 事实型数据（车型库 / Ghana playbook）仍通过 VEHICLE_KNOWLEDGE / GHANA_MARKET_PLAYBOOK
// 注入，但不在 ROLE_PROMPT 里写 meta-rule。

const ROLE_PROMPT = `# Role & Identity

You ARE Miles (戴蒙龙), the founder and senior sales manager of Sino Gear — a Chinese auto export company. You are not an assistant or a writing helper; you ARE the salesperson having this conversation. Speak in first person. Make decisions. Move the deal forward.

You communicate with overseas car dealers, importers, fleet buyers, trading companies, and high-value personal buyers through WhatsApp text only.

You are professional, confident, flexible, warm, commercially sharp, and good at reading people. You treat customers as friends, but you never lose control of price, process, payment terms, or negotiation direction.

You do NOT follow a rigid script. You adapt your tone, pace, and closing method to each buyer's personality, buying stage, seriousness, budget readiness, trust level, and reply style. You can sound like a friend, a consultant, a market analyst, a negotiator, or a closing manager depending on the customer's rhythm.

# Ad Copy vs Customer Budget — hard rule (never break)

Two types of messages in the chat history are **NOT** Miles's pricing offers and **NOT** the customer's stated budget:

1. **\`Sales (AD COPY — marketing pitch, NOT a price offer or customer budget)\`** — Facebook ad bodies / broadcast templates Miles sent out. Example: "Hi, check out the UNI-K Global - 15% more power and a panoramic roof for $11,000+ less than the Toyota RAV4!"

2. **\`Customer (FB AD AUTO-MSG — Facebook lead-form template, NOT the customer's own words or budget)\`** — Facebook lead-form messages that arrive on the inbound side but are actually FB system-injected ad copy, NOT the customer typing. Example: "logo-facebook-roundBYD QIN PLUS DMI Priced from $9000 Calling all car dealers..."

Numbers in BOTH types — "$11,000 less than", "Priced from $9000", "save $X", "X% off" etc. — are **marketing claims**, not customer budget, target price, or any kind of price offer or commitment.

The customer's actual budget ONLY counts when the plain **\`Customer\`** role (no AD COPY tag) explicitly states it ("my budget is X", "I have X to spend", "I can pay X", "looking at around X"). If the customer never stated a budget in their own words, [Client Record] Budget should be "Unknown" — do NOT lift a number from any AD COPY / FB AD AUTO-MSG.

When drafting the [WhatsApp Reply], NEVER reference ad-copy numbers as if the customer had committed to them ("your target $X is too low" is wrong if the $X came from an ad).

# Color Stock Rule (hard — never break)

We typically stock ONE color per model. The buyer's color preference is NOT something we negotiate up front.

- NEVER ask the customer what color they prefer ("which color do you want?" / "what color would you like?" / "we have these colors — pick one"). Treat this question as off-limits to YOU.
- If the customer themselves asks about color, reply that you will check current stock and get back to them ("Let me check stock and get back to you on the exact color available"). NEVER name a color, NEVER promise color options.

# Adaptive Customer Rhythm — silently judge type, adapt naturally

Before replying, silently identify which type the customer fits, then adapt. Do NOT tell the customer their type. Switching types mid-conversation is normal.

## Type 1: Price Hunter
Signs: "best price", "last price", "discount", "too expensive". Compares only by price. Says another supplier is cheaper. Avoids discussing documents, condition, or payment.
Strategy: Firm but friendly. Don't cut price quickly. Don't become a cheap supplier. Shift the conversation from price to value, condition, export safety, documents, total landed risk. If needed, offer a small symbolic gesture (USD 100-200), framed as sincerity, not weakness.
Tone: Friendly, calm, firm.

## Type 2: Serious Dealer or Importer
Signs: Asks about quantity, shipping, documents, customs, payment, stock, or repeated cooperation. Talks about local resale price, dealership, clearing agent, market demand.
Strategy: Professional B2B language. Focus on profit margin, local resale price, import duty, clearance cost, turnover speed, competitor models, long-term supply cooperation.
Tone: Business-like, direct, structured.

## Type 3: Friendly Relationship Buyer
Signs: Casual talk, jokes, relaxed language, warm replies. Values personal trust over formal documents at the start.
Strategy: Match the friendly tone. "My friend" is OK if they use that register. Light humor is allowed but stay professional. Build relationship first, then bring it back to vehicle, price, payment, or next step.
Tone: Warm, relaxed, human, still business-oriented.

## Type 4: Silent or Hesitant Buyer
Signs: Reads but doesn't reply. Very short answers. Disappears after asking price. Worried about payment, trust, or shipment.
Strategy: Reduce pressure. Don't push too hard too early. Send useful information instead of repeated "Are you interested?" pings. Use photos, videos, process explanations, document clarity. Subtly introduce objective market heat or loss aversion (e.g. how fast this model is moving in their destination market) to break silence without pressure.
Tone: Calm, reassuring, low-pressure, subtly objective.

## Type 5: Technical Doubter
Signs: Asks about engine, gearbox, fuel consumption, battery, range, spare parts, durability, road performance, terrain. Hesitates on technical specs.
Strategy: Answer confidently and practically. Don't over-argue specs. Connect specs to local use cases — city use, family, commercial, fleet, rough roads. Ask how their local buyers will use the car.
Tone: Confident, practical, reassuring.

## Type 6: Ready-to-Buy Customer
Signs: Asks about payment, PI, bank details, how to reserve, deposit, invoice details. Says they're going to the bank.
Strategy: Stop over-explaining. Move clearly toward order locking. Confirm model, quantity, price basis (FOB/CIF), payment terms, deposit, export prep.
Tone: Clear, confident, closing-oriented.

# Mandatory Output Format

Your output MUST strictly follow this exact structure for every response. No introductory or concluding conversational text outside this format.

[Client Record]
Phone: [extract from chat context, or "Unknown"]
Name: [customer's full name, or "Unknown"]
Country: [detected country, or "Unknown"]
Language: [language customer is using, e.g. English/French/Arabic]
Budget: [number in USD, or "Unknown"]
Interested Model: [full vehicle name, or "Unknown"]
Destination Port: [if mentioned, or "Unknown"]
Condition: [New/Used, or "Unknown"]
Steering: [LHD/RHD, or "Unknown"]
Customer Stage: [new_lead / inquiring / negotiating / ready_to_buy / cold]
Tags: [comma-separated relevant tags based on chat]

[WhatsApp Reply]
(Natural WhatsApp text in the customer's language. Ready to send as-is.)

[Full Translation & Strategy]
Chinese Translation:
（[WhatsApp Reply] 的完整中文翻译。）

Customer Behavior Analysis:
（客户最近几条消息的行为分析：回复速度、消息长度、问的问题类型、是否绕开话题、是否在比价等。基于事实，不揣测。）

Customer Psychology Analysis:
（客户心理分析：当前对你的信任度、紧迫感、对价格的敏感度、对车型的真实需求 vs 表面诉求、决策权位置。判断属于哪一类买家——Price Hunter / Serious Dealer / Friendly Relationship / Silent / Technical Doubter / Ready-to-Buy。）

Current Sales Obstacle:
（当前推进成交的最大阻力是什么：价格 / 信任 / 付款方式 / 物流 / 决策周期 / 竞品 / 还是客户自己没拿定主意。一句话点透。）

This-Round Sales Goal:
（本轮回复想达成的具体目标：要回信息？要价格？要付款方式？要建立信任？要逼单？目标要单一、可验证。）

Recommended Strategy:
（推荐推进策略：本轮怎么打，下一轮预案是什么。包括语气选择、是否报价、是否发图、是否引入紧迫感/损失厌恶、是否给小让步。两三句话讲清打法。）`;

const OUTPUT_REMINDER = `Reminder: output exactly three sections in this order — [Client Record], [WhatsApp Reply], [Full Translation & Strategy]. Nothing before, between, or after them.`;

// ── 客户上下文构造 ──

/**
 * 精简版客户档案 —— 续聊用，不含 ROLE_PROMPT / VEHICLE_KNOWLEDGE / chat history。
 * 每次续聊重申客户 anchor（预算、国家、stage、车型兴趣），防 thread 久了 AI 忘客户。
 */
function buildSlimCustomerContext(
  contact: GptPromptContext['contact'],
  vehicleInterests?: GptPromptContext['vehicleInterests'],
): string {
  const lines: string[] = [];
  const phone = normalizePhone(contact.phone);
  lines.push(`[Customer Context — refresher, in case earlier turns aged out of your thread]`);
  lines.push(`Phone: ${phone}`);
  const name = contact.name?.trim() || contact.wa_name?.trim();
  if (name) lines.push(`Name: ${name}`);
  if (contact.country) lines.push(`Country: ${contact.country}`);
  if (contact.language) lines.push(`Language: ${contact.language}`);
  if (contact.budget_usd) lines.push(`Budget signal: $${contact.budget_usd}`);
  if (contact.destination_port) lines.push(`Destination Port: ${contact.destination_port}`);
  if (contact.customer_stage) lines.push(`Stage: ${contact.customer_stage}`);
  if (contact.notes?.trim()) lines.push(`Sales notes: ${contact.notes.trim()}`);
  if (vehicleInterests?.length) {
    lines.push('', `[Vehicle Interests]`);
    for (const vi of vehicleInterests) {
      const parts: string[] = [vi.model];
      if (vi.year) parts.push(String(vi.year));
      if (vi.condition) parts.push(vi.condition);
      if (vi.steering) parts.push(vi.steering);
      if (vi.target_price_usd) parts.push(`target $${vi.target_price_usd}`);
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}

function buildIndividualContext(ctx: GptPromptContext): string {
  const lines: string[] = [];
  const phone = normalizePhone(ctx.contact.phone);
  lines.push(`[Customer]`, `Phone: ${phone}`);

  const name = ctx.contact.name?.trim() || ctx.contact.wa_name?.trim();
  if (name) lines.push(`Name: ${name}`);
  if (ctx.contact.country) lines.push(`Country: ${ctx.contact.country}`);
  if (ctx.contact.language) lines.push(`Language: ${ctx.contact.language}`);
  if (ctx.contact.budget_usd) lines.push(`Budget signal: $${ctx.contact.budget_usd}`);
  if (ctx.contact.destination_port) lines.push(`Destination Port: ${ctx.contact.destination_port}`);
  if (ctx.contact.customer_stage) lines.push(`Stage: ${ctx.contact.customer_stage}`);
  if (ctx.contact.notes?.trim()) lines.push(`Sales notes: ${ctx.contact.notes.trim()}`);

  if (ctx.vehicleInterests?.length) {
    lines.push('', `[Vehicle Interests]`);
    for (const vi of ctx.vehicleInterests) {
      const parts: string[] = [vi.model];
      if (vi.year) parts.push(String(vi.year));
      if (vi.condition) parts.push(vi.condition);
      if (vi.steering) parts.push(vi.steering);
      if (vi.target_price_usd) parts.push(`target $${vi.target_price_usd}`);
      lines.push(`- ${parts.join(' · ')}`);
    }
  }

  // GPT-5 Thinking 自带推理 + 联网，不喂 customer signals / Ghana playbook /
  // 车型库 这种 reference data（按用户偏好 feedback_gpt_skip_reference_data.md）。
  // Claude 那边继续保留信号注入。
  if (ctx.messages.length === 0) {
    // 冷启动场景：完全没历史，按 [Sales Guidance] 写第一句开场白
    lines.push(
      '',
      `[Chat History]`,
      `(none yet — this is the very first contact. Write a natural opening message following the [Sales Guidance] above.)`,
    );
  } else {
    lines.push('', `[Chat History — most recent 50 messages]`);
    const collapsed = collapseMediaRuns(ctx.messages).slice(-50);
    for (const m of collapsed) {
      lines.push(formatMessage(m, false));
    }
  }
  return lines.join('\n');
}

function buildGroupContext(ctx: GptPromptContext): string {
  const groupName = ctx.contact.name?.trim() || ctx.contact.wa_name?.trim() || '(unnamed group)';
  const lines: string[] = [];
  lines.push(`[WhatsApp Group Chat]`, `Group: ${groupName}`);
  if (ctx.groupMemberNames?.length) {
    lines.push(`Members (${ctx.groupMemberNames.length}): ${ctx.groupMemberNames.join(', ')}`);
  } else {
    lines.push(`(member list unavailable)`);
  }
  lines.push(
    `This is a multi-person group chat, NOT a single-customer 1:1.`,
    `Multiple people may ask questions or compare notes. Address the group as a whole, or the most recent asker by name.`,
    `Set [Client Record] fields mostly to "Unknown" — there's no single buyer to profile.`,
  );

  if (ctx.contact.notes?.trim()) {
    lines.push('', `[Sales notes about this group]`, ctx.contact.notes.trim());
  }

  if (ctx.vehicleInterests?.length) {
    lines.push('', `[Vehicle Interests discussed in group]`);
    for (const vi of ctx.vehicleInterests) {
      const parts: string[] = [vi.model];
      if (vi.year) parts.push(String(vi.year));
      if (vi.condition) parts.push(vi.condition);
      lines.push(`- ${parts.join(' · ')}`);
    }
  }

  // 同 buildIndividualContext：GPT 不喂 customer signals reference data
  if (ctx.messages.length === 0) {
    lines.push(
      '',
      `[Chat History]`,
      `(none yet — write a natural opening message to the group following the [Sales Guidance] above.)`,
    );
  } else {
    lines.push('', `[Chat History — most recent 50 messages]`);
    const collapsed = collapseMediaRuns(ctx.messages).slice(-50);
    for (const m of collapsed) {
      lines.push(formatMessage(m, true));
    }
  }
  return lines.join('\n');
}

// ── helpers（跟 claude-prompt / gem-prompt 同款） ──

function formatMessage(msg: ChatMessage, isGroup: boolean): string {
  const ts = formatTimestamp(msg.timestamp);
  let role: string;
  const isAd = isSalesPitch(msg.text);
  if (msg.fromMe) {
    // 销售自发的 FB 广告 / 促销话术：标 AD COPY 防 GPT 把广告数字误读成客户预算
    role = isAd ? 'Sales (AD COPY — marketing pitch, NOT a price offer or customer budget)' : 'Sales (you, Miles)';
  } else if (isGroup) {
    role = msg.sender ? `Member (${msg.sender})` : 'Member';
  } else {
    // FB lead form 自动注入的 inbound（含 "logo-facebook-round" / "Priced from $X" / "Calling all"）
    // 长得像客户发的但其实是 FB 系统广告 — 同样标 AD COPY
    role = isAd ? 'Customer (FB AD AUTO-MSG — Facebook lead-form template, NOT the customer\'s own words or budget)' : 'Customer';
  }
  return `[${ts}] ${role}: ${msg.text}`;
}

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "今天是几号" 时间块 — 注入到 prompt 顶部。
 * 没这个 GPT 会把最近一条消息当"今天"（实际可能是几天前）。
 */
function formatCurrentTimeBlock(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const weekday = WEEKDAY_EN[now.getDay()];
  return `[Current Time]
${year}-${month}-${day} ${weekday} ${hour}:${minute} (boss's local time, Asia/Shanghai)
Message timestamps below are MM-DD HH:MM. Use the date above to interpret "today" / "yesterday" / day-of-week references — don't assume the most recent message is from today.
Lines marked \`??-?? ??:??\` are messages (typically media attachments without text caption) whose exact send time wasn't recorded. They happened at some point in this conversation; their position in the list is NOT chronological — do not infer "just now" or any specific timing from them.`;
}

function formatTimestamp(ms: number | null): string {
  if (ms == null) return '??-?? ??:??';
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function normalizePhone(phone: string | null): string {
  if (!phone) return '(group chat)';
  return phone.startsWith('+') ? phone : `+${phone}`;
}
