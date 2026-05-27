import { useCallback, useEffect, useState } from 'react';

/**
 * Reply section 的 status 通用接口 — 三个 ReplySection（GPT/Claude/Gem）的 Status
 * 联合类型都有 `kind` 标签。这个 hook 只关心 kind 是不是 'done'，不关心 mode/text 等。
 */
interface BaseStatus {
  kind: 'idle' | 'reading' | 'sending' | 'waiting' | 'done' | 'error';
  /**
   * Hook 自动塞的"持久化写入时刻" — 仅 done 状态有。UI 用它显示 "生成于 XX:XX（X 分钟前）"
   * 让用户一眼看出这是当下生成的还是切回来看到的 stale done card。
   */
  generatedAt?: number;
}

/**
 * 持久化版 useState<Status> — 切客户后回到原客户能恢复上一次 AI 回复。
 *
 * 之前的 bug：
 *   - 三个 ReplySection 都用 useState<Status>(idle)，切 contact.id 时 setStatus(idle)
 *   - 用户跑完 generate 看到 done card；切到 contact B；切回 A → idle，回复看不到了
 *   - 用户被迫"留在原客户上不动直到回复出来"才能用上
 *
 * 修复策略（done 状态 only）：
 *   - storage key: `replyStatus:<source>:<contactId>`
 *   - setStatus(done) → 写 storage
 *   - setStatus(idle/error) → remove storage（清理，避免切回看到旧错误）
 *   - setStatus(reading/sending/waiting) → 不写（transient 状态，切回再来一遍才合理）
 *   - 切 contact.id → 先 setStateInner(initial)（瞬时 idle 避免闪现旧客户内容）
 *     → 然后异步 get storage，若有 done 则恢复
 *
 * 并发安全（用户切 A→B 之间 generate 完成）：
 *   - generate 是 async 函数，闭包绑定旧 setStatus（A 的 key）
 *   - generate 完成 → setStatus(done) → 写 A 的 storage（B 的组件已重置 status 不受影响）
 *   - 切回 A → useEffect 读 A 的 storage → 恢复 done ✅
 *
 * 不持久化的：
 *   - guidance / discuss textarea（各 ReplySection 自己已经按 contact 持久化）
 *   - 完整 ai_reply_log（独立系统，给 boss review 用）
 *
 * 空间：每条 done status ~5-50KB（含完整 response_text），按 source × contact 存。
 * chrome.storage.local 总配额 10MB，ai_reply_log 占大头（~8MB），这里留 ~1-2MB 够用。
 * LRU evict 暂没做（实际用量远低于上限），需要时再加。
 */
export function usePersistedReplyStatus<T extends BaseStatus>(
  source: 'gpt' | 'claude' | 'gem',
  contactId: string,
  initial: T,
): [T, (next: T) => void] {
  const key = `replyStatus:${source}:${contactId}`;
  const [state, setStateInner] = useState<T>(initial);

  // 切 contactId/source 时：立刻回到 initial（防止闪现旧客户 done），再异步恢复
  useEffect(() => {
    let cancelled = false;
    setStateInner(initial);
    void chrome.storage.local.get(key).then((s) => {
      if (cancelled) return;
      const saved = s[key] as T | undefined;
      if (saved && saved.kind === 'done') {
        // ⚠️ Race fix：async get 完成的时刻，state 可能已经被用户操作改过了
        // （切 contact 后立刻点 generate → state = reading；GPT 跑完 → state = new done）。
        // 这种情况下不能用 stale done 覆盖，否则用户看到的就是"1 小时前的 prompt"，
        // 跟刚点 generate 完全脱钩。用 functional setState 拿到当前 state 判断：
        // 只在 state 仍是 initial（kind 没变）时才用 stale done 恢复。
        setStateInner((current) => {
          if (current.kind !== initial.kind) return current;
          return saved;
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setStatus = useCallback(
    (next: T) => {
      // done 状态自动盖一个 generatedAt 戳，让 UI 能显示 "生成于 XX:XX"
      const stamped =
        next.kind === 'done' && next.generatedAt == null
          ? { ...next, generatedAt: Date.now() }
          : next;
      setStateInner(stamped);
      if (stamped.kind === 'done') {
        void chrome.storage.local.set({ [key]: stamped });
      } else if (stamped.kind === 'idle' || stamped.kind === 'error') {
        // 用户主动清除（reset 按钮）或失败 → 清 storage 不让切回再看到
        void chrome.storage.local.remove(key);
      }
      // reading / sending / waiting 不写 storage（transient）
    },
    [key],
  );

  return [state, setStatus];
}
