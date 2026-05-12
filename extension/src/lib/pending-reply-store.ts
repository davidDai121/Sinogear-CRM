import type { WAChat } from './whatsapp-idb';

/**
 * "点开了但没回"状态追踪。
 *
 * 解决的痛点：用户在 WA Web 点开一个聊天后，WhatsApp 立刻把 unreadCount
 * 清零；如果"我该回"只看 unreadCount > 0，这个聊天会立刻从 bucket 里消失
 * ——哪怕用户根本没敲回复。客户的消息就这么被遗忘了。
 *
 * 思路：每次 20s 扫 IDB chat 表时，对 unreadCount > 0 的聊天把当前 chat.t
 * 记下来。下次扫如果 chat.t 没变（说明用户没发新消息），保留记录 →
 * classifyChat 据此判定还在"我该回"。一旦用户真发了 reply，chat.t 会前进
 * 超过记录值，自动清掉。客户再发新消息时 unreadCount > 0 会重新写入。
 */

const STORAGE_KEY = 'sgc:pending_reply_v1';
/** 14 天还没回的就老化掉，免得长期僵尸条目 */
const MAX_AGE_SEC = 14 * 86400;

export interface PendingEntry {
  /** 上次观察到 unreadCount > 0 时 chat.t 的快照（unix 秒） */
  capturedAt: number;
}

export type PendingReplyMap = Record<string, PendingEntry>;

export async function loadPendingReplyMap(): Promise<PendingReplyMap> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return (stored[STORAGE_KEY] as PendingReplyMap | undefined) ?? {};
  } catch {
    return {};
  }
}

/**
 * 根据当前 chats 状态计算新的 pending map，并持久化（只在 diff 时写）。
 *
 * 规则：
 *   - chat.unreadCount > 0 → 设置/更新 next[id] = { capturedAt: chat.t }
 *   - chat.unreadCount == 0 且有 prev 条目：
 *     - chat.t === prev.capturedAt：用户点开但没发送 → 保留（仍"我该回"）
 *     - chat.t > prev.capturedAt：chat 前进了（用户发送或客户极速再发后用户立刻看）
 *       → 清掉。罕见 race 会漏一次，客户下次发会重新进入
 *     - chat.t < prev.capturedAt：不应该发生（chat.t 单调递增），谨慎保留
 *   - chat 不在 wa.chats 列表里了（归档/隐藏）→ 不写入 next（自动清理）
 *   - prev 条目超过 MAX_AGE_SEC 也丢弃
 */
export async function updatePendingReplyMap(
  chats: WAChat[],
  now: number = Date.now() / 1000,
): Promise<PendingReplyMap> {
  const prev = await loadPendingReplyMap();
  const next: PendingReplyMap = {};
  const prevKeys = Object.keys(prev);
  let changed = false;

  const seenIds = new Set<string>();
  for (const chat of chats) {
    seenIds.add(chat.id);
    const prevEntry = prev[chat.id];
    if (chat.unreadCount > 0) {
      if (!prevEntry || prevEntry.capturedAt !== chat.t) changed = true;
      next[chat.id] = { capturedAt: chat.t };
    } else if (prevEntry) {
      if (chat.t === prevEntry.capturedAt) {
        if (now - prevEntry.capturedAt > MAX_AGE_SEC) {
          changed = true; // 老化丢弃
        } else {
          next[chat.id] = prevEntry;
        }
      } else if (chat.t > prevEntry.capturedAt) {
        changed = true; // 用户发送了，清掉
      } else {
        next[chat.id] = prevEntry; // 时间倒退（不会发生），谨慎保留
      }
    }
  }

  // 不在当前 chats 列表里的条目自动消失（旧条目）
  for (const k of prevKeys) {
    if (!seenIds.has(k)) changed = true;
  }

  if (changed) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
    } catch {
      // 静默失败：下次扫还会再算
    }
  }
  return next;
}
