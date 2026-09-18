export const QUOTE_PREVIEW_KEY = 'sgc:quote-previews:v1';
export interface QuotePreview {
  conversationId: string; messageId: string; reply: string;
  amounts: Record<string, string>; savedAt: number;
}
export function quoteConversationId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://chatgpt.com') return null;
    return u.pathname.match(/\/c\/([a-z0-9-]+)\/?$/i)?.[1] ?? null;
  } catch { return null; }
}
export async function saveQuotePreview(preview: QuotePreview): Promise<void> {
  if (!preview.messageId || /^(count|prose):/.test(preview.messageId) || !preview.reply) return;
  const stored = await chrome.storage.local.get(QUOTE_PREVIEW_KEY);
  const entries: QuotePreview[] = Array.isArray(stored[QUOTE_PREVIEW_KEY]) ? stored[QUOTE_PREVIEW_KEY] : [];
  await chrome.storage.local.set({ [QUOTE_PREVIEW_KEY]: [
    ...entries.filter(p => p.conversationId !== preview.conversationId || p.messageId !== preview.messageId).slice(-49), preview,
  ] });
}

/** Local presentation only: never edits the conversation on ChatGPT's server. */
export function renderQuotePreview(root: ParentNode, conversationId: string, entries: QuotePreview[]) {
  for (const assistant of root.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]')) {
    const messageId = assistant.getAttribute('data-message-id');
    const entry = entries.find(p => p.conversationId === conversationId && p.messageId === messageId);
    const hasTokens = /\{\{quote\.\d+\.[A-Za-z]+\}\}/.test(assistant.textContent ?? '');
    let card = assistant.querySelector<HTMLElement>('[data-sgc-quote-preview]');
    if (!entry && !hasTokens) continue;
    if (!card) {
      card = document.createElement('section');
      card.setAttribute('data-sgc-quote-preview', '');
      card.setAttribute('translate', 'no');
      card.className = 'notranslate';
      card.style.cssText = 'border:2px solid #00a884;border-radius:8px;padding:14px;margin:12px 0;white-space:pre-wrap;background:#f0fdf4;color:#15392f;font:14px/1.6 system-ui';
      assistant.prepend(card);
    }
    const content = entry
      ? `CRM核算后的报价 · 草稿，未发送\n\n${entry.reply}`
      : '报价金额待CRM核算，请回WhatsApp查看最终回复。这里的生成内容还不是最终报价，无需再次要求GPT补价格。';
    if (card.textContent !== content) card.textContent = content;
    if (!entry || !hasTokens) continue;
    const walker = document.createTreeWalker(assistant, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (card.contains(node)) continue;
      const old = node.nodeValue ?? '';
      const next = old.replace(/\{\{quote\.\d+\.[A-Za-z]+\}\}/g, token => entry.amounts[token] ?? token);
      if (old !== next) node.nodeValue = next;
    }
  }
}
