import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  RealtimePostgresChangesPayload,
  RealtimePostgresDeletePayload,
  RealtimePostgresInsertPayload,
  RealtimePostgresUpdatePayload,
} from '@supabase/supabase-js';
import {
  batchBumpHandlers,
  buildHandlerMaps,
  fetchHandlersForOrg,
  type ContactHandlerRow,
  type HandlerMaps,
} from '@/lib/contact-handlers';
import { supabase } from '@/lib/supabase';
import { useOrgMembers, shortNameOf, type OrgMember } from '../hooks/useOrgMembers';

export type ViewScope = 'mine' | 'all';

interface ScopeValue {
  scope: ViewScope;
  setScope: (s: ViewScope) => void;
  /** 我的客户 id 集合（本地登录用户作为 handler 的所有 contact_id） */
  myContactIds: Set<string>;
  /** 所有 handler 的 contact_id → user_id[] 映射，用于撞单检测 */
  handlersByContact: Map<string, string[]>;
  /** 同 org 成员名册（user_id → member），撞单 tag 显示用 */
  membersById: Map<string, OrgMember>;
  myUserId: string | null;
  myRole: 'owner' | 'admin' | 'member' | null;
  /** 强制刷新 handlers + members */
  refresh: () => void;
  loading: boolean;
}

const SCOPE_STORAGE_KEY = 'sgc:viewScope';
/** Realtime + 60min 兜底 refetch。撞单 tag 不需要秒级新鲜，handlers 表写入
 *  全走 Realtime 推送，定时 refetch 只是 websocket 漏事件兜底 */
const DB_REFETCH_INTERVAL_MS = 60 * 60 * 1000;
/** visibilitychange 触发 refetch 的最短间隔。15min 内切回不重拉，对齐
 *  useCrmData 同款节流，避免日常切 tab 卡几秒 */
const VISIBILITY_REFRESH_THROTTLE_MS = 15 * 60 * 1000;

const ScopeCtx = createContext<ScopeValue | null>(null);

/**
 * contact_handlers 行的内存索引。Realtime INSERT / DELETE 直接增删一行，
 * 不重建整个 map（org 几千行时重建有几 ms 抖动，没必要）。
 */
function updateMaps(
  prev: HandlerMaps,
  mutate: (rows: Map<string, ContactHandlerRow>) => void,
): HandlerMaps {
  // 重建 row 集合：byContact + byUser 是从 rows[] 派生的，不直接存 rows，
  // 所以这里先反推。其实 byContact 已经够算了，byUser 也能从 byContact 反推。
  const allRows: ContactHandlerRow[] = [];
  for (const [contactId, userIds] of prev.byContact) {
    for (const userId of userIds) {
      // last_seen_at 在 hook 里没用，给个空串占位即可（仅 batchBumpHandlers 等
      // 写路径需要）
      allRows.push({ contact_id: contactId, user_id: userId, last_seen_at: '' });
    }
  }
  // 用 (contact_id|user_id) 复合 key 做去重池
  const pool = new Map<string, ContactHandlerRow>();
  for (const r of allRows) pool.set(`${r.contact_id}|${r.user_id}`, r);
  mutate(pool);
  return buildHandlerMaps(Array.from(pool.values()));
}

function applyHandlerChange(
  prev: HandlerMaps,
  payload: RealtimePostgresChangesPayload<ContactHandlerRow>,
): HandlerMaps {
  return updateMaps(prev, (pool) => {
    if (payload.eventType === 'DELETE') {
      const old = (payload as RealtimePostgresDeletePayload<ContactHandlerRow>).old;
      if (old.contact_id && old.user_id) {
        pool.delete(`${old.contact_id}|${old.user_id}`);
      }
    } else {
      const row = (
        payload as
          | RealtimePostgresInsertPayload<ContactHandlerRow>
          | RealtimePostgresUpdatePayload<ContactHandlerRow>
      ).new;
      pool.set(`${row.contact_id}|${row.user_id}`, row);
    }
  });
}

