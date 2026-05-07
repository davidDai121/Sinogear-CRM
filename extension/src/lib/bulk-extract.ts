import { supabase } from './supabase';
import { readChatMessages } from '@/content/whatsapp-messages';
import { waitForActiveChatPhone } from '@/content/whatsapp-dom';
import { phoneToCountry } from './phone-countries';
import { jumpToChat } from './jump-to-chat';
import { stringifyError } from './errors';
import { canonicalizeModel } from './vehicle-aliases';
import type {
  ContactSnapshot,
  ExtractFieldsResponse,
  FieldSuggestion,
  SuggestedField,
  VehicleSuggestion,
} from './field-suggestions';
import type { Database } from './database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type ContactPatch = Database['public']['Tables']['contacts']['Update'];
type VehicleInterestInsert =
  Database['public']['Tables']['vehicle_interests']['Insert'];

const EXTRACTED_PREFIX = 'sgc:extracted:';

export interface BulkExtractProgress {
  done: number;
  total: number;
  current: string | null;
  errors: number;
}

interface RunOptions {
  orgId: string;
  perMinute: number;
  onProgress: (p: BulkExtractProgress) => void;
  shouldStop: () => boolean;
}

function isPhoneShaped(value: string): boolean {
  return /^[+\d\s\-()]{6,}$/.test(value);
}

function effectivelyEmpty(field: SuggestedField, contact: ContactRow): boolean {
  if (field === 'budget_usd') {
    return contact.budget_usd == null || Number(contact.budget_usd) === 0;
  }
  const raw = (contact as Record<string, unknown>)[field];
  if (raw == null) return true;
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (!v) return true;
  if (field === 'name' && contact.phone) {
    if (isPhoneShaped(v)) return true;
    const vDigits = v.replace(/[^\d]/g, '');
    const pDigits = contact.phone.replace(/[^\d]/g, '');
    if (vDigits && vDigits === pDigits) return true;
  }
  return false;
}

function buildPatchFromSuggestion(
  field: SuggestedField,
  value: string,
): ContactPatch {
  if (field === 'budget_usd') {
    const num = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(num) || num <= 0) return {};
    return { budget_usd: num };
  }
  const v = value.trim();
  if (!v) return {};
  return { [field]: v } as ContactPatch;
}

function snapshot(
  contact: ContactRow,
  existingVehicleModels: string[],
): ContactSnapshot {
  return {
    name: contact.name ?? null,
    country: contact.country ?? null,
    language: contact.language ?? null,
    budget_usd: contact.budget_usd == null ? null : Number(contact.budget_usd),
    destination_port: contact.destination_port ?? null,
    existingVehicleModels,
  };
}

