import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

type Client = SupabaseClient<Database>;
export const PREFERENCE_SCHEMA = 'sales-preference.v1';
export type PreferenceScope = 'personal' | 'customer' | 'order';
export interface SalesPreference {
  id: string; at: string; orgId: string; userId: string; contactId: string; scopeId: string;
  scope: PreferenceScope; topic: string; text: string; sourceText: string; sourceEntryId: string;
  active: boolean;
}
export type PreferenceSuggestion = Pick<SalesPreference, 'scope' | 'topic' | 'text'>;

// Interpret only salesperson-entered text. Customer messages and model drafts
// never enter this classifier. Unknown advice remains in the original journal.
export function classifySalesPreferences(source: string): PreferenceSuggestion[] {
  const result: PreferenceSuggestion[] = [];
  if (/客户说|客户要求|他说|她说|对方说|转述|引用|customer (?:said|asked)/i.test(source)) return result;
  for (const raw of source.split(/[，,。；;\n]+/)) {
    const text = raw.trim();
    if (!text || text.length > 600) continue;
    const durable = /以后|今后|一直|长期|每次|始终|所有客户|所有回复|默认|always|from now on|every reply/i.test(text);
    if (/这次|本轮|今天|这回|暂时|先(?:别|不|只)|this time|today|for now/i.test(text)) continue;
    if (/客户说|客户问|客户要求|他说|她说|对方说|转述|引用|翻译|怎么算|你确定|先汇报|customer (?:said|asked)|translate/i.test(text)) continue;
    if (/重写|再来一版|换个说法|改短|改长/.test(text) && !durable) continue;
    // Commercial facts retain their existing source/expiry semantics.
    if (/(?:\d[\d.,]*\s*(?:台|辆|柜|美元|人民币|%|usd|cny|days?))|(?:usd|cny|\$)\s*\d|\d{1,4}[-/]\d{1,2}|(?:车价|运费|定金|尾款|折扣|保险|保修|交期|赠品|利润|税费|manufacturer|authorized dealer)/i.test(text)) continue;
    let topic = '';
    if (/简短|简洁|精简|短一点|少废话|啰嗦|详细|展开|concise|brief|verbose|detailed/i.test(text)) topic = 'length';
    else if (/危险品|carga peligrosa|dangerous goods/i.test(text)) topic = 'cargo-wording';
    else if (/my friend|amigo|称呼|喊他|叫他/i.test(text)) topic = 'address';
    else if (/直接.*报|报价.*直接|别绕|不绕|先报|direct.*quot/i.test(text)) topic = 'quote-style';
    else if (/别问|不要.*问|少问|多问|只问|重复.*问|提问/i.test(text)) topic = 'questions';
    else if (/自然|亲切|客气|热情|强硬|正式|随和|人味|机械|模板腔|warm|friendly|formal/i.test(text)) topic = 'tone';
    else if (durable && /中文|英语|英文|西语|西班牙语|法语|阿拉伯语|language|spanish|french/i.test(text)) topic = 'language';
    if (!topic) continue;
    const customer = /这个客户|该客户|这位客户|本客户|跟他|跟她|对他|对她|this customer|this client/i.test(text);
    const personal = !customer && /所有客户|所有回复|每次回复|每次都|以后(?:的)?(?:回复|回客)|今后(?:的)?回复|一律|全局|always|every reply|all (?:customers|replies)/i.test(text);
    const scope: PreferenceScope = personal ? 'personal' : customer ? 'customer' : 'order';
    result.push({ scope, topic, text });
  }
  return result;
}

