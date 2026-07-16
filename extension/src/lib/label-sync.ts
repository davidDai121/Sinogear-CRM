import { supabase } from './supabase';
import { readWhatsAppData, resolvePhone } from './whatsapp-idb';
import { stringifyError } from './errors';
import { REGIONS } from './regions';
import { canonicalizeModel } from './vehicle-aliases';
import { fetchAllPaged } from './supabase-paged';
import type { CustomerQuality, CustomerStage } from './database.types';

type WhatsAppDataSnapshot = Awaited<ReturnType<typeof readWhatsAppData>>;

interface CategoryResult {
  category: 'quality' | 'stage' | 'country' | 'vehicle' | 'tag' | 'system';
  value?: string;
}

const SYSTEM_LABELS = new Set(['未读', '特别关注', '群组']);

const COUNTRY_BY_NAME = (() => {
  const m = new Map<string, string>();
  for (const r of REGIONS) {
    for (const c of r.countries) {
      m.set(c.toLowerCase(), c);
    }
  }
  return m;
})();

const ALIAS_TO_COUNTRY: Array<[RegExp, string]> = [
  [/埃塞|ethiopia/i, 'Ethiopia'],
  [/肯尼亚|kenya/i, 'Kenya'],
  [/坦桑|tanzania/i, 'Tanzania'],
  [/尼日利亚|nigeria/i, 'Nigeria'],
  [/加纳|ghana/i, 'Ghana'],
  [/塞内加尔|senegal/i, 'Senegal'],
  [/喀麦隆|cameroon/i, 'Cameroon'],
  [/南非|south\s*africa/i, 'South Africa'],
  [/摩洛哥|morocco/i, 'Morocco'],
  [/阿尔及利亚|algeria/i, 'Algeria'],
  [/突尼斯|tunisia/i, 'Tunisia'],
  [/利比亚|libya/i, 'Libya'],
  [/沙特|saudi/i, 'Saudi Arabia'],
  [/迪拜|阿联酋|uae|emirates/i, 'UAE'],
  [/伊拉克|iraq/i, 'Iraq'],
  [/约旦|jordan/i, 'Jordan'],
  [/印度|india/i, 'India'],
  [/巴基斯坦|pakistan/i, 'Pakistan'],
  [/孟加拉|bangladesh/i, 'Bangladesh'],
  [/尼泊尔|nepal/i, 'Nepal'],
  [/泰国|thailand/i, 'Thailand'],
  [/越南|vietnam/i, 'Vietnam'],
  [/印尼|印度尼西亚|indonesia/i, 'Indonesia'],
  [/马来|malaysia/i, 'Malaysia'],
  [/菲律宾|philippines/i, 'Philippines'],
  [/秘鲁|peru/i, 'Peru'],
  [/墨西哥|mexico/i, 'Mexico'],
  [/哥伦比亚|colombia/i, 'Colombia'],
  [/玻利维亚|bolivia/i, 'Bolivia'],
  [/巴西|brazil/i, 'Brazil'],
  [/智利|chile/i, 'Chile'],
];

const VEHICLE_PATTERNS: Array<[RegExp, string]> = [
  [/坦克\s*300|tank\s*300/i, '坦克 300'],
  [/坦克\s*500|tank\s*500/i, '坦克 500'],
  [/坦克\s*700|tank\s*700/i, '坦克 700'],
  [/song\s*plus|宋\s*plus/i, 'BYD Song Plus'],
  [/^mini$|宝马\s*mini/i, 'MINI'],
  [/卡罗拉|corolla/i, 'Toyota Corolla'],
  [/hilux|海拉克斯/i, 'Toyota Hilux'],
  [/rav4|荣放/i, 'Toyota RAV4'],
  [/兰德酷路泽|land\s*cruiser|lc\s*\d+/i, 'Toyota Land Cruiser'],
  [/普拉多|prado/i, 'Toyota Prado'],
  [/海豚|dolphin/i, 'BYD Dolphin'],
  [/atto|元\s*plus/i, 'BYD Atto 3'],
  [/汉|han\b/i, 'BYD Han'],
  [/秦|qin/i, 'BYD Qin'],
  [/唐|tang/i, 'BYD Tang'],
  [/海豹|seal/i, 'BYD Seal'],
  [/h6|哈弗h6/i, 'Haval H6'],
  [/poer|皮卡|poer/i, 'GWM Poer'],
  [/civic|思域/i, 'Honda Civic'],
  [/cr-?v|crv/i, 'Honda CR-V'],
  [/model\s*y/i, 'Tesla Model Y'],
  [/model\s*3/i, 'Tesla Model 3'],
];

