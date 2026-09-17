import type { CrmContact } from '@/panel/hooks/useCrmData';

export const LEAD_HANDLED_TAG = '未联系线索：已处理';
export const LEAD_NO_WHATSAPP_TAG = '未联系线索：无 WhatsApp';
export const MESSAGES_SYNCED_EVENT = 'sgc:messages-synced';

export function hasMessageEvidence(activity: {
  inboundCount: number; outboundCount: number;
  lastInboundT: number | null; lastOutboundT: number | null;
} | undefined): boolean {
  return !!activity && (activity.inboundCount > 0 || activity.outboundCount > 0
    || !!activity.lastInboundT || !!activity.lastOutboundT);
}

/** 本机没匹配到会话不等于从未联系；姓名（包括 @ / 邮箱）不参与判定。 */
export function isUncontactedAdLead(c: CrmContact): boolean {
  return c.isAdLead
    && !c.chat
    && !c.hasMessageHistory
    && !c.lastOutboundT
    && c.contact?.customer_stage === 'new'
    && c.contact.quality !== 'spam'
    && !c.tags.includes(LEAD_HANDLED_TAG)
    && !c.tags.includes(LEAD_NO_WHATSAPP_TAG);
}
