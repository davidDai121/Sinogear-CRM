import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { stringifyError } from '@/lib/errors';

type Role = 'owner' | 'admin' | 'member';

interface Member {
  user_id: string;
  email: string;
  role: Role;
  joined_at: string;
  is_self: boolean;
}

interface Props {
  orgId: string;
  onClose: () => void;
}

const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
};

const ROLE_BADGE: Record<Role, string> = {
  owner: 'sgc-badge-primary',
  admin: 'sgc-badge',
  member: 'sgc-badge',
};

const RESULT_MESSAGES: Record<string, string> = {
  added: '✓ 已添加',
  removed: '✓ 已移除',
  updated: '✓ 已更新角色',
  unauthorized: '未登录或会话过期',
  invalid_role: '角色无效',
  no_org: '未找到团队',
  forbidden: '权限不足（仅所有者/管理员可操作）',
  user_not_found: '该邮箱用户未注册——请让对方先注册账号',
  already_member: '该用户已是团队成员',
  cannot_remove_self: '不能移除自己（请先转让所有权）',
  not_member: '该用户不是团队成员',
  last_owner: '不能移除/降级最后一个所有者',
};

function tr(code: string): string {
  return RESULT_MESSAGES[code] ?? code;
}

export function TeamMembersModal({ orgId, onClose }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [inviting, setInviting] = useState(false);

  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const myRole = members.find((m) => m.is_self)?.role;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const canSetRoles = myRole === 'owner';

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('list_org_members', {
      target_org: orgId,
    });
    if (error) setError(error.message);
    else setMembers((data ?? []) as Member[]);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, [orgId]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setInfo(null);
    try {
      const email = inviteEmail.trim();
      if (!email) return;
      const { data, error } = await supabase.rpc('invite_user_to_org', {
        target_email: email,
        target_role: inviteRole,
        target_org: orgId,
      });
      if (error) throw new Error(error.message);
      const code = data as string;
      if (code === 'added') {
        setInfo(`${tr(code)}：${email} (${ROLE_LABEL[inviteRole]})`);
        setInviteEmail('');
        await refresh();
      } else {
        setError(tr(code));
      }
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setInviting(false);
    }
  };

  const remove = async (member: Member) => {
    setError(null);
    setInfo(null);
    try {
      const { data, error } = await supabase.rpc('remove_org_member', {
        target_user_id: member.user_id,
        target_org: orgId,
      });
      if (error) throw new Error(error.message);
      const code = data as string;
      if (code === 'removed') {
        setInfo(`${tr(code)}：${member.email}`);
        setConfirmRemoveId(null);
        await refresh();
      } else {
        setError(tr(code));
      }
    } catch (err) {
      setError(stringifyError(err));
    }
  };

  const changeRole = async (member: Member, newRole: Role) => {
    if (newRole === member.role) return;
    setError(null);
    setInfo(null);
    try {
      const { data, error } = await supabase.rpc('update_org_member_role', {
        target_user_id: member.user_id,
        target_org: orgId,
        new_role: newRole,
      });
      if (error) throw new Error(error.message);
      const code = data as string;
      if (code === 'updated') {
        setInfo(`${tr(code)}：${member.email} → ${ROLE_LABEL[newRole]}`);
        await refresh();
      } else {
        setError(tr(code));
      }
    } catch (err) {
      setError(stringifyError(err));
    }
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>团队成员</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="sgc-modal-body">
          {loading ? (
            <div className="sgc-empty">加载中…</div>
          ) : (
            <>
              <div className="sgc-stack">
                {members.map((m) => (
                  <div key={m.user_id} className="sgc-stack-card">
                    <div className="sgc-stack-header">
                      <div>
                        <strong>{m.email}</strong>
                        {m.is_self && (
                          <span className="sgc-badge sgc-badge-primary">
                            你
                          </span>
                        )}
                      </div>
                      <div className="sgc-section-actions">
                        {canSetRoles && !m.is_self ? (
                          <select
                            value={m.role}
                            onChange={(e) =>
                              changeRole(m, e.target.value as Role)
                            }
                            className="sgc-role-select"
                          >
                            <option value="owner">所有者</option>
                            <option value="admin">管理员</option>
                            <option value="member">成员</option>
                          </select>
                        ) : (
                          <span
                            className={`sgc-badge ${ROLE_BADGE[m.role]}`}
                          >
                            {ROLE_LABEL[m.role]}
                          </span>
                        )}

                        {canManage && !m.is_self && (
                          <>
                            {confirmRemoveId === m.user_id ? (
                              <>
                                <button
                                  type="button"
                                  className="sgc-btn-link"
                                  onClick={() => setConfirmRemoveId(null)}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className="sgc-btn-danger"
                                  onClick={() => remove(m)}
                                >
                                  确认移除
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="sgc-btn-link sgc-btn-danger-link"
                                onClick={() => setConfirmRemoveId(m.user_id)}
                              >
                                移除
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="sgc-stack-meta">
                      <span>加入于 {new Date(m.joined_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>

              {canManage && (
                <form className="sgc-team-invite" onSubmit={invite}>
                  <div className="sgc-section-title">邀请成员</div>
                  <div className="sgc-muted" style={{ fontSize: 12 }}>
                    对方需要先在扩展登录页注册过——输入对方注册邮箱
                  </div>
                  <div className="sgc-team-invite-row">
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="colleague@example.com"
                      required
                    />
                    {canSetRoles && (
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as Role)}
                      >
                        <option value="member">成员</option>
                        <option value="admin">管理员</option>
                        <option value="owner">所有者</option>
                      </select>
                    )}
                    <button
                      type="submit"
                      className="sgc-btn-primary"
                      disabled={inviting || !inviteEmail.trim()}
                    >
                      {inviting ? '邀请中…' : '邀请'}
                    </button>
                  </div>
                </form>
              )}

              {!canManage && myRole && (
                <div className="sgc-muted" style={{ fontSize: 12, marginTop: 12 }}>
                  你是【{ROLE_LABEL[myRole]}】，仅所有者/管理员可邀请新成员。
                </div>
              )}
            </>
          )}

          {error && <div className="sgc-error">{error}</div>}
          {info && <div className="sgc-info">{info}</div>}
        </div>
      </div>
    </>
  );
}
