export interface ChatMessage {
  id: string;
  fromMe: boolean;
  text: string;
  timestamp: number | null;
  /** 群聊消息的发送者显示名（个人聊天恒为 null） */
  sender: string | null;
}

function findMainPane(): Element | null {
  return (
    document.querySelector('div#main') ||
    document.querySelector('[data-testid="conversation-panel"]')
  );
}

function readStrippingInjections(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('.sgc-translation, .sgc-translate-btn')
    .forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || '').trim();
}

function getMessageText(scope: Element): string {
  // 优先抓真正的消息体（有 data-pre-plain-text 属性的 .copyable-text 才是消息正文 wrapper）。
  // 不带 data-pre-plain-text 的 .copyable-text 是引用气泡 / Facebook 广告 header 卡片
  // ("Facebook 广告" / "查看详情") — 直接抓第一个 .copyable-text .selectable-text
  // 会拿到 header，把正文 "Hi, check out the UNI-K Global..." 整段丢掉。
  const realWrap = scope.querySelector(
    '.copyable-text[data-pre-plain-text]',
  ) as HTMLElement | null;
  if (realWrap) {
    const sel = realWrap.querySelector('.selectable-text') as HTMLElement | null;
    if (sel) {
      const text = readStrippingInjections(sel);
      if (text) return text;
    }
    const wrapText = readStrippingInjections(realWrap);
    if (wrapText) return wrapText;
  }

  // FB 广告气泡 / 引用回复等多 .copyable-text 的场景：data-pre-plain-text 缺失时，
  // 挑文本最长的 .selectable-text — header 短（"Facebook 广告"），正文长，取最长不会错。
  const allSelectables = scope.querySelectorAll<HTMLElement>(
    '.copyable-text .selectable-text',
  );
  let longest = '';
  for (const el of allSelectables) {
    const text = readStrippingInjections(el);
    if (text.length > longest.length) longest = text;
  }
  if (longest) return longest;

  const fallback = scope.querySelector('.selectable-text') as HTMLElement | null;
  if (fallback) {
    const text = readStrippingInjections(fallback);
    if (text) return text;
  }

  const anyCopyable = scope.querySelector('.copyable-text') as HTMLElement | null;
  return anyCopyable ? readStrippingInjections(anyCopyable) : '';
}

function findDataId(el: Element): string | null {
  // 优先：用 [data-testid^="conv-msg-"] 这个消息级标记的 closest()，不限层数。
  // 新版 WA Web (2026-05+) 把 data-id 挪到了 .message-in/out 的 3 层祖父之上，
  // 老的固定 N 层爬（3/6）一旦 DOM 微调就全军覆没（这次正好就是 inbound 客户消息
  // 全部丢失的根因 — 客户的所有文字 bubble 从未进 messages 表）。
  // `conv-msg-` 是 message-level wrapper 独有的 testid 前缀，不会撞 FB 广告 / 会话级
  // 共享 wrapper（那些没 conv-msg- testid，长度判定也兜底）。
  const msgWrap = el.closest('[data-testid^="conv-msg-"]');
  const wrapId = msgWrap?.getAttribute('data-id');
  if (wrapId) return wrapId;

  // 兜底：testid 不存在 / 命名变了时走层数爬，加 length 过滤防共享 wrapper
  // （单条消息的 data-id 通常 16+ 字符 hex；会话级 wrapper 一般更短或纯数字）
  let cur: Element | null = el;
  for (let i = 0; cur && i < 6; i++) {
    const id = cur.getAttribute('data-id');
    if (id && id.length >= 16) return id;
    cur = cur.parentElement;
  }
  return null;
}