function categorizeLabel(name: string): CategoryResult {
  const trimmed = name.trim();
  if (SYSTEM_LABELS.has(trimmed)) return { category: 'system' };

  if (/^大客户|VIP/i.test(trimmed)) return { category: 'quality', value: 'big' };
  if (/重要/.test(trimmed)) return { category: 'quality', value: 'big' };
  if (/有潜力/.test(trimmed)) return { category: 'quality', value: 'potential' };
  if (/普通/.test(trimmed)) return { category: 'quality', value: 'normal' };
  if (/垃圾|骚扰|无效|spam/i.test(trimmed))
    return { category: 'quality', value: 'spam' };

  if (/待付款|已报价|报价/.test(trimmed))
    return { category: 'stage', value: 'quoted' };
  // WhatsApp 标签常年不清理，不能作为付款/订单事实。以前这里直接写 won，
  // 导致“口头同意/等待银行”的客户被 CRM 统计成成交。保留成待核实标签，
  // 真正成交必须由销售在 CRM 手动确认。
  if (/成交|已成交|签约|订单/.test(trimmed))
    return { category: 'tag', value: 'WhatsApp 成交待核实' };
  if (/流失|丢失/.test(trimmed)) return { category: 'stage', value: 'lost' };
  if (/潜在客户|新询盘/.test(trimmed))
    return { category: 'stage', value: 'new' };
  if (/^跟进$|跟进中/.test(trimmed))
    return { category: 'stage', value: 'negotiating' };

  for (const [pattern, model] of VEHICLE_PATTERNS) {
    if (pattern.test(trimmed)) return { category: 'vehicle', value: model };
  }

  const direct = COUNTRY_BY_NAME.get(trimmed.toLowerCase());
  if (direct) return { category: 'country', value: direct };
  for (const [pattern, country] of ALIAS_TO_COUNTRY) {
    if (pattern.test(trimmed)) return { category: 'country', value: country };
  }

  if (/岛国|海岛|大区|片区/.test(trimmed))
    return { category: 'tag', value: trimmed };

  return { category: 'tag', value: trimmed };
}

export interface LabelSyncResult {
  totalAssociations: number;
  contactsTouched: number;
  labelsStored: number;
  labelsDeactivated: number;
  associationsStored: number;
  associationsRemoved: number;
  qualityUpdated: number;
  stageUpdated: number;
  countryUpdated: number;
  tagsAdded: number;
  vehiclesAdded: number;
  unmatchedLabels: string[];
}

interface PersistedWhatsAppResult {
  labelsStored: number;
  labelsDeactivated: number;
  associationsStored: number;
  associationsRemoved: number;
}

const WRITE_CHUNK_SIZE = 500;

