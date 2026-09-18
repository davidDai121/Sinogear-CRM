import { QUOTE_PREVIEW_KEY, quoteConversationId, renderQuotePreview, type QuotePreview } from '../lib/quote-preview';

let entries: QuotePreview[] = [];
let pending = false;
function render() {
  pending = false;
  const id = quoteConversationId(location.href);
  if (id) renderQuotePreview(document, id, entries);
}
function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(render, 200);
}
void chrome.storage.local.get(QUOTE_PREVIEW_KEY).then(s => {
  entries = Array.isArray(s[QUOTE_PREVIEW_KEY]) ? s[QUOTE_PREVIEW_KEY] : [];
  schedule();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[QUOTE_PREVIEW_KEY]) {
    entries = changes[QUOTE_PREVIEW_KEY].newValue ?? [];
    schedule();
  }
});
new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
