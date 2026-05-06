import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export interface OrgState {
  orgId: string | null;
  orgName: string | null;
  loading: boolean;
  error: string | null;
}

export function useOrg(userId: string | null) {
  const [state, setState] = useState<OrgState>({
    orgId: null,
    orgName: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!userId) {
      setState({ orgId: null, orgName: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { data, error } = await supabase
        .from('organization_members')
        .select('org_id, organizations(name)')
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      const org = data?.organizations as { name: string } | null;
      setState({
        orgId: data?.org_id ?? null,
        orgName: org?.name ?? null,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState({
        orgId: null,
        orgName: null,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createOrg = async (name: string) => {
    const { data, error } = await supabase.rpc('create_organization', {
      org_name: name,
    });
    if (error) throw error;
    await refresh();
    return data;
  };

  return { ...state, refresh, createOrg };
}