function chunksOf<T>(items: T[], size = WRITE_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function persistWhatsAppLabels(
  orgId: string,
  wa: WhatsAppDataSnapshot,
  contactByPhone: Map<
    string | null,
    {
      id: string;
      phone: string | null;
      quality: CustomerQuality;
      customer_stage: CustomerStage;
      country: string | null;
    }
  >,
): Promise<PersistedWhatsAppResult> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const userId = authData.user?.id;
  if (!userId) throw new Error('登录已失效，请重新登录 CRM');

  const syncedAt = new Date().toISOString();
  const labelRows = wa.labels.map((label) => ({
    org_id: orgId,
    user_id: userId,
    wa_label_id: label.id,
    name: label.name,
    color_index: label.colorIndex,
    label_type: label.type,
    is_active: label.isActive,
    synced_at: syncedAt,
  }));

  for (const chunk of chunksOf(labelRows)) {
    const { error } = await supabase
      .from('whatsapp_labels')
      .upsert(chunk, { onConflict: 'org_id,user_id,wa_label_id' });
    if (error) throw error;
  }

  const storedLabels = await fetchAllPaged((from, to) =>
    supabase
      .from('whatsapp_labels')
      .select('id, wa_label_id, is_active')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, to),
  );

  const currentWaIds = new Set(wa.labels.map((label) => label.id));
  const missingLabelIds = storedLabels
    .filter((label) => label.is_active && !currentWaIds.has(label.wa_label_id))
    .map((label) => label.id);
  for (const chunk of chunksOf(missingLabelIds)) {
    const { error } = await supabase
      .from('whatsapp_labels')
      .update({ is_active: false, synced_at: syncedAt })
      .in('id', chunk);
    if (error) throw error;
  }

  const storedLabelIdByWaId = new Map(
    storedLabels.map((label) => [label.wa_label_id, label.id]),
  );
  const activeWaLabelIds = new Set(
    wa.labels.filter((label) => label.isActive).map((label) => label.id),
  );
  const desiredAssociations = new Map<
    string,
    { contact_id: string; whatsapp_label_id: string; synced_at: string }
  >();

  for (const association of wa.associations) {
    if (
      association.type !== 'jid' ||
      !activeWaLabelIds.has(association.labelId)
    ) {
      continue;
    }
    const phone = resolvePhone(association.associationId, wa.jidToPhoneJid);
    if (!phone) continue;
    const contact = contactByPhone.get(phone);
    const whatsappLabelId = storedLabelIdByWaId.get(association.labelId);
    if (!contact || !whatsappLabelId) continue;
    const key = `${contact.id}:${whatsappLabelId}`;
    desiredAssociations.set(key, {
      contact_id: contact.id,
      whatsapp_label_id: whatsappLabelId,
      synced_at: syncedAt,
    });
  }

  const existingAssociations = await fetchAllPaged((from, to) =>
    supabase
      .from('contact_whatsapp_labels')
      .select(
        'id, contact_id, whatsapp_label_id, whatsapp_labels!inner(org_id, user_id)',
      )
      .eq('whatsapp_labels.org_id', orgId)
      .eq('whatsapp_labels.user_id', userId)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const staleAssociationIds = existingAssociations
    .filter(
      (row) =>
        !desiredAssociations.has(`${row.contact_id}:${row.whatsapp_label_id}`),
    )
    .map((row) => row.id);

  for (const chunk of chunksOf(staleAssociationIds)) {
    const { error } = await supabase
      .from('contact_whatsapp_labels')
      .delete()
      .in('id', chunk);
    if (error) throw error;
  }
  for (const chunk of chunksOf(Array.from(desiredAssociations.values()))) {
    const { error } = await supabase
      .from('contact_whatsapp_labels')
      .upsert(chunk, {
        onConflict: 'contact_id,whatsapp_label_id',
      });
    if (error) throw error;
  }

  return {
    labelsStored: labelRows.length,
    labelsDeactivated: missingLabelIds.length,
    associationsStored: desiredAssociations.size,
    associationsRemoved: staleAssociationIds.length,
  };
}

