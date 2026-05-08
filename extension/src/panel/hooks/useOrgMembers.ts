import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface OrgMember {
  user_id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
  is_self: boolean;
}

export interface OrgMembersState {
  members: OrgMember[];
  byId: Map<string, OrgMember>;
  myRole: 'owner' | 'admin' | 'member' | null;
  myUserId: string | null;
  loading: boolean;
  error: string | null;
}

/** Email 取 @ 前面那段做显示名（list_org_members 没返回 display_name） */
export function shortNameOf(member: OrgMember | undefined): string {
  if (!member) return '?';
  const email = member.email ?? '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email || member.user_id.slice(0, 6);
}

export function useOrgMembers(orgId: string | null): OrgMembersState {
  const [state, setState] = useState<OrgMembersState>({
    members: [],
    byId: new Map(),
    myRole: null,
    myUserId: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!orgId) {
      setState({
        members: [],
        byId: new Map(),
        myRole: null,
        myUserId: null,
        loading: false,
        error: null,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    void (async () => {
      try {
        const { data, error } = await supabase.rpc('list_org_members', {
          target_org: orgId,
        });
        if (error) throw error;
        const members = (data ?? []) as OrgMember[];
        const byId = new Map(members.map((m) => [m.user_id, m]));
        const me = members.find((m) => m.is_self) ?? null;
        if (cancelled) return;
        setState({
          members,
          byId,
          myRole: (me?.role as OrgMember['role']) ?? null,
          myUserId: me?.user_id ?? null,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          members: [],
          byId: new Map(),
          myRole: null,
          myUserId: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return state;
}
