/**
 * Auto-translate WhatsApp 消息（客户 + 自己回复）。
 *
 * 监听 div#main 的气泡，非中文文本 → Google Translate（Qwen fallback）→ 注入气泡下方。
 * 由 chrome.storage.local.autoTranslate 控制；同时给每个气泡注入手动 🌐 按钮。
 */

const TRANSLATED_ATTR = 'data-sgc-translated';
const TRANSLATION_CLASS = 'sgc-translation';
const PROCESSING_ATTR = 'data-sgc-translating';
const BUTTON_ATTR = 'data-sgc-tr-btn'; // 标记气泡已经注入过按钮
const TRANSLATE_BTN_CLASS = 'sgc-translate-btn';
const MAX_LEN = 2000;
const MIN_LEN = 3;
const MIN_INTERVAL_MS = 200; // Google Translate gtx 无配额限制，串行也能很快

let observer: MutationObserver | null = null;
let pollTimer: number | null = null;
let enabled = false;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();
const cache = new Map<string, string>(); // text → translation

function getCJKRatio(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // Extension A
      (code >= 0x20000 && code <= 0x2a6df) || // Extension B
      (code >= 0xff00 && code <= 0xffef) // Halfwidth/Fullwidth
    ) {
      cjk += 1;
    }
  }
  return cjk / [...s].length;
}

function shouldTranslate(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
  if (getCJKRatio(t) > 0.3) return false;
  if (/^[\d\s\-+()._:/?#=&%@]+$/.test(t)) return false;
  if (/^https?:\/\/\S+$/.test(t)) return false;
  return true;
}

function readBubbleText(bubble: Element): string {
  const cop = bubble.querySelector('.copyable-text .selectable-text');
  if (cop instanceof HTMLElement) return cop.innerText.trim();
  const sel = bubble.querySelector('.selectable-text');
  if (sel instanceof HTMLElement) return sel.innerText.trim();
  const any = bubble.querySelector('.copyable-text');
  if (any instanceof HTMLElement) return any.innerText.trim();
  return '';
}

function injectTranslation(bubble: Element, translation: string) {
  bubble.querySelector(`.${TRANSLATION_CLASS}`)?.remove();
  const div = document.createElement('div');
  div.className = TRANSLATION_CLASS;
  div.textContent = `🌐 ${translation}`;

  const container = bubble.querySelector('.copyable-text') ?? bubble;
  container.appendChild(div);
  bubble.setAttribute(TRANSLATED_ATTR, '1');
}

function injectManualButton(bubble: Element) {
  if (bubble.hasAttribute(BUTTON_ATTR)) return;
  bubble.setAttribute(BUTTON_ATTR, '1');

  // 确保气泡可作为绝对定位锚点
  if (bubble instanceof HTMLElement && getComputedStyle(bubble).position === 'static') {
    bubble.style.position = 'relative';
  }

  const btn = document.createElement('button');
  btn.className = TRANSLATE_BTN_CLASS;
  btn.type = 'button';
  btn.textContent = '🌐';
  btn.title = '翻译此消息';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    // 清掉已有标记重新翻译
    bubble.removeAttribute(TRANSLATED_ATTR);
    bubble.removeAttribute(PROCESSING_ATTR);
    bubble.querySelector(`.${TRANSLATION_CLASS}`)?.remove();
    btn.textContent = '⏳';
    enqueue(bubble).finally(() => {
      btn.textContent = '🌐';
    });
  });
  bubble.appendChild(btn);
}

/** 顺序队列：每条消息排队，间隔 ≥ MIN_INTERVAL_MS */
function enqueue(bubble: Element): Promise<void> {
  if (
    bubble.hasAttribute(TRANSLATED_ATTR) ||
    bubble.hasAttribute(PROCESSING_ATTR)
  ) {
    return Promise.resolve();
  }
  const text = readBubbleText(bubble);
  if (!shouldTranslate(text)) {
    bubble.setAttribute(TRANSLATED_ATTR, 'skip');
    return Promise.resolve();
  }

  // 命中缓存：直接注入
  const cached = cache.get(text);
  if (cached) {
    injectTranslation(bubble, cached);
    return Promise.resolve();
  }

  // 标记为处理中，避免被重复入队
  bubble.setAttribute(PROCESSING_ATTR, '1');

  const job = queue.then(() => runTranslate(bubble, text));
  queue = job.catch(() => {}); // 让队列继续推进
  return job;
}

