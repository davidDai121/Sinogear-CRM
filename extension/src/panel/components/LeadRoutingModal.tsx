/**
 * 线索分配 —— 每个广告表单归谁，以及把没人跟的线索一次性落到人头上。
 *
 * 为什么做成页面而不是脚本（boss 2026-08-21 原话：「我哪知道什么时候跑」）：
 * 归属推断本来是个命令行脚本，但那要求人记得在新建广告之后去跑一次。
 * 放进 CRM 里，打开就能看见「N 个表单还没归属、M 条线索没人跟」，一键处理。
 */
import { useCallback, useEffect, useState } from 'react';
import { useScope } from '../contexts/ScopeContext';
import {
  loadRoutingSnapshot,
  setRule,
  clearRule,
  applyRouting,
  MIN_SAMPLE,
  type RoutingSnapshot,
} from '@/lib/lead-routing';
import { stringifyError } from '@/lib/errors';

interface Props {
  orgId: string;
  onClose: () => void;
}

export function LeadRoutingModal({ orgId, onClose }: Props) {
  const { membersById } = useScope();
  const [snap, setSnap] = useState<RoutingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const nameOf = (uid: string) =>
    membersById.get(uid)?.email?.split('@')[0] ?? uid.slice(0, 8);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnap(await loadRoutingSnapshot(orgId));
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assign = async (formName: string, userId: string, auto: boolean, conf: number | null) => {
    setBusy(formName);
    setError(null);
    try {
      await setRule(orgId, formName, userId, auto, conf);
      await refresh();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    setBusy('apply');
    setError(null);
    setDone(null);
    try {
      const n = await applyRouting(orgId);
      setDone(`已把 ${n} 条线索落到对应业务员头上`);
      await refresh();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(null);
    }
  };

  const members = [...membersById.values()];

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>📣 线索分配</strong>
          <button className="sgc-drawer-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="sgc-modal-body">

        <p style={{ fontSize: 13, color: '#54656f', margin: '0 0 12px', lineHeight: 1.6 }}>
          一个广告表单归一个业务员。归属是按「客户点了 Chat on WhatsApp 之后被路由到谁」
          推断的 —— Meta 不提供这个绑定，只能从已发生的对话反推。
        </p>

        {loading && <div className="sgc-empty">加载中…</div>}
        {error && <div className="sgc-error">{error}</div>}
        {done && (
          <div className="sgc-sales-signal sgc-sales-signal-success">
            <strong>✅ {done}</strong>
          </div>
        )}

        {snap && !loading && (
          <>
            {(snap.assignable > 0 || snap.blocked > 0) && (
              <div
                className={`sgc-sales-signal ${snap.blocked > 0 ? 'sgc-sales-signal-warning' : 'sgc-sales-signal-info'}`}
              >
                <strong>
                  {snap.assignable > 0
                    ? `${snap.assignable} 条线索有规则但还没落到人头上`
                    : '所有有规则的线索都已分配'}
                </strong>
                {snap.blocked > 0 && (
                  <span>
                    另有 {snap.blocked} 条来自 {snap.formsWithoutRule} 个还没设归属的表单，
                    设好下面的归属它们才能分出去。
                  </span>
                )}
                {snap.assignable > 0 && (
                  <div>
                    <button
                      type="button"
                      className="sgc-btn-primary"
                      style={{ fontSize: 12, padding: '4px 10px', marginTop: 6 }}
                      disabled={!!busy}
                      onClick={() => void runApply()}
                    >
                      {busy === 'apply' ? '分配中…' : `一键分配 ${snap.assignable} 条`}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              {snap.forms.map((f) => {
                const ranked = Object.entries(f.handlers).sort((a, b) => b[1] - a[1]);
                const open = expanded === f.formName;
                return (
                  <div
                    key={f.formName}
                    style={{
                      border: '1px solid #d1d7db',
                      borderRadius: 8,
                      padding: '12px 14px',
                    }}
                  >
                    <div style={{ fontSize: 15, fontWeight: 600, color: '#111b21', wordBreak: 'break-all' }}>
                      {f.formName}
                    </div>

                    <div style={{ fontSize: 12, color: '#54656f', marginTop: 4, fontFamily: 'monospace' }}>
                      表单 ID {f.formId || '—'}
                      {f.adIds.length > 0 && (
                        <> · 广告 ID {f.adIds.join('、')}</>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 14, color: '#111b21' }}>
                      <span>共 <strong>{f.total}</strong></span>
                      <span>聊过 <strong>{f.contacted}</strong></span>
                      <span style={{ color: f.unassigned > 0 ? '#9a6700' : '#111b21' }}>
                        没人跟 <strong>{f.unassigned}</strong>
                      </span>
                    </div>

                    {ranked.length > 0 ? (
                      <div style={{ fontSize: 13, color: '#54656f', marginTop: 8, lineHeight: 1.6 }}>
                        实际在跟：{ranked.map(([u, n]) => `${nameOf(u)} ${n} 条`).join(' · ')}
                        {f.suggestUserId && (
                          <>
                            {' → '}
                            推断 <strong style={{ color: '#111b21' }}>{nameOf(f.suggestUserId)}</strong>{' '}
                            {Math.round(f.suggestPurity * 100)}%
                            {!f.suggestOk && f.contacted < MIN_SAMPLE && (
                              <span style={{ color: '#9a6700' }}>（样本只有 {f.contacted} 条，不够可靠）</span>
                            )}
                          </>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: 13, color: '#9a6700', marginTop: 8 }}>
                        还没有人聊过这个表单来的客户，推断不出归属，请手动指定
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                      <select
                        value={f.rule?.user_id ?? ''}
                        disabled={busy === f.formName}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) {
                            if (f.rule) void clearRule(f.rule.id).then(refresh);
                            return;
                          }
                          void assign(f.formName, v, false, null);
                        }}
                        style={{ fontSize: 14, padding: '6px 8px', minWidth: 220 }}
                      >
                        <option value="">（未指定归属）</option>
                        {members.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.email}
                          </option>
                        ))}
                      </select>
                      {f.suggestOk && f.rule?.user_id !== f.suggestUserId && (
                        <button
                          type="button"
                          className="sgc-btn-secondary"
                          style={{ fontSize: 13, padding: '5px 12px' }}
                          disabled={busy === f.formName}
                          onClick={() => void assign(f.formName, f.suggestUserId!, true, f.suggestPurity)}
                        >
                          采用推断
                        </button>
                      )}
                      {f.rule && (
                        <span style={{ fontSize: 13, color: '#087966' }}>
                          {f.rule.auto_detected ? '自动推断' : '人工指定'}
                        </span>
                      )}
                      {f.unassigned > 0 && (
                        <button
                          type="button"
                          className="sgc-btn-mini"
                          style={{ fontSize: 13, padding: '5px 10px' }}
                          onClick={() => setExpanded(open ? null : f.formName)}
                        >
                          {open ? '收起名单' : `看这 ${f.unassigned} 个客户`}
                        </button>
                      )}
                    </div>

                    {open && (
                      <div
                        style={{
                          marginTop: 10,
                          maxHeight: 220,
                          overflowY: 'auto',
                          border: '1px solid #e9edef',
                          borderRadius: 6,
                        }}
                      >
                        {f.samples.map((s2, i) => (
                          <div
                            key={s2.phone + i}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              gap: 10,
                              padding: '7px 10px',
                              fontSize: 13,
                              color: '#111b21',
                              borderTop: i === 0 ? 'none' : '1px solid #f0f2f5',
                            }}
                          >
                            <span style={{ flex: 1, wordBreak: 'break-all' }}>
                              {s2.name || '(没填姓名)'}
                            </span>
                            <span style={{ fontFamily: 'monospace' }}>{s2.phone || '—'}</span>
                            <span style={{ color: '#667781', whiteSpace: 'nowrap' }}>{s2.at}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        </div>
      </div>
    </>
  );
}
