/**
 * 广告线索横幅 —— 给「填了 Facebook 表单但从没在 WhatsApp 说过话」的客户用。
 *
 * 为什么需要（2026-08-20 实测）：8 个即时表单的感谢页都配了「Chat on WhatsApp」
 * 按钮，但只有 42% 的客户会点。剩下 58% 填完表就走了——他们的姓名、电话、
 * 要几台、多久买全在 Meta 手里，你们这边一条消息都没有。
 * 回填之后这批人进了 CRM，但客户卡上什么都看不到：没有聊天记录、没有那条
 * 含表单内容的预填消息，销售打开卡片只看到一个陌生号码。
 *
 * 这个横幅把表单作答摆到卡上，并解决两件事：
 *   1. 没有现成会话 → 「发起首次联系」走 deep link 开一个新会话 + 填好草稿
 *      （只有真发出消息才会产生持久聊天框，deep link 打开的是临时的）
 *   2. 没有主理人 → 「我来跟」写 contact_handlers，谁点归谁
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { jumpToChat } from '@/lib/jump-to-chat';
import { fillWhatsAppCompose } from '@/content/whatsapp-compose';
import { bumpHandler } from '@/lib/contact-handlers';
import { stringifyError } from '@/lib/errors';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

interface Props {
  contact: ContactRow;
}

interface LeadInfo {
  at: string | null;
  formName: string;
  fields: Record<string, string>;
}

/**
 * 表单字段名 / 取值 → 中文。
 * 2026-08-21 把全库 489 条线索的字段和取值扫了一遍，这里覆盖了全部变体。
 * 注意波兰表单用波兰语选项（sztuka / sztuk / więcej），别只按英文写。
 */
const FIELD_CN: Record<string, string> = {
  full_name: '姓名',
  email: '邮箱',
  phone_number: '电话',
  phone: '电话',
  'how_many_vehicles_do_you_need?': '要几台',
  'how_many_cars_in_the_first_order?': '首单几台',
  'when_are_you_planning_to_purchase?': '打算多久买',
  'purchase_timeline?': '打算多久买',
  'song_plus_purchase_timeline?': '打算多久买',
  'who_are_you?': '身份',
};
/** how_will_you_use_the_nammi01? / _the_byd_qin_plus_dm-i_? / _the_vehicle? 都是「用途」 */
function fieldLabel(name: string): string {
  if (FIELD_CN[name]) return FIELD_CN[name];
  if (/^how_will_you_use/i.test(name)) return '用途';
  return name;
}

const VALUE_CN: Record<string, string> = {
  // 台数
  '1_vehicle': '1 台',
  '2–5_vehicles': '2-5 台',
  '6–10_vehicles': '6-10 台',
  more_than_10_vehicles: '10 台以上',
  '1_sztuka': '1 台',
  '2–5_sztuk': '2-5 台',
  '6_i_więcej': '6 台以上',
  regular_supply: '长期供货',
  // 时间
  within_30_days: '30 天内',
  'within_1–3_months': '1-3 个月',
  'within_3–6_months': '3-6 个月',
  within_3_months: '3 个月内',
  this_month: '本月',
  later: '以后再说',
  just_comparing_prices: '只是比价',
  // 用途
  personal_use: '个人使用',
  'taxi_or_ride-hailing': '出租车 / 网约车',
  vehicle_resale: '转售',
  company_or_fleet: '公司 / 车队',
  for_my_own_business_fleet: '自用车队',
  to_resell_to_customers: '转售给客户',
  for_personal_use: '个人使用',
  // 身份
  private_buyer_: '个人买家',
  car_dealer: '车商',
  'importer_/_broker': '进口商 / 中间商',
  'used-car_lot_/_trader': '二手车商',
};
const cn = (v: string) => VALUE_CN[v] ?? v;

/** 展示顺序：销售最先想看的排前面，邮箱这种放最后 */
const FIELD_ORDER = ['用途', '要几台', '首单几台', '打算多久买', '身份', '邮箱'];

function carOf(formName: string): string {
  const f = formName.toUpperCase();
  if (f.includes('NAMMI')) return 'Nammi 01';
  if (f.includes('QINPLUS')) return 'BYD Qin Plus DM-i';
  if (f.includes('SONGPLUS')) return 'BYD Song Plus';
  return '';
}

/**
 * 起草第一条消息。
 * 故意只填进输入框不自动发——这批客户当初**没有**选择 WhatsApp 这个渠道
 * （感谢页按钮没点），语气要客气，且必须有人过目。
 */
