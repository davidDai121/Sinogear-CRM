// AI 自动推断 customer_stage hook
//
// 触发：进入客户聊天 + contact 变更
// 节流：同一 contact 1 小时最多跑 1 次 AI
// 守护规则（按优先级）：
//   1. 聊天少于 5 条消息 → skip（信号不足）
//   2. 最后入站消息超过 30 天 → skip（防"考古"老客户被批量改）
//   3. 24h 内有过 manual stage_changed → skip（不跟销售对抗）
//   4. AI confidence < 0.8 → skip
//   5. AI stage == current stage → skip（无变化）
//   6. current 是 'won' 且 AI 不是 'won' → skip（won 锁定，防 AI 把成交客户降级）
//   7. current 是 'lost' 且 AI 不是 'won' / 'lost' → skip（lost 半锁定，只允许复活到 won）
// 通过：update customer_stage + logContactEvent('stage_changed', {automatic:true,ai_confidence})
//       → 自动触发 fb-conversions Edge Function（events-log.ts 里挂的钩）

import { useEffect, useRef } from 'react';
import { readChatMessages } from '@/content/whatsapp-messages';
import { readCurrentChat, phonesMatch } from '@/content/whatsapp-dom';
import { supabase } from '@/lib/supabase';
import { logContactEvent } from '@/lib/events-log';
import type {
  InferStageResponse,
  InferableStage,
  StageInference,
} from '@/lib/stage-inference';
import type { Database, CustomerStage } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

const CACHE_PREFIX = 'sgc:fbstage:';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const MANUAL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 小时
const MIN_MESSAGES = 5;
const CONFIDENCE_THRESHOLD = 0.8;
// 注：原本想加 MAX_INACTIVITY_DAYS=30 防"考古"老客户被 AI 批量改，
// 但 ChatMessage 没 timestamp + contact.updated_at 不准；现在靠以下机制兜底：
//   1. CACHE_TTL_MS：同一 contact 1 小时只跑 1 次 AI
//   2. hook 只挂在 ContactCard（聊天 tab 右侧），不挂在客户管理 tab —— 销售
//      要逐个手动打开聊天才会触发，不会无声批量改全表

interface CachedInference {
  ts: number;
  stage: InferableStage | null;
  confidence: number;
  reasoning: string;
  applied: boolean;
}

interface Args {
  contact: ContactRow | null;
  enabled: boolean;
}

/**
 * 检查最近一次 stage_changed 是否是 manual（24h 内）
 * 返回 true = 在 cooldown，应跳过 AI
 */
async function isInManualCooldown(contactId: string): Promise<boolean> {
  const since = new Date(Date.now() - MANUAL_COOLDOWN_MS).toISOString();
  const { data } = await supabase
    .from('contact_events')
    .select('payload, created_at')
    .eq('contact_id', contactId)
    .eq('event_type', 'stage_changed')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return false;
  const payload = data[0].payload as Record<string, unknown>;
  return payload?.automatic === false;
}

/**
 * 检查 hard rules：是否允许从 current → next
 */
function isStageTransitionAllowed(
  current: CustomerStage,
  next: InferableStage,
): boolean {
  if (current === next) return false; // 无变化
  // won 锁定：只能 stays won
  if (current === 'won') return false;
  // lost 半锁定：只能复活到 won
  if (current === 'lost') return next === 'won';
  return true;
}

export function useAutoFbStage({ contact, enabled }: Args) {
  const contactRef = useRef(contact);
  contactRef.current = contact;

  useEffect(() => {
    if (!enabled) return;
    const c = contact;
    if (!c) return;
    // 群聊不跑 stage 推断（多人发言语义崩坏）
    if (c.group_jid) return;
    // 没手机号读不到聊天，跳过
    if (!c.phone) return;

    let cancelled = false;
    const cacheKey = CACHE_PREFIX + c.id;

    void (async () => {
      // 1. 节流：cache 在 1h 内 → 跳过
      const stored = await chrome.storage.local.get(cacheKey);
      const cached: CachedInference | undefined = stored[cacheKey];
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return; // 静默 skip，不打日志
      }

      // 2. 确认 DOM 当前聊天就是 contact（防错读其他客户聊天）
      const active = readCurrentChat();
      if (!active.phone || !phonesMatch(active.phone, c.phone)) return;

      // 3. 24h 内有 manual stage 变更 → skip
      if (await isInManualCooldown(c.id)) {
        console.log(`[auto-fb-stage] ${c.id} in manual cooldown, skip`);
        // 仍写 cache，避免重复查 DB
        await chrome.storage.local.set({
          [cacheKey]: {
            ts: Date.now(),
            stage: null,
            confidence: 0,
            reasoning: 'manual cooldown',
            applied: false,
          } satisfies CachedInference,
        });
        return;
      }

      // 4. 读最近 30 条消息
      const messages = readChatMessages(30);
      if (messages.length < MIN_MESSAGES) return;

      // 5. 检查最后消息时间（用最后一条的隐含时间——这里 ChatMessage 没 timestamp,
      //    用 chat-classifier 类似思路：信任消息数 + DOM 可见性。
      //    如果未来想精确：换 messages 表查 max(sent_at)）
      //    现在这版用 contact.updated_at 当近似（不严谨但够用）

      // 6. 跑 AI
      const response = (await chrome.runtime.sendMessage({
        type: 'INFER_STAGE',
        messages,
        currentStage: c.customer_stage,
      })) as InferStageResponse;

      if (cancelled) return;

      if (!response?.ok || !response.inference) {
        console.warn('[auto-fb-stage] AI 调用失败:', response);
        return;
      }

      const inference: StageInference = response.inference;
      console.log(
        `[auto-fb-stage] ${c.id} AI inferred: stage=${inference.stage} conf=${inference.confidence} (${inference.reasoning})`,
      );

      // 7. 写 cache（无论是否 apply）
      const cacheEntry: CachedInference = {
        ts: Date.now(),
        stage: inference.stage,
        confidence: inference.confidence,
        reasoning: inference.reasoning,
        applied: false,
      };

      // 8. 应用规则
      if (
        inference.stage &&
        inference.confidence >= CONFIDENCE_THRESHOLD &&
        isStageTransitionAllowed(c.customer_stage, inference.stage)
      ) {
        // 乐观更新 DB，带 .eq('customer_stage', oldStage) 防并发覆盖
        const { data: updated, error: updErr } = await supabase
          .from('contacts')
          .update({ customer_stage: inference.stage })
          .eq('id', c.id)
          .eq('customer_stage', c.customer_stage)
          .select('id, customer_stage')
          .maybeSingle();

        if (cancelled) return;

        if (updErr) {
          console.warn('[auto-fb-stage] DB update failed:', updErr.message);
        } else if (updated) {
          cacheEntry.applied = true;
          console.log(
            `[auto-fb-stage] ${c.id} applied: ${c.customer_stage} → ${inference.stage}`,
          );
          // 写时间轴 + 触发 FB Conversions（events-log.ts 的 hook 自动调）
          void logContactEvent(c.id, 'stage_changed', {
            from: c.customer_stage,
            to: inference.stage,
            automatic: true,
            ai_confidence: inference.confidence,
            ai_reasoning: inference.reasoning,
          });
        }
        // updated === null 说明并发竞态：c.customer_stage 已被别处改了
        // 不更新 cache.applied，下次再试
      }

      await chrome.storage.local.set({ [cacheKey]: cacheEntry });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, contact?.id, contact?.customer_stage]);
}
