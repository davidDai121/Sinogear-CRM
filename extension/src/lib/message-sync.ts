/**
 * 消息历史持久化（被动累积）
 *
 * 流程：
 *   ContactCard 加载完客户 → useMessageSync 读 readChatMessages(30) → upsert messages 表
 *   用 (contact_id, wa_message_id) UNIQUE 去重，重复 sync 不产生重复行
 *
 * 历史滚动加载靠用户在 WhatsApp Web 自己滚——滚到的部分会自动入库。
 */

import { supabase } from './supabase';
import type { ChatMessage } from '@/content/whatsapp-messages';
import type { Database } from './database.types';
import { attributeOutboundMessage } from './ai-reply-attribution';
import { markAiReplyFilled } from './ai-reply-log';

type MessageRow = Database['public']['Tables']['messages']['Row'];

export async function syncMessages(
  contactId: string,
  messages: ChatMessage[],
): Promise<{ inserted: number; error?: string }> {
  if (!contactId || messages.length === 0) return { inserted: 0 };

  // 对每条出站消息归因：查 pending fills（5 分钟窗口内 + 文本相似度匹配） → 写 ai_source
  // 入站消息 ai_source 永远 null
  const rows = await Promise.all(
    messages
      .filter((m) => m.id && m.text)
      .map(async (m) => {
        const direction = m.fromMe ? ('outbound' as const) : ('inbound' as const);
        let aiSource: string | null = null;
        let attributedLogId: string | null = null;
        if (direction === 'outbound') {
          const attr = await attributeOutboundMessage({
            contactId,
            text: m.text,
            sentAt: m.timestamp ?? undefined,
          });
          if (attr) {
            aiSource = attr.source;
            attributedLogId = attr.logId;
          }
        }
        return {
          contact_id: contactId,
          wa_message_id: m.id,
          direction,
          text: m.text,
          sent_at: m.timestamp ? new Date(m.timestamp).toISOString() : null,
          ai_source: aiSource,
          _attributedLogId: attributedLogId, // 内部字段，upsert 前剥掉
        };
      }),
  );

  if (rows.length === 0) return { inserted: 0 };

  // 剥内部字段
  const upsertRows = rows.map(({ _attributedLogId, ...row }) => row);

  const { error, count } = await supabase
    .from('messages')
    .upsert(upsertRows, {
      onConflict: 'contact_id,wa_message_id',
      ignoreDuplicates: true,
      count: 'exact',
    });

  if (error) return { inserted: 0, error: error.message };

  // upsert 成功后，对归因到的 ai_reply_log 标 was_sent —— fire and forget
  for (const row of rows) {
    if (row._attributedLogId) {
      void markAiReplyFilled(row._attributedLogId);
    }
  }

  // Backfill 历史 NULL sent_at —— 之前因为 WA Web 纯媒体 bubble 没 data-pre-plain-text
  // 而 syncMessages 写入时 sent_at=null；现在 readChatMessages 修源头后能从 bubble 时间字串
  // + date header 解析出真实时间。upsert + ignoreDuplicates 不更新已存行，单独 PATCH 把
  // sent_at IS NULL 的老行用本次解析到的时间填上。filter sent_at=is.null 保证不覆盖
  // 已有非 null 值。fire-and-forget，不阻塞本次同步。
  void backfillNullSentAt(contactId, rows);

  // 已删除消息覆盖：DOM 抓到 [已删除] 占位时，DB 里同 wa_message_id 可能还存着销售
  // 删除前发出去的原文（之前 sync 过）。upsert + ignoreDuplicates 不会更新，需要强制
  // PATCH 把 DB 的 text 也改成 [已删除]。否则 prompt 还是会把销售已撤回的话喂给 AI。
  void overwriteDeletedMessages(contactId, rows);

  return { inserted: count ?? 0 };
}

/** WA Web 已删除消息占位的内部统一标记，跟 content/whatsapp-messages.ts 同步 */
const DELETED_TEXT_MARKER = '[已删除]';

/**
 * DOM 抓到 [已删除] 占位时，把 DB 里同 wa_message_id 的 text 也改成 [已删除]
 * （之前 sync 过的原文被覆盖）。filter text=neq.[已删除] 保证幂等。
 */
