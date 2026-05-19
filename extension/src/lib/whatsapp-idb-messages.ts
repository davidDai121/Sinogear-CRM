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
