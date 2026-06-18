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

/**
 * 找出 #main 里所有消息气泡元素。
 *
 * ⚠️ 新版 WA Web（2026-06 实测）已经彻底删掉 `.message-in` / `.message-out` class，
 * 所有依赖它们的查询返回 0 → 翻译找不到任何气泡，开关打开也不翻译。
 * 改成：先试旧 class（向后兼容），返回 0 时退到消息级 wrapper `[data-testid^="conv-msg-"]`。
 * 跟 whatsapp-messages.ts 的 readChatMessages 同源（那边已经加过 conv-msg- 兜底）。
 */
function getBubbles(root: ParentNode): Element[] {
  const legacy = root.querySelectorAll('.message-in, .message-out');
  if (legacy.length > 0) return Array.from(legacy);
  return Array.from(root.querySelectorAll('[data-testid^="conv-msg-"]'));
}

/** 读元素文本，先剥掉我们自己注入的翻译行 / 翻译按钮，避免再翻译被污染 */
function cleanText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(`.${TRANSLATION_CLASS}, .${TRANSLATE_BTN_CLASS}`)
    .forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || '').trim();
}

function readBubbleText(bubble: Element): string {
  // ⚠️ 引用回复：被引用的原话在 [data-testid="quoted-message"] 预览框里，跟真回复同
  // bubble。不剥掉的话，下面 querySelector('.selectable-text') / 取最长 会命中引用框里
  // 的原话（常是销售自己之前发的消息），翻译出来的是"被引用的旧消息"而不是客户真回复
  // （如客户问"科托努有没有代表处"被译成那条旧跟进消息）。跟 whatsapp-messages.ts
  // getMessageText 同源 bug（2026-06-18），两处都要剥——翻译和读消息是两套独立 DOM 逻辑。
  let scope: ParentNode = bubble;
  if (bubble.querySelector('[data-testid="quoted-message"]')) {
    const clone = bubble.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('[data-testid="quoted-message"]')
      .forEach((n) => n.remove());
    scope = clone;
  }
  // 优先：带 data-pre-plain-text 的 .copyable-text（真正的消息正文 wrapper）
  const realWrap = scope.querySelector('.copyable-text[data-pre-plain-text]');
  if (realWrap instanceof HTMLElement) {
    const sel = realWrap.querySelector('.selectable-text');
    if (sel instanceof HTMLElement) {
      const t = cleanText(sel);
      if (t) return t;
    }
    const t = cleanText(realWrap);
    if (t) return t;
  }
  // ⚠️ 新版 WA Web 已弃用 `.selectable-text`，正文直接挂在 `.copyable-text` 自身。
  // 一个 wrapper 可能有多个 .copyable-text（引用气泡 / FB 广告 header），挑最长的当正文。
  let longest = '';
  scope.querySelectorAll('.copyable-text').forEach((el) => {
    if (el instanceof HTMLElement) {
      const t = cleanText(el);
      if (t.length > longest.length) longest = t;
    }
  });
  if (longest) return longest;
  // 兜底：老结构 .selectable-text
  const sel = scope.querySelector('.selectable-text');
  if (sel instanceof HTMLElement) return cleanText(sel);
  return '';
}

/** 翻译行注入到哪个容器：优先消息正文 wrapper，让译文出现在气泡内文字下方 */
function injectionContainer(bubble: Element): Element {
  return (
    bubble.querySelector('.copyable-text[data-pre-plain-text]') ??
    bubble.querySelector('.copyable-text') ??
    bubble
  );
}

function injectTranslation(bubble: Element, translation: string) {
  bubble.querySelector(`.${TRANSLATION_CLASS}`)?.remove();
  const div = document.createElement('div');
  div.className = TRANSLATION_CLASS;
  div.textContent = `🌐 ${translation}`;

  injectionContainer(bubble).appendChild(div);
  bubble.setAttribute(TRANSLATED_ATTR, '1');
}

function injectManualButton(bubble: Element) {
  if (bubble.hasAttribute(BUTTON_ATTR)) return;
  bubble.setAttribute(BUTTON_ATTR, '1');
  // 标记类：新版 WA Web 没有 .message-in/.message-out 了，CSS 的 hover 规则改挂在这个类上
  bubble.classList.add('sgc-bubble');

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
  for (const b of getBubbles(main)) {
    if (!b.hasAttribute(BUTTON_ATTR)) injectManualButton(b);
  }
}

/** 自动模式：扫描可见气泡入队 */
function processVisible() {
  injectButtons(); // 不论开关，按钮总是注入

  if (!enabled) return;
  const main = document.querySelector('div#main');
  if (!main) return;
  for (const b of getBubbles(main)) {
    if (!b.hasAttribute(TRANSLATED_ATTR) && !b.hasAttribute(PROCESSING_ATTR)) {
      void enqueue(b);
    }
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
  const bubbles = getBubbles(main);
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
