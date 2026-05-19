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

/**
 * 来自 Supabase messages 表的方向信号（migration 0019 的 RPC 提供，0022 加了 count）。
 * 用途：
 *   1. 回填"老聊天点开过但没回"——pending 追踪只能 forward-fill 新发生的；
 *      老 case 靠 useMessageSync 已经同步好的消息表反推：
 *      lastInbound > lastOutbound = 客户最后发的没回 = 我该回。
 *   2. "有历史保护"：当客户在 messages 表里有实质双向历史（双方各 ≥ 5 条）
 *      时，即使 WA chat.t 跨过 7 天的 lost 阈值，autoStage 也不允许是 lost，
 *      最多降到 stalled。防止"以前聊得火热、最近沉默"的客户被 stage-sync
 *      反复改回 lost 覆盖手工 negotiating 标记。
 */
export interface MessageDirectionState {
  /** unix 秒；该 contact 最后一条 inbound 消息的时间。null = 无 inbound 记录 */
  lastInboundT: number | null;
  /** unix 秒；该 contact 最后一条 outbound 消息的时间。null = 无 outbound 记录 */
  lastOutboundT: number | null;
  /** 该 contact 在 messages 表里的 inbound 总条数。0/undefined = 没有 RPC 数据 */
  inboundCount?: number;
  /** 该 contact 在 messages 表里的 outbound 总条数 */
  outboundCount?: number;
}

/** "有历史保护"门槛：双方各至少多少条消息才算"有实质历史"，禁止自动降 lost */
const HISTORY_PROTECT_MIN = 5;
/** 60 天内有任一方向消息 → 算"还活着"，保护生效；超过这个就让它自然 lost */
const HISTORY_PROTECT_RECENT_SEC = 60 * DAY_SEC;

export function classifyChat(
  chat: WAChat,
  pending: PendingReplyState = { capturedAt: null },
  msgDir: MessageDirectionState = { lastInboundT: null, lastOutboundT: null },
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

  // "有历史保护"：客户在 messages 表里有实质双向历史时，不允许自动降到
  // lost——chat-classifier 仅看 WA chat.t（最近一条消息时间），但
  // chat.t 一过 7 天就标 lost，会把"以前聊得很好但最近 sleep"的客户
  // 持续覆盖手工标的 negotiating（2026-05-19 Aca/DON/Grant Wang 案例：
  // 销售刚把它们改成 negotiating，5 秒后 stage-sync 又改回 lost）。
  // 规则：双方各 ≥ 5 条历史 + 最近一条 messages 在 60 天内 → 降级到
  // stalled 而非 lost。彻底没动静（> 60 天）让它自然 lost。
  if (autoStage === 'lost') {
    const inCount = msgDir.inboundCount ?? 0;
    const outCount = msgDir.outboundCount ?? 0;
    if (inCount >= HISTORY_PROTECT_MIN && outCount >= HISTORY_PROTECT_MIN) {
      const lastAnyT = Math.max(
        msgDir.lastInboundT ?? 0,
        msgDir.lastOutboundT ?? 0,
      );
      const ageSinceAnyMsg = lastAnyT > 0 ? now - lastAnyT : Number.MAX_SAFE_INTEGER;
      if (ageSinceAnyMsg <= HISTORY_PROTECT_RECENT_SEC) {
        autoStage = 'stalled';
      }
    }
  }

  // needsReply 三信号（任一即"我该回"）：
  //   1. 实时未读 unreadCount > 0
  //   2. "点开了没回"（forward-fill）：之前扫到未读时记下 chat.t，现在
  //      chat.t 仍等于这个值——说明用户点开把未读清了但没敲发送
  //   3. "DB 里客户最后发的没回"（backfill）：messages 表里
  //      lastInbound > lastOutbound——回填 2026-05-13 之前漏的老 case
  //
  // 没有 #2/#3 的话，用户一点开聊天 WA 立刻把 unread 清零，chat 立刻从
  // "我该回" 掉出去——这是 Kwabena +233 55 678 1531 + Antoine
  // +224 628 19 03 90 案例的根因
  const hasLiveUnread = chat.unreadCount > 0;
  const hasUnsentReply =
    pending.capturedAt != null && chat.t === pending.capturedAt;
  const hasUnansweredInDB =
    msgDir.lastInboundT != null &&
    (msgDir.lastOutboundT == null ||
      msgDir.lastInboundT > msgDir.lastOutboundT);
  const needsReply =
    !chat.archive && (hasLiveUnread || hasUnsentReply || hasUnansweredInDB);

  return { autoStage, needsReply, stalledDays };
}

export function isNewChat(chat: WAChat, now = Date.now() / 1000): boolean {
  if (chat.t === 0) return false;
  return now - chat.t <= NEW_SEC;
}
