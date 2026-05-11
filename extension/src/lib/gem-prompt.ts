import type { ChatMessage } from '@/content/whatsapp-messages';
import type { Database } from './database.types';

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
  const lines = [`[Customer Phone: ${phone}]`];

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

  lines.push('', '[Chat Messages]');
  // 先合并连续的媒体附件，再取最近 50 条 —— 不然 prompt 里全是 IMG-xxx.jpg 占位
  const collapsed = collapseMediaRuns(ctx.messages);
  const recent = collapsed.slice(-50);
  for (const msg of recent) {
    lines.push(formatMessage(msg, false));
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

  lines.push('', '[Chat Messages]');
  const collapsed = collapseMediaRuns(ctx.messages);
  const recent = collapsed.slice(-50);
  for (const msg of recent) {
    lines.push(formatMessage(msg, true));
  }

  lines.push('', FORMAT_CONSTRAINT);
  return lines.join('\n');
}

/**
 * 已有 Gem 对话，只发新消息（最近 5 条逻辑消息，媒体连发已合并）
 */
export function formatUpdate(
  phoneOrGroupName: string | null,
  newMessages: ChatMessage[],
  isGroup = false,
): string {
  const header = isGroup
    ? `[Update - Group: ${phoneOrGroupName ?? '(unknown)'}]`
    : `[Update - Phone: ${normalizePhone(phoneOrGroupName)}]`;
  const lines = [header];
  const collapsed = collapseMediaRuns(newMessages).slice(-5);
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
 */
const FORMAT_CONSTRAINT = `[Format Constraint]
The [WhatsApp Reply] section MUST be split into 2-4 short paragraphs.
Separate paragraphs with a single blank line (i.e. \\n\\n).
Each paragraph: max 2-3 sentences. No single paragraph longer than ~50 words.
This is mandatory for readability — customers won't read a wall of text.`;

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
  if (msg.fromMe) {
    role = 'Sales';
  } else if (isGroup) {
    // 群里发言人优先用 sender，没有就用通用 "Member"
    role = msg.sender ? `Member (${msg.sender})` : 'Member';
  } else {
    role = 'Customer';
  }
  return `[${ts}] ${role}: ${msg.text}`;
}

/**
 * 判断一条消息是不是「纯媒体附件」—— 文本只是图片/视频/文档的占位符，没有真实内容
 *  - `[媒体]`（导入解析时把 `<省略影音内容>` 替换成的占位）
 *  - `IMG-20260505-WA0014.jpg (文件附件)` / `VID-...mp4 (文件附件)` 等手机端导出格式
 *  - 空文本（DOM 端图片消息没 caption 时）
 */
function isMediaOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t === '[媒体]' || t === '<媒体>') return true;
  // 手机端导出的文件附件占位（IMG/VID/AUD/DOC/PTT/STK 等）
  if (
    /^‎?(IMG|VID|VIDEO|AUD|AUDIO|DOC|PTT|STK|PHOTO|GIF)[-_].+\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|opus|m4a|mp3|pdf|docx?|xlsx?|pptx?)\s*\(文件附件\)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 合并连续的媒体消息：同一发送方连续 N 条纯附件 → 1 行 `<sent N media items>`，
 * 给 Gem 让出空间给真正的对话内容。单条媒体也会缩成 `<sent 1 media item>` 简化。
 */
function collapseMediaRuns(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let run: ChatMessage[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const n = run.length;
    result.push({
      id: first.id + (n > 1 ? `:+${n - 1}` : ''),
      fromMe: first.fromMe,
      text:
        n === 1
          ? '<sent 1 media item>'
          : `<sent ${n} media items in a row>`,
      timestamp: last.timestamp ?? first.timestamp,
      sender: first.sender,
    });
    run = [];
  };

  for (const m of messages) {
    if (isMediaOnly(m.text)) {
      if (run.length === 0 || run[run.length - 1].fromMe === m.fromMe) {
        run.push(m);
      } else {
        flush();
        run.push(m);
      }
    } else {
      flush();
      result.push(m);
    }
  }
  flush();
  return result;
}

function formatTimestamp(ms: number | null): string {
  const d = ms ? new Date(ms) : new Date();
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
