import { useEffect, useRef, useState } from 'react';
import {
  chatFingerprint,
  readChatMessages,
  waitForChatMessages,
  type ChatMessage,
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

/** 持续同步 polling 间隔（ms） */
const POLL_MS = 4000;

/**
 * 自动把 WhatsApp Web 当前聊天可见的消息 sync 到 Supabase 的 messages 表。
 *
 * - 仅在 needsJump=false 时（用户当前已经在该聊天）同步
 * - 切换 contactId 时重新初始化
 * - mount 后启动 4 秒 polling：DOM 指纹变化才打 DB，无变化零成本
 *   这样销售在打开的聊天里"边聊边新进的双向消息"会持续入库，不止 mount 那一刻的快照
 * - 用 wa_message_id 去重，重复 sync 安全
 */
export function useMessageSync(
  contactId: string | null,
  needsJump?: boolean,
): UseMessageSyncResult {
  const [count, setCount] = useState(0);
  const [lastInserted, setLastInserted] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const inFlightRef = useRef(false);

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
    let lastFingerprint = '';
    let pollTimer: number | null = null;

    void bumpHandler(contactId);

    const doSync = async (messages: ChatMessage[]) => {
      if (cancelled || messages.length === 0) return;
      const fp = chatFingerprint(messages);
      if (fp === lastFingerprint) return;
      if (inFlightRef.current) return; // 上一轮还没回，避免并发
      inFlightRef.current = true;
      lastFingerprint = fp;
      setSyncing(true);
      try {
        const result = await syncMessages(contactId, messages);
        if (cancelled) return;
        setLastInserted(result.inserted);
        if (result.inserted > 0) {
          setRefreshKey((k) => k + 1);
        }
      } finally {
        inFlightRef.current = false;
        if (!cancelled) setSyncing(false);
      }
    };

    const tick = () => {
      if (cancelled) return;
      const msgs = readChatMessages(30);
      void doSync(msgs);
    };

    (async () => {
      // 首次：等 DOM 稳定后跑一次
      const initial = await waitForChatMessages(3000, 30, 1).catch(() =>
        readChatMessages(30),
      );
      if (cancelled) return;
      await doSync(initial);
      if (cancelled) return;
      // 之后每 4 秒检查一次（指纹未变则跳过 DB 调用）
      pollTimer = window.setInterval(tick, POLL_MS);
    })();

    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
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
