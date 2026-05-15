/**
 * Repair AI cross-contamination from earlier bulk-extract runs.
 *
 * Bug: bulk-extract used to read DOM messages without verifying the right
 * chat had loaded. When jumpToChat didn't actually switch chats, it would
 * read the previous customer's messages and write the extracted data
 * (country / vehicles / etc) to the WRONG contact.
 *
 * Reliable corruption signal: contact.country differs from the country
 * derived from the phone's country code. We use that as the trigger to
 * reset AI-derived fields and re-arm extraction.
 */

import { supabase } from './supabase';
import { phoneToCountry } from './phone-countries';
import { stringifyError } from './errors';
import { fetchAllPaged } from './supabase-paged';
import type { Database } from './database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

const EXTRACTED_PREFIX = 'sgc:extracted:';

export interface RepairScan {
  totalContacts: number;
  mismatched: ContactRow[];
}

export interface RepairResult {
  contactsRepaired: number;
  vehiclesRemoved: number;
  errors: number;
  errorMessages: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export async function scanForMismatches(orgId: string): Promise<RepairScan> {
  // 分页拉全集，规避 1000 行上限——大 org 的 contacts 经常超 1000
  let contacts: ContactRow[];
  try {
    contacts = await fetchAllPaged<ContactRow>((from, to) =>
      supabase
        .from('contacts')
        .select('*')
        .eq('org_id', orgId)
        .range(from, to),
    );
  } catch (err) {
    throw new Error(stringifyError(err));
  }
  const mismatched = contacts.filter((c) => {
    if (!c.country || !c.phone) return false;
    const expected = phoneToCountry(c.phone);
    if (!expected) return false; // Unknown phone code → can't judge
    return normalize(expected) !== normalize(c.country);
  });

  return { totalContacts: contacts.length, mismatched };
}

export async function repairMismatched(
  mismatched: ContactRow[],
): Promise<RepairResult> {
  let contactsRepaired = 0;
  let vehiclesRemoved = 0;
  let errors = 0;
  const errorMessages: string[] = [];

  for (const c of mismatched) {
    try {
      const expectedCountry = phoneToCountry(c.phone);

      // Clear AI-derived fields. Keep name (usually wa_name from WhatsApp profile),
      // notes, customer_stage, quality, tags — those are mostly user-set.
      const { error: updErr } = await supabase
        .from('contacts')
        .update({
          country: expectedCountry ?? null,
          language: null,
          budget_usd: null,
          destination_port: null,
        })
        .eq('id', c.id);
      if (updErr) throw updErr;

      // Vehicle interests are almost certainly cross-contaminated too —
      // if country was wrong, the vehicles came from the same wrong chat.
      const { data: deleted, error: delErr } = await supabase
        .from('vehicle_interests')
        .delete()
        .eq('contact_id', c.id)
        .select('id');
      if (delErr) throw delErr;
      vehiclesRemoved += (deleted ?? []).length;

      // Clear the "already extracted" flag so the next bulk-extract reprocesses.
      await chrome.storage.local.remove(EXTRACTED_PREFIX + c.id);

      contactsRepaired++;
    } catch (err) {
      errors++;
      errorMessages.push(`${c.phone}: ${stringifyError(err)}`);
    }
  }

  return { contactsRepaired, vehiclesRemoved, errors, errorMessages };
}
