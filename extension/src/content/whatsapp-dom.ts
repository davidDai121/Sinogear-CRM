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

export async function refreshChatNameCache(): Promise<void> {
  try {
    const wa = await readWhatsAppData();
    const next = new Map<string, CacheEntry>();

    const addEntry = (name: string | null | undefined, jid: string) => {
      if (!name) return;
      const key = name.trim();
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

  const span = header.querySelector('span[dir="auto"]') as HTMLElement | null;
  return span?.textContent?.trim() || null;
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

  const name = readNameFromHeader(main) || readNameFromHeader(document);
  if (!name) return EMPTY_CHAT;

  // 1. 先看 IDB 缓存（按 header 显示名查 JID）——
  //    新版 WhatsApp 不再把 JID 放进消息 data-id，所以 DOM 抓不到，必须靠 IDB
  const cached = nameToPhoneCache.get(name.trim());
  if (cached?.groupJid) {
    return { name, phone: null, rawJid: cached.jid, groupJid: cached.groupJid };
  }

  // 2. DOM 兜底：旧版 WA 的 data-id 仍带 JID（@g.us / @c.us），新版没有但保留兼容
  const groupJid = readGroupJidFromScope(main);
  if (groupJid) {
    return { name, phone: null, rawJid: null, groupJid };
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
