/**
 * 「客户在等你给什么」——把客户消息里明确的索取拎出来，一键变待办。
 *
 * 为什么做（2026-08-19 实测）：全库 3,936 个客户收到过报价，只有 36 个口头确认、
 * 24 个成交。逐个读聊天发现漏在同一处——客户张口要的东西没给到：
 * Brian 要电池 SOH 报告等了 6 天、Amr 要 catalog 问了两次、ÀL-Mìsbãh 要 CIF 报价
 * 等了 58 天。tasks 表本来就是干这个的，但要手动建，6/22 之后再没人用过。
 * 销售在 WhatsApp 里打字不会切 tab 填表单，所以必须自动认出来 + 一键入库。
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  collectOpenRequests,
  type OpenRequest,
  type RequestKind,
} from '@/lib/open-request';

interface Props {
  contactId: string;
  orgId: string;
}

type Item = OpenRequest & { askedAt: string | null };

/** 只看最近 60 天——更早的要求多半已经过期或换了车型 */
const WINDOW_DAYS = 60;
/** 够覆盖一轮完整问答，又不至于拉太多行（免费层 egress 敏感） */
const FETCH_LIMIT = 15;

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function PendingRequestBanner({ contactId, orgId }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [added, setAdded] = useState<Set<RequestKind>>(new Set());
  const [busy, setBusy] = useState<RequestKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setAdded(new Set());
    void (async () => {
      const since = new Date(
        Date.now() - WINDOW_DAYS * 86_400_000,
      ).toISOString();
      const { data } = await supabase
        .from('messages')
        .select('text, sent_at')
        .eq('contact_id', contactId)
        .eq('direction', 'inbound')
        .gte('sent_at', since)
        .order('sent_at', { ascending: false })
        .limit(FETCH_LIMIT);
      if (cancelled) return;
      setItems(collectOpenRequests(data ?? []));
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const addTask = async (item: Item) => {
    setBusy(item.kind);
    const { error } = await supabase.from('tasks').insert({
      org_id: orgId,
      contact_id: contactId,
      title: `给客户发：${item.label}`,
    });
    setBusy(null);
    if (!error) setAdded((s) => new Set(s).add(item.kind));
  };

  if (items.length === 0) return null;

  return (
    <div className="sgc-sales-signal sgc-sales-signal-warning">
      <strong>⏳ 客户在等你给这些</strong>
      <span style={{ fontSize: 12, opacity: 0.85 }}>
        从他最近 {WINDOW_DAYS} 天的消息里识别出来的，点一下加进待办。
      </span>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item) => {
          const d = daysAgo(item.askedAt);
          const done = added.has(item.kind);
          return (
            <div
              key={item.kind}
              style={{
                background: 'rgba(255,255,255,0.6)',
                borderRadius: 4,
                padding: '6px 8px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'space-between',
                }}
              >
                <strong style={{ fontSize: 13 }}>
                  {item.label}
                  {d != null && (
                    <span style={{ fontWeight: 400, opacity: 0.7 }}>
                      {' '}
                      · {d === 0 ? '今天提的' : `${d} 天前提的`}
                    </span>
                  )}
                </strong>
                <button
                  type="button"
                  className="sgc-btn-secondary"
                  style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}
                  disabled={done || busy === item.kind}
                  onClick={() => void addTask(item)}
                >
                  {done ? '✅ 已加' : busy === item.kind ? '…' : '加到待办'}
                </button>
              </div>
              <div
                style={{
                  fontSize: 11,
                  opacity: 0.75,
                  marginTop: 2,
                  wordBreak: 'break-word',
                }}
              >
                「{item.quote}」
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