function parsePrePlainText(pre: string): number | null {
  const m = pre.match(/\[([^\]]+)\]/);
  if (!m) return null;
  const inner = m[1].trim();

  const parts = inner.split(',').map((s) => s.trim());
  if (parts.length !== 2) return null;
  const [timePart, datePart] = parts;

  const timeMatch = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/);
  if (!timeMatch) return null;
  let hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = timeMatch[3] ? Number(timeMatch[3]) : 0;
  const meridiem = timeMatch[4]?.toUpperCase();
  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  const numbers = datePart.match(/\d+/g)?.map(Number);
  if (!numbers || numbers.length < 3) return null;

  let year: number, month: number, day: number;
  const yearIdx = numbers.findIndex((n) => n >= 1900);
  if (yearIdx === -1) return null;

  year = numbers[yearIdx];
  const others = numbers.filter((_, i) => i !== yearIdx);
  if (others.length < 2) return null;

  if (yearIdx === 0) {
    [month, day] = others;
  } else {
    if (datePart.includes('.') || datePart.includes('/') && /^\d+\/\d+\/\d+$/.test(datePart)) {
      [month, day] = others;
      if (month > 12 && day <= 12) {
        const tmp = month;
        month = day;
        day = tmp;
      }
    } else {
      [month, day] = others;
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day, hours, minutes, seconds);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function getMessageTimestamp(scope: Element): number | null {
  const copyable = scope.querySelector('.copyable-text[data-pre-plain-text]') as HTMLElement | null;
  const pre = copyable?.getAttribute('data-pre-plain-text');
  if (pre) {
    const ts = parsePrePlainText(pre);
    if (ts) return ts;
  }
  return null;
}

/**
 * 从 data-pre-plain-text 解析发送者名（仅群聊有意义）。
 * 格式："[2:46 PM, 5/9/2026] Aca: " 或 "[14:46, 9/5/2026] Aca: "
 * 个人聊天里这部分会是空（或 "You: " / 收件人手机号），返回 null。
 */
function getMessageSender(scope: Element): string | null {
  const copyable = scope.querySelector('.copyable-text[data-pre-plain-text]') as HTMLElement | null;
  const pre = copyable?.getAttribute('data-pre-plain-text');
  if (!pre) return null;
  // 取最后一个 ']' 之后到 ':' 之前的部分作为发送者
  const idx = pre.lastIndexOf(']');
  if (idx < 0) return null;
  const after = pre.slice(idx + 1).trim();
  const colonIdx = after.indexOf(':');
  if (colonIdx < 0) return null;
  const name = after.slice(0, colonIdx).trim();
  if (!name) return null;
  // "You" / 手机号 / "~" 开头的 push name 都不当作群成员名
  if (/^you$/i.test(name) || /^\+?\d[\d\s\-()]{4,}$/.test(name)) return null;
  return name;
}

/**
 * 探测空文本 bubble 的媒体类型（图/视频/音频/文档），返回中文占位符。
 *
 * 原本 readChatMessages 对空文本直接 `continue`，导致销售/客户发的图、视频、
 * 语音根本不入 messages 表 → AI prompt 看不到"我给客户发了 N 张图"这种关键
 * 上下文（销售刚发完车型图，AI 完全不知道）。
 *
 * 现在改成：探测 bubble 里有什么元素，返回对应占位符（沿用导入 .txt 的 `[媒体]`
 * 风格但带类型）。下游 isMediaOnly + collapseMediaRuns 识别这些占位合并成
 * "Sales sent N photos" 等人话给 AI。
 *
 * DOM selector 都是基于 WA Web 当前版本的观察，可能随版本漂移；都加了 fallback。
 */
function detectMediaKind(scope: Element): string {
  // 图片：bubble 内 <img> 排除 emoji / avatar / sticker icon
  const imgs = Array.from(scope.querySelectorAll('img'));
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    // emoji / wa avatar / 占位图通常 url 短或带 emoji/avatar 字样
    if (src.startsWith('blob:') || src.includes('/web-pack/') || src.startsWith('data:image/webp')) {
      // blob: 多数是真附件；data:image/webp 是 sticker
      if (src.startsWith('data:image/webp')) return '[贴纸]';
      if (src.startsWith('blob:')) return '[图片]';
    }
  }

  // 视频：<video> 元素或 video icon
  if (scope.querySelector('video')) return '[视频]';

  // 语音 / 音频：[data-testid*="audio"] 或 audio 元素
  if (
    scope.querySelector('audio') ||
    scope.querySelector('[data-testid*="audio" i]') ||
    scope.querySelector('[aria-label*="语音" i], [aria-label*="voice" i], [aria-label*="audio" i]')
  ) {
    return '[语音]';
  }

  // 文档（PDF/Excel/Word 等）：通常有 download icon 或 [data-testid*="document"]
  if (
    scope.querySelector('[data-testid*="document" i]') ||
    scope.querySelector('[data-icon="document"]') ||
    scope.querySelector('[aria-label*="document" i], [aria-label*="文档" i], [aria-label*="文件" i]')
  ) {
    return '[文档]';
  }

  // 兜底
  return '[媒体]';
}

