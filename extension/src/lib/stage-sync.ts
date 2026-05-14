import { supabase } from './supabase';
import type { AutoStage } from './chat-classifier';
import type { Database, CustomerStage } from './database.types';
import { logContactEvent } from './events-log';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

const AUTO_TO_DB: Record<AutoStage, CustomerStage> = {
  new: 'new',
  active: 'negotiating',
  stalled: 'stalled',
  lost: 'lost',
};

const AUTO_MANAGED: ReadonlySet<CustomerStage> = new Set<CustomerStage>([
  'new',
  'qualifying',
  'negotiating',
  'stalled',
  'lost',
]);

export interface StageSyncItem {
  contact: ContactRow | null;
  classification: { autoStage: AutoStage } | null;
  /** 用来判断 'new' 的写入是否真有客户活动证据；不传也不会崩，只会少一道防护 */
  chat?: { t: number; unreadCount: number } | null;
}

export async function syncAutoStages(items: StageSyncItem[]): Promise<number> {
  const updates: Array<{ id: string; from: CustomerStage; to: CustomerStage }> = [];
  for (const item of items) {
    if (!item.contact || !item.classification) continue;
    const current = item.contact.customer_stage;
    if (!AUTO_MANAGED.has(current)) continue;
    const target = AUTO_TO_DB[item.classification.autoStage];
    if (target === current) continue;

    // 🐛 flip-flop 防护（2026-05-14 案例：14 条 event 4 分钟内
    //    流失 ↔ 新客户 来回翻）：
    // - chat-classifier 看到 chat.t === 0（聊天无消息）会判定 autoStage='new'
    // - 同一手机号在 WA Web 里可能有多条 chat（@c.us / @lid 各一条），
    //   chatByPhone 取 max(t)，但 @lid resolvePhone 不稳定 → 每轮选中的
    //   chat 在 t=0 / t=large 之间来回切
    // - 已 lost 客户被这个 t=0 噪音拽回 'new'，下次又被 t=large 拽回 'lost'
    // 拒绝条件：target='new' 且 chat.t === 0 且 unreadCount === 0。空聊天
    // 不构成"客户真有活动"，不该改写 DB 阶段。
    if (target === 'new' && item.chat) {
      const hasRealActivity =
        item.chat.unreadCount > 0 || item.chat.t > 0;
      if (!hasRealActivity) continue;
    }

    updates.push({ id: item.contact.id, from: current, to: target });
  }
  if (updates.length === 0) return 0;

  const results = await Promise.all(
    updates.map((u) =>
      supabase
        .from('contacts')
        .update({ customer_stage: u.to })
        .eq('id', u.id)
        .eq('customer_stage', u.from),
    ),
  );

  let written = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.error) {
      written += 1;
      const u = updates[i];
      void logContactEvent(u.id, 'stage_changed', {
        from: u.from,
        to: u.to,
        automatic: true,
      });
    }
  }
  if (written > 0) {
    console.log(`[stage-sync] updated ${written}/${updates.length} contacts`);
  }
  return written;
}
