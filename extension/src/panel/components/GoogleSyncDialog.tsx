import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchAllPaged } from '@/lib/supabase-paged';
import {
  createGoogleContact,
  listGoogleContacts,
  normalizePhone,
  type GoogleContact,
} from '@/lib/google-people';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

type Direction = 'pull' | 'push' | 'both';

interface Props {
  orgId: string;
  onClose: () => void;
  onDone: () => void;
}

interface Summary {
  pulled: number;
  pulledUpdated: number;
  pushed: number;
  skipped: number;
  errors: string[];
}

export function GoogleSyncDialog({ orgId, onClose, onDone }: Props) {
  const [direction, setDirection] = useState<Direction>('pull');
  const [conflictWinner, setConflictWinner] = useState<'google' | 'crm'>('crm');
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    const result: Summary = { pulled: 0, pulledUpdated: 0, pushed: 0, skipped: 0, errors: [] };

    try {
      setProgress('正在加载 Google 联系人…');
      const googleList = await listGoogleContacts();

      setProgress('正在加载 CRM 客户…');
      // 分页拉全集——大 org 超 1000 contact，之前漏的 2000+ 会被
      // Google sync 当成"不存在"误判（虽然 upsert 兜得住，但 stats 不准）
      const crmContacts = await fetchAllPaged<ContactRow>((from, to) =>
        supabase
          .from('contacts')
          .select('*')
          .eq('org_id', orgId)
          .range(from, to),
      );

      // Google 同步只针对个人 contact（有 phone）；群聊不同步
      const crmByPhone = new Map<string, ContactRow>();
      for (const c of crmContacts) {
        if (c.phone) crmByPhone.set(c.phone, c);
      }

      if (direction === 'pull' || direction === 'both') {
        let i = 0;
        for (const g of googleList) {
          i++;
          if (i % 20 === 0) {
            setProgress(`Google → CRM: ${i} / ${googleList.length}`);
          }
          if (g.phones.length === 0) {
            result.skipped++;
            continue;
          }
          for (const phone of g.phones) {
            const existing = crmByPhone.get(phone);
            if (!existing) {
              const inserted = await supabase
                .from('contacts')
                .upsert(
                  {
                    org_id: orgId,
                    phone,
                    name: g.displayName,
                    google_resource_name: g.resourceName,
                    google_synced_at: new Date().toISOString(),
                  },
                  { onConflict: 'org_id,phone', ignoreDuplicates: true },
                )
                .select('*')
                .maybeSingle();
              if (inserted.error) {
                result.errors.push(`${phone}: ${inserted.error.message}`);
              } else if (inserted.data) {
                result.pulled++;
                crmByPhone.set(phone, inserted.data);
              }
            } else {
              const shouldUpdateName =
                conflictWinner === 'google' &&
                g.displayName &&
                g.displayName !== existing.name;
              const update: Database['public']['Tables']['contacts']['Update'] = {
                google_resource_name: g.resourceName,
                google_synced_at: new Date().toISOString(),
              };
              if (shouldUpdateName) update.name = g.displayName;
              const { error: updErr } = await supabase
                .from('contacts')
                .update(update)
                .eq('id', existing.id);
              if (updErr) {
                result.errors.push(`${phone}: ${updErr.message}`);
              } else {
                result.pulledUpdated++;
              }
            }
          }
        }
      }

      if (direction === 'push' || direction === 'both') {
        const googleByPhone = new Map<string, GoogleContact>();
        for (const g of googleList) {
          for (const p of g.phones) googleByPhone.set(p, g);
        }
        let i = 0;
        for (const c of crmContacts) {
          i++;
          if (i % 20 === 0) {
            setProgress(`CRM → Google: ${i} / ${crmContacts.length}`);
          }
          // 群聊跳过（没手机号）
          if (!c.phone) {
            result.skipped++;
            continue;
          }
          const norm = normalizePhone(c.phone);
          if (!norm) continue;
          if (googleByPhone.has(norm) || c.google_resource_name) {
            result.skipped++;
            continue;
          }
          try {
            const created = await createGoogleContact({
              displayName: c.name || c.wa_name || c.phone,
              phone: norm,
            });
            await supabase
              .from('contacts')
              .update({
                google_resource_name: created.resourceName,
                google_synced_at: new Date().toISOString(),
              })
              .eq('id', c.id);
            result.pushed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${c.phone}: ${msg}`);
          }
        }
      }

      setSummary(result);
      setProgress(null);
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setProgress(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={running ? undefined : onClose} />
      <div className="sgc-modal" role="dialog">
        <header className="sgc-modal-header">
          <strong>Google 联系人同步</strong>
          {!running && (
            <button
              className="sgc-drawer-close"
              onClick={onClose}
              aria-label="关闭"
            >
              ×
            </button>
          )}
        </header>

        <div className="sgc-modal-body">
          {!summary && (
            <>
              <div className="sgc-field">
                <span>同步方向</span>
                <div className="sgc-radio-group">
                  <label>
                    <input
                      type="radio"
                      checked={direction === 'pull'}
                      onChange={() => setDirection('pull')}
                      disabled={running}
                    />
                    Google → CRM（导入到本地）
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={direction === 'push'}
                      onChange={() => setDirection('push')}
                      disabled={running}
                    />
                    CRM → Google（推到 Google）
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={direction === 'both'}
                      onChange={() => setDirection('both')}
                      disabled={running}
                    />
                    双向同步
                  </label>
                </div>
              </div>

              {(direction === 'pull' || direction === 'both') && (
                <div className="sgc-field">
                  <span>姓名冲突时（Google 和 CRM 不同）以谁为准</span>
                  <div className="sgc-radio-group">
                    <label>
                      <input
                        type="radio"
                        checked={conflictWinner === 'crm'}
                        onChange={() => setConflictWinner('crm')}
                        disabled={running}
                      />
                      保留 CRM 已有姓名（推荐）
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={conflictWinner === 'google'}
                        onChange={() => setConflictWinner('google')}
                        disabled={running}
                      />
                      用 Google 姓名覆盖
                    </label>
                  </div>
                </div>
              )}

              <div className="sgc-muted" style={{ fontSize: 12 }}>
                匹配规则：用手机号（仅数字 + 国际区号）匹配。Google 中无手机号的联系人会被跳过。
              </div>
            </>
          )}

          {progress && (
            <div className="sgc-empty">{progress}</div>
          )}

          {error && <div className="sgc-error">{error}</div>}

          {summary && (
            <div className="sgc-stack">
              <div className="sgc-stack-card">
                <strong>同步完成 ✓</strong>
                <div className="sgc-stack-meta">
                  <span>新增 {summary.pulled}</span>
                  <span>更新 {summary.pulledUpdated}</span>
                  <span>推送 {summary.pushed}</span>
                  <span>跳过 {summary.skipped}</span>
                </div>
              </div>
              {summary.errors.length > 0 && (
                <div className="sgc-stack-card">
                  <strong>错误（{summary.errors.length} 条）</strong>
                  <div className="sgc-stack-notes">
                    {summary.errors.slice(0, 5).join('\n')}
                    {summary.errors.length > 5 && `\n…还有 ${summary.errors.length - 5} 条`}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="sgc-modal-actions">
            {!summary && (
              <>
                <button
                  type="button"
                  className="sgc-btn-link"
                  onClick={onClose}
                  disabled={running}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="sgc-btn-primary"
                  onClick={run}
                  disabled={running}
                >
                  {running ? '同步中…' : '开始同步'}
                </button>
              </>
            )}
            {summary && (
              <button
                type="button"
                className="sgc-btn-primary"
                onClick={onClose}
              >
                完成
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
