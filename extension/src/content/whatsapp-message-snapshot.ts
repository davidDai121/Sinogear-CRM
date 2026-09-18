import { readChatMessages, type ChatMessage } from './whatsapp-messages';

/** Hydrate recent virtualized rows on an explicit generation request. */
export async function collectRecentChatMessages(
  isTargetChat: () => boolean,
  limit = 50,
): Promise<ChatMessage[]> {
  const main = document.querySelector('#main, [data-testid="conversation-panel"]');
  if (!main || !isTargetChat()) throw new Error('当前聊天已切换，未采集其他客户消息');
  const wraps = () => Array.from(main.querySelectorAll<HTMLElement>('[data-testid^="conv-msg-"]')).slice(-limit);
  const targets = wraps();
  let scroll: HTMLElement | null = targets.at(-1)?.parentElement ?? null;
  while (scroll && scroll !== main && scroll.scrollHeight <= scroll.clientHeight) scroll = scroll.parentElement;
  const position = scroll?.scrollTop ?? 0;
  const bottom = scroll ? scroll.scrollHeight - scroll.clientHeight - position : 0;
  const captured = new Map<string, ChatMessage>();
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const check = () => {
    if (!main.isConnected || !isTargetChat()) throw new Error('采集期间客户已切换，本次未使用其他客户消息');
    if (interrupted) throw new Error('聊天正在手动滚动，本次采集已停止；停稳后可重新生成');
  };
  const capture = () => {
    check();
    for (const m of readChatMessages(limit * 2)) captured.set(m.id, m);
  };
  main.addEventListener('wheel', interrupt, { passive: true });
  main.addEventListener('touchstart', interrupt, { passive: true });
  try {
    capture();
    const started = Date.now();
    // Going newest to oldest usually hydrates several adjacent messages at once.
    for (const target of [...targets].reverse()) {
      const id = target.getAttribute('data-id');
      if (!id || captured.has(id) || captured.has(`${id}::in`) || captured.has(`${id}::out`)) continue;
      check();
      if (Date.now() - started > 12_000) break;
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 120));
        capture();
        if (captured.has(id) || captured.has(`${id}::in`) || captured.has(`${id}::out`)) break;
      }
    }
    capture();
    const missing = targets.filter(t => {
      const id = t.getAttribute('data-id');
      return id && !captured.has(id) && !captured.has(`${id}::in`) && !captured.has(`${id}::out`);
    });
    if (missing.length) throw new Error(`最近聊天仍有${missing.length}条未加载完整，未用残缺消息生成回复。请稍后重试。`);
    const order = new Map(targets.map((t, i) => [t.getAttribute('data-id'), i]));
    return [...captured.values()].sort((a, b) => {
      const ai = order.get(a.id.replace(/::(?:in|out)$/, ''));
      const bi = order.get(b.id.replace(/::(?:in|out)$/, ''));
      return ai != null && bi != null ? ai - bi : (a.timestamp ?? 0) - (b.timestamp ?? 0);
    });
  } finally {
    main.removeEventListener('wheel', interrupt);
    main.removeEventListener('touchstart', interrupt);
    // Never move the next customer's conversation or fight a manual scroll.
    if (!interrupted && main.isConnected && isTargetChat() && scroll) {
      scroll.scrollTop = bottom < 8 ? scroll.scrollHeight - scroll.clientHeight : position;
    }
  }
}
