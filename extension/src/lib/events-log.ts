import { supabase } from './supabase';
import type { ContactEventType } from './database.types';

/**
 * 写入 contact_events（append-only 时间轴）。失败不抛错，只 console.warn。
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
}
