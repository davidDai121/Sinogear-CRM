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
  jidUser: string;       // 不带 + 的国际格式，如 8613552592187（lid 聊天是反查后的真号）
  rawString: string;     // 8613552592187@s.whatsapp.net 或 74015288910069@lid
  messageCount: number;
  lastTs: number;
  /** 'pn' = jid.server 直接是手机号；'lid' = 经 jid_map 反查出来的 */
  source: 'pn' | 'lid';
}

export interface ExtractedMessage {
  fromMe: boolean;
  text: string;
  ts: number;
  messageType: number;
  /**
   * WhatsApp 原始消息 id（`message.key_id`），如 '3EB0C92FBCD18A6747989F'。
   * 跟 WhatsApp Web DOM / IndexedDB 里那个 id 是同一个值 —— 用它当
   * wa_message_id，备份导入就能和 DOM 抓取的行天然去重。
   * 老 schema 可能没有这列，此时为 null，调用方回退到内容 hash。
   */
  keyId: string | null;
}

export interface BackupSummary {
  totalChats: number;
  personalChats: number;
  groupChats: number;
  lidChats: number;
  totalMessages: number;
  personalMessages: number;
  /** lid 聊天里能经 jid_map 反查出手机号的数量（这些现在可以导入） */
  lidResolvedChats: number;
  /** 上面那些 lid 聊天对应的消息数 */
  lidResolvedMessages: number;
  dateRange: { from: number; to: number } | null;
  /** 所有可导入的个人聊天（含反查成功的 lid），按消息数倒序 */
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
  const lidChatsResolved = chats.filter((c) => c.source === 'lid');

  return {
    totalChats,
    personalChats,
    groupChats,
    lidChats,
    totalMessages,
    personalMessages,
    lidResolvedChats: lidChatsResolved.length,
    lidResolvedMessages: lidChatsResolved.reduce((n, c) => n + c.messageCount, 0),
    dateRange: fromTs && toTs ? { from: fromTs, to: toTs } : null,
    chats,
  };
}

/** 这份备份里有没有 lid → 手机号的映射表（老 schema 没有） */
function hasJidMap(db: Database): boolean {
  const r = db.exec(
    "select 1 from sqlite_master where type='table' and name='jid_map'",
  );
  return !!r[0]?.values.length;
}

/**
 * 列出所有「可归到某个手机号」的一对一聊天。
 *
 * 两个来源：
 *   1. jid.server = 's.whatsapp.net' —— 传统手机号聊天，直接用
 *   2. jid.server = 'lid' —— WhatsApp 2025 起全量迁移到的 LID 寻址。
 *      经 jid_map(lid_row_id → jid_row_id) 反查回手机号。
 *
 * 为什么必须带上 lid：boss 2026-08-19 的备份实测 —— lid 4393 个聊天 / 84509 条消息，
 * 而 s.whatsapp.net 只有 1107 / 22754。只取后者会丢掉 78% 的数据。
 * 同一批数据里 lid 反查成功率 4388/4393 = 99.9%。
 *
 * 同一个手机号可能既有 lid 聊天又有 s.whatsapp.net 聊天（实测 4 例）：
 * 这里各返回一行，导入侧按手机号归 contact，消息靠 key_id 去重，天然合并。
 */
function listPersonalChats(db: Database): ChatHeader[] {
  const counts = `
    left join (
      select chat_row_id, count(*) as cnt, max(timestamp) as last_ts
      from message
      group by chat_row_id
    ) mc on mc.chat_row_id = c._id
  `;

  const pnSql = `
    select c._id, j.user, j.raw_string,
           coalesce(mc.cnt, 0), coalesce(mc.last_ts, 0), 'pn'
    from chat c
    join jid j on j._id = c.jid_row_id
    ${counts}
    where j.server = '${PERSONAL_SERVER}'
  `;

  const lidSql = `
    select c._id, pj.user, lj.raw_string,
           coalesce(mc.cnt, 0), coalesce(mc.last_ts, 0), 'lid'
    from chat c
    join jid lj on lj._id = c.jid_row_id and lj.server = 'lid'
    join jid_map jm on jm.lid_row_id = lj._id
    join jid pj on pj._id = jm.jid_row_id and pj.server = '${PERSONAL_SERVER}'
    ${counts}
  `;

  const sql = hasJidMap(db)
    ? `${pnSql} union all ${lidSql} order by 4 desc`
    : `${pnSql} order by 4 desc`;

  const res = db.exec(sql);
  if (!res[0]) return [];
  return res[0].values
    .map((row) => ({
      chatRowId: row[0] as number,
      jidUser: row[1] as string,
      rawString: row[2] as string,
      messageCount: (row[3] as number) ?? 0,
      lastTs: (row[4] as number) ?? 0,
      source: (row[5] as string) === 'lid' ? ('lid' as const) : ('pn' as const),
    }))
    // 反查不到手机号的（实测 5 例）user 会是 null，导入侧没法建 contact，直接丢
    .filter((c) => !!c.jidUser);
}

/**
 * 抽一个聊天的消息。返回数组（不流式）—— 单聊最多几千条，浏览器内存够。
 */
export function extractChatMessages(
  db: Database,
  chatRowId: number,
): ExtractedMessage[] {
  const stmt = db.prepare(`
    select from_me, text_data, timestamp, message_type, key_id
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
    const keyId = (row[4] as string | null) ?? null;

    if (SYSTEM_TYPES.has(messageType)) continue;
    const text = normalizeText(textData, messageType);
    if (text === null) continue;

    out.push({ fromMe, text, ts, messageType, keyId });
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
