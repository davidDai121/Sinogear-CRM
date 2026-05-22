import { readWhatsAppData, jidToPhone } from '@/lib/whatsapp-idb';
import { rememberJidPhone } from '@/lib/jid-phone-cache';

export interface CurrentChat {
  name: string | null;
  phone: string | null;
  rawJid: string | null;
  groupJid: string | null;
}

const EMPTY_CHAT: CurrentChat = { name: null, phone: null, rawJid: null, groupJid: null };

const JID_RE = /(\d{7,})@(?:c\.us|s\.whatsapp\.net|lid)/;
// 群聊 JID 两种格式：
//   旧格式（2022 前）：<creator_phone>-<creation_timestamp>@g.us  例：8613552592187-1612345678@g.us
//   新格式（2022 后）：纯长数字（18-19 位）@g.us                  例：120363025246012345@g.us
const GROUP_JID_RE = /(\d{7,}(?:-\d+)?)@g\.us/;
const PHONE_TEXT_RE = /^\+?\s*(\d[\d\s\-().]{6,}\d)$/;

interface CacheEntry {
  phone: string | null;
  jid: string;
  groupJid: string | null;
}

let nameToPhoneCache = new Map<string, CacheEntry>();

/**
 * 归一化名字做 cache key。WA Web 在 DOM header 偶尔显示 typographic 引号
 * （'）而 IDB chat.name 存的是 ASCII 单引号（'）—— 不归一化时
 * "China car's" vs "China car's" 完全不匹配。同时 trim 防尾空格。
 */
function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"');
}

/** 上次因 cache miss 触发 refresh 的时间戳，防止抖动期间疯狂 refresh */
let lastCacheMissRefreshAt = 0;

export async function refreshChatNameCache(): Promise<void> {
  try {
    const wa = await readWhatsAppData();
    const next = new Map<string, CacheEntry>();

    const addEntry = (name: string | null | undefined, jid: string) => {
      if (!name) return;
      const key = normalizeName(name);
      if (!key) return;
      if (next.has(key)) return;
      // 群聊：jid 以 @g.us 结尾
      if (jid.endsWith('@g.us')) {
        next.set(key, { phone: null, jid, groupJid: jid });
        return;
      }
      const direct = jidToPhone(jid);
      if (direct) {
        next.set(key, { phone: direct, jid, groupJid: null });
        return;
      }
      const phoneJid = wa.jidToPhoneJid.get(jid);
      if (phoneJid) {
        const phone = jidToPhone(phoneJid);
        if (phone) next.set(key, { phone, jid, groupJid: null });
      }
    };

    for (const c of wa.contacts) {
      addEntry(c.name, c.id);
      addEntry(c.shortName, c.id);
      addEntry(c.pushname, c.id);
    }
    for (const chat of wa.chats) {
      addEntry(chat.name, chat.id);
    }
    nameToPhoneCache = next;
  } catch {
    // silent
  }
}

function findMainPane(): Element | null {
  return (
    document.querySelector('div#main') ||
    document.querySelector('[data-testid="conversation-panel"]')
  );
}

/**
 * 2026-05 起 WA Web 不再把 JID 放进 DOM attribute，但 React fiber 上的
 * `chat` model 仍然保留完整结构（id._serialized / contact.phoneNumber /
 * formattedTitle）。`#main` 元素 fiber 向上 ~5 层就有这个 chat 对象。
 *
 * 字段名带 `__x_` 前缀是 MobX observable 包装的产物；同时直接名 (`id`,
 * `contact`, `phoneNumber`) 在某些组件层也可能存在——两个都试一下。
 */
function getXProp<T = unknown>(obj: unknown, key: string): T | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const v = o[key] ?? o[`__x_${key}`];
  return (v as T) ?? null;
}

/** JID 字段可能是裸字符串 `"233@c.us"` 或对象 `{_serialized: "233@c.us"}`，统一抽出 string */
function asJidString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const ser = (v as Record<string, unknown>)._serialized;
    if (typeof ser === 'string') return ser;
  }
  return null;
}

