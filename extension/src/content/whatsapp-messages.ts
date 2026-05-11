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
  const copyable = scope.querySelector('.copyable-text .selectable-text') as HTMLElement | null;
  if (copyable) {
    const text = readStrippingInjections(copyable);
    if (text) return text;
  }

  const fallback = scope.querySelector('.selectable-text') as HTMLElement | null;
  if (fallback) {
    const text = readStrippingInjections(fallback);
    if (text) return text;
  }

  const anyCopyable = scope.querySelector('.copyable-text') as HTMLElement | null;
  return anyCopyable ? readStrippingInjections(anyCopyable) : '';
}

function findDataId(el: Element): string | null {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 6; i++) {
    const id = cur.getAttribute('data-id');
    if (id) return id;
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

export function readChatMessages(limit = 30): ChatMessage[] {
  const main = findMainPane();
  if (!main) return [];

  const bubbles = Array.from(main.querySelectorAll('.message-in, .message-out'));

  const messages: ChatMessage[] = [];
  const seen = new Set<string>();

  for (const bubble of bubbles) {
    const id = findDataId(bubble);
    if (!id || seen.has(id)) continue;

    const text = getMessageText(bubble);
    if (!text) continue;

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
 */
export async function waitForChatMessages(
  timeoutMs = 5000,
  limit = 30,
  minCount = 1,
): Promise<ChatMessage[]> {
  const start = Date.now();
  let last: ChatMessage[] = [];
  while (Date.now() - start < timeoutMs) {
    last = readChatMessages(limit);
    if (last.length >= minCount) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}
