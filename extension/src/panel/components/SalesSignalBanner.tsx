import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';

type ContactRow = Database['public']['Tables']['contacts']['Row'];
type SalesSignalRow =
  Database['public']['Tables']['contact_sales_signals']['Row'];

interface Props {
  contact: ContactRow;
}

interface BannerState {
  tone: 'danger' | 'warning' | 'info' | 'success';
  title: string;
  detail: string;
}

function buildBanner(
  contact: ContactRow,
  signal: SalesSignalRow | null,
): BannerState | null {
  const messageCount = signal?.message_count ?? 0;
  const coverage = `CRM 已同步 ${messageCount} 条消息`;

  // 成交客户不在这里出横幅：是否真收到水单由 PaymentReceiptSection 判定
  // （读 contact_events 的 payment_received 人工凭证）。
  // ⚠️ 曾经这里读 signal.payment_received_at 判「有没有付款证据」——那列的正则
  // 没分方向也没排除否定句，全库只命中 5 条且全是我方发的
  // "we still have not received the payment"，等于把没付款的判成付了。
  // 这一列在成交判定上一律不再采信。
  if (contact.customer_stage === 'won') return null;

  if (contact.customer_stage === 'quoted' && !signal?.quote_signal_at) {
    return {
      tone: 'warning',
      title: '已报价状态缺少聊天证据',
      detail: `已同步消息中未识别到 USD/CIF/FOB 正式价格，且报价表可能未填写。请补录报价或检查聊天同步。${coverage}。`,
    };
  }

  if (signal?.payment_pending_at) {
    return {
      tone: 'warning',
      title: '客户进入付款/银行环节',
      detail: `聊天里出现了银行/转账字样。记下承诺付款日期，收到水单后点「✅ 已收水单」再算成交。${coverage}。`,
    };
  }

  if (
    signal?.accepted_signal_at &&
    !['quoted', 'won'].includes(contact.customer_stage)
  ) {
    return {
      tone: 'info',
      title: '客户已表达继续意向',
      detail: `建议立即补齐 PI、配置、CIF 包含项和定金截止时间。${coverage}。`,
    };
  }

  if (
    signal?.quote_signal_at &&
    !['quoted', 'won'].includes(contact.customer_stage)
  ) {
    return {
      tone: 'info',
      title: '聊天中已出现正式价格',
      detail: `建议核对价格、车型、目的港和有效期，并把正式报价补录到 CRM。${coverage}。`,
    };
  }

  return null;
}

export function SalesSignalBanner({ contact }: Props) {
  const [banner, setBanner] = useState<BannerState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('contact_sales_signals')
        .select('*')
        .eq('contact_id', contact.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.warn('[SalesSignalBanner]', error.message);
        setBanner(null);
        return;
      }
      setBanner(buildBanner(contact, data));
    })();
    return () => {
      cancelled = true;
    };
  }, [contact.id, contact.customer_stage]);

  if (!banner) return null;

  return (
    <div className={`sgc-sales-signal sgc-sales-signal-${banner.tone}`}>
      <strong>{banner.title}</strong>
      <span>{banner.detail}</span>
    </div>
  );
}