interface FiberChatModel {
  id?: unknown;
  __x_id?: unknown;
  formattedTitle?: string;
  __x_formattedTitle?: string;
  contact?: unknown;
  __x_contact?: unknown;
}

function readChatFromMainFiber(main: Element): {
  name: string | null;
  phone: string | null;
  rawJid: string | null;
  groupJid: string | null;
} | null {
  const fiberKey = Object.keys(main).find((k) => k.startsWith('__reactFiber'));
  if (!fiberKey) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = (main as any)[fiberKey];
  let depth = 0;
  let chat: FiberChatModel | null = null;
  while (cur && depth < 15) {
    const mp = cur.memoizedProps;
    if (mp && typeof mp === 'object') {
      const candidate = mp.chat as FiberChatModel | undefined;
      const idStr = asJidString(getXProp(candidate, 'id'));
      if (candidate && idStr) {
        chat = candidate;
        break;
      }
    }
    cur = cur.return;
    depth++;
  }
  if (!chat) return null;

  const chatJid = asJidString(getXProp(chat, 'id'));
  if (!chatJid) return null;

  const nameRaw = getXProp(chat, 'formattedTitle');
  const name = typeof nameRaw === 'string' ? nameRaw : null;

  if (chatJid.endsWith('@g.us')) {
    return { name, phone: null, rawJid: chatJid, groupJid: chatJid };
  }

  // 个人聊天：@c.us 直接含手机号；@lid 业务号要看 contact.phoneNumber 拿真实 @c.us
  let phone = jidToPhone(chatJid);
  if (!phone) {
    const contact = getXProp(chat, 'contact');
    const pnJid = asJidString(getXProp(contact, 'phoneNumber'));
    if (pnJid) phone = jidToPhone(pnJid);
  }
  return { name, phone, rawJid: chatJid, groupJid: null };
}

function readNameFromHeader(scope: ParentNode): string | null {
  const header = scope.querySelector('header');
  if (!header) return null;

  const byTestId = header.querySelector(
    '[data-testid="conversation-info-header-chat-title"]',
  ) as HTMLElement | null;
  const testIdText =
    byTestId?.getAttribute('title')?.trim() ||
    byTestId?.textContent?.trim();
  if (testIdText) return testIdText;

  const titled = header.querySelector('span[title]') as HTMLElement | null;
  const title = titled?.getAttribute('title')?.trim();
  if (title) return title;

  // 2026-05+ 新版 WA Web：header 内既无 testid 也无 span[title]，
  // 名字直接放在被 Facebook 混淆 class 包裹的 <span> 里。
  // 取第一个非 SVG 内的、有直接 textNode 子节点的 span（长度上限防误抓状态行）。
  const spans = header.querySelectorAll('span');
  for (const span of spans) {
    if (span.closest('svg')) continue;
    let direct = '';
    for (const node of span.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        direct += (node as Text).nodeValue ?? '';
      }
    }
    direct = direct.trim();
    if (direct && direct.length <= 80) return direct;
  }

  const dirAuto = header.querySelector('span[dir="auto"]') as HTMLElement | null;
  return dirAuto?.textContent?.trim() || null;
}

function extractPhoneFromText(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(PHONE_TEXT_RE);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return `+${digits}`;
}

function readJidFromScope(scope: ParentNode): { phone: string; rawJid: string } | null {
  const elements = scope.querySelectorAll('[data-id]');
  for (const el of elements) {
    const dataId = el.getAttribute('data-id') ?? '';
    const match = dataId.match(JID_RE);
    if (match) {
      return { phone: `+${match[1]}`, rawJid: match[0] };
    }
  }
  return null;
}

function readGroupJidFromScope(scope: ParentNode): string | null {
  const elements = scope.querySelectorAll('[data-id]');
  for (const el of elements) {
    const dataId = el.getAttribute('data-id') ?? '';
    const match = dataId.match(GROUP_JID_RE);
    if (match) return match[0];
  }
  return null;
}

