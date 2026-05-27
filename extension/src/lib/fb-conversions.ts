// Meta Conversions API 客户端 wrapper
// 把 customer_stage 变化转发给 conversions-api Edge Function
//
// 设计要点：
//   - fire-and-forget：不 await、不抛错、失败只 console.warn——
//     销售改阶段是高频操作，绝不能让 Meta 那边的网络问题阻塞 UI
//   - 只挂"真实"stage 变化：stage-sync.ts auto-sync 不走这条路（它根本不写
//     contact_events，详见 stage-sync 注释）
//   - 只发"有意义"的阶段：new/qualifying/stalled 三档不发，
//     这些不是 Meta 算法关心的转化节点

import { supabase } from './supabase';
import type { CustomerStage } from './database.types';

/**
 * customer_stage → Meta event_name 映射
 *
 * 用 Meta 标准事件名（Lead / InitiateCheckout / AddPaymentInfo / Purchase）
 * 而不是自定义名——Meta 算法在这几个标准事件上有几十亿训练数据，
 * 优化模型立刻就能跑。自定义事件名要积累几千条才能开始学习。
 *
 * 决策表：
 * - new：跳过——客户刚来还没沟通，可能是 spam / 误触，不该污染 Meta 训练数据
 * - qualifying：'Lead'（Meta 标准）——销售确认是真意向客户
 * - negotiating：'InitiateCheckout'（Meta 标准）——客户进入议价 = 准备购买决策
 * - stalled：跳过——临时挂起，噪音信号
 * - quoted：'AddPaymentInfo'（Meta 标准）——发了正式报价 = 高度接近成交
 * - won：'Purchase'（Meta 标准）——成交，关键转化信号
 * - lost：'Lost'（自定义，Meta 无对应标准事件）——便于以后分析"哪类 lead 易流失"
 *
 * 返回 null 表示这个 stage 不该上报。
 */
export function mapStageToFbEvent(stage: CustomerStage): string | null {
  switch (stage) {
    case 'qualifying':
      return 'Lead';
    case 'negotiating':
      return 'InitiateCheckout';
    case 'quoted':
      return 'AddPaymentInfo';
    case 'won':
      return 'Purchase';
    case 'lost':
      return 'Lost';
    case 'new':
    case 'stalled':
    default:
      return null;
  }
}

/**
 * fire-and-forget 调 conversions-api Edge Function
 * stage 不在白名单内静默 skip。失败只 console.warn 不抛错。
 */
export function triggerFbConversion(
  contactId: string,
  toStage: CustomerStage,
  opts?: { value?: number; testEventCode?: string },
): void {
  const eventName = mapStageToFbEvent(toStage);
  if (!eventName) return;

  void supabase.functions
    .invoke('conversions-api', {
      body: {
        contact_id: contactId,
        event_name: eventName,
        ...(opts?.value !== undefined ? { value: opts.value } : {}),
        ...(opts?.testEventCode ? { test_event_code: opts.testEventCode } : {}),
      },
    })
    .then(({ data, error }) => {
      if (error) {
        console.warn('[fb-conversions] invoke failed:', error.message);
        return;
      }
      // data.ok=false 表示 Edge Function 返回了但 Meta 拒了
      if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
        console.warn('[fb-conversions] Meta rejected event:', data);
      }
    })
    .catch((err) => {
      console.warn('[fb-conversions] invoke threw:', err);
    });
}
