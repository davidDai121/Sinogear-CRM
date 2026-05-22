/**
 * AI 回复 log helper — 本地存储版（chrome.storage.local）
 *
 * 每次 LLM 调用（Claude / Gem 手动 / Gem 自动回复）跑完后调一次 logAiReply()
 * 失败的也记（error 字段），方便回看 prompt 找到为啥跪了
 *
 * 存储设计：
 *   - chrome.storage.local，key = 'aiReplyLog:<uuid>'，value = AiReplyLog
 *   - chrome.storage.local 总配额 10 MB（无 unlimitedStorage 权限）
 *   - 单条 ~10 KB（含完整 prompt） → 上限 ~1000 条
 *   - 写入后超 MAX_ENTRIES 自动 FIFO 淘汰最老的（按 generated_at）
 *
 * 不用 Supabase 的理由：
 *   - 单人主用，团队不真的需要看别人的 AI prompt
 *   - 零网络延迟 / 零 migration / 隐私不外发
 *   - 复制为 markdown 给 Claude review 仍然走 clipboard，跟存哪没关系
 *
 * 如果哪天单人 1000 条不够（≈ 50 calls/day × 20 天），换 IndexedDB 或加
 * "unlimitedStorage" 权限即可，对外 API 不变。
 */

export type AiReplySource = 'claude' | 'gem' | 'gem_auto' | 'gpt';

export interface AiReplyLog {
  id: string;
  org_id: string;
  contact_id: string;
  source: AiReplySource;
  /** Source-specific mode tag — claude: reply/discuss/analyze/variants/quote · gem: gem_first/gem_followup · auto: auto_first/auto_followup */
  mode: string;
  prompt: string;
  response: string | null;
  /** Parsed sections (reply / translation / clientRecord etc.). v1 不写，留扩展 */
  response_parsed: Record<string, unknown> | null;
  /** TOP PRIORITY guidance text user typed in textarea, if any */
  guidance: string | null;
  /** 'dom' = WA 实时聊天 · 'db' = 导入的历史 · 'guidance' = 仅按销售指令冷启动（无历史） */
  message_source: 'dom' | 'db' | 'guidance' | null;
  message_count: number | null;
  chat_url: string | null;
  was_filled: boolean;
  /** ms epoch when was_filled flipped true */
  filled_at: number | null;
  /** ms epoch when generated */
  generated_at: number;
  duration_ms: number | null;
  error: string | null;
}

const KEY_PREFIX = 'aiReplyLog:';
/**
 * 最多保留多少条。chrome.storage.local 配额 10 MB，单条 ~10 KB → 1000 条理论极限。
 * 留一些 headroom 给其他 chrome.storage 用户（自动回复 state 等）。
 */
const MAX_ENTRIES = 800;

export interface LogAiReplyParams {
  orgId: string;
  contactId: string;
  source: AiReplySource;
  mode: string;
  prompt: string;
  response?: string | null;
  responseParsed?: Record<string, unknown> | null;
  guidance?: string | null;
  messageSource?: 'dom' | 'db' | 'guidance' | null;
  messageCount?: number | null;
  chatUrl?: string | null;
  /** True if reply was auto-sent (auto-reply) or pre-filled at insert time. Otherwise false; flip later. */
  wasFilled?: boolean;
  durationMs?: number | null;
  error?: string | null;
}

function keyFor(id: string): string {
  return KEY_PREFIX + id;
}

function isLogKey(k: string): boolean {
  return k.startsWith(KEY_PREFIX);
}

/**
 * Insert a log row. Returns the new row id (for later was_filled flip).
 * 失败安静吞掉 — 永远不阻塞用户 UI。
 */
export async function logAiReply(
  params: LogAiReplyParams,
): Promise<string | null> {
  try {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const log: AiReplyLog = {
      id,
      org_id: params.orgId,
      contact_id: params.contactId,
      source: params.source,
      mode: params.mode,
      prompt: params.prompt,
      response: params.response ?? null,
      response_parsed: params.responseParsed ?? null,
      guidance: params.guidance?.trim() || null,
      message_source: params.messageSource ?? null,
      message_count: params.messageCount ?? null,
      chat_url: params.chatUrl ?? null,
      was_filled: params.wasFilled ?? false,
      filled_at: params.wasFilled ? now : null,
      generated_at: now,
      duration_ms: params.durationMs ?? null,
      error: params.error ?? null,
    };
    await chrome.storage.local.set({ [keyFor(id)]: log });
    // 写完顺手 evict（不 await — 失败也不影响本次写入）
    void evictOldestIfNeeded();
    return id;
  } catch (err) {
    console.warn('[ai-reply-log] write failed', err);
    return null;
  }
}

/**
 * 用户点了 💬 填入聊天框 → 把对应 log 标记 was_filled=true。
 */
export async function markAiReplyFilled(logId: string): Promise<void> {
  try {
    const key = keyFor(logId);
    const got = await chrome.storage.local.get(key);
    const log = got[key] as AiReplyLog | undefined;
    if (!log) return;
    log.was_filled = true;
    log.filled_at = Date.now();
    await chrome.storage.local.set({ [key]: log });
  } catch (err) {
    console.warn('[ai-reply-log] markFilled failed', err);
  }
}

export interface LogQueryOpts {
  orgId: string;
  limit?: number;
  source?: AiReplySource;
  contactId?: string;
  onlyFilled?: boolean;
  onlyErrored?: boolean;
}

