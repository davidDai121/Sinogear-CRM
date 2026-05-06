import { createRoot } from 'react-dom/client';
import { AppShell } from '@/panel/AppShell';
import {
  observeCurrentChat,
  refreshChatNameCache,
  type CurrentChat,
} from './whatsapp-dom';
import { initAutoTranslate } from './auto-translate';
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

  observeCurrentChat((chat: CurrentChat) => {
    window.dispatchEvent(
      new CustomEvent('sgc:chat-changed', { detail: chat }),
    );
  });

  initAutoTranslate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
