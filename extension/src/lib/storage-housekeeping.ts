/**
 * chrome.storage.local 清扫 —— service worker 每次启动跑一次。
 *
 * 配额只有 10 MB，撞满后所有 set 都报 "Resource::kQuotaBytes quota exceeded"，
 * 客户卡的生成/取回也跟着失败。这里把两类会无限累积的 key 收回来：
 *   - aiReplyLog:*            → 交给 ai-reply-log 的字节预算
 *   - gpt.archivedAction:*    → 「解除等待」时留作诊断的记录，单条 100–170 KB，7 天后删
 * 不碰 gpt.pendingAction / gpt.delivery（有自己的生命周期）和任何设置项。
 */
import { enforceAiReplyLogBudget } from './ai-reply-log';

const ARCHIVED_PREFIX = 'gpt.archivedAction:';
const ARCHIVED_TTL = 7 * 24 * 60 * 60 * 1000;

export async function pruneArchivedGptActions(now = Date.now()): Promise<number> {
  try {
    const all = await chrome.storage.local.get(null);
    const stale = Object.entries(all)
      .filter(([k, v]) => k.startsWith(ARCHIVED_PREFIX)
        && now - Number((v as { startedAt?: unknown })?.startedAt ?? 0) > ARCHIVED_TTL)
      .map(([k]) => k);
    if (stale.length) await chrome.storage.local.remove(stale);
    return stale.length;
  } catch (err) {
    console.warn('[storage-housekeeping] archived prune failed', err);
    return 0;
  }
}

/** 2026-09-22 拆掉 Jev 自动选模型后留下的 key：API key 不该继续留在浏览器里。 */
const RETIRED_KEYS = ['jev.credentials.v1', 'gptModelMode'];

export async function runStorageHousekeeping(now = Date.now()): Promise<void> {
  await chrome.storage.local.remove(RETIRED_KEYS).catch(() => {});
  const archived = await pruneArchivedGptActions(now);
  const logs = await enforceAiReplyLogBudget();
  if (archived || logs.removed) console.log('[storage-housekeeping] removed', { archived, logs: logs.removed });
}
