import {
  buildPrompt,
  buildTagPrompt,
  buildTaskPrompt,
  validateSuggestions,
  validateTags,
  validateTasks,
  validateVehicles,
} from '@/lib/field-suggestions';
import type {
  ExtractFieldsRequest,
  ExtractTagsRequest,
  ExtractTasksRequest,
} from '@/lib/field-suggestions';
import {
  buildStagePrompt,
  validateInference,
} from '@/lib/stage-inference';
import type { InferStageRequest } from '@/lib/stage-inference';
import { runGem, isBusy as isGemBusy } from '@/lib/gem-automation';
import { runClaude, isBusy as isClaudeBusy } from '@/lib/claude-automation';
import { runGpt, isBusy as isGptBusy } from '@/lib/gpt-automation';
import { alarmKey, parseAlarmKey } from '@/lib/auto-reply-state';
import { supabase } from '@/lib/supabase';

const AI_BASE_URL =
  import.meta.env.VITE_AI_BASE_URL ??
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const AI_MODEL = import.meta.env.VITE_AI_MODEL ?? 'qwen-turbo-latest';
const AI_URL = `${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`;

/**
 * MAIN-world fiber bridge（2026-07-28）：content script 在 isolated world，
 * 看不到页面 React 挂在 DOM 元素上的 __reactFiber$ expando（fiber 路径
 * 因此从未在生产真正生效过，一直靠 IDB name cache 兜着）。这个函数被
 * chrome.scripting.executeScript({world:'MAIN'}) 注入页面主世界执行：
 * 轮询 #main fiber 抽当前 chat 模型，把 {rawJid, phoneJid, title,
 * verifiedName} 写到 <html data-sgc-fiber-chat>——DOM 属性跨 world 共享，
 * isolated 侧 readCurrentChat 同步读。@lid 业务号（如 Sima）的真实手机号
 * 只存在于 fiber contact.phoneNumber，IDB 完全没有，这是唯一来源。
 * 注意：函数会被序列化注入，不能引用外部作用域。
 */
