/** Public read-only MCP queries. No booking, subscriptions, credentials or payments. */
export const FREIGHT_ENDPOINT = 'https://search.shaq-logistics.com/mcp';
export interface FreightRequest {
  origin: string; destination: string; container: '20GP' | '40GP' | '40HC';
  vehicle: string; propulsion: 'fuel' | 'bev' | 'phev' | 'unknown'; quantity: number;
  readyDate?: string;
}
export interface FreightLookup {
  schema: 'freight-lookup.v1'; checkedAt: string; request: FreightRequest;
  source: string; status: 'reference' | 'no_results' | 'unavailable';
  raw: string; vehicleAcceptance: 'unconfirmed'; validUntil: null;
  costScope: 'unconfirmed'; bindingQuote: false;
}
function rpcBody(text: string): Record<string, any> {
  if (!text.trim()) return {};
  if (text.trim().startsWith('{')) return JSON.parse(text);
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (data) { const parsed = JSON.parse(data); if (parsed.result || parsed.error) return parsed; }
  }
  throw new Error('运价服务返回格式无法识别');
}
export async function queryFreight(request: FreightRequest, fetcher: typeof fetch = fetch): Promise<FreightLookup> {
  if (![request.origin, request.destination, request.vehicle].every(v => typeof v === 'string' && v.trim() && v.length <= 200)
    || !['20GP', '40GP', '40HC'].includes(request.container)
    || !['fuel', 'bev', 'phev', 'unknown'].includes(request.propulsion)
    || !Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 100
    || (request.readyDate && !/^\d{4}-\d{2}-\d{2}$/.test(request.readyDate))) {
    throw new Error('请填写起运港、目的港、车辆、动力及有效数量；柜型是查询条件，不代表已确认装得下。');
  }
  const result: FreightLookup = { schema: 'freight-lookup.v1', checkedAt: new Date().toISOString(), request,
    source: FREIGHT_ENDPOINT, status: 'unavailable', raw: '', vehicleAcceptance: 'unconfirmed',
    validUntil: null, costScope: 'unconfirmed', bindingQuote: false };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  let id = 0;
  const rpc = async (method: string, params?: Record<string, unknown>, notification = false) => {
    const response = await fetcher(FREIGHT_ENDPOINT, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++id } : {}), method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`运价服务 HTTP ${response.status}；未订舱、未付费。`);
    const sid = response.headers.get('Mcp-Session-Id'); if (sid) headers['Mcp-Session-Id'] = sid;
    const text = await response.text();
    if (text.length > 250000) throw new Error('运价结果过大，未截断后用于报价');
    const body = rpcBody(text);
    if (body.error) throw new Error('运价服务返回查询错误');
    return body.result;
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'SinoGear-readonly', version: '1' } });
    headers['MCP-Protocol-Version'] = '2025-03-26';
    await rpc('notifications/initialized', undefined, true);
    const list = await rpc('tools/list');
    if (!list?.tools?.some((t: any) => t.name === 'search_freight_rates' && t.annotations?.readOnlyHint === true)) {
      throw new Error('未发现已确认的只读运价查询工具');
    }
    const data = await rpc('tools/call', { name: 'search_freight_rates', arguments: {
      origin: request.origin.trim(), destination: request.destination.trim(), container_type: request.container,
    } });
    if (data?.isError) throw new Error('运价查询失败，未取得可用结果');
    const raw = data?.structuredContent?.result ?? data?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('运价服务没有返回结果正文');
    result.raw = raw;
    result.status = /no rates found/i.test(raw) ? 'no_results' : 'reference';
  } catch (error) { result.raw = error instanceof Error ? error.message : '运价服务不可用'; }
  return result;
}
