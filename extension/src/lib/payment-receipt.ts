/**
 * 水单确认 —— 「成交」唯一的合法来源。
 *
 * boss 的口径（2026-08-19）：**客户发来水单（银行回单）才算成交，其余一律不算。**
 * 起因是几个还在砍价的客户被标成了成交，根因是 AI 回复里解析出的
 * won/closed_won 被直接落库（已在 useAutoFbStage 硬拦）。
 *
 * 这里管另一半：won 只能由人点「已收水单」产生，并且每次都在
 * contact_events 留一条 payment_received 当证据（append-only，删不掉）。
 *
 * ⚠️ 不要用 contact_sales_signals.payment_received_at 判成交 —— 那列的正则
 * 既没分方向也没排除否定句，全库只命中 5 条，全是我方发的
 * "we still have not received the payment"。
 */
import { supabase } from './supabase';

export interface PaymentReceipt {
  id: string;
  confirmedAt: string;
  receiptUrl: string | null;
  fileName: string | null;
  amountUsd: number | null;
  note: string | null;
}

export interface ConfirmInput {
  receiptUrl?: string | null;
  receiptPublicId?: string | null;
  fileName?: string | null;
  amountUsd?: number | null;
  note?: string | null;
}

function toReceipt(row: {
  id: string;
  created_at: string;
  payload: Record<string, unknown>;
}): PaymentReceipt {
  const p = row.payload ?? {};
  return {
    id: row.id,
    confirmedAt: row.created_at,
    receiptUrl: typeof p.receipt_url === 'string' ? p.receipt_url : null,
    fileName: typeof p.file_name === 'string' ? p.file_name : null,
    amountUsd: typeof p.amount_usd === 'number' ? p.amount_usd : null,
    note: typeof p.note === 'string' ? p.note : null,
  };
}

/** 最近一条水单确认；没有返回 null（= 这单没人确认过） */
export async function fetchLatestReceipt(
  contactId: string,
): Promise<PaymentReceipt | null> {
  const { data, error } = await supabase
    .from('contact_events')
    .select('id, created_at, payload')
    .eq('contact_id', contactId)
    .eq('event_type', 'payment_received')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('[payment-receipt] fetch', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return toReceipt(data[0] as never);
}

/**
 * 写入水单确认事件。
 *
 * 故意不用 logContactEvent —— 那个吞错误只 console.warn，
 * 而这条是成交凭证，写失败必须让人看见（比如 0035 迁移还没跑，
 * 枚举里没有 payment_received，insert 会直接报错）。
 * 调用方要在这条成功之后才把 stage 改成 won。
 */
export async function confirmPaymentReceived(
  contactId: string,
  input: ConfirmInput,
): Promise<PaymentReceipt> {
  const payload: Record<string, unknown> = {
    source: 'manual',
    receipt_url: input.receiptUrl ?? null,
    receipt_public_id: input.receiptPublicId ?? null,
    file_name: input.fileName ?? null,
    amount_usd: input.amountUsd ?? null,
    note: input.note ?? null,
  };
  const { data, error } = await supabase
    .from('contact_events')
    .insert({ contact_id: contactId, event_type: 'payment_received', payload })
    .select('id, created_at, payload')
    .single();
  if (error) {
    // 0035 迁移没跑时，PG 会报 invalid input value for enum。
    // 这条对销售毫无意义，翻译成能照着做的一句话。
    if (/enum|invalid input value/i.test(error.message)) {
      throw new Error(
        '数据库还没加 payment_received 事件类型：请先在 Supabase SQL Editor 跑 ' +
          'supabase/migrations/0035_payment_received_event.sql，再点一次。',
      );
    }
    throw new Error(error.message);
  }
  return toReceipt(data as never);
}
