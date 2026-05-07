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
import { runGem, isBusy as isGemBusy } from '@/lib/gem-automation';

const AI_BASE_URL =
  import.meta.env.VITE_AI_BASE_URL ??
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const AI_MODEL = import.meta.env.VITE_AI_MODEL ?? 'qwen-turbo-latest';
const AI_URL = `${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`;

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Sino Gear CRM] installed:', details.reason);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
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

  if (msg?.type === 'BULK_CAPTURE_ARM') {
    const tabId = _sender.tab?.id;
    if (typeof tabId === 'number') {
      bulkArmed = { tabId, armedAt: Date.now() };
      // 兜底：60s 没收到 disarm 就自动关掉，避免长期挂起
      setTimeout(() => {
        if (bulkArmed && Date.now() - bulkArmed.armedAt >= 59000) {
          console.log('[sgc/sw] bulk capture timeout, auto-disarm');
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

  return false;
});

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

    // 完整记录 onCreated 拿到了啥（debug 看 zip 还是单文件）
    console.log('[sgc/sw] downloads.onCreated:', {
      id: item.id,
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      totalBytes: item.totalBytes,
      referrer: item.referrer,
    });

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

async function callQwen(prompt: string): Promise<{ ok: true; parsed: unknown } | { ok: false; error: string }> {
  const apiKey = import.meta.env.VITE_DASHSCOPE_API_KEY;
  if (!apiKey) return { ok: false, error: '未配置 VITE_DASHSCOPE_API_KEY' };

  const body = JSON.stringify({
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(AI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });
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

  try {
    return { ok: true, parsed: JSON.parse(content) };
  } catch {
    return { ok: false, error: `AI 返回非 JSON：${content.slice(0, 100)}` };
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
  const body = JSON.stringify({
    model: AI_MODEL,
    messages: [
      {
        role: 'system',
        content: `你是专业翻译。把用户输入翻译成${targetName}。只输出译文，不要解释、不要原文、不要引号、不要前后缀。如果输入本身已经是${targetName}，原样返回。`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
  });

  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(AI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });
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