export function readCurrentChat(): CurrentChat {
  const main = findMainPane();
  if (!main) return EMPTY_CHAT;

  // 0. 最优路径：直接从 #main 的 React fiber 读 chat 模型。
  //    新版 WA Web (2026-05+) 不再把 JID 放进 DOM attribute / IDB chat.name，
  //    但 fiber 上的 chat 对象一直完整保留 id/phoneNumber/formattedTitle。
  //    这是唯一不依赖 nameToPhoneCache 命中的可靠路径。
  const fromFiber = readChatFromMainFiber(main);
  if (fromFiber && (fromFiber.phone || fromFiber.groupJid)) {
    if (fromFiber.rawJid && fromFiber.phone) {
      void rememberJidPhone(fromFiber.rawJid, fromFiber.phone);
    }
    return fromFiber;
  }

  const name = readNameFromHeader(main) || readNameFromHeader(document);
  if (!name) return EMPTY_CHAT;

  // 1. IDB 缓存（按 header 显示名查 JID）—— fiber 拿不到时的兜底
  const normalizedName = normalizeName(name);
  const cached = nameToPhoneCache.get(normalizedName);
  if (cached?.groupJid) {
    return { name, phone: null, rawJid: cached.jid, groupJid: cached.groupJid };
  }

  // 2. DOM 兜底：旧版 WA 的 data-id 仍带 JID（@g.us / @c.us），新版没有但保留兼容
  const groupJid = readGroupJidFromScope(main);
  if (groupJid) {
    return { name, phone: null, rawJid: null, groupJid };
  }

  // 3. Cache miss 且 DOM 也抓不到 JID → 可能是新建的群 / 刚加的客户，
  //    IDB 已有但 30s 轮询还没扫到。throttled 触发一次 refresh，
  //    refresh 完 dispatch sgc:refresh-chat 让 useCurrentChat 重读。
  if (!cached) {
    const now = Date.now();
    if (now - lastCacheMissRefreshAt > 3000) {
      lastCacheMissRefreshAt = now;
      void refreshChatNameCache().then(() => {
        window.dispatchEvent(new CustomEvent('sgc:refresh-chat'));
      });
    }
  }

  let phone: string | null = null;
  let rawJid: string | null = null;

  const phoneFromName = extractPhoneFromText(name);
  if (phoneFromName) phone = phoneFromName;

  if (!phone) {
    const jidInfo = readJidFromScope(main);
    if (jidInfo) {
      phone = jidInfo.phone;
      rawJid = jidInfo.rawJid;
    }
  }

  if (!phone && cached?.phone) {
    phone = cached.phone;
    rawJid = cached.jid;
  }

  // 持久缓存 jid→phone：业务号（@lid）IDB 没同步好映射时，下次 useCrmData
  // 全量扫聊天用这个缓存兜底。fire-and-forget，失败也不影响当前调用
  if (rawJid && phone) {
    void rememberJidPhone(rawJid, phone);
  }

  return { name, phone, rawJid, groupJid: null };
}

/**
 * Strip non-digit chars from a phone for comparison.
 */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/**
 * Loose phone equality: identical digits, OR one is a suffix of the other
 * (handles missing country code like "13552592187" vs "8613552592187").
 */
export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length >= 7 && db.endsWith(da)) return true;
  if (db.length >= 7 && da.endsWith(db)) return true;
  return false;
}

/**
 * Poll readCurrentChat until the active chat's phone matches the expected one.
 * Used by bulk-extract / auto-extract to guard against reading the WRONG chat
 * when WhatsApp Web hasn't finished switching after a jumpToChat.
 */
export async function waitForActiveChatPhone(
  expected: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = readCurrentChat();
    if (cur.phone && phonesMatch(cur.phone, expected)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function observeCurrentChat(
  onChange: (chat: CurrentChat) => void,
): () => void {
  let last = '';
  let raf = 0;

  const tick = () => {
    const chat = readCurrentChat();
    const serialized = JSON.stringify(chat);
    if (serialized !== last) {
      last = serialized;
      onChange(chat);
    }
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      tick();
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['title'],
  });

  tick();
  return () => {
    observer.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}