/**
 * 取最近 N 条 log（按 generated_at 倒序），按筛选条件过滤。
 * chrome.storage.local 没有 prefix query，必须 get(null) 全扫；500-800 条数据全在内存几毫秒。
 */
export async function listAiReplyLogs(
  opts: LogQueryOpts,
): Promise<AiReplyLog[]> {
  try {
    const all = await chrome.storage.local.get(null);
    let logs: AiReplyLog[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!isLogKey(k) || !v) continue;
      const log = v as AiReplyLog;
      if (log.org_id !== opts.orgId) continue;
      if (opts.source && log.source !== opts.source) continue;
      if (opts.contactId && log.contact_id !== opts.contactId) continue;
      if (opts.onlyFilled && !log.was_filled) continue;
      if (opts.onlyErrored && !log.error) continue;
      logs.push(log);
    }
    logs.sort((a, b) => b.generated_at - a.generated_at);
    return logs.slice(0, opts.limit ?? 100);
  } catch (err) {
    console.warn('[ai-reply-log] list failed', err);
    return [];
  }
}

/**
 * 总数（含筛选维度都不传时返回所有 org 的总数）— 给 stats / 配额提示用。
 */
export async function countAiReplyLogs(orgId?: string): Promise<number> {
  try {
    const all = await chrome.storage.local.get(null);
    let n = 0;
    for (const [k, v] of Object.entries(all)) {
      if (!isLogKey(k) || !v) continue;
      if (orgId && (v as AiReplyLog).org_id !== orgId) continue;
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 全清（维护工具用，没 UI 入口；用户可在 devtools 里调）。
 */
export async function clearAllAiReplyLogs(): Promise<{ cleared: number }> {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(isLogKey);
    if (keys.length === 0) return { cleared: 0 };
    await chrome.storage.local.remove(keys);
    return { cleared: keys.length };
  } catch (err) {
    console.warn('[ai-reply-log] clear failed', err);
    return { cleared: 0 };
  }
}

/**
 * 超过 MAX_ENTRIES 时按 generated_at 升序删最老的，直到剩 MAX_ENTRIES。
 * 不阻塞 logAiReply — 失败安静忽略。
 */
async function evictOldestIfNeeded(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const entries: { key: string; ts: number }[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!isLogKey(k) || !v) continue;
      entries.push({
        key: k,
        ts: (v as AiReplyLog).generated_at ?? 0,
      });
    }
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a.ts - b.ts);
    const toRemove = entries
      .slice(0, entries.length - MAX_ENTRIES)
      .map((e) => e.key);
    if (toRemove.length === 0) return;
    await chrome.storage.local.remove(toRemove);
    console.log('[ai-reply-log] evicted', toRemove.length, 'old logs');
  } catch (err) {
    console.warn('[ai-reply-log] evict failed', err);
  }
}

/**
 * 把单条 log 格式化成 markdown，方便复制粘贴给 Claude review 质量。
 */
export function formatLogAsMarkdown(
  log: AiReplyLog,
  contactSummary?: {
    name?: string | null;
    phone?: string | null;
    country?: string | null;
    stage?: string | null;
  },
): string {
  const lines: string[] = [];
  const ts = new Date(log.generated_at).toLocaleString();
  lines.push(`# AI Reply Log`);
  lines.push('');
  lines.push(`- **Time**: ${ts}`);
  lines.push(`- **Source**: \`${log.source}\` · **Mode**: \`${log.mode}\``);
  if (contactSummary) {
    const parts: string[] = [];
    if (contactSummary.name) parts.push(contactSummary.name);
    if (contactSummary.phone) parts.push(contactSummary.phone);
    if (contactSummary.country) parts.push(contactSummary.country);
    if (contactSummary.stage) parts.push(`stage=${contactSummary.stage}`);
    if (parts.length) lines.push(`- **Customer**: ${parts.join(' · ')}`);
  }
  lines.push(`- **Contact ID**: \`${log.contact_id}\``);
  lines.push(
    `- **Was filled**: ${log.was_filled ? '✅ yes' : '❌ no'}${log.filled_at ? ` (at ${new Date(log.filled_at).toLocaleString()})` : ''}`,
  );
  lines.push(
    `- **Context**: ${log.message_count ?? '?'} messages from \`${log.message_source ?? '?'}\``,
  );
  if (log.duration_ms) {
    lines.push(`- **Duration**: ${(log.duration_ms / 1000).toFixed(1)}s`);
  }
  if (log.chat_url) lines.push(`- **Chat URL**: ${log.chat_url}`);
  if (log.error) {
    lines.push('');
    lines.push(`## ❌ Error`);
    lines.push('```');
    lines.push(log.error);
    lines.push('```');
  }
  if (log.guidance?.trim()) {
    lines.push('');
    lines.push(`## Guidance (sales rep textarea — TOP PRIORITY)`);
    lines.push('```');
    lines.push(log.guidance);
    lines.push('```');
  }
  lines.push('');
  lines.push(`## Full Prompt sent to LLM`);
  lines.push('```');
  lines.push(log.prompt);
  lines.push('```');
  if (log.response) {
    lines.push('');
    lines.push(`## LLM Response (raw)`);
    lines.push('```');
    lines.push(log.response);
    lines.push('```');
  }
  return lines.join('\n');
}
