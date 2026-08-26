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
 * 直接发一个指定名字的事件（不走 stage 映射）。
 *
 * 用于人工判定的「合格线索 / 不合格线索」—— Meta 的 Conversion Leads
 * Optimization 就是靠这类自定义事件名学习的（需要在 Events Manager 里
 * 先把事件名注册成 lead 阶段）。
 *
 * conversions-api 的 event_name 是自由字符串、没有白名单，所以自定义名字
 * 不需要重新部署函数。
 */
export function sendFbEvent(
  contactId: string,
  eventName: string,
  opts?: { value?: number; testEventCode?: string },
): void {
  void supabase.functions
    .invoke('conversions-api', {
      body: {
        contact_id: contactId,
        event_name: eventName,
        ...(opts?.value !== undefined ? { value: opts.value } : {}),
        ...(opts?.testEventCode ? { test_event_code: opts.testEventCode } : {}),
      },
    })
    .then(({ error }) => {
      if (error) console.warn('[fb-conversions] invoke failed:', error.message);
    })
    .catch((err) => console.warn('[fb-conversions] invoke threw:', err));
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

  // 只回传带广告标识的客户 —— 跟 lead-qualification.recordJudgment 同一条规矩。
  //
  // 2026-08-25 实测：像素里躺着 4,155 条历史 CAPI 事件，成功的约 3,100 条里
  // 只有 2 条来自广告线索，其余全是老客户簿的阶段变化（Lead 1,665 /
  // InitiateCheckout 1,265 / AddPaymentInfo 152）。老客户的手机号哈希照样能
  // 匹配到某个 FB 用户，于是 Meta 学到的「优质客户长相」是这本簿子的样子，
  // 不是广告人群的样子 —— 广告信号被稀释了三个数量级。
  //
  // 查一次 contact 换一条干净的训练数据，值。查不到就不发（fail closed）。
  void (async () => {
    const { data: contact, error } = await supabase
      .from('contacts')
      .select('fb_lead_id, ctwa_clid, fb_ad_id')
      .eq('id', contactId)
      .maybeSingle();
    if (error) {
      console.warn('[fb-conversions] 查广告标识失败，跳过回传:', error.message);
      return;
    }
    if (!contact?.fb_lead_id && !contact?.ctwa_clid && !contact?.fb_ad_id) {
      return; // 不是广告来的客户，不污染数据集
    }
    sendToConversionsApi(contactId, eventName, opts);
  })();
}

function sendToConversionsApi(
  contactId: string,
  eventName: string,
  opts?: { value?: number; testEventCode?: string },
): void {
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
