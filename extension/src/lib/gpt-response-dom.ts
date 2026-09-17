export interface GptResponseSnapshot {
  generating: boolean;
  hasCopyBtn: boolean;
  content: string;
}

/**
 * Runs inside chatgpt.com via chrome.scripting.executeScript. Keep all helpers
 * inside this function: Chrome serializes the function without module closures.
 *
 * Do not read innerText from a detached clone. Without layout it falls back to
 * textContent and joins adjacent paragraphs. Read semantic block boundaries
 * directly instead, so background tabs and foreground tabs behave the same.
 */
export function readGptResponseSnapshot(prevId: string | null): GptResponseSnapshot {
  const stopBtn = document.querySelector(
    'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止" i]',
  );
  const assistantEls = document.querySelectorAll('[data-message-author-role="assistant"]');
  const proseEls = document.querySelectorAll('.markdown.prose, div.prose');
  const last = assistantEls.length > 0
    ? assistantEls[assistantEls.length - 1]
    : proseEls[proseEls.length - 1];
  const curId = assistantEls.length > 0
    ? last.getAttribute('data-message-id') ?? `count:${assistantEls.length}`
    : proseEls.length > 0 ? `prose:${proseEls.length}` : null;

  // Only use completion controls belonging to this turn, not an old response.
  const turn = last?.closest('[data-testid^="conversation-turn-"], article') ?? last;
  const copyBtn = turn?.querySelector(
    'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy" i], button[aria-label*="复制" i]',
  );
  const state = { generating: !!stopBtn, hasCopyBtn: !!copyBtn, content: '' };
  if (!last || curId === null || curId === prevId) return state;

  const ignored = [
    'button', 'script', 'style', 'noscript', '[role="toolbar"]',
    '[hidden]', '[aria-hidden="true"]',
    '[data-testid*="thinking" i]', '[aria-label*="Thinking" i]',
    '[aria-label*="Reasoning" i]',
    // Writing-card chrome is not message text; keep the sibling editor and its headings.
    '[data-testid="writing-block-header-sticky-container"]',
    '[data-testid="writing-block-header-surface"]',
    '[data-writing-block-fullscreen-header-chrome="true"]',
    // Search citations are UI chrome, not links offered in the customer message.
    '[data-testid="webpage-citation-pill"]',
  ].join(',');

  function read(node: Node): string {
    if (node.nodeType === 3) return node.nodeValue ?? '';
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (el.matches(ignored)) return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n';
    // Code blocks already contain intentional whitespace, including blank lines.
    if (tag === 'pre') return `\n\n${Array.from(el.childNodes).map(read).join('')}\n\n`;

    const body = Array.from(el.childNodes).map(read).join('');
    if (tag === 'a') {
      // Export actual absolute web destinations as plain text for WhatsApp.
      // Do not resolve relative paths against chatgpt.com or rewrite query/hash.
      const href = el.getAttribute('href')?.trim() ?? '';
      if (!/^https?:\/\//i.test(href)) return body;
      let target: URL;
      try {
        target = new URL(href);
      } catch {
        return body;
      }
      const label = body.trim();
      if (!label) return href;
      if (/^https?:\/\//i.test(label)) {
        try {
          // URL labels may omit tracking or point elsewhere: keep only the real target.
          return new URL(label).href === target.href ? body : href;
        } catch {
          // An invalid URL-shaped label is still ordinary descriptive text.
        }
      }
      return `${label}: ${href}`;
    }
    if (tag === 'li') {
      const list = el.parentElement;
      const siblings = Array.from(list?.children ?? []).filter((item) => item.tagName.toLowerCase() === 'li');
      const start = Number(list?.getAttribute('start') ?? 1);
      const ordinal = Number(el.getAttribute('value') ?? (Number.isFinite(start) ? start : 1) + siblings.indexOf(el));
      const marker = list?.tagName.toLowerCase() === 'ol' ? `${ordinal}. ` : '- ';
      return `${marker}${body.trim()}\n`;
    }
    if (tag === 'ul' || tag === 'ol') return `\n\n${body.trim()}\n\n`;
    if (tag === 'td' || tag === 'th') return `${body.trim()}\t`;
    if (tag === 'tr') return `${body.trim()}\n`;
    if (/^(p|h[1-6]|blockquote|table|dl)$/.test(tag)) return `\n\n${body.trim()}\n\n`;
    if (/^(div|section|article|main|dt|dd)$/.test(tag)) return `\n${body}\n`;
    return body;
  }

  // Normalize line endings and excess structural separators only. Never replace
  // all whitespace with spaces: that would destroy paragraphs again.
  state.content = read(last)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return state;
}