export async function syncWhatsAppLabels(
  orgId: string,
  snapshot?: WhatsAppDataSnapshot,
): Promise<LabelSyncResult> {
  const wa = snapshot ?? (await readWhatsAppData());

  const labelById = new Map(wa.labels.map((l) => [l.id, l]));

  // 三张表都分页拉全集，规避 1000 行上限
  let contactRows: Array<{
    id: string;
    phone: string | null;
    quality: CustomerQuality;
    customer_stage: CustomerStage;
    country: string | null;
  }>;
  let existingTags: Array<{ contact_id: string; tag: string }>;
  let existingVehicles: Array<{ contact_id: string; model: string }>;
  try {
    [contactRows, existingTags, existingVehicles] = await Promise.all([
      fetchAllPaged((from, to) =>
        supabase
          .from('contacts')
          .select('id, phone, quality, customer_stage, country')
          .eq('org_id', orgId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from('contact_tags')
          .select('contact_id, tag, contacts!inner(org_id)')
          .eq('contacts.org_id', orgId)
          .order('contact_id', { ascending: true })
          .order('tag', { ascending: true })
          .range(from, to),
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from('vehicle_interests')
          .select('contact_id, model, contacts!inner(org_id)')
          .eq('contacts.org_id', orgId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);
  } catch (err) {
    throw new Error(stringifyError(err));
  }

  const contactByPhone = new Map(contactRows.map((c) => [c.phone, c]));
  const persisted = await persistWhatsAppLabels(orgId, wa, contactByPhone);
  const existingTagSet = new Set(
    existingTags.map((t) => `${t.contact_id}:${t.tag}`),
  );
  const existingVehicleSet = new Set(
    existingVehicles.map((v) => `${v.contact_id}:${v.model}`),
  );

  const qualityUpdates = new Map<string, CustomerQuality>();
  const stageUpdates = new Map<string, CustomerStage>();
  const countryUpdates = new Map<string, string>();
  const tagsToInsert: Array<{ contact_id: string; tag: string }> = [];
  const vehiclesToInsert: Array<{ contact_id: string; model: string }> = [];
  const touchedContactIds = new Set<string>();
  const unmatched = new Set<string>();

  for (const a of wa.associations) {
    if (a.type !== 'jid') continue;
    const label = labelById.get(a.labelId);
    if (!label || !label.isActive) continue;

    const phone = resolvePhone(a.associationId, wa.jidToPhoneJid);
    if (!phone) continue;
    const contact = contactByPhone.get(phone);
    if (!contact) continue;

    const cat = categorizeLabel(label.name);
    if (cat.category === 'system') continue;
    touchedContactIds.add(contact.id);

    if (cat.category === 'quality' && cat.value) {
      const prev = qualityUpdates.get(contact.id) ?? contact.quality;
      const rank: Record<CustomerQuality, number> = {
        spam: 0,
        normal: 1,
        potential: 2,
        big: 3,
      };
      if (rank[cat.value as CustomerQuality] > rank[prev as CustomerQuality]) {
        qualityUpdates.set(contact.id, cat.value as CustomerQuality);
      } else if (!qualityUpdates.has(contact.id) && contact.quality === 'potential') {
        qualityUpdates.set(contact.id, cat.value as CustomerQuality);
      }
    } else if (cat.category === 'stage' && cat.value) {
      if (
        contact.customer_stage === 'new' ||
        contact.customer_stage === 'negotiating' ||
        contact.customer_stage === 'stalled'
      ) {
        stageUpdates.set(contact.id, cat.value as CustomerStage);
      }
    } else if (cat.category === 'country' && cat.value) {
      if (!contact.country) {
        countryUpdates.set(contact.id, cat.value);
      }
    } else if (cat.category === 'vehicle' && cat.value) {
      const canonModel = canonicalizeModel(cat.value);
      const key = `${contact.id}:${canonModel.toLowerCase()}`;
      if (!existingVehicleSet.has(key)) {
        vehiclesToInsert.push({ contact_id: contact.id, model: canonModel });
        existingVehicleSet.add(key);
      }
    } else if (cat.category === 'tag' && cat.value) {
      const key = `${contact.id}:${cat.value}`;
      if (!existingTagSet.has(key)) {
        tagsToInsert.push({ contact_id: contact.id, tag: cat.value });
        existingTagSet.add(key);
      }
    } else {
      unmatched.add(label.name);
    }
  }

  for (const [id, quality] of qualityUpdates) {
    const { error } = await supabase
      .from('contacts')
      .update({ quality })
      .eq('id', id);
    if (error) throw new Error(stringifyError(error));
  }
  for (const [id, stage] of stageUpdates) {
    const { error } = await supabase
      .from('contacts')
      .update({ customer_stage: stage })
      .eq('id', id);
    if (error) throw new Error(stringifyError(error));
  }
  for (const [id, country] of countryUpdates) {
    const { error } = await supabase
      .from('contacts')
      .update({ country })
      .eq('id', id);
    if (error) throw new Error(stringifyError(error));
  }
  if (tagsToInsert.length) {
    const { error } = await supabase.from('contact_tags').insert(tagsToInsert);
    if (error) throw new Error(stringifyError(error));
  }
  if (vehiclesToInsert.length) {
    const { error } = await supabase
      .from('vehicle_interests')
      .insert(vehiclesToInsert);
    if (error) throw new Error(stringifyError(error));
  }

  return {
    totalAssociations: wa.associations.length,
    contactsTouched: touchedContactIds.size,
    ...persisted,
    qualityUpdated: qualityUpdates.size,
    stageUpdated: stageUpdates.size,
    countryUpdated: countryUpdates.size,
    tagsAdded: tagsToInsert.length,
    vehiclesAdded: vehiclesToInsert.length,
    unmatchedLabels: Array.from(unmatched),
  };
}
