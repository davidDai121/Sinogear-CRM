/**
 * 「这条线索合格吗」—— 销售的人工判定，喂给 Meta 学习用。
 *
 * 为什么必须是人点的：2026-08-20 实测，近 8 周 qualifying 阶段变更里 78% 是
 * AI 自动推的，而同一个 AI 会把广告表单的自动首句「Hi, I'm interested in
 * the Changan UNI-K.」读成「客户已购买其他车型并支付定金」。把这种判断回传
 * 给 Meta，它会照着「发广告表单自动消息」这个特征去找更多同类人。
 *
 * 为什么有些客户不回传：全库 9,128 个客户 fb_lead_id / ctwa_clid / fb_ad_id
 * 全是 0，归因链是断的。不是广告来的客户，判定只存本地不发 Meta。
 */
import { useEffect, useState } from 'react';
import {
  fetchLatestJudgment,
  recordJudgment,
  hasAdIdentifier,
  type LeadJudgment,
} from '@/lib/lead-qualification';
import { stringifyError } from '@/lib/errors';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

interface Props {
  contact: ContactRow;
}

/** 不合格的常见原因 —— 固定选项比自由填写更能喂出干净的训练信号 */
const BAD_REASONS = [
  '买不起 / 预算差太远',
  '只是问问 / 没有真需求',
  '国家或港口做不了',
  '要的车型没有',
  '联系不上 / 假号码',
  '同行或骚扰',
];

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function LeadQualitySection({ contact }: Props) {
  const [judgment, setJudgment] = useState<LeadJudgment | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickingReason, setPickingReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromAd = hasAdIdentifier(contact);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPickingReason(false);
    setError(null);
    void (async () => {
      const j = await fetchLatestJudgment(contact.id);
      if (cancelled) return;
      setJudgment(j);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contact.id]);

  const judge = async (qualified: boolean, reason?: string) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await recordJudgment(contact, { qualified, reason });
      setJudgment(saved);
      setPickingReason(false);
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  // 判过了 → 显示结论，允许改判
  if (judgment && !pickingReason) {
    return (
      <div
        className={`sgc-sales-signal ${
          judgment.qualified
            ? 'sgc-sales-signal-success'
            : 'sgc-sales-signal-info'
        }`}
      >
        <strong>
          {judgment.qualified ? '✅ 已判定：合格线索' : '🚫 已判定：不合格'} ·{' '}
          {fmt(judgment.at)}
        </strong>
        <span>
          {judgment.reason ? `${judgment.reason} · ` : ''}
          {judgment.fbEventSent
            ? '已回传 Meta'
            : '未回传 Meta（这个客户身上没有广告标识）'}
        </span>
        <div>
          <button
            type="button"
            className="sgc-btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px', marginTop: 4 }}
            disabled={busy}
            onClick={() => setJudgment(null)}
          >
            改判
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sgc-sales-signal sgc-sales-signal-info">
      <strong>🎯 这条线索合格吗？</strong>
      <span>
        你的判断会教 Meta 该找什么样的人。
        {fromAd
          ? '这个客户带广告标识，判定会回传。'
          : '⚠️ 这个客户没有广告标识，判定只存 CRM、不回传 Meta。'}
      </span>

      {error && (
        <span style={{ fontSize: 11, color: '#b91c1c', wordBreak: 'break-word' }}>
          ⚠️ {error}
        </span>
      )}

      {!pickingReason ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button
            type="button"
            className="sgc-btn-primary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            disabled={busy}
            onClick={() => void judge(true)}
          >
            ✅ 合格
          </button>
          <button
            type="button"
            className="sgc-btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            disabled={busy}
            onClick={() => setPickingReason(true)}
          >
            🚫 不合格
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, opacity: 0.8 }}>为什么不合格？</span>
          {BAD_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              className="sgc-btn-secondary"
              style={{ fontSize: 11, padding: '3px 8px', textAlign: 'left' }}
              disabled={busy}
              onClick={() => void judge(false, r)}
            >
              {r}
            </button>
          ))}
          <button
            type="button"
            className="sgc-btn-mini"
            style={{ marginTop: 2 }}
            disabled={busy}
            onClick={() => setPickingReason(false)}
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}