function draftFirstMessage(contact: ContactRow, info: LeadInfo): string {
  const name = (contact.name || '').split(/\s+/)[0] || '';
  const car = carOf(info.formName);
  const qty = info.fields['how_many_vehicles_do_you_need?'];
  const when = info.fields['when_are_you_planning_to_purchase?'];
  const bits: string[] = [];
  if (qty) bits.push(qty.replace(/_/g, ' ').replace('–', '-'));
  if (when) bits.push(when.replace(/_/g, ' ').replace('–', '-'));
  return [
    `Hi${name ? ' ' + name : ''}, this is Miles from Sino Gear.`,
    car
      ? `You filled in our form on Facebook about the ${car}${bits.length ? ` (${bits.join(', ')})` : ''}.`
      : `You filled in our enquiry form on Facebook.`,
    `Happy to send you the full spec and a CIF price to your port — which port should I quote to?`,
  ].join('\n\n');
}

export function AdLeadBanner({ contact }: Props) {
  const [info, setInfo] = useState<LeadInfo | null>(null);
  const [msgCount, setMsgCount] = useState<number | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setMsgCount(null);
    setClaimed(false);
    setError(null);
    if (!contact.fb_lead_id) return;
    void (async () => {
      const [ev, sig] = await Promise.all([
        supabase
          .from('contact_events')
          .select('payload, created_at')
          .eq('contact_id', contact.id)
          .eq('event_type', 'fb_lead_received')
          .order('created_at', { ascending: false })
          .limit(1),
        supabase
          .from('contact_sales_signals')
          .select('message_count')
          .eq('contact_id', contact.id)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setMsgCount(sig.data?.message_count ?? 0);
      const p = ev.data?.[0]?.payload as Record<string, unknown> | undefined;
      if (!p) return;
      const fields: Record<string, string> = {};
      for (const f of (p.field_data as { name: string; values: string[] }[]) ?? []) {
        if (f?.name) fields[f.name] = (f.values ?? []).join(', ');
      }
      setInfo({
        at: typeof p.created_time === 'string' ? p.created_time : null,
        formName: typeof p.form_name === 'string' ? p.form_name : '',
        fields,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [contact.id, contact.fb_lead_id]);

  if (!contact.fb_lead_id || !info) return null;

  const untouched = msgCount === 0;

  const startChat = async () => {
    setBusy('打开聊天…');
    setError(null);
    try {
      if (!contact.phone) throw new Error('这个客户没有手机号');
      // allowDeepLink：搜不到就走 /send?phone= 让 WA 重载进 chat。
      // 这批人本来就没有会话，搜索框一定搜不到，deep link 是唯一入口。
      const ok = await jumpToChat(contact.phone, { allowDeepLink: true });
      if (!ok) throw new Error('打不开聊天，可能是号码没注册 WhatsApp');
      setBusy('填入草稿…');
      const filled = fillWhatsAppCompose(draftFirstMessage(contact, info));
      if (!filled) throw new Error('填不进输入框，请手动输入');
      // 已经开了会话就算接手了
      void bumpHandler(contact.id);
      setClaimed(true);
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    setBusy('认领中…');
    try {
      await bumpHandler(contact.id);
      setClaimed(true);
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusy(null);
    }
  };

  const shown = Object.entries(info.fields)
    .filter(([k]) => !['full_name', 'phone_number', 'phone'].includes(k))
    .map(([k, v]) => [fieldLabel(k), v] as const)
    .sort((a, b) => {
      const ia = FIELD_ORDER.indexOf(a[0]);
      const ib = FIELD_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const car = carOf(info.formName);

  return (
    <div
      className={`sgc-sales-signal ${untouched ? 'sgc-sales-signal-warning' : 'sgc-sales-signal-info'}`}
    >
      <strong>
        📣 广告线索{untouched ? ' · 还没人联系过' : ''}
        {car ? ` · ${car}` : ''}
      </strong>
      <span style={{ fontSize: 12 }}>
        {info.at ? `${info.at.slice(0, 10)} 填表` : ''}
        {info.formName ? ` · ${info.formName}` : ''}
        {untouched ? ' · 他没点「Chat on WhatsApp」，所以没有聊天记录' : ''}
      </span>

      <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
        {shown.map(([k, v]) => (
          <div key={k} style={{ fontSize: 12 }}>
            <span style={{ opacity: 0.7 }}>{k}：</span>
            <strong style={{ fontSize: 12 }}>{cn(v)}</strong>
          </div>
        ))}
      </div>

      {error && (
        <span style={{ fontSize: 11, color: '#b91c1c', wordBreak: 'break-word' }}>
          ⚠️ {error}
        </span>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {untouched && (
          <button
            type="button"
            className="sgc-btn-primary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            disabled={!!busy}
            onClick={() => void startChat()}
          >
            {busy ?? '💬 发起首次联系'}
          </button>
        )}
        <button
          type="button"
          className="sgc-btn-secondary"
          style={{ fontSize: 12, padding: '4px 10px' }}
          disabled={!!busy || claimed}
          onClick={() => void claim()}
        >
          {claimed ? '✅ 已接手' : '👤 我来跟'}
        </button>
      </div>
    </div>
  );
}
