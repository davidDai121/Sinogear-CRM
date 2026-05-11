import { supabase } from './supabase';

export const CLOUDINARY_FREE_QUOTA_BYTES = 25 * 1024 * 1024 * 1024;

export interface CloudinaryUsage {
  totalBytes: number;
  count: number;
  byType: { image: number; video: number; spec: number };
}

export async function fetchCloudinaryUsage(orgId: string): Promise<CloudinaryUsage> {
  const all: { file_size_bytes: number | null; media_type: string }[] = [];
  let from = 0;
  const step = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('vehicle_media')
      .select('file_size_bytes, media_type, vehicles!inner(org_id)')
      .eq('vehicles.org_id', orgId)
      .range(from, from + step - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as { file_size_bytes: number | null; media_type: string }[]));
    if (data.length < step) break;
    from += step;
  }
  const byType = { image: 0, video: 0, spec: 0 };
  let totalBytes = 0;
  for (const r of all) {
    const b = Number(r.file_size_bytes ?? 0);
    totalBytes += b;
    if (r.media_type === 'image') byType.image += b;
    else if (r.media_type === 'video') byType.video += b;
    else if (r.media_type === 'spec') byType.spec += b;
  }
  return { totalBytes, count: all.length, byType };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