function key(p: Pick<SalesPreference, 'scope' | 'topic' | 'contactId' | 'scopeId'>) {
  return JSON.stringify([p.scope, p.scope === 'personal' ? '' : p.contactId, p.scope === 'order' ? p.scopeId : '', p.topic]);
}
export function resolveSalesPreferences(rows: SalesPreference[], contactId: string, scopeId: string): SalesPreference[] {
  const latest = new Map<string, SalesPreference>();
  for (const row of [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    if (row.scope !== 'personal' && row.contactId !== contactId) continue;
    if (row.scope === 'order' && row.scopeId !== scopeId) continue;
    latest.set(key(row), row);
  }
  return [...latest.values()];
}

export async function loadSalesPreferences(db: Client, orgId: string, userId: string, contactId: string, scopeId: string) {
  const rows: SalesPreference[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await db.from('contact_events').select('id,contact_id,payload,created_at')
      .eq('event_type', 'ai_extracted').eq('payload->>schema', PREFERENCE_SCHEMA)
      .eq('payload->>orgId', orgId).eq('payload->>userId', userId)
      .order('created_at').order('id').range(from, from + 199);
    if (error) throw new Error(`读取销售偏好失败：${error.message}`);
    for (const row of data ?? []) {
      const p = row.payload;
      if (!['personal', 'customer', 'order'].includes(String(p.scope)) || typeof p.topic !== 'string'
        || typeof p.text !== 'string' || typeof p.sourceText !== 'string' || typeof p.sourceEntryId !== 'string'
        || typeof p.scopeId !== 'string' || typeof p.active !== 'boolean' || p.contactId !== row.contact_id) {
        throw new Error('销售偏好记录格式异常，请核对原记录');
      }
      rows.push({ ...p, id: row.id, at: row.created_at } as unknown as SalesPreference);
    }
    if (!data || data.length < 200) break;
  }
  return resolveSalesPreferences(rows, contactId, scopeId);
}

/** Append revisions, including revocations; never alter original instructions. */
export async function saveSalesPreference(db: Client, value: Omit<SalesPreference, 'id' | 'at'>) {
  const { data: auth, error: authError } = await db.auth.getUser();
  if (authError || auth.user?.id !== value.userId) throw new Error('销售偏好登录身份已变化');
  const { data: contact, error } = await db.from('contacts').select('id').eq('id', value.contactId).eq('org_id', value.orgId).single();
  if (error || !contact) throw new Error('无法核实销售偏好所属客户');
  if (!value.text.trim() || value.text.length > 600 || !value.sourceText.includes(value.text)
    || !value.sourceEntryId || !['personal', 'customer', 'order'].includes(value.scope)) throw new Error('销售偏好缺少有效原话');
  const { error: writeError } = await db.from('contact_events').insert({ id: crypto.randomUUID(), contact_id: value.contactId,
    event_type: 'ai_extracted', payload: { ...value, schema: PREFERENCE_SCHEMA } });
  if (writeError) throw new Error(`保存销售偏好失败：${writeError.message}`);
}

export async function rememberSalesPreferences(db: Client, context: {
  orgId: string; userId: string; contactId: string; scopeId: string; sourceText: string; sourceEntryId: string;
}, current: SalesPreference[]) {
  for (const suggestion of classifySalesPreferences(context.sourceText)) {
    const value = { ...context, ...suggestion, active: true };
    const previous = current.find(p => key(p) === key(value));
    // Reusing the same source entry cannot resurrect a revocation; a new owner
    // instruction may explicitly repeat it and make it active again.
    if (previous?.sourceEntryId === context.sourceEntryId || (previous?.active && previous.text === value.text)) continue;
    await saveSalesPreference(db, value);
  }
}

export function renderSalesPreferences(preferences: SalesPreference[]) {
  if (!preferences.length) return '';
  return `[Standing Preferences — salesperson confirmed wording]\nApply active preferences to this customer reply; current explicit guidance wins, then order, customer, personal. These are communication preferences, not prices or company facts. Revoked entries are inactive even if their source appears in old history.\n${JSON.stringify(preferences.map(p => ({ scope: p.scope, topic: p.topic, text: p.text, active: p.active, sourceEntryId: p.sourceEntryId })))}`;
}
