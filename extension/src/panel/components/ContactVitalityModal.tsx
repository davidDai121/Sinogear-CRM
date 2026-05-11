import { useEffect, useRef, useState } from 'react';
import {
  analyzeContactVitality,
  type Vitality,
  type VitalityReport,
} from '@/lib/contact-vitality';
import { jumpToChat } from '@/lib/jump-to-chat';
import { supabase } from '@/lib/supabase';

interface Props {
  orgId: string;
  onClose: () => void;
  onChanged: () => void; // 删除/标 spam 后让外面 refresh
}

type Tab = Vitality;
const TAB_META: Record<Tab, { label: string; emoji: string; color: string; hint: string }> = {
  active: {
    label: '活跃 ≤30 天',
    emoji: '🟢',
    color: '#1b5e20',
    hint: '在 WA Web 本地缓存里，最近 30 天有聊天活动。',
  },
  stale: {
    label: '沉睡 30-180 天',
    emoji: '🟡',
    color: '#795548',
    hint: '在 WA Web 本地缓存里，30-180 天没新消息。考虑重新激活。',
  },
  cold: {
    label: '极冷 >180 天',
    emoji: '🟠',
    color: '#bf5700',
    hint: '在 WA Web 本地缓存里，半年以上没动静。',
  },
  imported: {
    label: '已导入·WA Web 无缓存',
    emoji: '🔵',
    color: '#0277bd',
    hint: '不在 WA Web 本地缓存里（搜索框搜不到），但已导入过 .txt 聊天历史。这些是真客户，点 💬 会自动走 deep link 进入聊天。⚠️ 不要删。',
  },
  orphan: {
    label: '无任何 WA 痕迹',
    emoji: '🔴',
    color: '#b71c1c',
    hint: '既不在 WA Web 缓存、也没导入聊天历史。大概率是从 Google 联系人/旧 CRM 导入但从未在 WhatsApp 实际联系过的。**清理候选**。',
  },
};

