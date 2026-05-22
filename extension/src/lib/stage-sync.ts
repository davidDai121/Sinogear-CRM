import { supabase } from './supabase';
import type { AutoStage } from './chat-classifier';
import type { Database, CustomerStage } from './database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

/**
 * Hysteresis（迟滞）：同一 contact 在最近 HYSTERESIS_MS 内已被 stage-sync
 * 改过 → 跳过这次改动。
 *
 * 原理：chat-classifier 因为 @lid 多 chat / chats 顺序 / resolvePhone 抖动
 * 会让 autoStage 在 active↔stalled↔lost↔new 之间假性翻转。useCrmData 的
 * A 修复（t=0 chat 不参与 max(t)）能消除主要抖动源，但 jidPhoneCache 动态
 * 加载、chats 数组顺序变等次要抖动仍可能让单个 contact 偶发跳一次。
 * 5 分钟硬窗口的好处：
 *   - 真要改的客户每 5 分钟有一次窗口生效，对用户体验无感
 *   - 假性抖动被压成最多每 5 分钟翻 1 次，几乎不可察觉
 *   - 内存 Map 实现，刷页清空（不存 storage，免得重启后异常状态卡着）
 */
const HYSTERESIS_MS = 5 * 60 * 1000;
const lastUpdateAt = new Map<string, number>();

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
  const now = Date.now();
  const updates: Array<{ id: string; from: CustomerStage; to: CustomerStage }> = [];
  let skippedHysteresis = 0;
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

    // Hysteresis：5 分钟内已被 stage-sync 改过的 contact 跳过本次。
    // 即使 chat-classifier 输出抖动也不会引发翻转风暴。
    const lastT = lastUpdateAt.get(item.contact.id);
    if (lastT && now - lastT < HYSTERESIS_MS) {
      skippedHysteresis += 1;
      continue;
    }

    updates.push({ id: item.contact.id, from: current, to: target });
  }
  if (updates.length === 0) {
    if (skippedHysteresis > 0) {
      console.log(`[stage-sync] hysteresis 跳过 ${skippedHysteresis} 个 contact`);
    }
    return 0;
  }

  const results = await Promise.all(
    updates.map((u) =>
      supabase
        .from('contacts')
        .update({ customer_stage: u.to })
        .eq('id', u.id)
        .eq('customer_stage', u.from),
    ),
  );

  // ⚠️ 不再写 stage_changed 到 contact_events：
  // chat-classifier 因为 @lid 多 chat 抖动会让 autoStage 在 active↔stalled↔lost↔new
  // 之间反复跳；syncAutoStages 每次 merged useMemo 重算（30s WA poll + Realtime 事件）
  // 都跑一次全表对比，flip-flop 客户每秒翻几次 stage，导致 contact_events 表 7 天写入
  // 88 万条 stage_changed (99.6% 都是 auto=true)，让 Dashboard 看板查询变慢、egress 暴涨。
  //
  // 自动 stage 同步本来就是从 WA chat 状态推断的"实时摘要"，不是"真实事件"——
  // 客户在 contacts.customer_stage 列上能看到当前值就够，没必要在时间轴留下抖动痕迹。
  // 手动 stage 变更（ContactDetailDrawer / useContact 触发）仍然会写 contact_events。
  let written = 0;
  for (let i = 0; i < results.length; i++) {
    if (!results[i].error) {
      written += 1;
      lastUpdateAt.set(updates[i].id, now);
    }
  }
  if (written > 0 || skippedHysteresis > 0) {
    console.log(
      `[stage-sync] updated ${written}/${updates.length}` +
        (skippedHysteresis > 0 ? ` (hysteresis 跳过 ${skippedHysteresis})` : ''),
    );
  }
  return written;
}
