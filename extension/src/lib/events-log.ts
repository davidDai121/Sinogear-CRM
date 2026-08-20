import { supabase } from './supabase';
import type { ContactEventType, CustomerStage } from './database.types';
import { triggerFbConversion } from './fb-conversions';

/**
 * 写入 contact_events（append-only 时间轴）。失败不抛错，只 console.warn。
 *
 * 副作用：当 type === 'stage_changed' 且 payload.to 是关键转化阶段
 * （negotiating/quoted/won/lost）时，fire-and-forget 调 conversions-api
 * Edge Function 把事件回传给 Meta。详见 fb-conversions.ts。
 *
 * 注意：只有这里走过的 stage_changed 才会触发 FB 上报；
 * stage-sync.ts 的 auto-sync 故意不写 contact_events（防 flip-flop 噪音），
 * 所以也不会误触发 FB 事件。
 */
export async function logContactEvent(
  contactId: string,
  type: ContactEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await supabase
      .from('contact_events')
      .insert({ contact_id: contactId, event_type: type, payload });
    if (error) console.warn('[events-log]', type, error.message);
  } catch (err) {
    console.warn('[events-log]', type, err);
  }

  // 副作用：stage_changed → Meta Conversions API
  //
  // ⛔ 只回传人工改的（automatic === false）。
  // 2026-08-20 实测：近 8 周 qualifying 变更 532 条里 415 条（78%）是 AI 推的，
  // negotiating 401 条里 385 条（96%）。而同一个 AI 会把广告表单的自动首句
  // 「Hi, I'm interested in the Changan UNI-K.」读成「客户已购买并支付定金」。
  // 把这种判断回传给 Meta，等于教它「发广告表单自动消息的人 = 优质客户」，
  // 它会照这个特征找来更多同类人 —— 比不回传更糟。
  if (type === 'stage_changed' && payload['automatic'] === false) {
    const to = payload['to'];
    if (typeof to === 'string') {
      // ⚠️ Purchase 必须带 value + currency，否则 Meta 直接 400
      //（subcode 2804010 "Missing Currency for Purchase Event"）。
      // conversions-api 里 currency 是跟着 value 一起进 custom_data 的，
      // 所以这里不传 value 等于每条成交都被拒。2026-08-20 实测踩到。
      // 水单金额从 payload.value 来（PaymentReceiptSection 填的），
      // 销售没填金额时补 0 —— 数据不漂亮，但比整条事件丢掉强。
      const raw = payload['value'];
      const value =
        typeof raw === 'number' && Number.isFinite(raw)
          ? raw
          : to === 'won'
            ? 0
            : undefined;
      triggerFbConversion(contactId, to as CustomerStage, { value });
    }
  }
}