function fiberBridgeMainWorld(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__sgcFiberBridgeActive) return;
  w.__sgcFiberBridgeActive = true;

  const pick = (o: unknown, k: string): unknown => {
    if (!o || typeof o !== 'object') return null;
    const rec = o as Record<string, unknown>;
    return rec[k] ?? rec['__x_' + k] ?? null;
  };
  const ser = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const s = (v as Record<string, unknown>)._serialized;
      if (typeof s === 'string') return s;
    }
    return null;
  };
  const PROP_NAMES = ['chat', 'model', 'conversation', 'chatModel', 'peer', 'wid'];
  const extract = (mp: unknown): unknown => {
    if (!mp || typeof mp !== 'object') return null;
    for (const n of PROP_NAMES) {
      const c = (mp as Record<string, unknown>)[n];
      if (c && typeof c === 'object' && ser(pick(c, 'id'))) return c;
    }
    return null;
  };

  const read = (): void => {
    let payload: Record<string, string | null> | null = null;
    try {
      const main = document.querySelector('div#main');
      if (main) {
        const key = Object.getOwnPropertyNames(main).find(
          (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
        );
        let cur: unknown = key ? (main as unknown as Record<string, unknown>)[key] : null;
        let chat: unknown = null;
        for (let i = 0; cur && i < 30 && !chat; i++) {
          const fiber = cur as Record<string, unknown>;
          chat =
            extract(fiber.memoizedProps) ??
            extract(pick(fiber.stateNode, 'props'));
          if (!chat) cur = fiber.return;
        }
        if (chat) {
          const id = ser(pick(chat, 'id'));
          const contact = pick(chat, 'contact');
          let phoneJid: string | null = null;
          const cands = [
            pick(contact, 'phoneNumber'),
            pick(contact, 'id'),
            pick(contact, 'userid'),
            pick(contact, 'jid'),
          ];
          for (const c of cands) {
            const s = ser(c);
            if (s && s.endsWith('@c.us')) { phoneJid = s; break; }
          }
          if (!phoneJid && typeof chat === 'object') {
            for (const v of Object.values(chat as Record<string, unknown>)) {
              const s = ser(v);
              if (s && s.endsWith('@c.us')) { phoneJid = s; break; }
            }
          }
          const title = pick(chat, 'formattedTitle');
          const verified = pick(contact, 'verifiedName');
          if (id) {
            payload = {
              rawJid: id,
              phoneJid,
              title: typeof title === 'string' ? title : null,
              verifiedName: typeof verified === 'string' ? verified : null,
            };
          }
        }
      }
    } catch {
      // fiber 结构漂移时静默降级——isolated 侧自然回落到 IDB cache 路径
    }
    const v = payload ? JSON.stringify(payload) : '';
    const root = document.documentElement;
    if ((root.getAttribute('data-sgc-fiber-chat') ?? '') !== v) {
      root.setAttribute('data-sgc-fiber-chat', v);
    }
  };

  setInterval(read, 800);
  // 切聊天由点击触发——click 后短延迟补读两次，缩小轮询空窗
  document.addEventListener(
    'click',
    () => { setTimeout(read, 250); setTimeout(read, 900); },
    true,
  );
  read();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  if (msg?.type === 'INJECT_FIBER_BRIDGE') {
    const tabId = _sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'no sender tab' });
      return false;
    }
    chrome.scripting
      .executeScript({ target: { tabId }, world: 'MAIN', func: fiberBridgeMainWorld })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === 'GET_GOOGLE_TOKEN') {
    const interactive = msg.interactive ?? true;
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      const t =
        typeof token === 'string'
          ? token
          : (token as { token?: string } | undefined)?.token;
      if (!t) {
        sendResponse({ error: '未获取到 Google 授权令牌' });
        return;
      }
      sendResponse({ token: t });
    });
    return true;
  }

  if (msg?.type === 'CLEAR_GOOGLE_TOKEN') {
    chrome.identity.removeCachedAuthToken({ token: msg.token }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === 'EXTRACT_FIELDS') {
    handleExtractFields(msg as ExtractFieldsRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'EXTRACT_TAGS') {
    handleExtractTags(msg as ExtractTagsRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'EXTRACT_TASKS') {
    handleExtractTasks(msg as ExtractTasksRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'INFER_STAGE') {
    handleInferStage(msg as InferStageRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'TRANSLATE_TEXT') {
    handleTranslate(msg as { text: string; targetLang?: string })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'GEM_RUN') {
    handleGemRun(msg as GemRunRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'GEM_BUSY') {
    sendResponse({ ok: true, busy: isGemBusy() });
    return false;
  }

  if (msg?.type === 'CLAUDE_RUN') {
    handleClaudeRun(msg as ClaudeRunRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'CLAUDE_BUSY') {
    sendResponse({ ok: true, busy: isClaudeBusy() });
    return false;
  }

  if (msg?.type === 'GPT_RUN') {
    handleGptRun(msg as GptRunRequest)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg?.type === 'GPT_BUSY') {
    sendResponse({ ok: true, busy: isGptBusy() });
    return false;
  }

  if (msg?.type === 'BULK_CAPTURE_ARM') {
    const tabId = _sender.tab?.id;
    if (typeof tabId === 'number') {
      bulkArmed = { tabId, armedAt: Date.now() };
      // 兜底：60s 没收到 disarm 就自动关掉，避免长期挂起
      setTimeout(() => {
        if (bulkArmed && Date.now() - bulkArmed.armedAt >= 59000) {
          bulkArmed = null;
        }
      }, 60000);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: '无 tab' });
    }
    return false;
  }

  if (msg?.type === 'BULK_CAPTURE_DISARM') {
    bulkArmed = null;
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'SCHEDULE_AUTO_REPLY') {
    handleScheduleAutoReply(msg as ScheduleAutoReplyRequest)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
    return true;
  }

  if (msg?.type === 'CANCEL_AUTO_REPLY') {
    handleCancelAutoReply(msg as CancelAutoReplyRequest)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
    return true;
  }

  if (msg?.type === 'CLEAR_ALL_AUTO_REPLY') {
    handleClearAllAutoReply()
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
    return true;
  }

  return false;
});

// ── 自动回复闹钟 ──
// React 排队时调 SCHEDULE_AUTO_REPLY；SW 注册 chrome.alarm（SW 休眠也能唤醒），
// 到点找 web.whatsapp.com 标签页发 AUTO_REPLY_FIRE。content/auto-reply.ts 接管。

interface ScheduleAutoReplyRequest {
  type: 'SCHEDULE_AUTO_REPLY';
  contactId: string;
  /** ms epoch — 到点时刻；过去时间立即触发 */
  fireAt: number;
}

interface CancelAutoReplyRequest {
  type: 'CANCEL_AUTO_REPLY';
  contactId: string;
}

async function handleScheduleAutoReply(req: ScheduleAutoReplyRequest) {
  if (!req.contactId) return { ok: false, error: '缺少 contactId' };
  if (!req.fireAt) return { ok: false, error: '缺少 fireAt' };
  const name = alarmKey(req.contactId);
  // chrome.alarms.create when 必须 ≥ now+1s；过期就给 now+1s 立即触发
  const when = Math.max(req.fireAt, Date.now() + 1000);
  await chrome.alarms.create(name, { when });
  return { ok: true, scheduledAt: when };
}

async function handleCancelAutoReply(req: CancelAutoReplyRequest) {
  if (!req.contactId) return { ok: false, error: '缺少 contactId' };
  await chrome.alarms.clear(alarmKey(req.contactId));
  return { ok: true };
}

async function handleClearAllAutoReply() {
  const all = await chrome.alarms.getAll();
  let cleared = 0;
  for (const a of all) {
    if (parseAlarmKey(a.name)) {
      await chrome.alarms.clear(a.name);
      cleared++;
    }
  }
  return { ok: true, cleared };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const contactId = parseAlarmKey(alarm.name);
  if (!contactId) return;
  void fireAutoReply(contactId);
});

async function fireAutoReply(contactId: string): Promise<void> {
  // 找当前打开的 WA Web 标签页，把执行权交给 content script
  const tabs = await chrome.tabs.query({
    url: ['https://web.whatsapp.com/*', 'https://*.whatsapp.com/*'],
  });
  // 优先选 active 的；都不 active 取第一个
  const activeFirst = tabs.find((t) => t.active) ?? tabs[0];
  if (!activeFirst?.id) {
    console.warn(
      '[sgc/sw] auto-reply 触发但没找到 WhatsApp Web 标签页 — 用户可能关了',
      contactId,
    );
    return;
  }
  try {
    await chrome.tabs.sendMessage(activeFirst.id, {
      type: 'AUTO_REPLY_FIRE',
      contactId,
    });
  } catch (err) {
    console.warn('[sgc/sw] AUTO_REPLY_FIRE 投递失败', contactId, err);
  }
}

// ---- 媒体批量抓取：拦截 WA 触发的 chrome.downloads ----
// 用户点扩展的"📥 加入车源"工具栏按钮 →
//   content script 调 BULK_CAPTURE_ARM → 模拟点 WA 原生"下载"按钮 →
//   每个下载触发 onCreated → SW 立刻取消 + 把 url/filename/mime 发回 content →
//   content fetch(url) 拿 blob → 按 mime 分到 image/video/spec → 进 tray
// 完成后 content 调 BULK_CAPTURE_DISARM 关闭拦截。
let bulkArmed: { tabId: number; armedAt: number } | null = null;

if (chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    if (!bulkArmed) return;
    if (Date.now() - bulkArmed.armedAt > 60000) {
      bulkArmed = null;
      return;
    }
    const { tabId } = bulkArmed;

    const url = item.url || item.finalUrl || '';
    const filename = (item.filename || '').split(/[\\/]/).pop() || '';
    const mime = item.mime || '';

    // 立刻取消，避免真的写到磁盘
    void chrome.downloads
      .cancel(item.id)
      .catch(() => undefined)
      .then(() => chrome.downloads.erase({ id: item.id }).catch(() => undefined));

    void chrome.tabs
      .sendMessage(tabId, {
        type: 'BULK_CAPTURE_DOWNLOAD',
        url,
        filename,
        mime,
      })
      .catch(() => undefined);
  });
}

