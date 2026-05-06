import { supabase } from './supabase';
import type { AutoStage } from './chat-classifier';
import type { Database, CustomerStage } from './database.types';
import { logContactEvent } from './events-log';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

const AUTO_TO_DB: Record<AutoStage, CustomerStage> = {
  new: 'new',
  active: 'negotiating',
  stalled: 'stalled',
  lost: 'lost',
};

const AUTO_MANAGED: ReadonlySet<CustomerStage> = new Set<CustomerStage>([
  'new',
  'qualifying',
  'negotiating',
  'stalled',
  'lost',
]);

export interface StageSyncItem {
  contact: ContactRow | null;
  classification: { autoStage: AutoStage } | null;
}

export async function syncAutoStages(items: StageSyncItem[]): Promise<number> {
  const updates: Array<{ id: string; from: CustomerStage; to: CustomerStage }> = [];
  for (const item of items) {
    if (!item.contact || !item.classification) continue;
    const current = item.contact.customer_stage;
    if (!AUTO_MANAGED.has(current)) continue;
    const target = AUTO_TO_DB[item.classification.autoStage];
    if (target === current) continue;
    updates.push({ id: item.contact.id, from: current, to: target });
  }
  if (updates.length === 0) return 0;

  const results = await Promise.all(
    updates.map((u) =>
      supabase
        .from('contacts')
        .update({ customer_stage: u.to })
        .eq('id', u.id)
        .eq('customer_stage', u.from),
    ),
  );

  let written = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.error) {
      written += 1;
      const u = updates[i];
      void logContactEvent(u.id, 'stage_changed', {
        from: u.from,
        to: u.to,
        automatic: true,
      });
    }
  }
  if (written > 0) {
    console.log(`[stage-sync] updated ${written}/${updates.length} contacts`);
  }
  return written;
}
