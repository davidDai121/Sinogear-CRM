/** Read original message text, never an extension's translated copy. */
export function readOriginalMessageText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll([
    '.sgc-translation', '.sgc-translate-btn',
    '.immersive-translate-target-wrapper',
    '[data-immersive-translate-translation-element-mark]',
    '[data-testid="quoted-message"]',
  ].join(',')).forEach(n => n.remove());
  // Detached innerText loses line breaks in Chromium. WA spans already contain
  // newlines; preserve those and explicit BRs without deleting genuine Chinese.
  clone.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
  return (clone.textContent || '').trim();
}

/** Mixed WA versions can render legacy bubbles and modern wrappers together. */
export function messageBubbles(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('.message-in, .message-out, [data-testid^="conv-msg-"]'))
    .filter(el => !el.closest('[data-testid="quoted-message"]'))
    .filter(el => !el.matches('[data-testid^="conv-msg-"]') || !el.querySelector('.message-in, .message-out'));
}

/** A virtualized shell has an ID but no message body or direction evidence. */
export function isVirtualMessageShell(el: Element): boolean {
  return !!el.querySelector('[data-virtualized="true"]')
    && !el.querySelector('[data-testid="msg-container"], .copyable-text, [data-testid="msg-meta"]');
}
