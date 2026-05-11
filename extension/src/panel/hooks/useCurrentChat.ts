import { useEffect, useState } from 'react';
import { readCurrentChat, type CurrentChat } from '@/content/whatsapp-dom';

const EMPTY: CurrentChat = { name: null, phone: null, rawJid: null, groupJid: null };

export function useCurrentChat(): CurrentChat {
  const [chat, setChat] = useState<CurrentChat>(EMPTY);

  useEffect(() => {
    const initial = readCurrentChat();
    if (initial.phone || initial.groupJid || initial.name) setChat(initial);

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CurrentChat>).detail;
      setChat(detail ?? EMPTY);
    };
    const refreshHandler = () => {
      const current = readCurrentChat();
      if (current.phone || current.groupJid || current.name) setChat(current);
    };
    window.addEventListener('sgc:chat-changed', handler);
    window.addEventListener('sgc:refresh-chat', refreshHandler);
    return () => {
      window.removeEventListener('sgc:chat-changed', handler);
      window.removeEventListener('sgc:refresh-chat', refreshHandler);
    };
  }, []);

  return chat;
}
