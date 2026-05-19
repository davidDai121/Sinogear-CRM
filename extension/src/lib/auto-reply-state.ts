/**
 * 自动回复状态：每个 lead 一个状态对象，存在 chrome.storage.local。
 *
 *   key:  autoReply:<contactId>
 *   value: AutoReplyState
 *
 * 流程：scheduled → firing → sending_images → gem_running → reply_filled → done
 *                                                                      ↘ error
 *                                                                      ↘ cancelled
 *
 * 排队成功后还要把同样的 timestamp 通过 chrome.alarms 注册——alarm 是真正的"定时
 * 引爆"机制（SW 休眠也能唤醒）。state 表只是 React 显示 + dedup 用。
 */

export type AutoReplyPhase =
  | 'scheduled'
  | 'firing'
  | 'sending_images'
  | 'gem_running'
  | 'reply_filled'
  | 'done'
  | 'error'
  | 'cancelled';

export interface AutoReplyState {
  contactId: string;
  phone: string | null;
  /** 触发本轮的 inbound 消息进来的时间（首轮=lead，后续=客户回的新消息） */
  leadArrivedAt: number;
  /** 计划触发时间 (= leadArrivedAt + DELAY_MS) */
  scheduledAt: number;
  /** 匹配到的库存车 id（找不到则 null，仍会跑 Gem 但不发图）— 首轮设置后续不变 */
  vehicleId: string | null;
  /** 原始首轮 lead 文本（用于复盘） */
  leadText: string;
  /** 本轮触发的 inbound 消息文本（首轮=lead，续聊=客户最新消息）— 用于判图请求等语义 */
  lastInboundText: string;
  /** lead 表单解析出来的车型片段（debug 用） */
  vehicleHint?: string;
  /** 第几轮：0 = 首轮（lead，发图+文字），≥1 = 续聊（只发文字 + Gem 续上下文） */
  roundCount: number;
  /** 上次本系统处理过的 inbound msg id —— 用于 detector 判断"客户又发新消息了" */
  lastHandledInboundId: string | null;
  phase: AutoReplyPhase;
  error?: string;
  /** 单步完成时间戳，便于显示进度 */
  imagesSentAt?: number;
  gemStartedAt?: number;
  replyFilledAt?: number;
  doneAt?: number;
  updatedAt: number;
}

const PREFIX = 'autoReply:';

export function stateKey(contactId: string): string {
  return `${PREFIX}${contactId}`;
}

export async function getState(
  contactId: string,
): Promise<AutoReplyState | null> {
  const key = stateKey(contactId);
  const got = await chrome.storage.local.get(key);
  const v = got[key];
  return v ? (v as AutoReplyState) : null;
}

export async function setState(state: AutoReplyState): Promise<void> {
  const next = { ...state, updatedAt: Date.now() };
  await chrome.storage.local.set({ [stateKey(state.contactId)]: next });
}

export async function patchState(
  contactId: string,
  patch: Partial<AutoReplyState>,
): Promise<AutoReplyState | null> {
  const cur = await getState(contactId);
  if (!cur) return null;
  const next: AutoReplyState = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [stateKey(contactId)]: next });
  return next;
}

export async function deleteState(contactId: string): Promise<void> {
  await chrome.storage.local.remove(stateKey(contactId));
}

export async function listStates(): Promise<AutoReplyState[]> {
  const all = await chrome.storage.local.get(null);
  const out: AutoReplyState[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PREFIX) && v && typeof v === 'object') {
      out.push(v as AutoReplyState);
    }
  }
  return out;
}

/**
 * 清掉所有自动回复 state（chrome.storage）+ 让 SW 顺手 clear 对应 chrome.alarms。
 *
 * 用于维护按钮"重置自动回复"。SW 里 stale alarm 不清也行（触发时 executeAutoReply
 * 看到 state 没了会 early return），但顺手清干净更整洁。
 */
export async function clearAllStates(): Promise<{ cleared: number }> {
  const all = await chrome.storage.local.get(null);
  // 清 phase state + 旧版 disabled 名单残留（新版 enabled 名单不动——保留用户启用记录）
  const keys = Object.keys(all).filter(
    (k) => k.startsWith(PREFIX) || k.startsWith(LEGACY_DISABLED_PREFIX),
  );
  if (keys.length === 0) return { cleared: 0 };
  await chrome.storage.local.remove(keys);
  await chrome.runtime
    .sendMessage({ type: 'CLEAR_ALL_AUTO_REPLY' })
    .catch(() => undefined); // SW 没启也无所谓，state 已清
  return { cleared: keys.length };
}

/**
 * "本轮已占用"——orchestrator 正在跑或已排队等触发。detector 不应在这种情况下
 * 重新写 state（避免冲掉进行中的工作）。
 *
 * done / reply_filled / error 不算占用——这些是上一轮的终态，遇到客户新消息时
 * detector 会用 startFollowupRound 重置进入下一轮。
 */
export function isInFlight(state: AutoReplyState | null): boolean {
  if (!state) return false;
  return (
    state.phase === 'scheduled' ||
    state.phase === 'firing' ||
    state.phase === 'sending_images' ||
    state.phase === 'gem_running'
  );
}

/** chrome.alarms 用的 alarm key */
export function alarmKey(contactId: string): string {
  return `auto-reply:${contactId}`;
}

/** 反向解出 contactId */
export function parseAlarmKey(name: string): string | null {
  if (!name.startsWith('auto-reply:')) return null;
  return name.slice('auto-reply:'.length);
}

// ── 单客户启用开关 ──
// 跟 AutoReplyState 独立——这是用户级别的"主开关"，跟"本轮已跑过"的 state 是两件事。
//
// **默认关**：没存 key 时视为"未开启"，detector / watcher / orchestrator 三处都跳过。
// 销售必须对某个 contact 显式点 "🔔 开启" 才会自动回复——避免全员客户不知情被自动接管。

const ENABLED_PREFIX = 'autoReplyEnabled:';
// 旧版默认开启时用的禁用名单 prefix——清理时一并扫掉
const LEGACY_DISABLED_PREFIX = 'autoReplyDisabled:';

export async function isContactAutoReplyEnabled(
  contactId: string,
): Promise<boolean> {
  const key = `${ENABLED_PREFIX}${contactId}`;
  const got = await chrome.storage.local.get(key);
  return got[key] === true;
}

export async function setContactAutoReplyEnabled(
  contactId: string,
  enabled: boolean,
): Promise<void> {
  const key = `${ENABLED_PREFIX}${contactId}`;
  if (enabled) {
    await chrome.storage.local.set({ [key]: true });
  } else {
    await chrome.storage.local.remove(key);
  }
}

export function enabledKey(contactId: string): string {
  return `${ENABLED_PREFIX}${contactId}`;
}
