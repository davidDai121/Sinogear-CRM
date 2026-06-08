import type { ChatMessage } from '@/content/whatsapp-messages';
import type { Database } from './database.types';
import { isSalesPitch } from './sales-pitch';
import { collapseMediaRuns } from './chat-media-utils';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type VehicleInterestRow = Database['public']['Tables']['vehicle_interests']['Row'];

export interface GemPromptContext {
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
  /** 群成员名（Phase 2 GroupMembersSection 已能拿到）— 用于让 Gem 知道这个群里都有谁 */
  groupMemberNames?: string[];
}

/**
 * 第一次给 Gem 发完整上下文。
 * 自动判断个人 vs 群聊：contact.group_jid 非空时切到群聊格式。
 */
export function formatNewCustomer(ctx: GemPromptContext): string {
  return ctx.contact.group_jid ? formatNewGroup(ctx) : formatNewIndividual(ctx);
}

function formatNewIndividual(ctx: GemPromptContext): string {
  const phone = normalizePhone(ctx.contact.phone);
  const lines = [`[Customer Phone: ${phone}]`, '', formatCurrentTimeBlock()];

  const profile = buildProfileLines(ctx.contact);
  if (profile.length) {
    lines.push('', '[Customer Profile]', ...profile);
  }

  if (ctx.vehicleInterests?.length) {
    lines.push('', '[Vehicle Interests]');
    for (const vi of ctx.vehicleInterests) {
      const parts: string[] = [vi.model];
      if (vi.year) parts.push(String(vi.year));
      if (vi.condition) parts.push(vi.condition);
      if (vi.steering) parts.push(vi.steering);
      if (vi.target_price_usd) parts.push(`target $${vi.target_price_usd}`);
      lines.push(`- ${parts.join(' · ')}`);
    }
  }

  if (ctx.messages.length === 0) {
    // 冷启动：完全没历史，按 [Sales Guidance] / Gem 指令写第一句开场白
    lines.push(
      '',
      '[Chat Messages]',
      '(none yet — this is the very first contact. Write a natural opening message.)',
    );
  } else {
    lines.push('', '[Chat Messages]');
    // 先合并连续的媒体附件，再取最近 50 条 —— 不然 prompt 里全是 IMG-xxx.jpg 占位
    const collapsed = collapseMediaRuns(ctx.messages);
    const recent = collapsed.slice(-50);
    for (const msg of recent) {
      lines.push(formatMessage(msg, false));
    }
  }

  lines.push('', FORMAT_CONSTRAINT);
  return lines.join('\n');
}

function formatNewGroup(ctx: GemPromptContext): string {
  const groupName = ctx.contact.name?.trim() || ctx.contact.wa_name?.trim() || '(unnamed group)';
  const memberCount = ctx.groupMemberNames?.length;
  const lines = [
    `[WhatsApp Group Chat]`,
    `Group Name: ${groupName}`,
    memberCount ? `Members (${memberCount}): ${ctx.groupMemberNames!.join(', ')}` : `(member list unavailable)`,
    '',
    formatCurrentTimeBlock(),
    '',
    `This is a multi-person group chat, NOT a single-customer 1:1 conversation.`,
    `Multiple people may be asking questions, comparing notes, or chatting casually.`,
    `Treat each non-Sales message as coming from the named sender (shown in [Chat Messages]).`,
    `When drafting [WhatsApp Reply], address the group as a whole or address the most recent asker by name.`,
    `Skip [Client Record] — there's no single buyer to record fields for.`,
  ];

  // group context can still have notes (sales' own group memo) but country/language/budget skipped
  if (ctx.contact.notes?.trim()) {
    lines.push('', '[Sales Notes about this group]', ctx.contact.notes.trim());
  }

  if (ctx.vehicleInterests?.length) {
    lines.push('', '[Vehicle Interests discussed in group]');
    for (const vi of ctx.vehicleInterests) {
      const parts: string[] = [vi.model];
      if (vi.year) parts.push(String(vi.year));
      if (vi.condition) parts.push(vi.condition);
      if (vi.steering) parts.push(vi.steering);
      if (vi.target_price_usd) parts.push(`target $${vi.target_price_usd}`);
      lines.push(`- ${parts.join(' · ')}`);
    }
  }

  if (ctx.messages.length === 0) {
    lines.push(
      '',
      '[Chat Messages]',
      '(none yet — write a natural opening message to the group.)',
    );
  } else {
    lines.push('', '[Chat Messages]');
    const collapsed = collapseMediaRuns(ctx.messages);
    const recent = collapsed.slice(-50);
    for (const msg of recent) {
      lines.push(formatMessage(msg, true));
    }
  }

  lines.push('', FORMAT_CONSTRAINT);
  return lines.join('\n');
}

/**
 * 已有 Gem 对话，重发最近 50 条聊天消息（跟首次对齐）。
 *
 * 之前只带 5 条，导致客户上一轮回复后又陆续发了几条新消息时，Gem 看不到关键信息
 * （典型：客户给了预算 / 改了车型 / 新发图）。统一 50 条覆盖跨多轮场景。
 *
 * 续聊也带精简客户档案（contact + vehicleInterests）—— 防 Gem 对话跑久 / 上下文
 * 被截断后客户 anchor（预算、国家、stage）丢失。群聊不带（多人不是单一客户）。
 */