export function readChatMessages(limit = 30): ChatMessage[] {
  const main = findMainPane();
  if (!main) return [];

  const allMatches = Array.from(main.querySelectorAll('.message-in, .message-out'));
  // 只留顶层气泡：嵌套在另一个 .message-in/.message-out 里的元素是 quoted reply 的引用
  // 上下文（销售引用客户原话 → 内层 .message-in；客户引用销售 → 内层 .message-out），
  // 不是独立消息。不过滤的话，内层会被当成一条"凭空冒出的对话"喂给 AI，方向还跟外层反着，
  // 用户场景："我发附件给客户，AI 误认为是客户发给我的" 就是这么来的。
  const bubbles = allMatches.filter((el) => {
    let cur = el.parentElement;
    while (cur && cur !== main) {
      if (cur.classList.contains('message-in') || cur.classList.contains('message-out')) {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  });

  const messages: ChatMessage[] = [];
  const seen = new Set<string>();

  for (const bubble of bubbles) {
    const id = findDataId(bubble);
    if (!id || seen.has(id)) continue;

    let text = getMessageText(bubble);
    // 空 text 通常是图/视频/语音 bubble — 探测类型占位，让消息能进 messages 表 + AI 能看到
    if (!text) {
      text = detectMediaKind(bubble);
    }

    seen.add(id);
    const fromMe = bubble.classList.contains('message-out');
    messages.push({
      id,
      fromMe,
      text,
      timestamp: getMessageTimestamp(bubble),
      sender: fromMe ? null : getMessageSender(bubble),
    });
  }

  return messages.slice(-limit);
}

export function chatFingerprint(messages: ChatMessage[]): string {
  if (!messages.length) return 'empty';
  const tail = messages.slice(-5).map((m) => m.id).join('|');
  return `${messages.length}:${tail}`;
}

/**
 * 轮询 readChatMessages，等待消息渲染完成。
 * 用于 jumpToChat 之后，避免 800ms 固定等待对冷加载聊天不够。
 *
 * ⚠️ 之前是"count >= minCount 就返回"——WA Web 渲染消息是从下往上慢慢出现的，
 * 销售刚发完图就点 Generate 时 DOM 上常常只有最新 1 条 bubble，函数立刻返回，
 * AI prompt 就只有这 1 条上下文，整段聊天历史全丢。
 *
 * 改成"count 稳定 STABLE_POLLS 次后才返回"：每 POLL_INTERVAL ms 读一次，count
 * 不再增长就认为 DOM 渲染完毕。chat 真的只有 1 条消息也只多等 STABLE_POLLS *
 * POLL_INTERVAL ≈ 600ms，可接受。
 */
export async function waitForChatMessages(
  timeoutMs = 5000,
  limit = 30,
  minCount = 1,
): Promise<ChatMessage[]> {
  const POLL_INTERVAL = 200;
  const STABLE_POLLS = 3;
  const start = Date.now();
  let last: ChatMessage[] = [];
  let stableHits = 0;
  let prevLen = -1;
  while (Date.now() - start < timeoutMs) {
    last = readChatMessages(limit);
    if (last.length >= minCount) {
      if (last.length === prevLen) {
        stableHits++;
        if (stableHits >= STABLE_POLLS) return last;
      } else {
        stableHits = 0;
        prevLen = last.length;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return last;
}
