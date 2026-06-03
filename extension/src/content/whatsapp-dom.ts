import { readWhatsAppData, jidToPhone } from '@/lib/whatsapp-idb';
import {
  rememberJidPhone,
  getJidPhoneCacheSync,
} from '@/lib/jid-phone-cache';

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

// 候选 prop 名：WA Web 不同组件层用不同名字挂 chat 模型
const FIBER_CHAT_PROP_NAMES = [
  'chat',
  'model',
  'conversation',
  'chatModel',
  'peer',
  'wid',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractChatFromFiberProps(mp: any): FiberChatModel | null {
  if (!mp || typeof mp !== 'object') return null;
  for (const propName of FIBER_CHAT_PROP_NAMES) {
    const candidate = mp[propName] as FiberChatModel | undefined;
    if (!candidate) continue;
    const idStr = asJidString(getXProp(candidate, 'id'));
    if (idStr) return candidate;
  }
  return null;
}

// React fiber 属性名前缀。新版 React 18 用 __reactFiber$<随机>，老版可能用
// __reactInternalInstance$<...>。WA Web 不同版本不一样，全试一遍。
const FIBER_KEY_PREFIXES = [
  '__reactFiber',
  '__reactInternalInstance',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findFiberOnElement(el: Element): any | null {
  // 同时查 enumerable (Object.keys) 和 non-enumerable (getOwnPropertyNames)
  // 内部 React 版本偶尔把 fiber 挂成 non-enumerable
  const allKeys = new Set([
    ...Object.keys(el),
    ...Object.getOwnPropertyNames(el),
  ]);
  for (const k of allKeys) {
    for (const prefix of FIBER_KEY_PREFIXES) {
      if (k.startsWith(prefix)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (el as any)[k];
      }
    }
  }
  return null;
}

// #main 本身没 fiber 时，扫子树找一个有 fiber 的元素（限制 2000 节点——
// WA 子树可能很深）。WA Web 偶尔把 React app 挂在 #main 内部子 div 上。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findFiberInSubtree(root: Element): any | null {
  const queue: Element[] = [root];
  let visited = 0;
  while (queue.length && visited < 2000) {
    const el = queue.shift()!;
    visited++;
    const fiber = findFiberOnElement(el);
    if (fiber) return fiber;
    for (const child of Array.from(el.children)) queue.push(child);
  }
  return null;
}

// 全页面扫 fiber——最后兜底。React 可能挂在 body 或别处不是 #main 的根
// 上；找到任意一个 fiber 后从它爬整个 fiber 树搜 chat 模型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findAnyFiberOnPage(): { fiber: any; hostTag: string } | null {
  const all = document.querySelectorAll('*');
  let visited = 0;
  for (const el of Array.from(all)) {
    if (visited++ > 5000) break;
    const fiber = findFiberOnElement(el);
    if (fiber) {
      const hostTag =
        el.tagName +
        (el.id ? '#' + el.id : '') +
        (typeof el.className === 'string'
          ? '.' + el.className.slice(0, 40)
          : '');
      return { fiber, hostTag };
    }
  }
  return null;
}