export function formatUpdate(
  phoneOrGroupName: string | null,
  newMessages: ChatMessage[],
  isGroup = false,
  contact?: GemPromptContext['contact'],
  vehicleInterests?: GemPromptContext['vehicleInterests'],
): string {
  const header = isGroup
    ? `[Update - Group: ${phoneOrGroupName ?? '(unknown)'}]`
    : `[Update - Phone: ${normalizePhone(phoneOrGroupName)}]`;
  // 续聊每次都注入当前时间 — Gem 对话 thread 不知道唤起时刻
  const lines = [header, '', formatCurrentTimeBlock(), ''];

  // 续聊也带客户档案（个人聊天才有意义；群聊跳过）
  if (contact && !isGroup) {
    lines.push(
      `[Customer Profile — refresher, in case earlier turns aged out]`,
      ...buildProfileLines(contact),
    );
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
    lines.push('');
  }

  // 标题诚实化：之前没标题（直接铺消息），改成显式说明这是最近 50 条
  lines.push(`[Recent Chat Messages — last 50, may overlap with what you've already seen in this thread]`);
  const collapsed = collapseMediaRuns(newMessages).slice(-50);
  for (const msg of collapsed) {
    lines.push(formatMessage(msg, isGroup));
  }
  lines.push('', FORMAT_CONSTRAINT);
  return lines.join('\n');
}

/**
 * 销售引导：让 Gem 调整回复方向
 */
export function formatGuidance(guidance: string): string {
  return `[Sales Guidance]\n${guidance.trim()}\n\n${FORMAT_CONSTRAINT}`;
}

/**
 * 强制 Gem 把 [WhatsApp Reply] 分段输出，避免一大坨墙文字客户读不下去。
 * 顺带塞了 AD COPY 规则 —— Gem 的 system prompt 在用户 Gem builder 里改不动，
 * 但这段 FORMAT_CONSTRAINT 每次都会拼到对话末尾，作为兜底说明。
 *
 * ⚠️ 2026-06：Flash 模型续聊时偶尔只输出 [Translation & Strategy] 不出
 * [WhatsApp Reply]（认为已经给过），导致 boss 拿不到英文文本要去 Gemini
 * 自取。新增 [Required Sections] 段明确强制每轮都必须输出两段。
 */
const FORMAT_CONSTRAINT = `[Required Sections — EVERY turn, including followup]
Every response MUST contain BOTH of these sections in this order:
1. [WhatsApp Reply]
   The reply to send the customer, in the customer's language (English / French / Spanish / Arabic etc).
   Even in followup / continuation turns where you already gave a reply earlier, you must STILL output a fresh [WhatsApp Reply] for THIS turn. Do not skip it just because you've replied before — Miles needs the English/foreign-language text to copy-paste into WhatsApp.
2. [Translation & Strategy]
   Chinese translation of the [WhatsApp Reply] + brief strategy notes for Miles (in 中文).
[Client Record] is optional and only when customer info changed.

[Format Constraint]
The [WhatsApp Reply] section MUST be split into 2-4 short paragraphs.
Separate paragraphs with a single blank line (i.e. \\n\\n).
Each paragraph: max 2-3 sentences. No single paragraph longer than ~50 words.
This is mandatory for readability — customers won't read a wall of text.

[Ad Copy Rule — hard, never break]
Two kinds of messages in [Chat Messages] contain marketing numbers that are NOT the customer's budget:
(1) \`Sales (AD COPY — marketing pitch, NOT customer budget)\` = FB ad / promo Miles sent out ("$11,000+ less than RAV4", "save $X").
(2) \`Customer (FB AD AUTO-MSG — Facebook lead template, NOT customer budget)\` = inbound FB lead-form template, looks like the customer wrote it but is system-injected ad copy ("Priced from $9000", "Calling all car dealers", "logo-facebook-round").
Numbers in BOTH types are marketing claims, never the customer's budget or commitment. The customer's real budget only counts when the plain \`Customer\` role (no tag) explicitly says it ("my budget is X" / "I have X"). Do NOT write AD COPY / FB AD AUTO-MSG numbers into [Client Record] Budget, and do NOT reference them in [WhatsApp Reply] as if the customer committed to them.`;

function buildProfileLines(
  contact: GemPromptContext['contact'],
): string[] {
  const lines: string[] = [];
  const name = contact.name?.trim() || contact.wa_name?.trim();
  if (name) lines.push(`Name: ${name}`);
  if (contact.country) lines.push(`Country: ${contact.country}`);
  if (contact.language) lines.push(`Language: ${contact.language}`);
  if (contact.budget_usd) lines.push(`Budget: $${contact.budget_usd}`);
  if (contact.destination_port) {
    lines.push(`Destination Port: ${contact.destination_port}`);
  }
  if (contact.customer_stage) lines.push(`Stage: ${contact.customer_stage}`);
  if (contact.notes?.trim()) lines.push(`Notes: ${contact.notes.trim()}`);
  return lines;
}

function formatMessage(msg: ChatMessage, isGroup: boolean): string {
  const ts = formatTimestamp(msg.timestamp);
  let role: string;
  const isAd = isSalesPitch(msg.text);
  if (msg.fromMe) {
    // 销售自发的 FB 广告 / 促销话术
    role = isAd ? 'Sales (AD COPY — marketing pitch, NOT customer budget)' : 'Sales';
  } else if (isGroup) {
    role = msg.sender ? `Member (${msg.sender})` : 'Member';
  } else {
    // FB lead form 自动注入的 inbound — 长得像客户发的但实际是 FB 广告模板
    role = isAd ? 'Customer (FB AD AUTO-MSG — Facebook lead template, NOT customer budget)' : 'Customer';
  }
  return `[${ts}] ${role}: ${msg.text}`;
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

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "今天是几号" 时间块 — 注入到 prompt 顶部。
 * 没这个 Gem 会把最近一条消息当"今天"（实际可能是几天前）。
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

function normalizePhone(phone: string | null): string {
  if (!phone) return '(group chat)';
  return phone.startsWith('+') ? phone : `+${phone}`;
}
