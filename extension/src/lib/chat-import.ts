/**
 * 把手机端导出的聊天 .txt 写入 messages 表
 *
 * - 客户匹配：org_id + phone 找已有 contact，找不到则创建（country 按区号推断）
 * - wa_message_id：`import:<sha256(ts|direction|text).slice(0,16)>`，重复导入幂等
 * - 分批 upsert 防止单次请求体过大
 */

import { supabase } from './supabase';
import { phoneToCountry } from './phone-countries';
import { logContactEvent } from './events-log';
import type { ParsedChat } from './import-chat-parser';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface ImportResult {
  contactId: string;
  contactCreated: boolean;
  total: number;
  inserted: number;
  skippedNoTimestamp: number;
}

export async function importParsedChat(
  orgId: string,
  parsed: ParsedChat,
  meSender: string,
  phoneOverride?: string | null,
): Promise<ImportResult> {
  const phone = phoneOverride ?? parsed.phone;
  if (!phone) throw new Error('缺少客户手机号（解析与文件名都未识别到）');

  // find or create contact
  const existing = await supabase
    .from('contacts')
    .select('id')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing.error) throw existing.error;

  let contactId: string;
  let contactCreated = false;
  if (existing.data) {
    contactId = existing.data.id;
  } else {
    const country = phoneToCountry(phone);
    const ins = await supabase
      .from('contacts')
      .insert({ org_id: orgId, phone, country })
      .select('id')
      .single();
    if (ins.error) throw ins.error;
    contactId = ins.data.id;
    contactCreated = true;
    void logContactEvent(contactId, 'created', { phone, source: 'import' });
  }

  // 构造 rows
  let skippedNoTimestamp = 0;
  const rows: {
    contact_id: string;
    wa_message_id: string;
    direction: 'inbound' | 'outbound';
    text: string;
    sent_at: string | null;
  }[] = [];

  for (const m of parsed.messages) {
    if (!m.ts) {
      skippedNoTimestamp++;
      continue;
    }
    const direction: 'inbound' | 'outbound' =
      m.sender === meSender ? 'outbound' : 'inbound';
    const tsIso = m.ts.toISOString();
    const hash = await sha256Hex(`${tsIso}|${direction}|${m.text.slice(0, 500)}`);
    rows.push({
      contact_id: contactId,
      wa_message_id: 'import:' + hash.slice(0, 16),
      direction,
      text: m.text,
      sent_at: tsIso,
    });
  }

  // 分批 upsert
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await supabase
      .from('messages')
      .upsert(chunk, {
        onConflict: 'contact_id,wa_message_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (error) throw error;
    inserted += count ?? 0;
  }

  return {
    contactId,
    contactCreated,
    total: rows.length,
    inserted,
    skippedNoTimestamp,
  };
}
