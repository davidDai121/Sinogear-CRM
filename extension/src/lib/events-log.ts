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
  if (type === 'stage_changed') {
    const to = payload['to'];
    if (typeof to === 'string') {
      triggerFbConversion(contactId, to as CustomerStage);
    }
  }
}
