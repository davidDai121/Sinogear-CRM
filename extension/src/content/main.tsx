import { createRoot } from 'react-dom/client';
import { AppShell } from '@/panel/AppShell';
import {
  observeCurrentChat,
  refreshChatNameCache,
  type CurrentChat,
} from './whatsapp-dom';
import { ensureJidPhoneCacheLoaded } from '@/lib/jid-phone-cache';
import { initAutoTranslate } from './auto-translate';
import { initChatMediaCapture } from './chat-media-capture';
import { initAutoReply } from './auto-reply';
import '@/panel/styles.css';

const HOST_ID = 'sgc-extension-host';

function mount() {
  if (document.getElementById(HOST_ID)) return;

  document.body.classList.add('sgc-body-shifted');

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);

  const root = createRoot(host);
  root.render(<AppShell />);

  void refreshChatNameCache().then(() => {
    // After cache populated, re-detect current chat (in case initial read missed phone)
    window.dispatchEvent(new CustomEvent('sgc:refresh-chat'));
  });
  setInterval(() => void refreshChatNameCache(), 30000);

  // 加载 jid→phone 持久缓存到内存。@lid 业务号 fiber.contact.phoneNumber
  // 偶尔会空（如 javierulises1412 用户名显示场景），这时 readCurrentChat
  // 需要用 rawJid 反查 cache。content script 跟 panel 是独立模块实例，
  // 各自要 init 一次。
  void ensureJidPhoneCacheLoaded().then(() => {
    window.dispatchEvent(new CustomEvent('sgc:refresh-chat'));
  });

  observeCurrentChat((chat: CurrentChat) => {
    window.dispatchEvent(
      new CustomEvent('sgc:chat-changed', { detail: chat }),
    );
  });

  initAutoTranslate();
  initChatMediaCapture();
  initAutoReply();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
