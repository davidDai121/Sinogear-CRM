// CRM 运费估算的扩展侧入口（2026-09-25）：调 Edge Function freight-rate-lookup（action=estimate），
// 带上客户国家，拿回「对客运费（成本 + 按客户国家分档加价）+ 每台保险 + 柜数」。
// 用业务员自己的登录 JWT 调，函数里校验 org 成员；物流巴巴密钥只在服务器端。
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CrmFreightResolver } from './quote-workflow';

interface EstimateResponse {
  ok: boolean; reason?: string; error?: string;
  total_usd?: number; containers?: { container: string; count: number }[];
  route?: { dest_code: string; dest_name: string | null; dest_country: string };
  rates_fetched_at?: string;
  pricing?: { customer_freight_total: number; insurance_total: number; valid_until: string | null };
}

async function readError(error: unknown): Promise<string> {
  const ctx = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (ctx?.json) {
    try {
      const body = await ctx.json() as EstimateResponse;
      if (body?.reason || body?.error) return String(body.reason ?? body.error);
    } catch { /* 读不到响应体就用下面的通用信息 */ }
  }
  return error instanceof Error ? error.message : String(error);
}

export function makeCrmFreightResolver(client: SupabaseClient, orgId: string, customerCountry: string | null | undefined): CrmFreightResolver {
  return async ({ port, country, quantity, propulsion }) => {
    const { data, error } = await client.functions.invoke('freight-rate-lookup', {
      body: { action: 'estimate', org_id: orgId, dest: port, dest_country: country ?? undefined, quantity, propulsion,
        customer_country: customerCountry || undefined },
    });
    if (error) throw new Error(await readError(error));
    const r = data as EstimateResponse;
    if (!r?.ok || !r.pricing || !r.route || !r.containers?.length) throw new Error(r?.reason ?? r?.error ?? '运费估算没有返回结果');
    return {
      customerFreightTotalUsd: r.pricing.customer_freight_total,
      insuranceTotalUsd: r.pricing.insurance_total,
      containers: r.containers.reduce((s, c) => s + c.count, 0),
      checkedAt: r.rates_fetched_at ?? new Date().toISOString(),
      validUntil: r.pricing.valid_until,
      // 给计算记录用的来源，不写成本和加价（这段文本可能被带回给模型）
      source: `CRM 运费估算 ${r.route.dest_name ?? r.route.dest_code}（${r.route.dest_code}），平台价 ${(r.rates_fetched_at ?? '').slice(0, 10)}，Data from Awice Logistics`,
      raw: r,
    };
  };
}
