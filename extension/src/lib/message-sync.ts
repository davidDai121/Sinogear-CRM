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

type MessageRow = Database['public']['Tables']['messages']['Row'];

export async function syncMessages(
  contactId: string,
  messages: ChatMessage[],
): Promise<{ inserted: number; error?: string }> {
  if (!contactId || messages.length === 0) return { inserted: 0 };

  const rows = messages
    .filter((m) => m.id && m.text)
    .map((m) => ({
      contact_id: contactId,
      wa_message_id: m.id,
      direction: m.fromMe ? ('outbound' as const) : ('inbound' as const),
      text: m.text,
      sent_at: m.timestamp ? new Date(m.timestamp).toISOString() : null,
    }));

  if (rows.length === 0) return { inserted: 0 };

  const { error, count } = await supabase
    .from('messages')
    .upsert(rows, {
      onConflict: 'contact_id,wa_message_id',
      ignoreDuplicates: true,
      count: 'exact',
    });

  if (error) return { inserted: 0, error: error.message };
  return { inserted: count ?? 0 };
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
