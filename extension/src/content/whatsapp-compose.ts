/**
 * 把文本填入 WhatsApp Web 当前聊天的输入框（footer 那个 contenteditable）。
 *
 * 不自动发送 — 只填好让用户检查 + 按发送。
 *
 * 用 paste event 注入，比直接改 innerText 更兼容（Lexical/Quill/普通 contenteditable）。
 */

const COMPOSE_SELECTORS = [
  'footer [data-testid="conversation-compose-box-input"]',
  'footer [contenteditable="true"][role="textbox"]',
  'footer [contenteditable="true"][data-tab]',
  'footer [contenteditable="true"]',
  '[data-testid="conversation-compose-box-input"]',
];

function findCompose(): HTMLElement | null {
  for (const sel of COMPOSE_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el && el.isContentEditable) return el;
  }
  return null;
}

/**
 * 把文本填入当前聊天输入框。返回 true = 成功，false = 找不到输入框。
 *
 * 优先 paste 事件（保留 \n 换行 — WA 的 Lexical 输入框会渲染成 <br>）；
 * fallback 走 execCommand 按行 insertText + insertLineBreak（execCommand
 * insertText 一次性传带 \n 的字符串会把换行折叠成空格）。
 */
export function fillWhatsAppCompose(text: string): boolean {
  const input = findCompose();
  if (!input) return false;

  input.focus();

  // 1. paste 事件 — text/plain 含 \n，Lexical 会渲成多行
  // 检测策略：比较 dispatch 前后的 textContent 长度 + 看 defaultPrevented
  //   - WA Lexical 的 onPaste 会同步调 preventDefault → defaultPrevented = true 表示它接管了
  //   - 长度变化兜底（万一某天它不调 preventDefault 但确实插入了）
  // 不要用 `textContent.trim().length > 0`：用户已经在输入框里打过字时会误判 true
  let pasteOk = false;
  try {
    const before = input.textContent?.length ?? 0;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(pasteEvent);
    const after = input.textContent?.length ?? 0;
    pasteOk = pasteEvent.defaultPrevented || after > before;
  } catch {
    pasteOk = false;
  }

  // 2. Fallback：手动按行写入（execCommand insertText 单次会丢 \n）
  // 仅在 paste 完全没被 WA 处理时走（pasteOk=false），否则会双填
  if (!pasteOk) {
    try {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) document.execCommand('insertLineBreak');
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
    } catch {
      // 兜底再来一次单次 insertText（至少把内容写进去，丢换行也认了）
      try {
        document.execCommand('insertText', false, text);
      } catch {
        /* ignore */
      }
    }
  }

  // 3. 触发 input 事件让 React 状态同步
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, cancelable: true }),
  );

  return true;
}

/**
 * 把若干 File 通过 paste 事件粘到当前 WhatsApp 输入框 → WA 跳出附件预览，
 * 用户在预览里 caption + 点发送。
 *
 * 不自动发送（图片附件预览界面有它自己的输入框 + 发送按钮，由用户决定）。
 *
 * @returns 成功 paste 的文件数（== files.length 时全部成功）
 */
export function pasteFilesToWhatsApp(files: File[]): boolean {
  if (files.length === 0) return false;
  const input = findCompose();
  if (!input) return false;

  input.focus();

  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);

  // WhatsApp Web 监听 paste 事件并把 clipboardData.files 转成附件预览
  const pasteEvent = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(pasteEvent);

  return true;
}

/**
 * 在 WA 图片预览模态里找 caption 输入框。pasteFilesToWhatsApp 之后约 500ms～几秒
 * WA 才弹出预览，所以调用方要轮询调本函数等结果。
 *
 * 它**不是** footer 那个 compose 输入框（会被 findCompose 跳过）。
 */
function findPreviewCaption(): HTMLElement | null {
  // 已知的 selector 路径（不同 WA 版本差异较大，多重 fallback）
  const candidates = [
    '[data-testid="media-caption-input-container"] [contenteditable="true"]',
    'div[aria-label*="caption" i][contenteditable="true"]',
    'div[aria-label*="标题" i][contenteditable="true"]',
    'div[aria-label*="说明" i][contenteditable="true"]',
    '[role="dialog"] [contenteditable="true"][role="textbox"]',
    '[role="application"] [contenteditable="true"][role="textbox"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el?.isContentEditable && !el.closest('footer')) {
      return el;
    }
  }
  // 通用兜底：所有 contenteditable[role=textbox] 中排除 footer compose 后取第一个
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[contenteditable="true"][role="textbox"]',
    ),
  );
  for (const el of all) {
    if (!el.isContentEditable) continue;
    if (el.closest('footer')) continue; // skip compose
    return el;
  }
  return null;
}

/**
 * 在 WA 图片预览模态里找"发送"按钮（不是 footer compose 的）。
 */