export function ContactVitalityModal({ orgId, onClose, onChanged }: Props) {
  const [report, setReport] = useState<VitalityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('orphan');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pingResults, setPingResults] = useState<Map<string, boolean>>(new Map());
  const [pingProgress, setPingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  // 用 ref 存取消标志，避免 for 循环里读到 stale closure 的 state 值
  const cancelRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    analyzeContactVitality(orgId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const list = report ? report[tab] : [];

  const toggleAll = () => {
    if (selected.size === list.length) setSelected(new Set());
    else setSelected(new Set(list.map((c) => c.contactId)));
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const runPing = async () => {
    if (list.length === 0) return;
    if (
      !window.confirm(
        `将逐个尝试在 WhatsApp Web 打开这 ${list.length} 个客户的聊天框来验证号码是否还活跃。\n\n` +
          `预计耗时 ${Math.ceil(list.length * 3 / 60)} 分钟。期间不要切换/关闭 WA Web 标签页。\n\n` +
          `是否开始？`,
      )
    ) {
      return;
    }
    cancelRef.current = false;
    setPingProgress({ current: 0, total: list.length });
    const results = new Map(pingResults);
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break;
      const c = list[i];
      if (!c.phone) {
        results.set(c.contactId, false);
        setPingResults(new Map(results));
        setPingProgress({ current: i + 1, total: list.length });
        continue;
      }
      const digits = c.phone.replace(/^\+/, '');
      let ok = false;
      try {
        ok = await jumpToChat(digits);
      } catch {
        ok = false;
      }
      results.set(c.contactId, ok);
      setPingResults(new Map(results));
      setPingProgress({ current: i + 1, total: list.length });
      // 间隔避免触发 WA 反爬
      await new Promise((r) => setTimeout(r, 200));
    }
    setPingProgress(null);
  };

  const bulkAction = async (action: 'delete' | 'spam') => {
    if (selected.size === 0) return;
    const verb = action === 'delete' ? '删除' : '标记为垃圾';
    // 选中里有几个有导入聊天历史 — 这种客户即使 WA Web 搜不到也是真客户，
    // 通常不该删（删了导入的 .txt 历史也跟着没了）。
    const withMsgs = list.filter(
      (c) => selected.has(c.contactId) && c.hasMessagesInDb,
    ).length;
    if (action === 'delete' && withMsgs > 0) {
      if (
        !window.confirm(
          `⚠️ 选中的 ${selected.size} 个客户里，有 ${withMsgs} 个已导入过聊天历史。\n\n` +
            `这些往往是真客户（手机端能搜到、已经有沟通记录），只是 WA Web 本地缓存里没有。\n` +
            `删除会把他们的导入历史一并清掉，不可撤销。\n\n` +
            `确定要继续吗？`,
        )
      ) {
        return;
      }
    }
    if (
      !window.confirm(
        `${verb} ${selected.size} 个客户？\n\n${
          action === 'delete'
            ? '将连带删除他们的标签 / 车型兴趣 / 报价 / 任务 / 消息历史 / 时间轴。不可撤销。'
            : 'quality 字段改为 spam，默认筛选会隐藏。可随时改回。'
        }`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const ids = Array.from(selected);
      const CHUNK = 100;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        if (action === 'delete') {
          const { error } = await supabase.from('contacts').delete().in('id', batch);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('contacts')
            .update({ quality: 'spam' })
            .in('id', batch);
          if (error) throw error;
        }
      }
      // 重新分析
      setSelected(new Set());
      setPingResults(new Map());
      const next = await analyzeContactVitality(orgId);
      setReport(next);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 8,
          width: '92%',
          maxWidth: 800,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🩺 客户活性体检</h3>
          <button onClick={onClose} className="sgc-btn-link" type="button">
            关闭
          </button>
        </div>

        <p style={{ fontSize: 12, color: '#667781', margin: '0 0 12px 0', lineHeight: 1.5 }}>
          根据 WhatsApp Web 本地缓存 + CRM 消息历史给每个客户打活性标签。
          <br />
          <strong style={{ color: '#0277bd' }}>🔵 已导入·WA Web 无缓存</strong>：真客户，只是 WA Web 缓存装不下太多 chat。
          点 💬 会走 deep link 自动进 chat（已修好）。**不要删**。
          <br />
          <strong style={{ color: '#b71c1c' }}>🔴 无任何 WA 痕迹</strong>：既没缓存也没聊天历史，是清理候选。
          <br />
          ⚠️ "实测验证"靠 WA Web 搜索框，搜不到 ≠ 死号——有些注册号 WA Web 本地搜不到。
        </p>

        {!report && !error && <div className="sgc-empty">分析中…</div>}
        {error && <div className="sgc-error">{error}</div>}

        {report && (
          <>
            {/* 统计 + tab 切换 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {(['active', 'stale', 'cold', 'imported', 'orphan'] as Tab[]).map((k) => {
                const meta = TAB_META[k];
                const count = report[k].length;
                const isActive = tab === k;
                return (
                  <button
                    key={k}
                    type="button"
                    title={meta.hint}
                    onClick={() => {
                      setTab(k);
                      setSelected(new Set());
                    }}
                    style={{
                      padding: '6px 12px',
                      border: `1.5px solid ${isActive ? meta.color : '#d1d7db'}`,
                      background: isActive ? meta.color + '15' : '#fff',
                      color: isActive ? meta.color : '#111b21',
                      borderRadius: 16,
                      fontSize: 12,
                      cursor: 'pointer',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {meta.emoji} {meta.label} · {count}
                  </button>
                );
              })}
            </div>

            <div style={{ fontSize: 12, color: '#667781', marginBottom: 4 }}>
              共 {report.total} 个客户 · 当前显示 {list.length} 个 · 已选 {selected.size}
            </div>
            <div
              style={{
                fontSize: 11,
                color: TAB_META[tab].color,
                marginBottom: 8,
                padding: '4px 8px',
                background: TAB_META[tab].color + '0c',
                borderLeft: `3px solid ${TAB_META[tab].color}`,
                lineHeight: 1.5,
              }}
            >
              {TAB_META[tab].hint}
            </div>

            {/* 操作行 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className="sgc-btn-secondary"
                onClick={toggleAll}
                disabled={list.length === 0 || busy}
                style={{ fontSize: 12 }}
              >
                {selected.size === list.length && list.length > 0 ? '取消全选' : '全选'}
              </button>
              <button
                type="button"
                className="sgc-btn-secondary"
                onClick={runPing}
                disabled={pingProgress != null || list.length === 0 || busy}
                style={{ fontSize: 12 }}
                title="逐个 jumpToChat 实测；预计 3 秒/个"
              >
                {pingProgress
                  ? `🔍 验证中 ${pingProgress.current}/${pingProgress.total}`
                  : '🔍 实测验证号码'}
              </button>
              {pingProgress && (
                <button
                  type="button"
                  className="sgc-btn-link"
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                  style={{ fontSize: 12 }}
                >
                  停止
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="sgc-btn-secondary"
                onClick={() => bulkAction('spam')}
                disabled={selected.size === 0 || busy}
                style={{ fontSize: 12 }}
              >
                🗑 标 spam ({selected.size})
              </button>
              <button
                type="button"
                className="sgc-btn-primary"
                onClick={() => bulkAction('delete')}
                disabled={selected.size === 0 || busy}
                style={{ fontSize: 12, background: '#b71c1c' }}
              >
                ✗ 删除 ({selected.size})
              </button>
            </div>

            {/* 列表 */}
            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e9edef', borderRadius: 4 }}>
              {list.length === 0 ? (
                <div className="sgc-empty" style={{ padding: 24 }}>
                  这一档没有客户
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: '#f6f7f9', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={{ padding: '6px 8px', textAlign: 'left', width: 28 }}></th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>姓名</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>手机号</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>最近活动</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>消息</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>实测</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, 500).map((c) => {
                      const ping = pingResults.get(c.contactId);
                      return (
                        <tr key={c.contactId} style={{ borderTop: '1px solid #f0f2f5' }}>
                          <td style={{ padding: '6px 8px' }}>
                            <input
                              type="checkbox"
                              checked={selected.has(c.contactId)}
                              onChange={() => toggleOne(c.contactId)}
                            />
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {c.groupJid && '👥 '}
                            {c.name}
                          </td>
                          <td style={{ padding: '6px 8px' }}>{c.phone ?? '—'}</td>
                          <td style={{ padding: '6px 8px' }}>
                            {c.daysSinceActivity == null
                              ? '—'
                              : `${c.daysSinceActivity} 天前`}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {c.hasMessagesInDb ? '✓' : '—'}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {ping == null
                              ? '—'
                              : ping
                                ? <span style={{ color: '#1b5e20' }}>✓ 能开</span>
                                : <span
                                    style={{ color: '#bf5700' }}
                                    title="WA Web 搜索框搜不到。可能号未注册（真死号），也可能仅手机端能搜到。已导入聊天历史的客户不要删。"
                                  >
                                    ⚠ 搜不到
                                  </span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {list.length > 500 && (
                <div style={{ padding: 8, fontSize: 11, color: '#667781', textAlign: 'center' }}>
                  显示前 500 条 · 共 {list.length} 条
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
