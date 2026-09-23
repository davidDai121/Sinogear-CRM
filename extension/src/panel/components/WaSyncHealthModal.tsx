/**
 * 📡 号码同步状态 —— 每个业务号的 coexistence 推送是否正常。
 *
 * 为什么要有（2026-09-23）：Grant 接入当天，前几批历史被 webhook 解析成 0 条还回了 200，
 * Meta 不会再推，数据永久丢了，而系统没有任何提示，是翻函数日志才发现的。
 * boss 原话：「同步我怕出错，你没同步成功怎么办」——出错必须在 CRM 里看得见。
 *
 * 数据：wa_business_numbers（最后推送时间 / 最近错误）+ wa_number_daily_stats（每天计数），
 * 都由 wa-cloud-webhook 写，org 成员 RLS 只读。
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useScope } from '../contexts/ScopeContext';
import { stringifyError } from '@/lib/errors';

interface NumberRow {
  phone: string;
  label: string | null;
  user_id: string | null;
  phone_number_id: string | null;
  last_webhook_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

interface StatRow {
  phone: string;
  day: string;
  received: number;
  inserted: number;
  skipped: number;
  failed: number;
}

interface Props {
  orgId: string;
  onClose: () => void;
}

const HOUR = 3600_000;

function ago(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < HOUR) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} 小时前`;
  return `${Math.round(ms / (24 * HOUR))} 天前`;
}

type Health = { tone: 'gray' | 'green' | 'orange' | 'red'; title: string; hint?: string };

function healthOf(n: NumberRow, now: number): Health {
  if (!n.phone_number_id) {
    return { tone: 'gray', title: '未接入', hint: '这个号还没接共存模式，聊天仍靠 WhatsApp 网页版扩展抓取' };
  }
  if (n.last_error_at && now - new Date(n.last_error_at).getTime() < 24 * HOUR) {
    return {
      tone: 'red',
      title: '最近有入库失败',
      hint: `${ago(n.last_error_at, now)}：${n.last_error ?? '未知错误'}。Meta 会自动重推，原始数据已留底；如果一直重复出现请告诉 Claude`,
    };
  }
  if (!n.last_webhook_at) {
    return { tone: 'orange', title: '已接入，还没收到推送' };
  }
  const silent = now - new Date(n.last_webhook_at).getTime();
  if (silent > 3 * 24 * HOUR) {
    return {
      tone: 'red',
      title: `${ago(n.last_webhook_at, now)}没收到推送，可能已断开`,
      hint: '让这个号的手机打开 WhatsApp Business 看一眼；14 天不打开共存会自动断开',
    };
  }
  if (silent > 24 * HOUR) {
    return {
      tone: 'orange',
      title: `${ago(n.last_webhook_at, now)}没收到推送`,
      hint: '可能只是这段时间没人聊天；超过 3 天还这样就要检查',
    };
  }
  return { tone: 'green', title: '正常' };
}

const TONE: Record<Health['tone'], { dot: string; bg: string; fg: string }> = {
  gray: { dot: '⚪', bg: '#f6f7f9', fg: '#54656f' },
  green: { dot: '🟢', bg: '#e7f8f1', fg: '#087966' },
  orange: { dot: '🟠', bg: '#fff4e5', fg: '#9a6700' },
  red: { dot: '🔴', bg: '#fdecec', fg: '#b91c1c' },
};

export function WaSyncHealthModal({ orgId, onClose }: Props) {
  const { membersById } = useScope();
  const [numbers, setNumbers] = useState<NumberRow[]>([]);
  const [stats, setStats] = useState<StatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - 7 * 24 * HOUR).toISOString().slice(0, 10);
      const [n, s] = await Promise.all([
        supabase
          .from('wa_business_numbers')
          .select('phone, label, user_id, phone_number_id, last_webhook_at, last_error, last_error_at')
          .eq('org_id', orgId)
          .order('label'),
        supabase
          .from('wa_number_daily_stats')
          .select('phone, day, received, inserted, skipped, failed')
          .eq('org_id', orgId)
          .gte('day', since),
      ]);
      if (n.error) throw n.error;
      if (s.error) throw s.error;
      setNumbers((n.data ?? []) as NumberRow[]);
      setStats((s.data ?? []) as StatRow[]);
      setNow(Date.now());
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const today = new Date().toISOString().slice(0, 10);
  const sum = (phone: string, onlyToday: boolean) =>
    stats
      .filter((r) => r.phone === phone && (!onlyToday || r.day === today))
      .reduce(
        (a, r) => ({
          received: a.received + r.received,
          inserted: a.inserted + r.inserted,
          skipped: a.skipped + r.skipped,
          failed: a.failed + r.failed,
        }),
        { received: 0, inserted: 0, skipped: 0, failed: 0 },
      );

  const nameOf = (uid: string | null) =>
    uid ? membersById.get(uid)?.email?.split('@')[0] ?? uid.slice(0, 8) : '未绑定业务员';

  // 有问题的排前面
  const order = { red: 0, orange: 1, green: 2, gray: 3 } as const;
  const rows = numbers
    .map((n) => ({ n, h: healthOf(n, now) }))
    .sort((a, b) => order[a.h.tone] - order[b.h.tone]);

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong style={{ color: '#111b21' }}>📡 号码同步状态</strong>
          <button className="sgc-drawer-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="sgc-modal-body">
          <p style={{ fontSize: 13, color: '#54656f', margin: '0 0 12px', lineHeight: 1.6 }}>
            接入共存模式的号，WhatsApp 收发的每条消息由 Meta 直接推进 CRM。
            「入库」少于「收到」是正常的——重复的消息会自动去重；
            <strong>跳过 / 失败</strong>的原始数据都已留底，可以补录。
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button type="button" className="sgc-btn-link" onClick={() => void refresh()} disabled={loading}>
              {loading ? '加载中…' : '🔄 刷新'}
            </button>
          </div>

          {error && <div className="sgc-error">{error}</div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map(({ n, h }) => {
              const t = TONE[h.tone];
              const d = sum(n.phone, true);
              const w = sum(n.phone, false);
              return (
                <div
                  key={n.phone}
                  style={{ border: '1px solid #d1d7db', borderRadius: 8, padding: '10px 14px' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: '#111b21' }}>
                      {n.label ?? n.phone}
                      <span style={{ fontSize: 12, fontWeight: 400, color: '#667781', marginLeft: 8 }}>
                        {n.phone} · {nameOf(n.user_id)}
                      </span>
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: t.bg,
                        color: t.fg,
                        fontWeight: 600,
                      }}
                    >
                      {t.dot} {h.title}
                    </span>
                  </div>

                  {h.hint && (
                    <div style={{ fontSize: 12, color: t.fg, marginTop: 6, lineHeight: 1.5 }}>{h.hint}</div>
                  )}

                  {n.phone_number_id && (
                    <div style={{ fontSize: 12, color: '#54656f', marginTop: 6, lineHeight: 1.7 }}>
                      最后推送：{n.last_webhook_at ? ago(n.last_webhook_at, now) : '—'}
                      <br />
                      今天：收到 {d.received} · 入库 {d.inserted}
                      {d.skipped > 0 && <span style={{ color: '#9a6700' }}> · 跳过 {d.skipped}</span>}
                      {d.failed > 0 && <span style={{ color: '#b91c1c' }}> · 失败 {d.failed}</span>}
                      <br />
                      近 7 天：收到 {w.received} · 入库 {w.inserted}
                      {w.skipped > 0 && <span style={{ color: '#9a6700' }}> · 跳过 {w.skipped}</span>}
                      {w.failed > 0 && <span style={{ color: '#b91c1c' }}> · 失败 {w.failed}</span>}
                    </div>
                  )}
                </div>
              );
            })}
            {!loading && rows.length === 0 && <div className="sgc-empty">还没有登记任何业务号</div>}
          </div>
        </div>
      </div>
    </>
  );
}
