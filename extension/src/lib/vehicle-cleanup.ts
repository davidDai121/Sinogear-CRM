import { supabase } from './supabase';
import { canonicalizeModel, isNoiseModel } from './vehicle-aliases';
import { stringifyError } from './errors';
import { fetchAllPaged } from './supabase-paged';

export interface VehicleCleanupResult {
  scanned: number;
  renamed: number;
  deleted: number;
  noiseDeleted: number;
}

interface InterestRow {
  id: string;
  contact_id: string;
  model: string;
  condition: string | null;
  target_price_usd: number | null;
}

export async function cleanupVehicleInterests(
  orgId: string,
): Promise<VehicleCleanupResult> {
  // 分页拉全集，规避 Supabase 默认 1000 行上限（用户 2026-05-15 反馈"扫描 1000"
  // 然后停了，就是这里漏分页）
  let rows: InterestRow[];
  try {
    rows = await fetchAllPaged<InterestRow>((from, to) =>
      supabase
        .from('vehicle_interests')
        .select(
          'id, contact_id, model, condition, target_price_usd, contacts!inner(org_id)',
        )
        .eq('contacts.org_id', orgId)
        .range(from, to),
    );
  } catch (err) {
    throw new Error(stringifyError(err));
  }

  let renamed = 0;
  let deleted = 0;
  let noiseDeleted = 0;
  const seen = new Map<string, { id: string; price: number | null }>();
  const toUpdate: Array<{ id: string; model: string }> = [];
  const toDelete: string[] = [];

  for (const r of rows) {
    if (isNoiseModel(r.model)) {
      toDelete.push(r.id);
      noiseDeleted++;
      continue;
    }
    const canon = canonicalizeModel(r.model);
    if (isNoiseModel(canon)) {
      toDelete.push(r.id);
      noiseDeleted++;
      continue;
    }
    const key = `${r.contact_id}::${canon.toLowerCase()}::${r.condition ?? ''}`;

    const existing = seen.get(key);
    if (existing) {
      if (r.target_price_usd != null && existing.price == null) {
        toDelete.push(existing.id);
        seen.set(key, { id: r.id, price: r.target_price_usd });
      } else {
        toDelete.push(r.id);
      }
    } else {
      seen.set(key, { id: r.id, price: r.target_price_usd });
      if (canon !== r.model) toUpdate.push({ id: r.id, model: canon });
    }
  }

  for (const u of toUpdate) {
    const { error: uErr } = await supabase
      .from('vehicle_interests')
      .update({ model: u.model })
      .eq('id', u.id);
    if (uErr) throw new Error(stringifyError(uErr));
    renamed++;
  }

  if (toDelete.length) {
    const CHUNK = 100;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const batch = toDelete.slice(i, i + CHUNK);
      const { error: dErr } = await supabase
        .from('vehicle_interests')
        .delete()
        .in('id', batch);
      if (dErr) throw new Error(stringifyError(dErr));
      deleted += batch.length;
    }
  }

  return { scanned: rows.length, renamed, deleted: deleted - noiseDeleted, noiseDeleted };
}
