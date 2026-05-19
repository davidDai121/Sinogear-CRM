import { supabase } from './supabase';

export interface ContactPinRow {
  contact_id: string;
  user_id: string;
  pinned_at: string;
  note: string | null;
}

/**
 * 拉取当前 org 内 *当前 user* 的所有置顶。
 * RLS 限制写入到 user_id=auth.uid()，但 select 是同 org 都能读——
 * 这里 client 端再加一个 user_id 过滤，只拿"我的置顶"。
 */
export async function fetchMyPinnedIdsForOrg(
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  const PAGE = 1000;
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contact_pins')
      .select('contact_id, user_id, contacts!inner(org_id)')
      .eq('contacts.org_id', orgId)
      .eq('user_id', userId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const r of rows) out.add(r.contact_id);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function pinContact(contactId: string, note?: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('未登录');
  const { error } = await supabase.from('contact_pins').upsert(
    {
      contact_id: contactId,
      user_id: userId,
      pinned_at: new Date().toISOString(),
      note: note ?? null,
    },
    { onConflict: 'contact_id,user_id' },
  );
  if (error) throw error;
}

export async function unpinContact(contactId: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('未登录');
  const { error } = await supabase
    .from('contact_pins')
    .delete()
    .eq('contact_id', contactId)
    .eq('user_id', userId);
  if (error) throw error;
}
