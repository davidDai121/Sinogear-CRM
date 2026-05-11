/**
 * @lid → phone 持久缓存。
 *
 * 背景：WhatsApp 业务号在 IDB 里是 `<lid_id>@lid`，需要 IDB 里也有
 * jidToPhoneJid 映射才能反查到真手机号。但 WA 经常没及时同步这份映射，
 * 导致 useCrmData 全量扫聊天时这些 @lid chat 的 phone 解析失败 → 这条
 * 聊天虽然在 WA 里能看到，但跟 CRM 的 contact 对不上，左边列表不出现。
 *
 * 这里的策略：用户每打开一个聊天，readCurrentChat 能从 DOM header 文字
 * （形如 "+591 69820483"）解析到真手机号 + 那个聊天的 rawJid，于是把
 * 这对 (rawJid → phone) 持久化到 chrome.storage.local。下次 useCrmData
 * 跑全量扫描时，对 IDB 里没解析出来的 @lid chat 优先查这个缓存。
 *
 * 持久化：chrome.storage.local 跨 session 保留，无需后端。容量上限 5MB
 * 完全够用（一条 entry ~80 字节，几百个业务号也才几十 KB）。
 */

const STORAGE_KEY = 'sgc:jid_phone_cache_v1';

let memCache: Record<string, string> | null = null;
let loadPromise: Promise<Record<string, string>> | null = null;

async function load(): Promise<Record<string, string>> {
  if (memCache) return memCache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const v = got[STORAGE_KEY];
      memCache = v && typeof v === 'object' ? v : {};
    } catch {
      memCache = {};
    }
    return memCache!;
  })();
  return loadPromise;
}

export function getJidPhoneCacheSync(): Record<string, string> {
  // 同步读：返回 mem 副本（如果还没 load 就空）；调用方应先 await ensureLoaded
  return memCache ?? {};
}

export async function ensureJidPhoneCacheLoaded(): Promise<Record<string, string>> {
  return await load();
}

/**
 * 记录一对 (jid → phone)。已存在且相同则跳过 IO。
 */
export async function rememberJidPhone(jid: string, phone: string): Promise<void> {
  if (!jid || !phone) return;
  const cache = await load();
  if (cache[jid] === phone) return;
  cache[jid] = phone;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: cache });
  } catch {
    /* ignore */
  }
}
