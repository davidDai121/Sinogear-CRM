/** Expand only WhatsApp's actual message controls, never links in customer text. */
export async function expandRenderedMessages(main: Element, check: () => void,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const label = /^(?:查看更多|展开全文|显示更多|顯示更多|閱讀更多|read more|see more|leer m[aá]s|ver m[aá]s|ler mais|ver mais|voir plus|lire la suite|mehr lesen)$/i;
  const normalize = (text: string) => text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/^[\s.…]+|[\s.…]+$/g, '').replace(/\s+/g, ' ');
  const controls = () => Array.from(main.querySelectorAll<HTMLElement>('[data-testid="caption-read-more-button"], .read-more-button, button, [role="button"], [tabindex="0"]'))
    .filter(el => el.closest('[data-testid^="conv-msg-"], [data-id], [data-testid="msg-container"], .message-in, .message-out, .copyable-text'))
    .filter(el => el.matches('[data-testid="caption-read-more-button"], .read-more-button') || label.test(normalize(el.textContent ?? '')) || label.test(normalize(el.getAttribute('aria-label') ?? '')));
  for (let round = 0; round < 4; round++) {
    check();
    const pending = controls();
    if (!pending.length) return;
    for (const control of pending) { check(); if (control.isConnected) control.click(); }
    await sleep(150);
  }
  check();
  if (controls().length) throw new Error('客户长消息尚未展开完整，本次未生成；请展开“查看更多”后重试。');
}
