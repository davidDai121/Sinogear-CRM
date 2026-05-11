import { supabase } from './supabase';
import { BUILD_VERSION } from './build-version';

const CACHE_KEY = 'sgc_required_version_cache';
const CACHE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000; // 一周

export type VersionStatus =
  | 'dev' // 开发模式，永远放行
  | 'ok' // BUILD_VERSION === required
  | 'mismatch' // 版本号不一致 → 拦死
  | 'missing'; // 拉不到 + 没缓存 → 拦死

export interface VersionCheckResult {
  status: VersionStatus;
  buildVersion: string;
  requiredVersion: string | null;
  /** required 是从网络还是缓存来的（用于 UI 提示） */
  source: 'network' | 'cache' | 'none';
}

interface CachedRequired {
  value: string;
  fetchedAt: number;
}

async function readCache(): Promise<CachedRequired | null> {
  try {
    const got = await chrome.storage.local.get(CACHE_KEY);
    const v = got[CACHE_KEY];
    if (
      v &&
      typeof v === 'object' &&
      typeof v.value === 'string' &&
      typeof v.fetchedAt === 'number'
    ) {
      return v as CachedRequired;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function writeCache(value: string): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { value, fetchedAt: Date.now() } satisfies CachedRequired,
    });
  } catch {
    /* ignore */
  }
}

/**
 * 拉 required_version + 跟 BUILD_VERSION 对比。
 *
 * 策略：
 * - BUILD_VERSION = 'dev' 永远放行（boss `npm run dev` 不受影响）
 * - 网络拉到 → 写缓存 + 比对
 * - 网络拉不到但缓存还在新鲜期 → 用缓存比对
 * - 网络拉不到且无缓存 → 拦死（'missing'）
 * - 比对不匹配 → 'mismatch'（拦死）
 */
export async function checkVersion(): Promise<VersionCheckResult> {
  if (BUILD_VERSION === 'dev' || BUILD_VERSION.startsWith('dev-')) {
    return { status: 'dev', buildVersion: BUILD_VERSION, requiredVersion: null, source: 'none' };
  }

  let required: string | null = null;
  let source: 'network' | 'cache' | 'none' = 'none';

  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'required_version')
      .maybeSingle();
    if (!error && data?.value) {
      required = data.value;
      source = 'network';
      await writeCache(data.value);
    }
  } catch {
    /* fall through to cache */
  }

  if (!required) {
    const cached = await readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_FRESHNESS_MS) {
      required = cached.value;
      source = 'cache';
    }
  }

  if (!required) {
    return { status: 'missing', buildVersion: BUILD_VERSION, requiredVersion: null, source: 'none' };
  }

  if (BUILD_VERSION === required) {
    return { status: 'ok', buildVersion: BUILD_VERSION, requiredVersion: required, source };
  }
  return { status: 'mismatch', buildVersion: BUILD_VERSION, requiredVersion: required, source };
}
