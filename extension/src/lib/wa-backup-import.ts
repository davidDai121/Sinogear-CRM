/**
 * 把解密后的 msgstore.db 全量批量写到 Supabase。
 *
 * 复用 chat-import.ts 的幂等思路：wa_message_id = 'crypt15:<sha16(ts|dir|text)>'。
 * 跟 .txt 导入用的 'import:' 前缀分开，两条路径各自去重不互踩。
 *
 * 性能优化（vs 一条条调 chat-import）：
 *   - 一次性 batch 查所有已存 contacts
 *   - missing 的 contacts 批量 insert (chunk 200)
 *   - messages 批量 upsert (chunk 500)
 * 1100 联系人 / 16k 消息预计 30 个 RTT 左右。
 */
import { supabase } from './supabase';
import { phoneToCountry } from './phone-countries';
import { logContactEvent } from './events-log';
import type { Database } from 'sql.js';
import {
  summarizeBackup,
  extractChatMessages,
  type BackupSummary,
} from './wa-backup-extract';

const CONTACT_LOOKUP_CHUNK = 200;
const CONTACT_INSERT_CHUNK = 200;
const MESSAGE_UPSERT_CHUNK = 500;

type Direction = 'inbound' | 'outbound';

interface MessageRow {
  contact_id: string;
  wa_message_id: string;
  direction: Direction;
  text: string;
  sent_at: string;
}

export interface ImportProgress {
  /** 0..1 */
  ratio: number;
  stage: string;
  contactsProcessed: number;
  contactsTotal: number;
  contactsCreated: number;
  messagesQueued: number;
  messagesInserted: number;
}

