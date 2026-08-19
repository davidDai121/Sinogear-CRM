/**
 * 读 WhatsApp Web IndexedDB 的 'message' store —— 不像 chat/contact，message 表
 * 没文档化、schema 因版本变化大，所以这里全部容错+多重 fallback。
 *
 * 主要用途：后台 watcher 每 45s 扫一次找新进来的 inbound 消息，不依赖用户切 chat。
 *
 * 性能：全表扫 cursor，硬限制 10k 条扫描上限避免大账号 freeze。10k 条
 * 约 50-100MB 内存峰值，~1s 主线程时间。每 45s 一次 = ~2% CPU。
 */

const DB_NAME = 'model-storage';
const STORE = 'message';
const SCAN_LIMIT = 10000;

/** 一个聊天的收发活跃度——只要方向和时间，不要正文 */
export interface ChatActivity {
  /** 最后一条客户来信，秒级 epoch；没有则 null */
  lastInboundT: number | null;
  /** 最后一条我方外发，秒级 epoch；没有则 null */
  lastOutboundT: number | null;
  inboundCount: number;
  outboundCount: number;
}

export interface InboundMessage {
  /** 全局唯一 id (_serialized form, 如 'false_1234@c.us_ABC123') */
  msgId: string;
  /** chat jid (含 @c.us / @lid / @g.us 后缀) */
  chatId: string;
  /** 消息文本（无文本的图片消息可能是空字符串） */
  body: string;
  /** ms epoch */
  t: number;
  type: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 拉最近 sinceMs 之后的所有 inbound 消息。
 * 全表 cursor 扫，按 record 解析 t / fromMe / body / chat id，filter 后返回。
 *
 * 不按时间排序输出 — 调用方自己 sort。
 */
export async function readRecentInboundMessages(
  sinceMs: number,
): Promise<InboundMessage[]> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  try {
    if (!db.objectStoreNames.contains(STORE)) return [];

    const tx = db.transaction([STORE], 'readonly');
    const store = tx.objectStore(STORE);

    return await new Promise<InboundMessage[]>((resolve, reject) => {
      const out: InboundMessage[] = [];
      let scanned = 0;
      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cur) {
          resolve(out);
          return;
        }
        scanned++;
        if (scanned > SCAN_LIMIT) {
          // 硬上限保护
          resolve(out);
          return;
        }

        const parsed = parseMessage(cur.value);
        if (parsed && parsed.t >= sinceMs) {
          out.push(parsed);
        }
        cur.continue();
      };
    });
  } finally {
    db.close();
  }
}

function parseMessage(v: unknown): InboundMessage | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;

  // fromMe：可能在 id.fromMe 或顶层 fromMe
  const idField = r.id;
  let fromMe = false;
  let msgId = '';
  let chatIdFromKey = '';

  if (typeof idField === 'object' && idField !== null) {
    const idObj = idField as Record<string, unknown>;
    fromMe = idObj.fromMe === true;
    if (typeof idObj._serialized === 'string') {
      msgId = idObj._serialized;
    }
    if (typeof idObj.remote === 'string') {
      chatIdFromKey = idObj.remote;
    } else if (typeof idObj.remote === 'object' && idObj.remote !== null) {
      const rem = idObj.remote as Record<string, unknown>;
      if (typeof rem._serialized === 'string') chatIdFromKey = rem._serialized;
    }
  } else if (typeof idField === 'string') {
    msgId = idField;
    // 旧版本 id 是 字符串 'false_<jid>_<msgid>' 或 'true_<jid>_<msgid>'
    const m = idField.match(/^(true|false)_([^_]+@[^_]+)_(.+)$/);
    if (m) {
      fromMe = m[1] === 'true';
      chatIdFromKey = m[2];
    }
  }

  if (typeof r.fromMe === 'boolean') fromMe = r.fromMe;
  if (fromMe) return null; // 只要 inbound

  // chatId fallback：r.from / r.chatId / r.remote
  let chatId = chatIdFromKey;
  if (!chatId && typeof r.from === 'string') chatId = r.from;
  if (!chatId && typeof r.chatId === 'string') chatId = r.chatId;
  if (!chatId) return null;

  // body：r.body 或 r.caption 或空
  let body = '';
  if (typeof r.body === 'string') body = r.body;
  else if (typeof r.caption === 'string') body = r.caption;

  // type
  const type = typeof r.type === 'string' ? r.type : '';

  // t：WA 一般用秒，转 ms
  let t = 0;
  if (typeof r.t === 'number' && r.t > 0) {
    t = r.t < 1e12 ? r.t * 1000 : r.t; // 秒 vs 毫秒嗅探
  }
  if (!t) return null;

  if (!msgId) {
    // 兜底用 chatId+t 组合，唯一性差但能让 dedup 起步
    msgId = `${chatId}:${t}`;
  }

  return { msgId, chatId, body, t, type };
}