async function overwriteDeletedMessages(
  contactId: string,
  rows: Array<{ wa_message_id: string; text: string }>,
): Promise<void> {
  const deleted = rows.filter((r) => r.text === DELETED_TEXT_MARKER);
  if (deleted.length === 0) return;
  for (const r of deleted) {
    try {
      const { error } = await supabase
        .from('messages')
        .update({ text: DELETED_TEXT_MARKER })
        .eq('contact_id', contactId)
        .eq('wa_message_id', r.wa_message_id)
        .neq('text', DELETED_TEXT_MARKER);
      if (error) {
        console.warn('[overwriteDeletedMessages]', r.wa_message_id, error.message);
      }
    } catch (e) {
      console.warn('[overwriteDeletedMessages]', r.wa_message_id, e);
    }
  }
}

/**
 * 老 NULL row 在新 DOM 解析到 timestamp 时反向回填 sent_at。
 * 单条 PATCH 因为 PostgREST 不支持"不同行给不同值"的 batch update。
 * 用 sent_at=is.null filter 保证只填空，不覆盖已有时间。
 */
async function backfillNullSentAt(
  contactId: string,
  rows: Array<{ wa_message_id: string; sent_at: string | null }>,
): Promise<void> {
  const candidates = rows.filter((r) => r.sent_at != null);
  if (candidates.length === 0) return;
  for (const r of candidates) {
    try {
      const { error } = await supabase
        .from('messages')
        .update({ sent_at: r.sent_at })
        .eq('contact_id', contactId)
        .eq('wa_message_id', r.wa_message_id)
        .is('sent_at', null);
      if (error) {
        console.warn('[backfillNullSentAt]', r.wa_message_id, error.message);
      }
    } catch (e) {
      console.warn('[backfillNullSentAt]', r.wa_message_id, e);
    }
  }
}

export async function countMessages(contactId: string): Promise<number> {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('contact_id', contactId);
  return count ?? 0;
}

export async function loadMessages(
  contactId: string,
  limit = 200,
): Promise<MessageRow[]> {
  // 按 sent_at DESC 取最近 N 条，再反转成正序返回
  // 之前用 ASC + limit 拿到的是最老的 N 条，导入大量历史后 Gem 看到的是开头不是最近
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('contact_id', contactId)
    .order('sent_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  return (data ?? []).reverse();
}

/**
 * DOM 消息 + DB 消息合并：DOM 优先（最新状态），DB 补 DOM 没拿到的（DOM 部分加载）。
 *
 * 为啥需要：WA Web 刚发完图后 DOM 只有最新 1 条 bubble，老消息还没渲染出来；
 * `readChatMessages` / `waitForChatMessages` 拿到 ≥1 就返回，AI prompt 就成了
 * "只有最新一条" 的残缺上下文。任何「DOM 消息 → AI prompt」的路径都该过这个 helper。
 *
 * 合并规则：
 *   - dedup by `id` (DOM) === `wa_message_id` (DB)
 *   - DB 行用 outbound/inbound 推导 fromMe，没 sender（DB 不存）
 *   - 按 timestamp ASC 排序（正序）
 *
 * 注意：`messages` 表行依赖 useMessageSync 先把客户在 DOM 见过的消息持久化过。
 * 客户的 reply 如果用户从没打开过聊天，DB 也没有 → 这种 case 兜不住。
 * 但只要正常浏览过该客户一次，customer reply 就会进 DB。
 */
export async function mergeDomWithDbMessages(
  domMessages: ChatMessage[],
  contactId: string,
  dbLimit = 50,
): Promise<ChatMessage[]> {
  const dbRows = await loadMessages(contactId, dbLimit);
  if (dbRows.length === 0) return domMessages;
  const domIds = new Set(domMessages.map((m) => m.id));
  const extras: ChatMessage[] = dbRows
    .filter((r) => !domIds.has(r.wa_message_id))
    .map((r) => ({
      id: r.wa_message_id,
      fromMe: r.direction === 'outbound',
      text: r.text,
      timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
      sender: null,
    }));
  if (extras.length === 0) return domMessages;
  return [...domMessages, ...extras].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );
}

/**
 * 拉某个 contact 的全部消息，正序返回。用于消息历史 modal 显示完整记录。
 *
 * Supabase / PostgREST 单次 select 默认上限 1000 行，所以分页 fetch 直到拿完。
 */
export async function loadAllMessages(contactId: string): Promise<MessageRow[]> {
  const PAGE = 1000;
  const out: MessageRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('contact_id', contactId)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out.reverse();
}
