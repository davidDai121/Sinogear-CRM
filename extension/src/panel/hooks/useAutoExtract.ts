import { useEffect, useRef, useState } from 'react';
import { readChatMessages } from '@/content/whatsapp-messages';
import { phoneToCountry } from '@/lib/phone-countries';
import { stringifyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { logContactEvent } from '@/lib/events-log';
import type {
  ContactSnapshot,
  ExtractFieldsResponse,
  FieldSuggestion,
  SuggestedField,
  VehicleSuggestion,
} from '@/lib/field-suggestions';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type ContactPatch = Partial<ContactRow>;

export type ExtractStatus = 'idle' | 'running' | 'done' | 'error';

const EXTRACTED_PREFIX = 'sgc:extracted:';

function isPhoneShaped(value: string): boolean {
  return /^[+\d\s\-()]{6,}$/.test(value);
}

function effectivelyEmpty(
  field: SuggestedField,
  contact: ContactRow,
): boolean {
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

import { canonicalizeModel } from '@/lib/vehicle-aliases';

function vehicleKey(model: string, condition: string | null) {
  return `${canonicalizeModel(model).toLowerCase().trim()}::${condition ?? ''}`;
}

interface Args {
  contact: ContactRow | null;
  save: (patch: ContactPatch) => Promise<void>;
  enabled: boolean;
}

export function useAutoExtract({ contact, save, enabled }: Args) {
  const [status, setStatus] = useState<ExtractStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [appliedFields, setAppliedFields] = useState<SuggestedField[]>([]);
  const [retryNonce, setRetryNonce] = useState(0);
  const contactRef = useRef(contact);
  const saveRef = useRef(save);
  contactRef.current = contact;
  saveRef.current = save;

  useEffect(() => {
    if (!enabled) return;
    const contactId = contact?.id;
    if (!contactId) return;

    let cancelled = false;
    const key = EXTRACTED_PREFIX + contactId;

    void (async () => {
      const stored = await chrome.storage.local.get(key);
      if (stored[key] && retryNonce === 0) {
        if (!cancelled) setStatus('done');
        return;
      }

      if (cancelled) return;
      setStatus('running');
      setError(null);
      setAppliedFields([]);

      try {
        const c = contactRef.current;
        if (!c) return;

        const { data: existingVehicles } = await supabase
          .from('vehicle_interests')
          .select('model, condition')
          .eq('contact_id', c.id);

        const existingKeys = new Set(
          (existingVehicles ?? []).map((v) => vehicleKey(v.model, v.condition)),
        );
        const existingModels = (existingVehicles ?? []).map((v) => v.model);

        const messages = readChatMessages(30);

        let suggestions: FieldSuggestion[] = [];
        let vehicles: VehicleSuggestion[] = [];
        if (messages.length) {
          const response = (await chrome.runtime.sendMessage({
            type: 'EXTRACT_FIELDS',
            messages,
            contact: snapshot(c, existingModels),
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
          if (!effectivelyEmpty(s.field, c)) continue;
          const fragment = buildPatchFromSuggestion(s.field, s.value);
          const keys = Object.keys(fragment) as (keyof ContactPatch)[];
          if (!keys.length) continue;
          Object.assign(patch, fragment);
          applied.push(s.field);
        }

        if (
          effectivelyEmpty('country', c) &&
          patch.country == null
        ) {
          const fallback = phoneToCountry(c.phone);
          if (fallback) {
            patch.country = fallback;
            applied.push('country');
          }
        }

        const vehiclesToInsert: Array<{
          contact_id: string;
          model: string;
          condition: 'new' | 'used' | null;
          target_price_usd: number | null;
        }> = [];
        const seen = new Set(existingKeys);
        for (const v of vehicles) {
          const canonModel = canonicalizeModel(v.model);
          const k = vehicleKey(canonModel, v.condition);
          if (seen.has(k)) continue;
          seen.add(k);
          vehiclesToInsert.push({
            contact_id: c.id,
            model: canonModel,
            condition: v.condition,
            target_price_usd: v.target_price_usd,
          });
        }

        if (cancelled) return;

        if (Object.keys(patch).length > 0) {
          await saveRef.current(patch);
        }

        if (vehiclesToInsert.length > 0) {
          await supabase.from('vehicle_interests').insert(vehiclesToInsert);
          for (const v of vehiclesToInsert) {
            void logContactEvent(c.id, 'vehicle_added', {
              model: v.model,
              condition: v.condition,
              source: 'ai',
            });
          }
        }

        if (applied.length > 0 || vehiclesToInsert.length > 0) {
          void logContactEvent(c.id, 'ai_extracted', {
            applied_fields: applied,
            vehicles_added: vehiclesToInsert.length,
          });
        }

        await chrome.storage.local.set({
          [key]: { ts: Date.now(), applied },
        });

        if (cancelled) return;
        setAppliedFields(applied);
        setStatus('done');
      } catch (err) {
        if (cancelled) return;
        setError(stringifyError(err));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, contact?.id, retryNonce]);

  const retry = () => setRetryNonce((n) => n + 1);

  return { status, error, appliedFields, retry };
}
