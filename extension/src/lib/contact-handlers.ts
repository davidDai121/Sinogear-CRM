import { supabase } from './supabase';

export interface ContactHandlerRow {
  contact_id: string;
  user_id: string;
  last_seen_at: string;
}

export interface HandlerMaps {
  /** contact_id → 该客户所有的 handler user_id */
  byContact: Map<string, string[]>;
  /** user_id → 该 user 主理的 contact_id 集合 */
  byUser: Map<string, Set<string>>;
}

/** 拉取 org 内所有 contact_handlers 行（RLS 自动限定本 org） */
export async function fetchHandlersForOrg(
  orgId: string,
): Promise<ContactHandlerRow[]> {
  // 突破 Supabase 默认 1000 行限制：分页拉
  const PAGE = 1000;
  const out: ContactHandlerRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contact_handlers')
      .select('contact_id, user_id, last_seen_at, contacts!inner(org_id)')
      .eq('contacts.org_id', orgId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const r of rows) {
      out.push({
        contact_id: r.contact_id,
        user_id: r.user_id,
        last_seen_at: r.last_seen_at,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

export function buildHandlerMaps(rows: ContactHandlerRow[]): HandlerMaps {
  const byContact = new Map<string, string[]>();
  const byUser = new Map<string, Set<string>>();
  for (const r of rows) {
    const arr = byContact.get(r.contact_id) ?? [];
    arr.push(r.user_id);
    byContact.set(r.contact_id, arr);

    const set = byUser.get(r.user_id) ?? new Set<string>();
    set.add(r.contact_id);
    byUser.set(r.user_id, set);
  }
  return { byContact, byUser };
}

/**
 * 批量登记当前用户为多个客户的 handler。
 * 用于 ChatPage 加载时，把 WA 聊天列表里的所有联系人一次性归到我名下。
 * 已存在的不动（onConflict do nothing），不会刷新 last_seen_at。
 */
export async function batchBumpHandlers(
  contactIds: string[],
  userId: string,
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const now = new Date().toISOString();
  // 切块避免单 request 太大
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const slice = contactIds.slice(i, i + CHUNK);
    const rows = slice.map((id) => ({
      contact_id: id,
      user_id: userId,
      last_seen_at: now,
    }));
    const { error, count } = await supabase
      .from('contact_handlers')
      .upsert(rows, {
        onConflict: 'contact_id,user_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (error) {
      console.warn('[batch-bump-handlers]', error.message);
      break;
    }
    if (typeof count === 'number') inserted += count;
  }
  return inserted;
}

/**
 * 心跳 upsert：登记 (contact_id, current_user) 为 handler。
 * 安全调用——失败不抛错（只 console.warn），不阻塞主流程。
 */
export async function bumpHandler(contactId: string): Promise<void> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return;
    const { error } = await supabase.from('contact_handlers').upsert(
      {
        contact_id: contactId,
        user_id: userId,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'contact_id,user_id' },
    );
    if (error) {
      console.warn('[contact-handlers] bump failed', error.message);
    }
  } catch (err) {
    console.warn('[contact-handlers] bump exception', err);
  }
}

/**
 * 撞单检测：返回除当前用户外，还在主理这个客户的其他 user_id 列表。
 */
export function getOtherHandlers(
  contactId: string,
  currentUserId: string | null,
  byContact: Map<string, string[]>,
): string[] {
  const all = byContact.get(contactId);
  if (!all || all.length === 0) return [];
  if (!currentUserId) return all;
  return all.filter((u) => u !== currentUserId);
}
