import { supabase } from './supabase';
import { canonicalizeModel, isNoiseModel } from './vehicle-aliases';
import { stringifyError } from './errors';

export interface VehicleCleanupResult {
  scanned: number;
  renamed: number;
  deleted: number;
  noiseDeleted: number;
}

export async function cleanupVehicleInterests(
  orgId: string,
): Promise<VehicleCleanupResult> {
  const { data, error } = await supabase
    .from('vehicle_interests')
    .select('id, contact_id, model, condition, target_price_usd, contacts!inner(org_id)')
    .eq('contacts.org_id', orgId);
  if (error) throw new Error(stringifyError(error));

  const rows = (data ?? []) as Array<{
    id: string;
    contact_id: string;
    model: string;
    condition: string | null;
    target_price_usd: number | null;
  }>;

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
