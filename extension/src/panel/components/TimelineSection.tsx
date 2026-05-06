import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Database,
  ContactEventType,
  CustomerStage,
} from '@/lib/database.types';
import { stringifyError } from '@/lib/errors';

type ContactEventRow = Database['public']['Tables']['contact_events']['Row'];

interface Props {
  contactId: string;
}

const STAGE_LABEL: Record<CustomerStage, string> = {
  new: '新客户',
  qualifying: '资质确认',
  negotiating: '跟进中',
  stalled: '待跟进',
  quoted: '已报价',
  won: '成交',
  lost: '流失',
};

const ICON: Record<ContactEventType, string> = {
  created: '👤',
  stage_changed: '🎯',
  tag_added: '🏷',
  vehicle_added: '🚗',
  quote_created: '💵',
  task_created: '✅',
  ai_extracted: '🤖',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return '刚刚';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 周前`;
  return new Date(iso).toLocaleDateString();
}

function describe(ev: ContactEventRow): { title: string; detail?: string } {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.event_type) {
    case 'created':
      return {
        title: '客户档案创建',
        detail: typeof p.phone === 'string' ? p.phone : undefined,
      };
    case 'stage_changed': {
      const from = STAGE_LABEL[p.from as CustomerStage] ?? String(p.from ?? '');
      const to = STAGE_LABEL[p.to as CustomerStage] ?? String(p.to ?? '');
      const auto = p.automatic ? '（自动）' : '';
      return { title: `阶段 ${from} → ${to}${auto}` };
    }
    case 'tag_added': {
      const tag = String(p.tag ?? '');
      const source = p.source === 'ai' ? '（AI）' : '';
      return { title: `添加标签 "${tag}"${source}` };
    }
    case 'vehicle_added': {
      const model = String(p.model ?? '');
      const cond =
        p.condition === 'new'
          ? ' · 新车'
          : p.condition === 'used'
          ? ' · 二手'
          : '';
      const source = p.source === 'ai' ? '（AI）' : '';
      return { title: `关注车型 ${model}${cond}${source}` };
    }
    case 'quote_created': {
      const model = String(p.vehicle_model ?? '');
      const price = typeof p.price_usd === 'number' ? p.price_usd : Number(p.price_usd ?? 0);
      return {
        title: `发送报价 ${model}`,
        detail: `USD ${price.toLocaleString()}`,
      };
    }
    case 'task_created': {
      const title = String(p.title ?? '');
      const source = p.source === 'ai' ? '（AI）' : '';
      return { title: `新建任务 "${title}"${source}` };
    }
    case 'ai_extracted': {
      const fields = Array.isArray(p.applied_fields) ? p.applied_fields : [];
      const vehicles = typeof p.vehicles_added === 'number' ? p.vehicles_added : 0;
      const parts: string[] = [];
      if (fields.length) parts.push(`${fields.length} 个字段`);
      if (vehicles) parts.push(`${vehicles} 个车型`);
      return { title: `AI 抽取 ${parts.join('、') || '客户信息'}` };
    }
    default:
      return { title: ev.event_type };
  }
}

export function TimelineSection({ contactId }: Props) {
  const [events, setEvents] = useState<ContactEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from('contact_events')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) setError(stringifyError(error));
      else setEvents((data ?? []) as ContactEventRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-title">
        客户时间轴
        {events.length > 0 && (
          <span className="sgc-muted"> · {events.length} 条</span>
        )}
      </div>

      {loading && <span className="sgc-muted">加载中…</span>}
      {error && <div className="sgc-error">{error}</div>}

      {!loading && events.length === 0 && (
        <span className="sgc-muted">暂无事件记录</span>
      )}

      {events.length > 0 && (
        <div className="sgc-timeline">
          {events.map((ev) => {
            const { title, detail } = describe(ev);
            return (
              <div key={ev.id} className="sgc-timeline-row">
                <div className="sgc-timeline-icon">{ICON[ev.event_type] ?? '•'}</div>
                <div className="sgc-timeline-body">
                  <div className="sgc-timeline-title">{title}</div>
                  {detail && (
                    <div className="sgc-timeline-detail">{detail}</div>
                  )}
                  <div className="sgc-timeline-time">
                    {timeAgo(ev.created_at)} ·{' '}
                    {new Date(ev.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
