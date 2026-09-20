export interface HistoricalGuidance { id: string; payload: Record<string, unknown> }

/** A phone alone may be a consignee or forwarder. Require an explicit customer
 * introduction; carry that identity through its source conversation until an
 * explicit introduction of the current customer. Import timestamps are irrelevant. */
export function partitionHistoricalGuidance(rows: HistoricalGuidance[], currentPhone?: string | null) {
  const phone = currentPhone?.replace(/\D/g, '') ?? '';
  const accepted: HistoricalGuidance[] = [];
  const quarantined: (HistoricalGuidance & { reason: string })[] = [];
  const identities = new Map<string, string>();
  for (const row of [...rows].sort((a, b) => String(a.payload.sourceAt ?? '').localeCompare(String(b.payload.sourceAt ?? '')) || a.id.localeCompare(b.id))) {
    const text = String(row.payload.text ?? '');
    const thread = String(row.payload.sourceThread ?? row.payload.sourceChatUrl ?? row.id);
    const intro = text.match(/(?:我有(?:一)?[个位]?[^。\n]{0,30}客户|(?:这个|这位|当前|现在的)客户|(?:my|this|another)\s+(?:customer|client))[\s\S]{0,650}?(?:电话|手机|号码|phone|tel)\s*[:：]?\s*(\+\d[\d ()-]{7,22}\d)/i);
    if (phone.length >= 8 && intro && !/收货人|货代|司机|供应商|consignee|forwarder|supplier/i.test(intro[0])) identities.set(thread, intro[1].replace(/\D/g, ''));
    const declared = identities.get(thread);
    if (phone.length >= 8 && declared && declared !== phone) {
      quarantined.push({ ...row, reason: `原对话明确介绍另一客户（号码尾号 ${declared.slice(-4)}）；本条及该身份下的后续指导暂不用于当前客户。` });
    } else accepted.push(row);
  }
  return { accepted, quarantined };
}
