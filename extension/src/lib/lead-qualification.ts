/**
 * 线索合格判定 —— 回传给 Meta 的那个「这人是不是我们真正想要的客户」。
 *
 * boss 要的闭环：
 *   Facebook Lead → CRM → 销售跟进 → 判定合格/不合格 → 回传 Meta → Meta 学会找对人
 *
 * 两条硬规矩，都是 2026-08-20 实测得出的：
 *
 * 1. **只能人点，AI 不许碰。** 近 8 周 qualifying 变更 78% 是 AI 推的，而同一个
 *    AI 会把广告表单的自动首句读成「客户已购买并支付定金」。拿它训练 Meta，
 *    等于教 Meta「发广告表单自动消息的人 = 优质客户」。
 *
 * 2. **只有带广告标识的客户才回传。** 全库 9,128 个客户里 fb_lead_id /
 *    ctwa_clid / fb_ad_id 全为 0 —— 归因链断着。给一个不是从广告来的客户发
 *    「合格线索」，Meta 仍可能靠哈希手机号匹配到某个 FB 用户，然后拿这个
 *    根本不是广告带来的人当学习样本。宁可不发。
 *    等 fb-lead-webhook / wa-cloud-webhook 配通、lead_id 有值了，自动开始发。
 *
 * 判定本身**总是**记进 contact_events（append-only），跟回不回传无关 ——
 * 销售的判断是有价值的数据，哪怕 Meta 现在收不到。
 */
import { supabase } from './supabase';
import { sendFbEvent } from './fb-conversions';
import type { Database } from './database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

/** Meta 侧的事件名 —— 要先在 Events Manager 里注册成 lead 阶段才会被用于优化 */
export const FB_EVENT_QUALIFIED = 'QualifiedLead';
export const FB_EVENT_DISQUALIFIED = 'DisqualifiedLead';

export interface LeadJudgment {
  id: string;
  at: string;
  qualified: boolean;
  reason: string | null;
  note: string | null;
  fbEventSent: boolean;
}

function toJudgment(row: {
  id: string;
  created_at: string;
  payload: Record<string, unknown>;
}): LeadJudgment {
  const p = row.payload ?? {};
  return {
    id: row.id,
    at: row.created_at,
    qualified: p.qualified === true,
    reason: typeof p.reason === 'string' ? p.reason : null,
    note: typeof p.note === 'string' ? p.note : null,
    fbEventSent: p.fb_event_sent === true,
  };
}

/** 这个客户身上有没有广告标识 —— 决定判定要不要回传 Meta */
export function hasAdIdentifier(contact: ContactRow): boolean {
  return Boolean(contact.fb_lead_id || contact.ctwa_clid || contact.fb_ad_id);
}

export async function fetchLatestJudgment(
  contactId: string,
): Promise<LeadJudgment | null> {
  const { data, error } = await supabase
    .from('contact_events')
    .select('id, created_at, payload')
    .eq('contact_id', contactId)
    .eq('event_type', 'lead_qualified')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('[lead-qualification] fetch', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return toJudgment(data[0] as never);
}

/**
 * 记一次判定。
 *
 * 跟 payment-receipt 一样不用 logContactEvent —— 那个吞错误只 console.warn，
 * 而这是要喂给 Meta 训练的判断，写失败必须让人看见。
 */
export async function recordJudgment(
  contact: ContactRow,
  input: { qualified: boolean; reason?: string | null; note?: string | null },
): Promise<LeadJudgment> {
  const willSend = hasAdIdentifier(contact);
  const payload: Record<string, unknown> = {
    qualified: input.qualified,
    reason: input.reason ?? null,
    note: input.note ?? null,
    fb_event_sent: willSend,
    source: 'manual',
  };

  const { data, error } = await supabase
    .from('contact_events')
    .insert({
      contact_id: contact.id,
      event_type: 'lead_qualified',
      payload,
    })
    .select('id, created_at, payload')
    .single();
  if (error) {
    if (/enum|invalid input value/i.test(error.message)) {
      throw new Error(
        '数据库还没加 lead_qualified 事件类型：请先在 Supabase SQL Editor 跑 ' +
          'supabase/migrations/0036_lead_qualified_event.sql，再点一次。',
      );
    }
    throw new Error(error.message);
  }

  // 判定落库成功之后才回传 —— 顺序跟水单一致
  if (willSend) {
    sendFbEvent(
      contact.id,
      input.qualified ? FB_EVENT_QUALIFIED : FB_EVENT_DISQUALIFIED,
    );
  }

  return toJudgment(data as never);
}