interface GemRunRequest {
  type: 'GEM_RUN';
  url: string;
  prompt: string;
  active?: boolean;
  responseTimeoutMs?: number;
  preferModel?: string[];
  avoidModel?: string[];
}

async function handleGemRun(req: GemRunRequest) {
  if (!req.url) return { ok: false, error: '缺少 Gem URL' };
  if (!req.prompt) return { ok: false, error: '缺少 prompt' };
  try {
    const result = await runGem({
      url: req.url,
      prompt: req.prompt,
      active: req.active,
      responseTimeoutMs: req.responseTimeoutMs,
      preferModel: req.preferModel,
      avoidModel: req.avoidModel,
    });
    return {
      ok: true,
      responseText: result.responseText,
      chatUrl: result.chatUrl,
      modelSelected: result.modelSelected,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

interface ClaudeRunRequest {
  type: 'CLAUDE_RUN';
  url: string;
  prompt: string;
  active?: boolean;
  responseTimeoutMs?: number;
}

async function handleClaudeRun(req: ClaudeRunRequest) {
  if (!req.url) return { ok: false, error: '缺少 Claude URL' };
  if (!req.prompt) return { ok: false, error: '缺少 prompt' };
  try {
    const result = await runClaude({
      url: req.url,
      prompt: req.prompt,
      active: req.active,
      responseTimeoutMs: req.responseTimeoutMs,
    });
    return {
      ok: true,
      responseText: result.responseText,
      chatUrl: result.chatUrl,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

interface GptRunRequest {
  type: 'GPT_RUN';
  url: string;
  prompt: string;
  active?: boolean;
  responseTimeoutMs?: number;
  ensureThinking?: boolean;
}

async function handleGptRun(req: GptRunRequest) {
  if (!req.url) return { ok: false, error: '缺少 ChatGPT URL' };
  if (!req.prompt) return { ok: false, error: '缺少 prompt' };
  try {
    const result = await runGpt({
      url: req.url,
      prompt: req.prompt,
      active: req.active,
      responseTimeoutMs: req.responseTimeoutMs,
      ensureThinking: req.ensureThinking,
    });
    return {
      ok: true,
      responseText: result.responseText,
      chatUrl: result.chatUrl,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

async function callQwen(prompt: string): Promise<{ ok: true; parsed: unknown } | { ok: false; error: string }> {
  const apiKey = import.meta.env.VITE_DASHSCOPE_API_KEY;
  if (!apiKey) return { ok: false, error: '未配置 VITE_DASHSCOPE_API_KEY' };

  const requestBody = {
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  };
  const body = JSON.stringify(requestBody);

  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const proxied = await callAiProxy(requestBody);
      if (!proxied.ok) {
        return {
          ok: false,
          error: `AI 直连失败：${message}；代理也失败：${proxied.error}`,
        };
      }
      return parseJsonContent(proxied.content, 'AI 代理');
    }
    if (response.status !== 429) break;
    const waitMs = [3000, 8000, 15000][attempt] ?? 15000;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (!response || !response.ok) {
    const text = (await response?.text().catch(() => '')) ?? '';
    return {
      ok: false,
      error: `AI API ${response?.status ?? '?'}: ${text.slice(0, 200)}`,
    };
  }

  const json = await response.json();
  const content: string | undefined = json?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'AI 返回空内容' };

  return parseJsonContent(content, 'AI');
}

async function callAiProxy(
  requestBody: Record<string, unknown>,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('ai-proxy', {
      body: requestBody,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    if (!data?.ok || typeof data.content !== 'string') {
      return {
        ok: false,
        error: String(data?.error ?? 'AI proxy returned invalid response'),
      };
    }
    return { ok: true, content: data.content };
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error)?.message ?? err),
    };
  }
}

function parseJsonContent(
  content: string,
  source: string,
): { ok: true; parsed: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: JSON.parse(content) };
  } catch {
    return { ok: false, error: `${source} 返回非 JSON：${content.slice(0, 100)}` };
  }
}

async function handleExtractFields(req: ExtractFieldsRequest) {
  if (!req.messages?.length) {
    return { ok: true, suggestions: [] };
  }
  const result = await callQwen(buildPrompt(req.messages, req.contact));
  if (!result.ok) return result;
  return {
    ok: true,
    suggestions: validateSuggestions(result.parsed),
    vehicles: validateVehicles(result.parsed),
  };
}

async function handleExtractTags(req: ExtractTagsRequest) {
  if (!req.messages?.length) {
    return { ok: true, tags: [] };
  }
  const result = await callQwen(buildTagPrompt(req.messages, req.existingTags ?? []));
  if (!result.ok) return result;
  return {
    ok: true,
    tags: validateTags(result.parsed),
  };
}

async function handleExtractTasks(req: ExtractTasksRequest) {
  if (!req.messages?.length) {
    return { ok: true, tasks: [] };
  }
  const result = await callQwen(
    buildTaskPrompt(req.messages, req.existingTitles ?? []),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    tasks: validateTasks(result.parsed),
  };
}

async function handleInferStage(req: InferStageRequest) {
  if (!req.messages?.length) {
    return {
      ok: true,
      inference: { stage: null, confidence: 0, reasoning: '无聊天消息' },
    };
  }
  const result = await callQwen(
    buildStagePrompt(req.messages, req.currentStage ?? 'new'),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    inference: validateInference(result.parsed),
  };
}

async function handleTranslate(req: { text: string; targetLang?: string }) {
  const text = (req.text ?? '').trim();
  const targetLang = req.targetLang ?? 'zh-CN';
  if (!text) return { ok: true, translation: '' };

  // 主路径：Google Translate gtx endpoint（免费、无 key、快、稳定）
  try {
    const translation = await callGoogleTranslate(text, targetLang);
    if (translation && translation !== text) {
      return { ok: true, translation };
    }
  } catch (err) {
    console.warn('[translate] Google failed, fallback to Qwen:', err);
  }

  // Fallback: Qwen（万一 Google 不通时兜底）
  return await callQwenTranslate(text, targetLang);
}

async function callGoogleTranslate(
  text: string,
  targetLang: string,
): Promise<string> {
  // Chrome 自带翻译用的就是这个 endpoint，无需 API key
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto'); // source: auto-detect
  url.searchParams.set('tl', targetLang);
  url.searchParams.set('dt', 't'); // return translation only
  url.searchParams.set('q', text);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Google Translate ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  // 响应格式：[[[translated, original, ...], [translated, original, ...], ...], ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google Translate 返回格式异常');
  }
  const segments = data[0] as unknown[];
  const translated = segments
    .map((seg) =>
      Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '',
    )
    .filter(Boolean)
    .join('');
  return translated.trim();
}

const TARGET_LANG_NAME: Record<string, string> = {
  'zh-CN': '简体中文',
  en: '英文',
  es: '西班牙文',
  fr: '法文',
  ar: '阿拉伯文',
  ru: '俄文',
  pt: '葡萄牙文',
  it: '意大利文',
  ja: '日文',
  ko: '韩文',
  tr: '土耳其文',
  de: '德文',
  vi: '越南文',
  th: '泰文',
  id: '印尼文',
  fa: '波斯文',
  ur: '乌尔都文',
  hi: '印地文',
  bn: '孟加拉文',
};

async function callQwenTranslate(
  text: string,
  targetLang: string,
): Promise<{ ok: true; translation: string } | { ok: false; error: string }> {
  const apiKey = import.meta.env.VITE_DASHSCOPE_API_KEY;
  if (!apiKey)
    return { ok: false, error: 'Google Translate 失败 + 未配置 Qwen fallback' };

  const targetName = TARGET_LANG_NAME[targetLang] ?? targetLang;
  const requestBody = {
    model: AI_MODEL,
    messages: [
      {
        role: 'system',
        content: `你是专业翻译。把用户输入翻译成${targetName}。只输出译文，不要解释、不要原文、不要引号、不要前后缀。如果输入本身已经是${targetName}，原样返回。`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
  };
  const body = JSON.stringify(requestBody);

  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const proxied = await callAiProxy(requestBody);
      if (!proxied.ok) {
        return {
          ok: false,
          error: `AI 直连失败：${message}；代理也失败：${proxied.error}`,
        };
      }
      return { ok: true, translation: proxied.content.trim() };
    }
    if (response.status !== 429) break;
    const waitMs = [3000, 8000, 15000][attempt] ?? 15000;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (!response || !response.ok) {
    const errText = (await response?.text().catch(() => '')) ?? '';
    return {
      ok: false,
      error: `AI API ${response?.status ?? '?'}: ${errText.slice(0, 200)}`,
    };
  }

  const json = await response.json();
  const content: string | undefined = json?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'AI 返回空内容' };

  return { ok: true, translation: content.trim() };
}
