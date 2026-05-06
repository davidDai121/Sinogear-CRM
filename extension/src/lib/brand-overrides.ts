const KEY = 'sgc:brand-overrides';

// Map of model-name (exact match, case-insensitive) → brand label
export type BrandOverrides = Record<string, string>;

let cache: BrandOverrides | null = null;
let listeners = new Set<() => void>();

export async function loadBrandOverrides(): Promise<BrandOverrides> {
  if (cache) return cache;
  try {
    const result = await chrome.storage.local.get(KEY);
    cache = (result[KEY] as BrandOverrides) ?? {};
  } catch {
    cache = {};
  }
  return cache;
}

export async function saveBrandOverride(
  model: string,
  brand: string,
): Promise<void> {
  const current = await loadBrandOverrides();
  const next = { ...current };
  const key = model.trim().toLowerCase();
  if (brand.trim()) next[key] = brand.trim();
  else delete next[key];
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
  listeners.forEach((fn) => fn());
}

export function getBrandOverride(model: string): string | null {
  if (!cache) return null;
  return cache[model.trim().toLowerCase()] ?? null;
}

export function subscribeBrandOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
