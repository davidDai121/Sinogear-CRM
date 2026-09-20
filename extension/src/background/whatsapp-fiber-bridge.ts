/**
 * MAIN-world fiber bridge（2026-07-28）：content script 在 isolated world，
 * 看不到页面 React 挂在 DOM 元素上的 __reactFiber$ expando（fiber 路径
 * 因此从未在生产真正生效过，一直靠 IDB name cache 兜着）。这个函数被
 * chrome.scripting.executeScript({world:'MAIN'}) 注入页面主世界执行：
 * 轮询 #main fiber 抽当前 chat 模型，把 {rawJid, phoneJid, title,
 * verifiedName} 写到 <html data-sgc-fiber-chat>——DOM 属性跨 world 共享，
 * isolated 侧 readCurrentChat 同步读。@lid 业务号（如 Sima）的真实手机号
 * 只存在于 fiber contact.phoneNumber，IDB 完全没有，这是唯一来源。
 * 注意：函数会被序列化注入，不能引用外部作用域。
 */
export function fiberBridgeMainWorld(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__sgcFiberBridgeActive) {
    if (typeof w.__sgcFiberBridgeRefresh === 'function') w.__sgcFiberBridgeRefresh();
    return;
  }
  w.__sgcFiberBridgeActive = true;

  const pick = (o: unknown, k: string): unknown => {
    if (!o || typeof o !== 'object') return null;
    const rec = o as Record<string, unknown>;
    return rec[k] ?? rec['__x_' + k] ?? null;
  };
  const ser = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const s = (v as Record<string, unknown>)._serialized;
      if (typeof s === 'string') return s;
    }
    return null;
  };
  const PROP_NAMES = ['chat', 'model', 'conversation', 'chatModel', 'peer', 'wid'];
  const extract = (mp: unknown): unknown => {
    if (!mp || typeof mp !== 'object') return null;
    for (const n of PROP_NAMES) {
      const c = (mp as Record<string, unknown>)[n];
      if (c && typeof c === 'object' && ser(pick(c, 'id'))) return c;
    }
    return null;
  };

  const read = (): void => {
    let payload: Record<string, string | null> | null = null;
    let status = 'no-main';
    try {
      const main = document.querySelector('div#main');
      if (main) {
        const key = Object.getOwnPropertyNames(main).find(
          (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
        );
        let cur: unknown = key ? (main as unknown as Record<string, unknown>)[key] : null;
        status = cur ? 'no-chat-model' : 'no-fiber';
        let chat: unknown = null;
        for (let i = 0; cur && i < 30 && !chat; i++) {
          const fiber = cur as Record<string, unknown>;
          chat =
            extract(fiber.memoizedProps) ??
            extract(pick(fiber.stateNode, 'props'));
          if (!chat) cur = fiber.return;
        }
        if (chat) {
          const id = ser(pick(chat, 'id'));
          const contact = pick(chat, 'contact');
          let phoneJid: string | null = null;
          const cands = [
            pick(contact, 'phoneNumber'),
            pick(contact, 'id'),
            pick(contact, 'userid'),
            pick(contact, 'jid'),
          ];
          for (const c of cands) {
            const s = ser(c);
            if (s && s.endsWith('@c.us')) { phoneJid = s; break; }
          }
          if (!phoneJid && typeof chat === 'object') {
            for (const v of Object.values(chat as Record<string, unknown>)) {
              const s = ser(v);
              if (s && s.endsWith('@c.us')) { phoneJid = s; break; }
            }
          }
          const title = pick(chat, 'formattedTitle');
          const verified = pick(contact, 'verifiedName');
          if (id) {
            status = 'model-read';
            payload = {
              rawJid: id,
              phoneJid,
              title: typeof title === 'string' ? title : null,
              verifiedName: typeof verified === 'string' ? verified : null,
            };
          }
        }
      }
    } catch {
      status = 'read-error';
    }
    const v = payload ? JSON.stringify(payload) : '';
    const root = document.documentElement;
    // 即使没有 model，也写入空值，区分“读取过但没找到”与“尚未注入”。
    if (root.getAttribute('data-sgc-fiber-chat') !== v) {
      root.setAttribute('data-sgc-fiber-chat', v);
    }
    if (root.getAttribute('data-sgc-bridge-reader') !== status) {
      root.setAttribute('data-sgc-bridge-reader', status);
    }
  };

  w.__sgcFiberBridgeRefresh = read;
  setInterval(read, 800);
  // 切聊天由点击触发——click 后短延迟补读两次，缩小轮询空窗
  document.addEventListener(
    'click',
    () => { setTimeout(read, 250); setTimeout(read, 900); },
    true,
  );
  read();
}
