import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Period {
  key: string;
  label: string;
  type: 'all' | 'month' | 'week';
  newAll: number;
  withChat: number;
  neg: number;
  pi: number;
  pay: number;
  ctwa: number;
  form: number;
  topRegion: string;
  topModel: string;
}
interface ReportSummary {
  date?: string;
  total?: number;
  piPipeline?: number;
  topRep?: { name: string; n: number; unpaidPi: number; piVal: number };
  periods?: Period[];
}
interface ReportRow {
  week_of: string;
  summary: ReportSummary | null;
  html: string;
}

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('en-US');

export function WeeklyReportPage({ orgId }: { orgId: string }) {
  const [row, setRow] = useState<ReportRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selKey, setSelKey] = useState('all');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => any;
      })
        .from('weekly_reports')
        .select('week_of, summary, html')
        .eq('org_id', orgId)
        .eq('period', 'snapshot')
        .order('week_of', { ascending: false })
        .limit(1);
      if (cancelled) return;
      if (error) setErr(error.message);
      else setRow((data && data[0]) || null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const periods = row?.summary?.periods || [];
  const months = useMemo(() => periods.filter((p) => p.type === 'month'), [periods]);
  const weeks = useMemo(() => periods.filter((p) => p.type === 'week'), [periods]);
  const sel = periods.find((p) => p.key === selKey) || periods[0];

  const downloadFull = (html: string, weekOf: string) => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `SinoGear报告-${weekOf}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  if (loading) return <div style={{ padding: 24, color: '#64748b' }}>加载中…</div>;
  if (err) return <div style={{ padding: 24, color: '#dc2626' }}>读取失败:{err}</div>;
  if (!row || !sel)
    return (
      <div style={{ padding: 24 }}>
        <h3 style={{ marginTop: 0 }}>📊 报告</h3>
        <p style={{ color: '#64748b', lineHeight: 1.7 }}>
          还没有可选时期的报告。请在电脑上双击{' '}
          <b>D:\crm-analysis-dashboard\生成周报.bat</b>(会生成全部/各月/各周数据)。生成后刷新本页。
        </p>
      </div>
    );

  const s = row.summary || {};
  const isAll = sel.type === 'all';
  const kpis = [
    { l: '进线客户', v: fmt(sel.newAll), hot: true },
    { l: '有聊天', v: fmt(sel.withChat) },
    { l: '进谈判', v: fmt(sel.neg) },
    { l: '开 PI', v: fmt(sel.pi) },
    { l: '付款截图', v: fmt(sel.pay) },
    { l: 'CTWA / 表单', v: `${fmt(sel.ctwa)}/${fmt(sel.form)}` },
  ];

  return (
    <div style={{ padding: '20px 24px', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>📊 进线质量报告</div>
        <label style={{ fontSize: 13, color: '#475569', fontWeight: 600 }}>
          选择时期:{' '}
          <select
            value={selKey}
            onChange={(e) => setSelKey(e.target.value)}
            style={{
              padding: '7px 12px',
              borderRadius: 9,
              border: '1px solid #cbd5e1',
              fontSize: 14,
              fontWeight: 700,
              color: '#2563eb',
            }}
          >
            <option value="all">全部(累计)</option>
            {months.length > 0 && (
              <optgroup label="按月">
                {months.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            )}
            {weeks.length > 0 && (
              <optgroup label="按周">
                {weeks.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <div
          style={{
            fontSize: 12,
            color: '#475569',
            background: '#eff6ff',
            border: '1px solid #dbeafe',
            borderRadius: 20,
            padding: '4px 12px',
            fontWeight: 600,
          }}
        >
          📅 数据截至 {row.week_of}
        </div>
        <button
          type="button"
          onClick={() => downloadFull(row.html, row.week_of)}
          title="下载完整看板 HTML,双击打开查看全部图表(浏览器内直接打开会被安全策略拦截)"
          style={{
            marginLeft: 'auto',
            padding: '9px 16px',
            borderRadius: 9,
            border: 'none',
            background: '#2563eb',
            color: '#fff',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          下载完整看板 ↓
        </button>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '16px 0 4px' }}>
        {sel.label}
        <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 400, marginLeft: 8 }}>
          {isAll ? '截至今日全部累计' : '该时期进线的客户(按建档时间)'}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
          gap: 12,
          margin: '8px 0',
        }}
      >
        {kpis.map((k) => (
          <div
            key={k.l}
            style={{
              background: k.hot ? '#eff6ff' : '#f8fafc',
              border: `1px solid ${k.hot ? '#bfdbfe' : '#e2e8f0'}`,
              borderRadius: 12,
              padding: 14,
            }}
          >
            <div style={{ fontSize: 23, fontWeight: 800, color: k.hot ? '#2563eb' : '#0f172a' }}>
              {k.v}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{k.l}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          fontSize: 13,
          color: '#334155',
          margin: '10px 0',
        }}
      >
        <span>
          主力区域 <b>{sel.topRegion}</b>
        </span>
        <span>
          热门车型 <b>{sel.topModel}</b>
        </span>
        {sel.withChat > 0 && (
          <span>
            进谈判率 <b>{Math.round((100 * sel.neg) / sel.withChat)}%</b> · 开PI率{' '}
            <b>{Math.round((100 * sel.pi) / sel.withChat)}%</b>
          </span>
        )}
      </div>

      {isAll && s.topRep && (
        <div
          style={{
            background: '#fee2e2',
            borderLeft: '4px solid #dc2626',
            borderRadius: '0 8px 8px 0',
            padding: '12px 16px',
            margin: '14px 0',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <b>跟单瓶颈:</b>
          {s.topRep.name} 一人扛 {s.topRep.unpaidPi} 个未付 PI、约 ${fmt(s.topRep.piVal)} 待收 ·
          全库待收 PI ${fmt(s.piPipeline)}。点「下载完整看板」看分业务员 / 188 未付 PI 追单 /
          回复行为 / 卡点详解等全部分析。
        </div>
      )}

      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 16 }}>
        选时期看的是该批进线客户的核心指标(进线/有聊天/进谈判/开PI/付款/渠道/Top);
        「下载完整看板」是当前累计的全套深度分析。由「生成周报.bat」每周自动生成上传。
      </div>
    </div>
  );
}