async function runTranslate(bubble: Element, text: string): Promise<void> {
  // 节流
  const sinceLast = Date.now() - lastRequestAt;
  if (sinceLast < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - sinceLast));
  }
  lastRequestAt = Date.now();

  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'TRANSLATE_TEXT',
      text,
    })) as { ok: boolean; translation?: string; error?: string };

    if (response?.ok && response.translation) {
      const trimmed = response.translation.trim();
      if (trimmed && getCJKRatio(trimmed) > 0.3 && trimmed !== text) {
        cache.set(text, trimmed);
        injectTranslation(bubble, trimmed);
      } else {
        bubble.setAttribute(TRANSLATED_ATTR, 'skip');
      }
    } else {
      console.warn('[auto-translate] fail', response?.error);
      bubble.setAttribute(TRANSLATED_ATTR, 'fail');
    }
  } catch (err) {
    console.warn('[auto-translate]', err);
    bubble.setAttribute(TRANSLATED_ATTR, 'fail');
  } finally {
    bubble.removeAttribute(PROCESSING_ATTR);
  }
}

/** 给所有可见气泡注入手动按钮 */
function injectButtons() {
  const main = document.querySelector('div#main');
  if (!main) return;
  const bubbles = main.querySelectorAll(
    `.message-in:not([${BUTTON_ATTR}]),.message-out:not([${BUTTON_ATTR}])`,
  );
  for (const b of bubbles) {
    injectManualButton(b);
  }
}

/** 自动模式：扫描可见气泡入队 */
function processVisible() {
  injectButtons(); // 不论开关，按钮总是注入

  if (!enabled) return;
  const main = document.querySelector('div#main');
  if (!main) return;
  const bubbles = main.querySelectorAll(
    `.message-in:not([${TRANSLATED_ATTR}]):not([${PROCESSING_ATTR}]),` +
      `.message-out:not([${TRANSLATED_ATTR}]):not([${PROCESSING_ATTR}])`,
  );
  for (const b of bubbles) {
    void enqueue(b);
  }
}

function startObserver() {
  if (!observer) {
    observer = new MutationObserver(() => processVisible());
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (pollTimer == null) {
    pollTimer = window.setInterval(() => processVisible(), 3000);
  }
  processVisible();
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  document
    .querySelectorAll(`.${TRANSLATION_CLASS}`)
    .forEach((el) => el.remove());
  document
    .querySelectorAll(`[${TRANSLATED_ATTR}]`)
    .forEach((el) => el.removeAttribute(TRANSLATED_ATTR));
}

export function setAutoTranslate(on: boolean) {
  enabled = on;
  if (on) startObserver();
  else stopObserver();
}

/** 手动触发：清掉所有标记，强制重新翻译当前 #main 中所有可见气泡 */
export function manualRetranslate(): number {
  document
    .querySelectorAll(`[${TRANSLATED_ATTR}]`)
    .forEach((el) => el.removeAttribute(TRANSLATED_ATTR));
  document
    .querySelectorAll(`[${PROCESSING_ATTR}]`)
    .forEach((el) => el.removeAttribute(PROCESSING_ATTR));
  document
    .querySelectorAll(`.${TRANSLATION_CLASS}`)
    .forEach((el) => el.remove());

  const main = document.querySelector('div#main');
  if (!main) return 0;
  const bubbles = main.querySelectorAll('.message-in, .message-out');
  for (const b of bubbles) {
    void enqueue(b);
  }
  return bubbles.length;
}

export function initAutoTranslate() {
  // 始终启动按钮注入轮询（不论 toggle 状态）
  if (pollTimer == null) {
    pollTimer = window.setInterval(() => injectButtons(), 3000);
  }
  injectButtons();

  void chrome.storage.local.get('autoTranslate').then((s) => {
    setAutoTranslate(Boolean(s.autoTranslate));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.autoTranslate) return;
    setAutoTranslate(Boolean(changes.autoTranslate.newValue));
  });
}
