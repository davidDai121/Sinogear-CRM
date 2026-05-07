/**
 * 媒体暂存盘的内存 store。Phase C：
 * 用户在聊天里点 📥 → 这里收集 File + 缩略图 →
 * 用户在 tray 里点 "保存到车型" → 上传 Cloudinary + 写 vehicle_media。
 *
 * 不持久化（File 对象不能 serialize；blob URL 跨页面无效），
 * 所以仅当前 web.whatsapp.com 标签页内有效。刷新即清空。
 */

export type CapturedKind = 'image' | 'video' | 'spec';

export interface CapturedMedia {
  id: string;                  // uuid v4 简化版
  file: File;
  thumbDataUrl: string | null; // 小预览（image: dataURL；video: 首帧）
  kind: CapturedKind;
  sourceContactPhone: string | null;
  capturedAt: number;
}

const items: Map<string, CapturedMedia> = new Map();
const listeners: Set<(arr: CapturedMedia[]) => void> = new Set();

function genId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emit() {
  const arr = Array.from(items.values()).sort(
    (a, b) => a.capturedAt - b.capturedAt,
  );
  for (const fn of listeners) {
    try {
      fn(arr);
    } catch {
      // ignore
    }
  }
}

export function getCaptured(): CapturedMedia[] {
  return Array.from(items.values()).sort(
    (a, b) => a.capturedAt - b.capturedAt,
  );
}

export function addCaptured(
  m: Omit<CapturedMedia, 'id' | 'capturedAt'>,
): string {
  const id = genId();
  items.set(id, { ...m, id, capturedAt: Date.now() });
  emit();
  return id;
}

export function removeCaptured(id: string) {
  if (items.delete(id)) emit();
}

export function clearCaptured() {
  if (items.size === 0) return;
  items.clear();
  emit();
}

export function subscribeCaptured(
  fn: (arr: CapturedMedia[]) => void,
): () => void {
  listeners.add(fn);
  fn(getCaptured());
  return () => {
    listeners.delete(fn);
  };
}
