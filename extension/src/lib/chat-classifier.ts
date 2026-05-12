import type { WAChat } from './whatsapp-idb';

const DAY_SEC = 86400;
const STALLED_MIN_SEC = 3 * DAY_SEC;
const STALLED_MAX_SEC = 7 * DAY_SEC;
const NEW_SEC = DAY_SEC;

export type AutoStage = 'new' | 'active' | 'stalled' | 'lost';

export interface ChatClassification {
  autoStage: AutoStage;
  needsReply: boolean;
  stalledDays: number;
}

export interface PendingReplyState {
  /**
   * 上次扫描到 unreadCount > 0 时 chat.t 的快照（unix 秒）。
   * 用来识别"用户点开了但还没回"——unreadCount 被 WA Web 清零，但
   * chat.t 仍等于这个快照（如果用户真的发了 reply，chat.t 会前进）。
   * null = 从未观察到 unread（或被清理了）。
   */
  capturedAt: number | null;
}

export function classifyChat(
  chat: WAChat,
  pending: PendingReplyState = { capturedAt: null },
  now = Date.now() / 1000,
): ChatClassification {
  const ageSec = chat.t > 0 ? now - chat.t : Number.MAX_SAFE_INTEGER;
  const stalledDays = Math.floor(ageSec / DAY_SEC);

  let autoStage: AutoStage;
  if (chat.t === 0) {
    autoStage = 'new';
  } else if (ageSec > STALLED_MAX_SEC) {
    autoStage = 'lost';
  } else if (ageSec >= STALLED_MIN_SEC) {
    autoStage = 'stalled';
  } else if (ageSec <= NEW_SEC && chat.unreadCount <= 2) {
    autoStage = 'new';
  } else {
    autoStage = 'active';
  }

  // needsReply 双信号（任一即"我该回"）：
  //   1. 实时未读 unreadCount > 0
  //   2. "点开了没回"：之前扫到未读时记下 chat.t，现在 chat.t 仍等于这个
  //      值——说明用户点开把未读清了但没敲发送（真发了 chat.t 会前进）。
  //
  // 没有 #2 的话，用户一点开聊天 WA 立刻把 unread 清零，chat 立刻从
  // "我该回" 掉出去——这是 2026-05-12 的痛点（客户 +233 55 678 1531 案例）
  const hasLiveUnread = chat.unreadCount > 0;
  const hasUnsentReply =
    pending.capturedAt != null && chat.t === pending.capturedAt;
  const needsReply = !chat.archive && (hasLiveUnread || hasUnsentReply);

  return { autoStage, needsReply, stalledDays };
}

export function isNewChat(chat: WAChat, now = Date.now() / 1000): boolean {
  if (chat.t === 0) return false;
  return now - chat.t <= NEW_SEC;
}