function findPreviewSendButton(): HTMLElement | null {
  const candidates = [
    '[role="dialog"] button[aria-label*="发送" i]',
    '[role="dialog"] button[aria-label*="Send" i]',
    'div[role="application"] button[aria-label*="发送" i]',
    'div[role="application"] button[aria-label*="Send" i]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel) as HTMLButtonElement | null;
    if (el && !el.disabled) return el;
  }
  // 通过 data-icon=send 反查包裹的 button，但排除 footer
  const sendIcons = Array.from(
    document.querySelectorAll<HTMLElement>(
      'span[data-icon="send"], [data-icon="send"], [data-icon="wds-ic-send-filled"]',
    ),
  );
  for (const icon of sendIcons) {
    if (icon.closest('footer')) continue;
    const btn = icon.closest('button');
    if (btn instanceof HTMLButtonElement && !btn.disabled) return btn;
  }
  return null;
}

/**
 * 不填 caption，直接等 WA 图片预览框弹出来 + 点击预览的发送键。
 *
 * 比 fillPreviewCaptionAndSend 稳定得多——它只依赖一个 selector（预览发送键），
 * 不依赖最容易漂的 caption 输入框 selector。
 *
 * @returns true = 图片预览的发送键已点击；false = 超时找不到发送键
 */
export async function sendPastedImagesNoCaption(
  timeoutMs = 10000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = findPreviewSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    await sleep(400);
  }
  return false;
}

/**
 * 按 Esc 关掉 WA 当前打开的模态（图片预览 / lightbox 等）。
 * 在 paste 图但 preview 卡死时用来回到 compose 输入框。
 */
export function pressEscapeToClosePreview(): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * 等 WA 图片预览模态出现（用预览发送键的存在与否判定）。
 */
export async function waitForPreviewReady(
  timeoutMs = 6000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPreviewSendButton()) return true;
    await sleep(300);
  }
  return false;
}

/**
 * 等 WA 图片预览模态关闭（footer compose 重新出现 + 预览发送键消失）。
 */
export async function waitForPreviewClosed(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const previewBtn = findPreviewSendButton();
    const compose = findCompose();
    if (!previewBtn && compose) return true;
    await sleep(300);
  }
  return false;
}

/**
 * 等 WA 图片预览框弹出来，把 caption 文字填进去，再点预览的发送按钮。
 *
 * ⚠️ 不再推荐用：caption 输入框 selector 在不同 WA 版本里不稳。
 * 现在 orchestrator 默认走 sendPastedImagesNoCaption + 单独发文字消息两步路径。
 *
 * @returns true = caption 已填且发送已点击；false = 找不到预览或发送键
 */
export async function fillPreviewCaptionAndSend(
  caption: string,
  timeoutMs = 8000,
): Promise<boolean> {
  // 1. 等 caption 输入框出现
  const start = Date.now();
  let captionInput: HTMLElement | null = null;
  while (Date.now() - start < timeoutMs) {
    captionInput = findPreviewCaption();
    if (captionInput) break;
    await sleep(300);
  }
  if (!captionInput) return false;

  // 2. 填 caption（paste 优先 + execCommand 兜底，跟 fillWhatsAppCompose 同思路）
  captionInput.focus();
  let pasteOk = false;
  try {
    const before = captionInput.textContent?.length ?? 0;
    const dt = new DataTransfer();
    dt.setData('text/plain', caption);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    captionInput.dispatchEvent(pasteEvent);
    const after = captionInput.textContent?.length ?? 0;
    pasteOk = pasteEvent.defaultPrevented || after > before;
  } catch {
    pasteOk = false;
  }
  if (!pasteOk) {
    try {
      const lines = caption.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) document.execCommand('insertLineBreak');
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
    } catch {
      try {
        document.execCommand('insertText', false, caption);
      } catch {
        /* ignore */
      }
    }
  }
  captionInput.dispatchEvent(
    new InputEvent('input', { bubbles: true, cancelable: true }),
  );

  // 3. 给 WA 一拍把发送按钮 enable
  await sleep(600);

  // 4. 找发送键 + 点击（重试几次，因为 WA 可能稍后才 enable）
  for (let i = 0; i < 10; i++) {
    const sendBtn = findPreviewSendButton();
    if (sendBtn) {
      sendBtn.click();
      return true;
    }
    await sleep(400);
  }
  return false;
}

/**
 * 在 footer compose 区域找发送按钮 + 点击。
 * 调用方应该先 fillWhatsAppCompose 让 React 把发送按钮 enable 起来。
 *
 * @returns true = 点了发送键；false = 找不到
 */
export async function sendCurrentCompose(): Promise<boolean> {
  // 等 React state 同步 + 发送键 enable
  for (let i = 0; i < 10; i++) {
    const btn = findComposeSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    await sleep(400);
  }
  return false;
}

function findComposeSendButton(): HTMLButtonElement | null {
  const direct = [
    'footer button[aria-label*="发送" i]',
    'footer button[aria-label*="Send" i]',
    'footer [data-testid="compose-btn-send"]',
  ];
  for (const sel of direct) {
    const el = document.querySelector(sel) as HTMLButtonElement | null;
    if (el && !el.disabled) return el;
  }
  // 通过 send icon 反查
  const icons = Array.from(
    document.querySelectorAll<HTMLElement>(
      'footer [data-icon="send"], footer [data-icon="send-light"], footer [data-icon="wds-ic-send-filled"]',
    ),
  );
  for (const icon of icons) {
    const btn = icon.closest('button');
    if (btn instanceof HTMLButtonElement && !btn.disabled) return btn;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
