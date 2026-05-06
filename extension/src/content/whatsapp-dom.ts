import { readWhatsAppData, jidToPhone } from '@/lib/whatsapp-idb';

export interface CurrentChat {
  name: string | null;
  phone: string | null;
  rawJid: string | null;
}

const EMPTY_CHAT: CurrentChat = { name: null, phone: null, rawJid: null };

const JID_RE = /(\d{7,})@(?:c\.us|s\.whatsapp\.net|lid)/;
const PHONE_TEXT_RE = /^\+?\s*(\d[\d\s\-().]{6,}\d)$/;

let nameToPhoneCache = new Map<string, { phone: string; jid: string }>();

export async function refreshChatNameCache(): Promise<void> {
  try {
    const wa = await readWhatsAppData();
    const next = new Map<string, { phone: string; jid: string }>();

    const addEntry = (name: string | null | undefined, jid: string) => {
      if (!name) return;
      const key = name.trim();
      if (!key) return;
      if (next.has(key)) return;
      const direct = jidToPhone(jid);
      if (direct) {
        next.set(key, { phone: direct, jid });
        return;
      }
      const phoneJid = wa.jidToPhoneJid.get(jid);
      if (phoneJid) {
        const phone = jidToPhone(phoneJid);
        if (phone) next.set(key, { phone, jid });
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

export function readCurrentChat(): CurrentChat {
  const main = findMainPane();
  if (!main) return EMPTY_CHAT;

  const name = readNameFromHeader(main) || readNameFromHeader(document);
  if (!name) return EMPTY_CHAT;

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

  if (!phone) {
    const cached = nameToPhoneCache.get(name.trim());
    if (cached) {
      phone = cached.phone;
      rawJid = cached.jid;
    }
  }

  return { name, phone, rawJid };
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
