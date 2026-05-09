/**
 * 用 sql.js 在浏览器里打开解密后的 SQLite，按个人聊天抽消息。
 *
 * 数据形态参考姐妹仓库 sino-gear-wa-importer：新 schema 用 message + chat + jid 三表。
 * 业务号 lid / 群 g.us 第一版跳过。
 */
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
// Vite 把 wasm 文件复制到 dist/ 并给一个 URL；crxjs 让它在扩展里 web_accessible。
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/**
 * Vite 给的 URL 是 "/assets/sql-wasm-XXX.wasm"。
 * 内容脚本里相对路径会解析成 https://web.whatsapp.com/assets/...（404）。
 * 必须改成 chrome-extension://EXTENSION_ID/assets/... 才能 fetch 到。
 */
function resolveWasmUrl(): string {
  if (sqlWasmUrl.startsWith('chrome-extension://') || sqlWasmUrl.startsWith('http')) {
    return sqlWasmUrl;
  }
  const path = sqlWasmUrl.replace(/^\//, '');
  return chrome.runtime.getURL(path);
}

let SQL: SqlJsStatic | null = null;
async function getSql(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  const wasmUrl = resolveWasmUrl();
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SQL;
}

export interface ChatHeader {
  chatRowId: number;
  jidUser: string;       // 不带 + 的国际格式，如 8613552592187
  rawString: string;     // 8613552592187@s.whatsapp.net
  messageCount: number;
  lastTs: number;
}

export interface ExtractedMessage {
  fromMe: boolean;
  text: string;
  ts: number;
  messageType: number;
}

export interface BackupSummary {
  totalChats: number;
  personalChats: number;
  groupChats: number;
  lidChats: number;
  totalMessages: number;
  personalMessages: number;
  dateRange: { from: number; to: number } | null;
  /** 所有个人聊天，按消息数倒序 */
  chats: ChatHeader[];
}

const PERSONAL_SERVER = 's.whatsapp.net';

/** 系统/控制消息 type — 直接丢，不当聊天内容处理 */
const SYSTEM_TYPES = new Set([
  7, 8, 10, 14, 15, 17, 18, 19, 22, 27, 28, 36, 37, 39, 42, 44, 45, 46,
  50, 51, 53, 54, 55, 56, 57, 58, 60, 62, 64, 65, 66, 67, 68, 69, 70,
  80, 82, 90, 99, 112,
]);

export async function openBackup(sqlite: Uint8Array): Promise<Database> {
  const SQL = await getSql();
  const db = new SQL.Database(sqlite);
  // 验证 schema
  const tables = db.exec(
    "select name from sqlite_master where type='table' and name in ('message','chat','jid')",
  );
  const names = new Set((tables[0]?.values ?? []).map((r) => r[0] as string));
  if (!names.has('message') || !names.has('chat') || !names.has('jid')) {
    db.close();
    throw new Error(
      '不认识的 schema：缺 message / chat / jid 表。可能是老版 WhatsApp（< 2.23）或被改了',
    );
  }
  return db;
}

export function summarizeBackup(db: Database): BackupSummary {
  const totals = db.exec(`
    select
      (select count(*) from chat) as totalChats,
      (select count(*) from chat c join jid j on j._id=c.jid_row_id where j.server='s.whatsapp.net') as personalChats,
      (select count(*) from chat c join jid j on j._id=c.jid_row_id where j.server='g.us') as groupChats,
      (select count(*) from chat c join jid j on j._id=c.jid_row_id where j.server='lid') as lidChats,
      (select count(*) from message) as totalMessages,
      (select count(*) from message m join chat c on c._id=m.chat_row_id join jid j on j._id=c.jid_row_id where j.server='s.whatsapp.net') as personalMessages,
      (select min(timestamp) from message where timestamp > 0) as fromTs,
      (select max(timestamp) from message where timestamp > 0) as toTs
  `)[0];
  const r = totals?.values[0] ?? [];
  const [
    totalChats,
    personalChats,
    groupChats,
    lidChats,
    totalMessages,
    personalMessages,
    fromTs,
    toTs,
  ] = r as [number, number, number, number, number, number, number | null, number | null];

  const chats = listPersonalChats(db);

  return {
    totalChats,
    personalChats,
    groupChats,
    lidChats,
    totalMessages,
    personalMessages,
    dateRange: fromTs && toTs ? { from: fromTs, to: toTs } : null,
    chats,
  };
}

function listPersonalChats(db: Database): ChatHeader[] {
  const res = db.exec(`
    select
      c._id, j.user, j.raw_string,
      coalesce(mc.cnt, 0), coalesce(mc.last_ts, 0)
    from chat c
    join jid j on j._id = c.jid_row_id
    left join (
      select chat_row_id, count(*) as cnt, max(timestamp) as last_ts
      from message
      group by chat_row_id
    ) mc on mc.chat_row_id = c._id
    where j.server = '${PERSONAL_SERVER}'
    order by mc.cnt desc nulls last
  `);
  if (!res[0]) return [];
  return res[0].values.map((row) => ({
    chatRowId: row[0] as number,
    jidUser: row[1] as string,
    rawString: row[2] as string,
    messageCount: (row[3] as number) ?? 0,
    lastTs: (row[4] as number) ?? 0,
  }));
}

/**
 * 抽一个聊天的消息。返回数组（不流式）—— 单聊最多几千条，浏览器内存够。
 */
export function extractChatMessages(
  db: Database,
  chatRowId: number,
): ExtractedMessage[] {
  const stmt = db.prepare(`
    select from_me, text_data, timestamp, message_type
    from message
    where chat_row_id = ? and timestamp > 0
    order by timestamp asc
  `);
  stmt.bind([chatRowId]);

  const out: ExtractedMessage[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    const fromMe = (row[0] as number) === 1;
    const textData = row[1] as string | null;
    const ts = row[2] as number;
    const messageType = row[3] as number;

    if (SYSTEM_TYPES.has(messageType)) continue;
    const text = normalizeText(textData, messageType);
    if (text === null) continue;

    out.push({ fromMe, text, ts, messageType });
  }
  stmt.free();
  return out;
}

function normalizeText(textData: string | null, type: number): string | null {
  const t = textData?.trim() ?? '';
  if (t.length > 0) return t;
  if (type === 0) return null; // 空文本直接丢
  return '[媒体]';
}
