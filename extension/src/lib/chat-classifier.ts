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

export interface ReminderState {
  reminderAckAt: number | null;
  reminderDisabled: boolean;
}

export function classifyChat(
  chat: WAChat,
  reminder: ReminderState = { reminderAckAt: null, reminderDisabled: false },
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

  const hasUnread = chat.unreadCount > 0;
  const customerLastAt = chat.t;
  const ackBlocks =
    reminder.reminderAckAt != null && customerLastAt <= reminder.reminderAckAt;

  // 只要有未读 + 没归档 + 没标已处理 = 我该回
  // (之前有 8 小时阈值，太保守，客户发消息 8 小时内不算"该回"不符合实际工作流)
  const needsReply =
    !chat.archive &&
    hasUnread &&
    !reminder.reminderDisabled &&
    !ackBlocks;

  return { autoStage, needsReply, stalledDays };
}

export function isNewChat(chat: WAChat, now = Date.now() / 1000): boolean {
  if (chat.t === 0) return false;
  return now - chat.t <= NEW_SEC;
}
