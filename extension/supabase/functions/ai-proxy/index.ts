// OpenAI-compatible AI proxy for the extension.
//
// Why this exists:
// Some sales machines intermittently fail to resolve open.bigmodel.cn. The
// extension first tries the AI provider directly; on network failure it calls
// this Edge Function with the user's Supabase JWT, and the function calls the
// provider from Supabase instead.
//
// Deploy:
//   supabase functions deploy ai-proxy
//
// Required secrets:
//   AI_API_KEY      (or legacy VITE_DASHSCOPE_API_KEY)
//   AI_BASE_URL     (or legacy VITE_AI_BASE_URL)
//   AI_MODEL        (or legacy VITE_AI_MODEL)
// Supabase injects:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const AI_API_KEY =
  Deno.env.get('AI_API_KEY') ?? Deno.env.get('VITE_DASHSCOPE_API_KEY') ?? '';
const AI_BASE_URL =
  Deno.env.get('AI_BASE_URL') ??
  Deno.env.get('VITE_AI_BASE_URL') ??
  'https://open.bigmodel.cn/api/paas/v4';
const AI_MODEL =
  Deno.env.get('AI_MODEL') ?? Deno.env.get('VITE_AI_MODEL') ?? 'glm-4-flash';
const AI_URL = `${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`;
const BIGMODEL_HOST = 'open.bigmodel.cn';
const BIGMODEL_IPV4_FALLBACKS = ['47.110.175.20'];

interface ProxyBody {
  model?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  response_format?: { type: 'json_object' };
  temperature?: number;
}

interface UpstreamResult {
  ok: boolean;
  status: number;
  text: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'POST only' }, 405);
  }
  if (!AI_API_KEY) {
    return jsonResponse({ ok: false, error: 'AI_API_KEY secret not configured' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ ok: false, error: 'Missing Authorization header' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ ok: false, error: 'Supabase env not configured' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData.user;
  if (userErr || !user) {
    return jsonResponse({ ok: false, error: 'Invalid user token' }, 401);
  }

  const { data: member, error: memberErr } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (memberErr || !member) {
    return jsonResponse({ ok: false, error: 'User is not an org member' }, 403);
  }

  let body: ProxyBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ ok: false, error: 'messages required' }, 400);
  }
  const totalChars = body.messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
  if (totalChars > 100_000) {
    return jsonResponse({ ok: false, error: 'Prompt too large' }, 413);
  }

  const upstreamBody = JSON.stringify({
    model: body.model || AI_MODEL,
    messages: body.messages,
    response_format: body.response_format,
    temperature: body.temperature ?? 0.1,
  });

  const upstream = await callUpstream(upstreamBody);

  if (!upstream.ok) {
    return jsonResponse({
      ok: false,
      error: `AI proxy ${upstream.status}: ${upstream.text.slice(0, 200)}`,
    });
  }

  let json: unknown = null;
  try {
    json = JSON.parse(upstream.text);
  } catch {
    return jsonResponse({ ok: false, error: 'AI proxy returned non-JSON response' });
  }
  const content = (json as {
    choices?: Array<{ message?: { content?: unknown } }>;
  })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return jsonResponse({ ok: false, error: 'AI proxy returned empty content' });
  }

  return jsonResponse({ ok: true, content: content.trim() });
});

async function callUpstream(body: string): Promise<UpstreamResult> {
  try {
    const resp = await fetch(AI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body,
    });
    return {
      ok: resp.ok,
      status: resp.status,
      text: await resp.text().catch(() => ''),
    };
  } catch (err) {
    const fetchError = String((err as Error)?.message ?? err);
    if (!AI_URL.startsWith(`https://${BIGMODEL_HOST}/`)) {
      return { ok: false, status: 0, text: `AI proxy network failed: ${fetchError}` };
    }
    return await callBigModelViaPinnedIpv4(body, fetchError);
  }
}

async function callBigModelViaPinnedIpv4(
  body: string,
  fetchError: string,
): Promise<UpstreamResult> {
  let lastError = fetchError;
  for (const ip of BIGMODEL_IPV4_FALLBACKS) {
    try {
      return await postHttpsByIp({
        ip,
        host: BIGMODEL_HOST,
        path: '/api/paas/v4/chat/completions',
        body,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AI_API_KEY}`,
        },
      });
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
    }
  }
  return {
    ok: false,
    status: 0,
    text: `AI proxy fetch failed: ${fetchError}; IPv4 fallback failed: ${lastError}`,
  };
}

async function postHttpsByIp(args: {
  ip: string;
  host: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}): Promise<UpstreamResult> {
  const conn = await Deno.connectTls({
    hostname: args.ip,
    port: 443,
    serverName: args.host,
  });
  try {
    const requestHeaders = [
      `POST ${args.path} HTTP/1.1`,
      `Host: ${args.host}`,
      'Connection: close',
      `Content-Length: ${new TextEncoder().encode(args.body).length}`,
      ...Object.entries(args.headers).map(([k, v]) => `${k}: ${v}`),
      '',
      args.body,
    ].join('\r\n');
    await conn.write(new TextEncoder().encode(requestHeaders));

    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(16 * 1024);
    for (;;) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return parseHttpResponse(new TextDecoder().decode(merged));
  } finally {
    try {
      conn.close();
    } catch {
      // ignore close errors
    }
  }
}

function parseHttpResponse(raw: string): UpstreamResult {
  const splitAt = raw.indexOf('\r\n\r\n');
  if (splitAt < 0) {
    return { ok: false, status: 0, text: 'Malformed upstream response' };
  }
  const head = raw.slice(0, splitAt);
  let body = raw.slice(splitAt + 4);
  const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
  const transferEncoding = head.match(/^transfer-encoding:\s*(.+)$/im)?.[1]?.toLowerCase();
  if (transferEncoding?.includes('chunked')) {
    body = decodeChunkedBody(body);
  }
  return { ok: status >= 200 && status < 300, status, text: body };
}

function decodeChunkedBody(body: string): string {
  let pos = 0;
  let out = '';
  for (;;) {
    const lineEnd = body.indexOf('\r\n', pos);
    if (lineEnd < 0) return out || body;
    const sizeHex = body.slice(pos, lineEnd).split(';')[0].trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size)) return out || body;
    pos = lineEnd + 2;
    if (size === 0) return out;
    out += body.slice(pos, pos + size);
    pos += size + 2;
  }
}