export interface BackupImportResult {
  chatsProcessed: number;
  contactsCreated: number;
  contactsMatched: number;
  messagesQueued: number;
  messagesInserted: number;
  messagesSkipped: number;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 一次性按 phone 批量查 contacts.id；返回 map<phone,id>。
 * 不在表里的 phone 会缺。
 */
async function lookupContactsByPhone(
  orgId: string,
  phones: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < phones.length; i += CONTACT_LOOKUP_CHUNK) {
    const chunk = phones.slice(i, i + CONTACT_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('org_id', orgId)
      .in('phone', chunk);
    if (error) throw new Error(`查 contacts 失败：${error.message}`);
    for (const row of data ?? []) {
      if (row.phone) found.set(row.phone, row.id);
    }
  }
  return found;
}

/** 批量 insert 缺失 contact，country 自动按区号填 */
async function bulkInsertContacts(
  orgId: string,
  phones: string[],
): Promise<Map<string, string>> {
  const created = new Map<string, string>();
  if (phones.length === 0) return created;

  for (let i = 0; i < phones.length; i += CONTACT_INSERT_CHUNK) {
    const chunk = phones.slice(i, i + CONTACT_INSERT_CHUNK);
    const rows = chunk.map((phone) => ({
      org_id: orgId,
      phone,
      country: phoneToCountry(phone),
    }));
    const { data, error } = await supabase
      .from('contacts')
      .insert(rows)
      .select('id, phone');
    if (error) throw new Error(`建 contacts 失败：${error.message}`);
    for (const row of data ?? []) {
      if (row.phone) {
        created.set(row.phone, row.id);
        // 不 await — 时间轴日志失败不影响主流程
        void logContactEvent(row.id, 'created', { phone: row.phone, source: 'crypt15-import' });
      }
    }
  }
  return created;
}

export interface RunImportOpts {
  /** 只导消息数 ≥ 这个阈值的聊天（默认 1，即所有非空） */
  minMessages?: number;
  /** 限制最多导 N 个聊天（调试） */
  limitChats?: number;
  /** 只导这一条 jid（如 8613552592187@s.whatsapp.net） */
  filterJid?: string;
  onProgress?: (p: ImportProgress) => void;
}

/**
 * 主入口：解密后的 SQLite 已经在 db 里，按个人聊天逐个抽 + 写。
 *
 * 流程：
 *   1. summarize → 拿到所有候选聊天
 *   2. 按选项过滤
 *   3. 一次性 lookup 所有 phone → existing map
 *   4. 缺失的 phone 批量 insert → created map
 *   5. 遍历每个 chat，抽消息，攒到全局 rows 队列
 *   6. rows 满 chunk 就 flush
 */
export async function importBackupToSupabase(
  orgId: string,
  db: Database,
  summary: BackupSummary | null,
  opts: RunImportOpts = {},
): Promise<BackupImportResult> {
  const minMessages = opts.minMessages ?? 1;
  const sum = summary ?? summarizeBackup(db);

  let chats = sum.chats.filter((c) => c.messageCount >= minMessages);
  if (opts.filterJid) {
    chats = chats.filter((c) => c.rawString === opts.filterJid);
  }
  if (opts.limitChats) {
    chats = chats.slice(0, opts.limitChats);
  }

  const phones = chats.map((c) => '+' + c.jidUser);

  opts.onProgress?.({
    ratio: 0,
    stage: '查找已有客户',
    contactsProcessed: 0,
    contactsTotal: chats.length,
    contactsCreated: 0,
    messagesQueued: 0,
    messagesInserted: 0,
  });

  const existing = await lookupContactsByPhone(orgId, phones);
  const missing = phones.filter((p) => !existing.has(p));

  opts.onProgress?.({
    ratio: 0.05,
    stage: `创建 ${missing.length} 个新客户`,
    contactsProcessed: 0,
    contactsTotal: chats.length,
    contactsCreated: 0,
    messagesQueued: 0,
    messagesInserted: 0,
  });

  const created = await bulkInsertContacts(orgId, missing);
  const phoneToContactId = new Map<string, string>([...existing, ...created]);

  // 抽消息 + 写
  let chatsProcessed = 0;
  let messagesQueued = 0;
  let messagesInserted = 0;
  let messagesSkipped = 0;
  let pending: MessageRow[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const chunk = pending.splice(0, pending.length);
    const { error, count } = await supabase
      .from('messages')
      .upsert(chunk, {
        onConflict: 'contact_id,wa_message_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (error) throw new Error(`写 messages 失败：${error.message}`);
    messagesInserted += count ?? 0;
  };

  for (const chat of chats) {
    const phone = '+' + chat.jidUser;
    const contactId = phoneToContactId.get(phone);
    if (!contactId) {
      // 不应发生（all phones 上面都处理了），保险起见跳过
      messagesSkipped += chat.messageCount;
      chatsProcessed++;
      continue;
    }

    const messages = extractChatMessages(db, chat.chatRowId);
    messagesSkipped += chat.messageCount - messages.length;

    for (const m of messages) {
      const direction: Direction = m.fromMe ? 'outbound' : 'inbound';
      const tsIso = new Date(m.ts).toISOString();
      const hash = (await sha256Hex(`${tsIso}|${direction}|${m.text.slice(0, 500)}`)).slice(0, 16);
      pending.push({
        contact_id: contactId,
        wa_message_id: `crypt15:${hash}`,
        direction,
        text: m.text,
        sent_at: tsIso,
      });
      messagesQueued++;

      if (pending.length >= MESSAGE_UPSERT_CHUNK) {
        await flush();
      }
    }

    chatsProcessed++;
    // 每 10 个聊天报一次进度
    if (chatsProcessed % 10 === 0 || chatsProcessed === chats.length) {
      opts.onProgress?.({
        ratio: 0.1 + 0.9 * (chatsProcessed / chats.length),
        stage: `导入聊天 ${chatsProcessed}/${chats.length}`,
        contactsProcessed: chatsProcessed,
        contactsTotal: chats.length,
        contactsCreated: created.size,
        messagesQueued,
        messagesInserted,
      });
    }
  }

  await flush();

  opts.onProgress?.({
    ratio: 1,
    stage: '完成',
    contactsProcessed: chatsProcessed,
    contactsTotal: chats.length,
    contactsCreated: created.size,
    messagesQueued,
    messagesInserted,
  });

  return {
    chatsProcessed,
    contactsCreated: created.size,
    contactsMatched: existing.size,
    messagesQueued,
    messagesInserted,
    messagesSkipped,
  };
}
