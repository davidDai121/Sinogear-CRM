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
import { completeTaskFromSyncedMessages } from './task-send-completion';
import { MESSAGES_SYNCED_EVENT } from './ad-lead-status';

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
  // Re-reading a hydrated bubble must replace an old empty-shell/media row or
  // translated text. Finish this BEFORE GPT loads its evidence ledger.
  const repaired = await repairObservedMessages(contactId, upsertRows);
  if (repaired) return { inserted: count ?? 0, error: repaired };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MESSAGES_SYNCED_EVENT, { detail: { contactId } }));
  }
  for (const row of rows) {
    if (row._attributedLogId) void markAiReplyFilled(row._attributedLogId);
  }

  try {
    await completeTaskFromSyncedMessages(supabase, contactId, upsertRows);
  } catch (error) {
    // Keep the binding and retry on the next sync, without resending any message.
    return { inserted: count ?? 0, error: error instanceof Error ? error.message : String(error) };
  }

  // 广告线索重号自愈：客户在 FB 表单里填的号码，跟他实际发 WhatsApp 的号经常不是
  // 同一个（填座机 / 填旧号 / 手滑打错，实测有一对只差两位）。fb-lead-webhook 按
  // 表单号建 contact，客户后来用另一个号来聊，就成了两条记录，而且归因挂在那个
  // 从没说过话的号上——真实对话反而显示「没有广告标识、不回传 Meta」。
  // 客户点「Chat on WhatsApp」发来的首条消息正文里带着他填的表单内容，
  // 这是唯一能把两个号对上的时刻，所以在这里认。
  void reconcileFbLeadDuplicate(contactId, rows);

  return { inserted: count ?? 0 };
}

// ⚠️ Meta 的预填文案有多个变体，实测全库：
//   "filled out your form"  1,174 条  ← 主流
//   "filled in  your form"    609 条
// 2026-08-21 第一版只写了 "filled in"，漏掉三分之二的重号没认出来。
const FB_FORM_MSG = /filled\s+(?:in|out)\s+your\s+form/i;
const FB_FORM_PHONE = /phone\s*number\s*:?\s*\n?\s*(\+?[\d][\d\s\-()]{6,})/i;

/**
 * 把「表单号」占位客户合并到「真正在聊的」客户身上。
 *
 * 只在这条聊天里出现 FB 表单自动消息、且正文里的号码跟当前客户的号**不一样**时才动。
 * 删除条件非常保守——占位记录必须同时满足：有 fb_lead_id、没有任何消息、没有主理人。
 * 少删一个只是留个重复，误删一个会丢真实对话。
 */
async function reconcileFbLeadDuplicate(
  contactId: string,
  rows: { direction: string; text: string }[],
): Promise<void> {
  try {
    const hit = rows.find((r) => r.direction === 'inbound' && FB_FORM_MSG.test(r.text));
    if (!hit) return;
    const m = FB_FORM_PHONE.exec(hit.text);
    if (!m) return;
    const formDigits = m[1].replace(/\D/g, '');
    if (formDigits.length < 8) return;

    const { data: me } = await supabase
      .from('contacts')
      .select('id, org_id, phone, fb_lead_id')
      .eq('id', contactId)
      .maybeSingle();
    if (!me) return;
    // 表单号跟当前号一致 → 没有重号问题
    if ((me.phone ?? '').replace(/\D/g, '') === formDigits) return;

    const { data: dup } = await supabase
      .from('contacts')
      .select('id, phone, fb_lead_id, fb_ad_id')
      .eq('org_id', me.org_id)
      .eq('phone', '+' + formDigits)
      .maybeSingle();
    if (!dup || dup.id === contactId || !dup.fb_lead_id) return;

    // 占位记录必须是「干净的」才敢删
    const [{ count: msgCount }, { count: handlerCount }] = await Promise.all([
      supabase.from('messages').select('id', { count: 'exact', head: true }).eq('contact_id', dup.id),
      supabase.from('contact_handlers').select('contact_id', { count: 'exact', head: true }).eq('contact_id', dup.id),
    ]);
    if ((msgCount ?? 0) > 0 || (handlerCount ?? 0) > 0) return;

    // 占位记录的表单名 / 广告名要带过来：删掉占位记录时它的事件会被级联删掉，
    // 不带的话真人身上的事件就没 form_name，线索分配页和按表单统计都会把它漏掉
    // （2026-09-09 实测 8/25 以来有 31 条这样的「无表单」事件）。
    const { data: srcEv } = await supabase
      .from('contact_events')
      .select('payload')
      .eq('contact_id', dup.id)
      .eq('event_type', 'fb_lead_received')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const src = (srcEv?.payload ?? {}) as Record<string, unknown>;
    const pick = (k: string) => (typeof src[k] === 'string' ? (src[k] as string) : null);

    // 先摘归因腾出 (org_id, fb_lead_id) 唯一约束，再搬到真人身上
    await supabase.from('contacts').update({ fb_lead_id: null, fb_ad_id: null }).eq('id', dup.id);
    if (!me.fb_lead_id) {
      await supabase
        .from('contacts')
        .update({ fb_lead_id: dup.fb_lead_id, fb_ad_id: dup.fb_ad_id })
        .eq('id', contactId);
      await supabase.from('contact_events').insert({
        contact_id: contactId,
        event_type: 'fb_lead_received',
        payload: {
          fb_lead_id: dup.fb_lead_id,
          form_id: pick('form_id'),
          form_name: pick('form_name'),
          ad_id: pick('ad_id') ?? dup.fb_ad_id ?? null,
          ad_name: pick('ad_name'),
          field_data: src.field_data ?? null,
          repaired_from_phone: dup.phone,
          repaired_at: new Date().toISOString(),
          source: 'reconcile-on-message',
        },
      });
    }
    await supabase.from('contacts').delete().eq('id', dup.id);
    console.warn('[fb-lead] 合并重号占位客户', dup.phone, '→', me.phone);
  } catch (err) {
    console.warn('[fb-lead] reconcile failed', err);
  }
}

/** Repair only messages actually observed again; never guess historical content. */
export async function repairObservedMessages(
  contactId: string,
  rows: Array<{ wa_message_id: string; text: string; direction: 'inbound'|'outbound'; sent_at: string|null }>,
): Promise<string | undefined> {
  const { data, error } = await supabase.from('messages')
    .select('id,wa_message_id,text,direction,sent_at').eq('contact_id', contactId)
    .in('wa_message_id', rows.map(r => r.wa_message_id));
  if (error) return `核对已同步消息失败：${error.message}`;
  for (const old of data ?? []) {
    const observed = rows.find(r => r.wa_message_id === old.wa_message_id);
    if (!observed) continue;
    // A generic fallback cannot erase previously captured original text.
    const text = observed.text === '[媒体]' && old.text !== '[媒体]' ? old.text : observed.text;
    const patch = { text, direction: observed.direction, sent_at: old.sent_at ?? observed.sent_at };
    if (patch.text === old.text && patch.direction === old.direction && patch.sent_at === old.sent_at) continue;
    let update = supabase.from('messages').update(patch).eq('contact_id', contactId)
      .eq('id', old.id).eq('text', old.text).eq('direction', old.direction);
    update = old.sent_at === null ? update.is('sent_at', null) : update.eq('sent_at', old.sent_at);
    const { data: saved, error: writeError } = await update.select('id');
    if (writeError || !saved?.length) return `消息修正尚未保存：${writeError?.message ?? '消息已更新，稍后重试'}`;
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
