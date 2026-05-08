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
