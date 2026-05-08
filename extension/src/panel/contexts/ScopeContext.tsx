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
import {
  batchBumpHandlers,
  buildHandlerMaps,
  fetchHandlersForOrg,
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
const POLL_INTERVAL_MS = 30000;

const ScopeCtx = createContext<ScopeValue | null>(null);

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
  const [nonce, setNonce] = useState(0);
  const [scope, setScopeState] = useState<ViewScope>('mine');

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

  // 拉 handlers + 轮询
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchHandlersForOrg(orgId);
        if (cancelled) return;
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
  }, [orgId, nonce]);

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
          setNonce((n) => n + 1);
        }
      } catch (err) {
        console.warn('[scope] auto-claim failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, members.myUserId, loading, maps]);

  useEffect(() => {
    if (!orgId) return;
    const t = setInterval(() => setNonce((n) => n + 1), POLL_INTERVAL_MS);
    return () => clearInterval(t);
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
      refresh: () => setNonce((n) => n + 1),
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
