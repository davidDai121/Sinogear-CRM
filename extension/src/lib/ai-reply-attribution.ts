/**
 * AI 回复 attribution —— 出站消息的 AI 来源标记。
 *
 * 问题：用户点 fillReply 把 AI 回复填入 WhatsApp 输入框，但可能：
 *   - 改了几个字再发 ⇒ 半 AI 半 人
 *   - 删了重写 ⇒ manual
 *   - 没发 ⇒ 没出站
 *   - 换 AI 重新生成 ⇒ 实际成单的是后一个
 *   - 复制粘贴而不点填入 ⇒ 没法追踪
 *
 * 现有的 ai_reply_log.was_filled 只代表"点了填入"，不代表"客户收到了 AI 写的版本"。
 *
 * 方案：
 *   1. fillReply 成功 → recordFill 存 chrome.storage 5 分钟窗口（含文本 snippet）
 *   2. syncMessages 写出站消息 → attributeOutboundMessage 查窗口 + 文本相似度匹配
 *   3. 匹配中 → messages.ai_source 写入；匹配不中 → null（manual）
 *
 * 工作流（一条消息从填入到归因的生命周期）：
 *
 *   t=0   用户点 "💬 填入聊天框"
 *         → fillWhatsAppCompose 成功
 *         → recordFill({contactId, source: 'claude', snippet: text.slice(0,80), fillAt: now})
 *         → chrome.storage.local.aiReplyFills 多一条 pending fill
 *
 *   t=10s 用户改了一两个字然后点 WhatsApp 发送
 *         → WhatsApp Web 推送 outbound message 到 DOM
 *
 *   t=15s useMessageSync 轮询读到这条 outbound message
 *         → syncMessages upsert 进 messages 表
 *         → attributeOutboundMessage(contactId, text, sentAt)
 *           ↳ 查 pending fills 里 contactId 一致 + fillAt 在过去 5 分钟内 + 文本前 80 字符相似度 ≥ 0.6
 *           ↳ 命中 → 返回 source='claude'，从 pending 里删除（防止重复归因）
 *           ↳ 不中 → 返回 null（manual）
 *         → ai_source = 'claude' 写入 messages 表
 *
 *   t=5min+ pending fill 自动过期清理（next recordFill / loadFills 时）
 *
 * 设计取舍：
 *   - chrome.storage 不跨设备但用户单人主用，足够
 *   - 文本相似度用 normalized 公共前缀比例（启发式，60% 阈值，容忍小修改）
 *   - 严格匹配会 miss "改了一两个字"；宽松匹配会误判 manual 为 AI —— 60% 是折中
 */

const STORAGE_KEY = 'aiReplyFills';
const WINDOW_MS = 5 * 60 * 1000; // 5 分钟匹配窗口
const SNIPPET_LEN = 80; // 文本快照长度（覆盖大部分回复的关键部分，又不至于太长影响相似度判断）
const SIMILARITY_THRESHOLD = 0.6; // 公共前缀比例阈值

export type AiSource = 'claude' | 'gem' | 'gem_auto' | 'gpt' | 'translate';

export interface PendingFill {
  contactId: string;
  source: AiSource;
  /** 填入文本的前 80 字符 */
  snippet: string;
  /** ms epoch */
  fillAt: number;
  /** 关联的 ai_reply_log id（命中归因时用来 markAiReplyFilled was_sent=true） */
  logId?: string | null;
}

/**
 * 记录一次填入 —— 调用方：ClaudeReplySection / GemReplySection / GPTReplySection 的 fillReply 成功后
 */
export async function recordFill(opts: {
  contactId: string;
  source: AiSource;
  text: string;
  logId?: string | null;
}): Promise<void> {
  const all = await loadFills();
  const fresh = all.filter((f) => Date.now() - f.fillAt < WINDOW_MS);
  fresh.push({
    contactId: opts.contactId,
    source: opts.source,
    snippet: opts.text.slice(0, SNIPPET_LEN),
    fillAt: Date.now(),
    logId: opts.logId ?? null,
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
}

/**
 * 给一条出站消息找匹配的 AI 来源 —— 调用方：syncMessages upsert outbound 时
 *
 * 命中：fillAt 在 5 分钟内 + contactId 一致 + 文本前 80 字符相似度 ≥ 0.6
 * 命中后会从 pending fills 删除这条（防止两条相似消息都被归到同一 fill）
 */
export async function attributeOutboundMessage(opts: {
  contactId: string;
  text: string;
  /** ms epoch；可选，没传就用 now */
  sentAt?: number;
}): Promise<{ source: AiSource; logId: string | null } | null> {
  if (!opts.text) return null;
  const all = await loadFills();
  const now = Date.now();
  const refTs = opts.sentAt ?? now;

  // 候选：同 contact，且 fillAt 时间窗口内
  // 注意：sent_at 可能稍微早于或晚于 fillAt（填入后改字 / WhatsApp 自己的时钟偏差）—— 用绝对差
  const candidates = all.filter(
    (f) =>
      f.contactId === opts.contactId &&
      Math.abs(refTs - f.fillAt) < WINDOW_MS &&
      now - f.fillAt < WINDOW_MS,
  );
  if (candidates.length === 0) return null;

  const sentSnippet = opts.text.slice(0, SNIPPET_LEN);

  // 找相似度最高的
  let best: { fill: PendingFill; score: number } | null = null;
  for (const f of candidates) {
    const score = similarity(f.snippet, sentSnippet);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { fill: f, score };
    }
  }
  if (!best) return null;

  // 命中 → 从 pending 删除避免重复归因
  const remaining = all.filter((f) => f !== best.fill);
  await chrome.storage.local.set({ [STORAGE_KEY]: remaining });

  return { source: best.fill.source, logId: best.fill.logId ?? null };
}

/**
 * 批量归因 —— 给 syncMessages 用，一次性查多条 outbound 的来源
 * 内部串行调 attributeOutboundMessage，确保一条 fill 只命中一条消息
 */
export async function attributeOutboundBatch(
  items: Array<{ contactId: string; text: string; sentAt?: number }>,
): Promise<Array<{ source: AiSource; logId: string | null } | null>> {
  const results: Array<{ source: AiSource; logId: string | null } | null> = [];
  for (const item of items) {
    results.push(await attributeOutboundMessage(item));
  }
  return results;
}

async function loadFills(): Promise<PendingFill[]> {
  const s = await chrome.storage.local.get(STORAGE_KEY);
  const v = s[STORAGE_KEY];
  return Array.isArray(v) ? (v as PendingFill[]) : [];
}

/**
 * 简单文本相似度：normalized 公共前缀比例。
 *
 * 不用 Levenshtein：启发式够用 —— "改了 1-2 个字" 通常在末尾，公共前缀敏感；
 * Levenshtein O(n*m) 每条出站消息都跑略浪费。
 */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  let common = 0;
  const minLen = Math.min(na.length, nb.length);
  for (let i = 0; i < minLen; i++) {
    if (na[i] === nb[i]) common++;
    else break;
  }
  return common / Math.max(na.length, nb.length);
}