/**
 * 扫全部聊天的收发活跃度。**不读正文**——WhatsApp 2025 起消息正文在 IndexedDB
 * 里是加密的（`msgRowOpaqueData`），`body` 字段已经不存在（boss 机器实测
 * 7479 条消息里 body 存在数 = 0）。但方向和精确时间戳都还在，而
 * 「球在谁手上 / 等了多久 / 我该回」这几个判断本来就只需要这两样。
 *
 * 为什么要它：messages 表靠 DOM 抓取累积，只覆盖「人点开过的聊天」的
 * 「渲染出来的 30 条」——2026-08-19 实测近 7 天本机 202 个聊天里库里只有 155 个、
 * 消息只有 54%。拿 IDB 直接算就能 100% 覆盖，且不产生任何数据库读写。
 *
 * 性能：一次 getAll 全表 + 一遍分组。boss 机器 7.5k 条约 200ms。
 * 调用方自己节流（见 useCrmData 的 ACTIVITY_REFRESH_MS）。
 */
export async function readChatActivity(): Promise<Map<string, ChatActivity>> {
  const out = new Map<string, ChatActivity>();
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return out;
  }
  try {
    if (!db.objectStoreNames.contains(STORE)) return out;
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction([STORE], 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });

    for (const v of rows) {
      const parsed = parseActivity(v);
      if (!parsed) continue;
      const { chatId, fromMe, t } = parsed;
      let cur = out.get(chatId);
      if (!cur) {
        cur = {
          lastInboundT: null,
          lastOutboundT: null,
          inboundCount: 0,
          outboundCount: 0,
        };
        out.set(chatId, cur);
      }
      if (fromMe) {
        cur.outboundCount++;
        if (cur.lastOutboundT === null || t > cur.lastOutboundT) {
          cur.lastOutboundT = t;
        }
      } else {
        cur.inboundCount++;
        if (cur.lastInboundT === null || t > cur.lastInboundT) {
          cur.lastInboundT = t;
        }
      }
    }
    return out;
  } catch {
    return out;
  } finally {
    db.close();
  }
}

/**
 * 轻量解析：只抠 chatId / fromMe / 秒级时间戳。
 * 比 parseMessage 便宜（不碰 body / type），且**不丢 outbound**。
 */
function parseActivity(
  v: unknown,
): { chatId: string; fromMe: boolean; t: number } | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;

  let fromMe = false;
  let chatId = '';
  const idField = r.id;
  if (typeof idField === 'string') {
    // 'false_<jid>_<msgid>' / 'true_<jid>_<msgid>'
    const m = idField.match(/^(true|false)_([^_]+@[^_]+)_/);
    if (m) {
      fromMe = m[1] === 'true';
      chatId = m[2]!;
    }
  } else if (typeof idField === 'object' && idField !== null) {
    const o = idField as Record<string, unknown>;
    fromMe = o.fromMe === true;
    if (typeof o.remote === 'string') chatId = o.remote;
    else if (typeof o.remote === 'object' && o.remote !== null) {
      const rem = o.remote as Record<string, unknown>;
      if (typeof rem._serialized === 'string') chatId = rem._serialized;
    }
  }
  if (typeof r.fromMe === 'boolean') fromMe = r.fromMe;
  if (!chatId && typeof r.from === 'string') chatId = r.from;
  if (!chatId) return null;
  // 群聊 / 广播 / newsletter 不参与「我该回」判定
  if (!/@(c\.us|lid)$/.test(chatId) || chatId.includes('-')) return null;

  const raw = r.t;
  if (typeof raw !== 'number' || raw <= 0) return null;
  // WA 存秒；偶有毫秒。统一成秒（与 MsgDirection 的单位一致）
  const t = raw > 1e12 ? Math.floor(raw / 1000) : raw;

  return { chatId, fromMe, t };
}
