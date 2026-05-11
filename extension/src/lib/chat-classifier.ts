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

  // "只要有新消息来 = 我该回" —— 不再考虑 reminder_disabled / reminder_ack_at，
  // 客户每次发消息都触发重新进 bucket（reminder 仅用于个别业务场景，UI 别用它过滤）
  const needsReply = !chat.archive && chat.unreadCount > 0;

  // reminder 字段保留接口（返回结构没变）以免外面调用方报错；不再影响 needsReply
  void reminder;

  return { autoStage, needsReply, stalledDays };
}

export function isNewChat(chat: WAChat, now = Date.now() / 1000): boolean {
  if (chat.t === 0) return false;
  return now - chat.t <= NEW_SEC;
}
