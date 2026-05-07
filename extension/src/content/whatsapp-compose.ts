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
 */
export function fillWhatsAppCompose(text: string): boolean {
  const input = findCompose();
  if (!input) return false;

  input.focus();

  // 1. 先尝试 execCommand insertText — 对老版 contenteditable 最稳
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }

  // 2. Fallback: 模拟 paste event（适用 Lexical 等新框架）
  if (!inserted) {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(pasteEvent);
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