export function ScopeProvider({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) {
  const members = useOrgMembers(orgId);
  const [maps, setMaps] = useState<HandlerMaps>({
    byContact: new Map(),
    byUser: new Map(),
  });
  const [loading, setLoading] = useState(true);
  /** 兜底全量 refetch 触发器（30min / 手动 / visibility throttle） */
  const [refetchNonce, setRefetchNonce] = useState(0);
  const [scope, setScopeState] = useState<ViewScope>('mine');
  const lastFetchRef = useRef(0);

  // 加载持久化的 scope 选择；默认 owner/admin → all，member → mine
  useEffect(() => {
    void chrome.storage.local.get(SCOPE_STORAGE_KEY).then((s) => {
      const v = s[SCOPE_STORAGE_KEY];
      if (v === 'mine' || v === 'all') {
        setScopeState(v);
      } else if (members.myRole === 'owner' || members.myRole === 'admin') {
        setScopeState('all');
      } else {
        setScopeState('mine');
      }
    });
  }, [members.myRole]);

  const setScope = useCallback((s: ViewScope) => {
    setScopeState(s);
    void chrome.storage.local.set({ [SCOPE_STORAGE_KEY]: s });
  }, []);

  // ----- Effect: 初次加载 + 兜底 refetch -----
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchHandlersForOrg(orgId);
        if (cancelled) return;
        lastFetchRef.current = Date.now();
        setMaps(buildHandlerMaps(rows));
        setLoading(false);
      } catch (err) {
        console.warn('[scope] fetchHandlers failed', err);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, refetchNonce]);

  // ----- Effect: Realtime 订阅 contact_handlers 变更 -----
  useEffect(() => {
    if (!orgId) return;
    // 注：contact_handlers 表无 org_id 列（PK 是 contact_id+user_id），
    // Realtime filter 也没法 join 反查。RLS 服务端已限定本 org 可见行才下发。
    const channel = supabase
      .channel(`handlers-${orgId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'contact_handlers',
        },
        (payload) => {
          setMaps((prev) =>
            applyHandlerChange(
              prev,
              payload as RealtimePostgresChangesPayload<ContactHandlerRow>,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [orgId]);

  // 一次性"孤儿认领"：对没有任何 handler 的客户，把当前用户登记为 handler。
  // 解决早期 bulk-sync 进来的、created_by 为 null 的老数据。
  // 团队场景中孤儿稀少（每个新客户都通过 trigger 或心跳被归属），这个逻辑只在
  // 偶发空缺时兜底。
  const autoClaimedRef = useRef(false);
  useEffect(() => {
    if (autoClaimedRef.current) return;
    if (!orgId || !members.myUserId || loading) return;
    autoClaimedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        // 分页拉所有 contact id（突破 Supabase 默认 1000 行限制）
        const PAGE = 1000;
        const allIds: string[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('contacts')
            .select('id')
            .eq('org_id', orgId)
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1);
          if (error || cancelled) return;
          const rows = data ?? [];
          for (const r of rows) allIds.push(r.id);
          if (rows.length < PAGE) break;
        }
        if (cancelled) return;
        const handledIds = new Set(maps.byContact.keys());
        const orphans = allIds.filter((id) => !handledIds.has(id));
        if (orphans.length === 0) return;
        const inserted = await batchBumpHandlers(orphans, members.myUserId!);
        if (inserted > 0) {
          console.log(
            `[scope] 自动归属 ${inserted} 个孤儿客户给当前用户`,
          );
          // Realtime 会推 INSERT 事件回来，state 自动更新；无需手动 refetch
        }
      } catch (err) {
        console.warn('[scope] auto-claim failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, members.myUserId, loading, maps]);

  // ----- Effect: 30min 兜底 refetch + visibility 触发（throttled） -----
  useEffect(() => {
    if (!orgId) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setRefetchNonce((n) => n + 1);
    }, DB_REFETCH_INTERVAL_MS);
    const onVisible = (): void => {
      if (typeof document === 'undefined' || document.hidden) return;
      if (Date.now() - lastFetchRef.current > VISIBILITY_REFRESH_THROTTLE_MS) {
        setRefetchNonce((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [orgId]);

  const myContactIds = useMemo(() => {
    if (!members.myUserId) return new Set<string>();
    return maps.byUser.get(members.myUserId) ?? new Set<string>();
  }, [maps, members.myUserId]);

  const value: ScopeValue = useMemo(
    () => ({
      scope,
      setScope,
      myContactIds,
      handlersByContact: maps.byContact,
      membersById: members.byId,
      myUserId: members.myUserId,
      myRole: members.myRole,
      refresh: () => setRefetchNonce((n) => n + 1),
      loading: loading || members.loading,
    }),
    [scope, setScope, myContactIds, maps, members, loading],
  );

  return <ScopeCtx.Provider value={value}>{children}</ScopeCtx.Provider>;
}

export function useScope(): ScopeValue {
  const v = useContext(ScopeCtx);
  if (!v) throw new Error('useScope must be inside <ScopeProvider>');
  return v;
}

/** 给某个 contact 算撞单 tag（除了我之外还有谁主理） */
export function useCollisionTag(contactId: string | null | undefined): string | null {
  const { handlersByContact, membersById, myUserId } = useScope();
  if (!contactId) return null;
  const all = handlersByContact.get(contactId);
  if (!all || all.length < 2) return null;
  const others = myUserId ? all.filter((u) => u !== myUserId) : all;
  if (others.length === 0) return null;
  const names = others.map((u) => shortNameOf(membersById.get(u)));
  return names.join('、');
}
