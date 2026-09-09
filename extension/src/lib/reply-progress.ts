/**
 * 回复进度 —— 跨客户可见的「这个人我处理到哪一步了」。
 *
 * 为什么要有（boss 2026-08-23 原话）：「同时处理多个客户很容易忘了哪个没回哪个回了」。
 *
 * 现状的缺口：`usePersistedReplyStatus` 已经把 done 状态按 (source, contactId)
 * 存进 chrome.storage 了，但那是**给客户卡自己用的**——你切到别的客户，左栏那 130 行
 * 里没有任何痕迹告诉你「这个刚生成完在等你发」「那个还在跑」。人一并发就乱。
 *
 * 这里存的是一份**扁平的、全局的**进度表，左栏每行都能 O(1) 查：
 *
 *   generating  点了生成，还没回来
 *   ready       生成完了，还没填进聊天框
 *   filled      已填入 WhatsApp 输入框，但**还没发出去**
 *
 * 「已发出」故意不存 —— 它由真实数据推导（该客户的 lastOutboundT 晚于本条进度的
 * 时间戳），推导得出就把这条进度删掉。存一个"已发送"标记等于又造一份可能跟事实
 * 不符的状态，而 messages 表 + WA IDB 已经知道答案了。
 *
 * 存一个 key 而不是 per-contact key：左栏渲染要一次拿全量，N 个 key 得 N 次 get。
 */

export type ReplyPhase = 'generating' | 'ready' | 'filled';
export type ReplySource = 'gpt' | 'claude' | 'gem';

export interface ReplyProgress {
  phase: ReplyPhase;
  /** 进入该 phase 的时刻（ms）。判「之后有没有真的发出去」用它当基准线 */
  at: number;
  source: ReplySource;
}

export type ReplyProgressMap = Record<string, ReplyProgress>;

const KEY = 'replyProgress';

/**
 * generating 的最长存活时间。GPT_RUN / GEM_RUN 那边的超时是 240 秒，
 * 这里给到 10 分钟：面板在生成中途被关掉 / WA Web 重载时，那条 generating
 * 没人来改，超时后当它不存在，否则左栏会永远挂着一个 ⏳。
 */
const GENERATING_TTL_MS = 10 * 60 * 1000;

/**
 * ready / filled 的最长存活时间。一天没动就不再提示 —— 到这个份上要么早发了
 * （只是 lastOutboundT 没同步到），要么这条草稿已经没意义了。
 */
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function isFresh(p: ReplyProgress, now: number): boolean {
  const ttl = p.phase === 'generating' ? GENERATING_TTL_MS : IDLE_TTL_MS;
  return now - p.at < ttl;
}

/** 读全量并顺手剔掉过期项（不写回，写回留给下次 set/clear） */
export async function loadReplyProgress(): Promise<ReplyProgressMap> {
  try {
    const s = await chrome.storage.local.get(KEY);
    const raw = (s[KEY] ?? {}) as ReplyProgressMap;
    const now = Date.now();
    const out: ReplyProgressMap = {};
    for (const [id, p] of Object.entries(raw)) {
      if (p && isFresh(p, now)) out[id] = p;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 记一步进度。
 *
 * ⚠️ 读-改-写有并发风险：三个 ReplySection 可能同时在跑不同客户。这里每次都
 * 重新 get 再 set，两次调用挨得极近时后写的会盖掉前一个的改动。实际场景下
 * 两次进度变更之间至少隔着一次网络往返（生成要几十秒），撞上的概率可以忽略，
 * 不值得为它上锁。
 */
export async function setReplyProgress(
  contactId: string,
  phase: ReplyPhase,
  source: ReplySource,
): Promise<void> {
  if (!contactId) return;
  try {
    const cur = await loadReplyProgress();
    cur[contactId] = { phase, at: Date.now(), source };
    await chrome.storage.local.set({ [KEY]: cur });
  } catch {
    // 进度是纯展示用的，写不进去不该影响生成本身
  }
}

export async function clearReplyProgress(contactId: string): Promise<void> {
  if (!contactId) return;
  try {
    const cur = await loadReplyProgress();
    if (!(contactId in cur)) return;
    delete cur[contactId];
    await chrome.storage.local.set({ [KEY]: cur });
  } catch {
    // 同上
  }
}

/**
 * 这条进度是不是已经被真实的出站消息覆盖了 —— 也就是「已经发出去了」。
 *
 * lastOutboundT 是 unix **秒**（messages 表 + WA IDB 两路合并的结果），
 * progress.at 是 **毫秒**，别忘了换算。
 */
export function isSentAfter(
  p: ReplyProgress,
  lastOutboundT: number | null | undefined,
): boolean {
  if (lastOutboundT == null) return false;
  return lastOutboundT * 1000 > p.at;
}