function readChatFromMainFiber(main: Element): {
  name: string | null;
  phone: string | null;
  rawJid: string | null;
  groupJid: string | null;
} | null {
  // 1. #main 自己上找 fiber（含 non-enumerable）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rootFiber: any = findFiberOnElement(main);
  // 2. #main 没 fiber → BFS 子树
  if (!rootFiber) rootFiber = findFiberInSubtree(main);
  // 3. 子树也没 → 全页面扫（最贵兜底，5000 元素上限）
  if (!rootFiber) {
    const anyFiber = findAnyFiberOnPage();
    if (anyFiber) rootFiber = anyFiber.fiber;
  }
  if (!rootFiber) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = rootFiber;
  let depth = 0;
  let chat: FiberChatModel | null = null;
  // 上行（祖先）搜索：深度 30，应对 WA Web 加深的组件树
  while (cur && depth < 30) {
    chat = extractChatFromFiberProps(cur.memoizedProps);
    if (chat) break;
    chat = extractChatFromFiberProps(cur.stateNode?.props);
    if (chat) break;
    cur = cur.return;
    depth++;
  }
  // 上行没找到 → 试下行（后代）：BFS 最多 200 节点
  if (!chat) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue: any[] = [rootFiber.child];
    let visited = 0;
    while (queue.length && visited < 200) {
      const node = queue.shift();
      if (!node) continue;
      visited++;
      chat = extractChatFromFiberProps(node.memoizedProps);
      if (chat) break;
      chat = extractChatFromFiberProps(node.stateNode?.props);
      if (chat) break;
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
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
    // 多路径找 phone——某些 @lid 业务账户 contact.phoneNumber 是空的，
    // 但 contact.id / contact.userid 可能是 @c.us 真号
    const candidates: unknown[] = [
      getXProp(contact, 'phoneNumber'),
      getXProp(contact, 'id'),
      getXProp(contact, 'userid'),
      getXProp(contact, 'jid'),
    ];
    for (const cand of candidates) {
      const jidStr = asJidString(cand);
      if (jidStr && jidStr.endsWith('@c.us')) {
        const p = jidToPhone(jidStr);
        if (p) {
          phone = p;
          break;
        }
      }
    }
    // 仍未找到：扫 chat 顶层属性里任何 @c.us 字串（最后兜底）
    if (!phone && chat) {
      for (const v of Object.values(chat as Record<string, unknown>)) {
        const jidStr = asJidString(v);
        if (jidStr && jidStr.endsWith('@c.us')) {
          const p = jidToPhone(jidStr);
          if (p) {
            phone = p;
            break;
          }
        }
      }
    }
    // 最后兜底：内存里的 jidPhoneCache（曾在别的地方写过这个 rawJid → phone 的映射）
    if (!phone && chatJid) {
      const cached = getJidPhoneCacheSync()[chatJid];
      if (cached) phone = cached;
    }
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
  // fiber 给了 rawJid 但没 phone（@lid 业务号 contact.phoneNumber 空 + 多源
  // fallback 也没命中）—— 别整段丢，保留 rawJid 让下面 cache 路径还能补救
  const fiberRawJid =
    fromFiber && !fromFiber.groupJid ? fromFiber.rawJid : null;
  const fiberName = fromFiber?.name ?? null;

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
  let rawJid: string | null = fiberRawJid;

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

  // 最后兜底：fiber 给的 rawJid（如 @lid 业务号）查 jidPhoneCache。
  // 这条 cache 在用户之前打开过该聊天且分析出过 phone 时被写入，下次开同
  // 一聊天即使 fiber.contact.phoneNumber 空了也能用 rawJid 反查
  if (!phone && rawJid) {
    const cachedPhone = getJidPhoneCacheSync()[rawJid];
    if (cachedPhone) phone = cachedPhone;
  }

  // 持久缓存 jid→phone：业务号（@lid）IDB 没同步好映射时，下次 useCrmData
  // 全量扫聊天用这个缓存兜底。fire-and-forget，失败也不影响当前调用
  if (rawJid && phone) {
    void rememberJidPhone(rawJid, phone);
  }

  // 防 fiberName 未使用警告（保留以便后续如果想直接拿 fiber 的 name 也行）
  void fiberName;

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

/**
 * 调试用：内部 inspect 函数，返回 readCurrentChat 各路径的中间值。
 *
 * ⚠️ Content script 跑在 isolated world，所以 window.X 在 page console 里
 * 看不见（CLAUDE.md 2026-05-11 也踩过同样的坑）。这里改成"满足触发条件时
 * 自动 console.log" —— 用户直接在 console 复制 `[sgc/inspect-chat]` 输出
 * 就行，不用手动调函数。
 *
 * 触发条件：readCurrentChat 返回 name 但 phone+groupJid 都 null（即典型的
 * "右 panel 报请选聊天但 WA 明明开着聊天" 失败状态）
 */
function buildInspectReport(): Record<string, unknown> {
  const main = findMainPane();
  if (!main) return { error: 'no main pane' };
  // 同时拿 enumerable + non-enumerable 上所有 key
  const mainAllOwnKeys = [
    ...Object.keys(main),
    ...Object.getOwnPropertyNames(main),
  ];
  const mainReactKeys = mainAllOwnKeys.filter(
    (k) => k.startsWith('__react') || k.includes('react') || k.startsWith('_react'),
  );
  // 子树里第一个有 fiber 的元素
  let subtreeFiberHostTag: string | null = null;
  if (mainReactKeys.length === 0) {
    const queue: Element[] = [main];
    let visited = 0;
    while (queue.length && visited < 500) {
      const el = queue.shift()!;
      visited++;
      const reactKeys = [
        ...Object.keys(el),
        ...Object.getOwnPropertyNames(el),
      ].filter(
        (k) => k.startsWith('__react') || k.startsWith('_react'),
      );
      if (reactKeys.length > 0) {
        subtreeFiberHostTag =
          el.tagName + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string'
            ? '.' + el.className.slice(0, 60)
            : '');
        break;
      }
      for (const child of Array.from(el.children)) queue.push(child);
    }
  }
  // 全页面扫 fiber（找到任意一个，看 WA 把 React 挂在哪个根上）
  const anyFiberOnPage = findAnyFiberOnPage();
  // #main 子树里所有 [data-id] 的实际值（前 5 个），看格式是否匹配 JID_RE
  const dataIdSamples = Array.from(main.querySelectorAll('[data-id]'))
    .slice(0, 5)
    .map((el) => el.getAttribute('data-id'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fiberRoot: any = findFiberOnElement(main) ?? findFiberInSubtree(main);
  const summarize = (
    o: unknown,
    maxDepth = 3,
    curDepth = 0,
  ): unknown => {
    if (o === null || o === undefined) return o;
    if (typeof o !== 'object') return typeof o;
    if (Array.isArray(o)) return `Array(${o.length})`;
    if (curDepth >= maxDepth) return Object.keys(o).slice(0, 30);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).slice(0, 30)) {
      try {
        out[k] = summarize(
          (o as Record<string, unknown>)[k],
          maxDepth,
          curDepth + 1,
        );
      } catch {
        out[k] = '<err>';
      }
    }
    return out;
  };
  const fromFiber = readChatFromMainFiber(main);
  const headerName = readNameFromHeader(main);
  const groupJid = readGroupJidFromScope(main);
  const jidInfo = readJidFromScope(main);
  const cacheKeys = Object.keys(getJidPhoneCacheSync()).slice(0, 10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let foundChat: any = null;
  if (fiberRoot) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = fiberRoot;
    for (let i = 0; cur && i < 30; i++) {
      const c = extractChatFromFiberProps(cur.memoizedProps);
      if (c) {
        foundChat = c;
        break;
      }
      cur = cur.return;
    }
  }
  return {
    hasMain: !!main,
    hasFiber: !!fiberRoot,
    mainReactKeys,
    mainAllOwnKeysCount: mainAllOwnKeys.length,
    mainAllOwnKeysSample: mainAllOwnKeys.slice(0, 30), // 前 30 own key (含 non-enumerable)
    subtreeFiberHostTag,
    anyFiberOnPageHost: anyFiberOnPage?.hostTag ?? null, // 全页扫到的第一个 fiber 元素
    dataIdSamples, // #main 子树前 5 个 [data-id] 的实际值
    dataIdCount: main.querySelectorAll('[data-id]').length,
    mainTagInfo:
      main.tagName +
      (main.id ? '#' + main.id : '') +
      (typeof main.className === 'string'
        ? '.' + main.className.slice(0, 60)
        : ''),
    headerName,
    groupJid,
    jidInfoFromDataId: jidInfo,
    jidPhoneCacheKeys: cacheKeys,
    fromFiber,
    foundChatRaw: foundChat ? summarize(foundChat, 3) : null,
    foundChatContact: foundChat
      ? summarize(getXProp(foundChat, 'contact'), 4)
      : null,
  };
}

// 自动诊断：observeCurrentChat 每次拿到"有 name 但 phone+groupJid 都空"
// 的 chat 时，打一行 [sgc/inspect-chat] 到 console。throttle 5 秒避免刷屏
let lastInspectAt = 0;
export function maybeLogChatInspect(chat: CurrentChat): void {
  if (!chat.name) return;
  if (chat.phone || chat.groupJid) return;
  const now = Date.now();
  if (now - lastInspectAt < 5000) return;
  lastInspectAt = now;
  try {
    const report = buildInspectReport();
    console.log(
      '[sgc/inspect-chat] phone+groupJid 都没解析到，下面是 fiber/cache/DOM 各路径中间值：',
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.warn('[sgc/inspect-chat] failed:', err);
  }
}