function vehicleKey(model: string, condition: string | null) {
  return `${canonicalizeModel(model).toLowerCase().trim()}::${condition ?? ''}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isAlreadyExtracted(contactId: string): Promise<boolean> {
  const key = EXTRACTED_PREFIX + contactId;
  const stored = await chrome.storage.local.get(key);
  return Boolean(stored[key]);
}

async function markExtracted(contactId: string, applied: SuggestedField[]) {
  const key = EXTRACTED_PREFIX + contactId;
  await chrome.storage.local.set({
    [key]: { ts: Date.now(), applied },
  });
}

export async function findExtractTargets(orgId: string): Promise<ContactRow[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('org_id', orgId);
  if (error) throw new Error(stringifyError(error));

  const targets: ContactRow[] = [];
  for (const c of (data ?? []) as ContactRow[]) {
    const alreadyExtracted = await isAlreadyExtracted(c.id);
    if (alreadyExtracted) continue;
    const allFilled =
      !effectivelyEmpty('name', c) &&
      !effectivelyEmpty('country', c) &&
      !effectivelyEmpty('budget_usd', c);
    if (allFilled) {
      await markExtracted(c.id, []);
      continue;
    }
    targets.push(c);
  }
  return targets;
}

async function extractOne(
  contact: ContactRow,
): Promise<{
  patch: ContactPatch;
  applied: SuggestedField[];
  vehiclesToInsert: VehicleInterestInsert[];
} | null> {
  const { data: existingVehicles, error: veErr } = await supabase
    .from('vehicle_interests')
    .select('model, condition')
    .eq('contact_id', contact.id);
  if (veErr) throw new Error(stringifyError(veErr));

  const existingKeys = new Set(
    (existingVehicles ?? []).map((v) => vehicleKey(v.model, v.condition)),
  );
  const existingModels = (existingVehicles ?? []).map((v) => v.model);

  const queryDigits = contact.phone.replace(/^\+/, '');
  const jumped = await jumpToChat(queryDigits);
  if (!jumped) return null;

  // Verify the right chat actually loaded — if WhatsApp didn't switch
  // (slow load / search miss / business account), reading DOM messages
  // would pull from the PREVIOUS chat and cross-contaminate this contact.
  const matched = await waitForActiveChatPhone(contact.phone, 3500);
  if (!matched) return null;

  await sleep(300);

  const messages = readChatMessages(30);

  let suggestions: FieldSuggestion[] = [];
  let vehicles: VehicleSuggestion[] = [];
  if (messages.length) {
    const response = (await chrome.runtime.sendMessage({
      type: 'EXTRACT_FIELDS',
      messages,
      contact: snapshot(contact, existingModels),
    })) as ExtractFieldsResponse;
    if (!response?.ok) {
      throw new Error(response?.error ?? '抽取失败');
    }
    suggestions = response.suggestions ?? [];
    vehicles = response.vehicles ?? [];
  }

  const patch: ContactPatch = {};
  const applied: SuggestedField[] = [];

  for (const s of suggestions) {
    if (!effectivelyEmpty(s.field, contact)) continue;
    const fragment = buildPatchFromSuggestion(s.field, s.value);
    if (!Object.keys(fragment).length) continue;
    Object.assign(patch, fragment);
    applied.push(s.field);
  }

  if (effectivelyEmpty('country', contact) && patch.country == null) {
    const fallback = phoneToCountry(contact.phone);
    if (fallback) {
      patch.country = fallback;
      applied.push('country');
    }
  }

  const vehiclesToInsert: VehicleInterestInsert[] = [];
  const seenKeys = new Set(existingKeys);
  for (const v of vehicles) {
    const canonModel = canonicalizeModel(v.model);
    const key = vehicleKey(canonModel, v.condition);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    vehiclesToInsert.push({
      contact_id: contact.id,
      model: canonModel,
      condition: v.condition,
      target_price_usd: v.target_price_usd,
    });
  }

  return { patch, applied, vehiclesToInsert };
}

export async function runBulkExtract(opts: RunOptions): Promise<void> {
  const targets = await findExtractTargets(opts.orgId);
  const total = targets.length;
  let done = 0;
  let errors = 0;
  const intervalMs = Math.max(60000 / Math.max(1, opts.perMinute), 1000);

  opts.onProgress({ done, total, current: null, errors });

  for (const contact of targets) {
    if (opts.shouldStop()) break;
    opts.onProgress({
      done,
      total,
      current: contact.name || contact.phone,
      errors,
    });

    const startTs = Date.now();
    try {
      const result = await extractOne(contact);
      if (result) {
        if (Object.keys(result.patch).length > 0) {
          const { error } = await supabase
            .from('contacts')
            .update(result.patch)
            .eq('id', contact.id);
          if (error) throw new Error(stringifyError(error));
        }
        if (result.vehiclesToInsert.length > 0) {
          const { error } = await supabase
            .from('vehicle_interests')
            .insert(result.vehiclesToInsert);
          if (error) throw new Error(stringifyError(error));
        }
        await markExtracted(contact.id, result.applied);
      } else {
        // Jump-to-chat failed (chat deleted / archived / not in list).
        // Apply phone-code country fallback and mark extracted so we don't loop forever.
        const fallback = phoneToCountry(contact.phone);
        if (fallback && !contact.country) {
          const { error } = await supabase
            .from('contacts')
            .update({ country: fallback })
            .eq('id', contact.id);
          if (!error) {
            await markExtracted(contact.id, ['country']);
          } else {
            await markExtracted(contact.id, []);
          }
        } else {
          await markExtracted(contact.id, []);
        }
      }
    } catch {
      errors++;
    }

    done++;
    opts.onProgress({ done, total, current: null, errors });

    const elapsed = Date.now() - startTs;
    const wait = Math.max(0, intervalMs - elapsed);
    if (wait > 0) await sleep(wait);
  }

  opts.onProgress({ done, total, current: null, errors });
}
