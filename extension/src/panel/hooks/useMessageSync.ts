import { useEffect, useState } from 'react';
import {
  readChatMessages,
  waitForChatMessages,
} from '@/content/whatsapp-messages';
import { countMessages, syncMessages } from '@/lib/message-sync';
import { bumpHandler } from '@/lib/contact-handlers';

interface UseMessageSyncResult {
  /** Supabase 中已存的消息总数 */
  count: number;
  /** 上次 sync 插入的新条数（done 时更新） */
  lastInserted: number | null;
  /** 是否在执行 sync */
  syncing: boolean;
  /** 手动触发 sync 当前可见消息 */
  triggerSync: () => Promise<void>;
}

/**
 * 自动把 WhatsApp Web 当前聊天可见的消息 sync 到 Supabase 的 messages 表。
 *
 * - 仅在 needsJump=false 时（用户当前已经在该聊天）自动 sync
 * - 切换 contactId 时重新 sync
 * - 用 wa_message_id 去重，重复调用安全
 */
export function useMessageSync(
  contactId: string | null,
  needsJump?: boolean,
): UseMessageSyncResult {
  const [count, setCount] = useState(0);
  const [lastInserted, setLastInserted] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 加载已存数量
  useEffect(() => {
    if (!contactId) {
      setCount(0);
      return;
    }
    void countMessages(contactId).then(setCount);
  }, [contactId, refreshKey]);

  // 自动 sync + 登记 contact_handlers 心跳（标记我在跟这个客户）
  useEffect(() => {
    if (!contactId || needsJump) return;
    let cancelled = false;
    void bumpHandler(contactId);
    (async () => {
      setSyncing(true);
      try {
        // 给 WhatsApp DOM 一点时间稳定
        const messages = await waitForChatMessages(3000, 30, 1).catch(() =>
          readChatMessages(30),
        );
        if (cancelled || messages.length === 0) return;
        const result = await syncMessages(contactId, messages);
        if (!cancelled) {
          setLastInserted(result.inserted);
          if (result.inserted > 0) {
            setRefreshKey((k) => k + 1);
          }
        }
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, needsJump]);

  const triggerSync = async () => {
    if (!contactId) return;
    setSyncing(true);
    try {
      const messages = readChatMessages(30);
      if (messages.length === 0) return;
      const result = await syncMessages(contactId, messages);
      setLastInserted(result.inserted);
      setRefreshKey((k) => k + 1);
    } finally {
      setSyncing(false);
    }
  };

  return { count, lastInserted, syncing, triggerSync };
}
