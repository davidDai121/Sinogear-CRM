import { useEffect, useRef, useState } from 'react';
import {
  chatFingerprint,
  readChatMessages,
  waitForChatMessages,
  type ChatMessage,
} from '@/content/whatsapp-messages';
import { countMessages, syncMessages } from '@/lib/message-sync';
import { bumpHandler } from '@/lib/contact-handlers';
import { verifyHeaderMatches } from '@/lib/jump-to-chat';

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
 * 校验所需：用 phone / name / waName 任一命中当前 WA Web header 才算"现在视野里
 * 的聊天 == 我要 sync 的客户"。任一对得上就算 match（防销售改了备注名等）。
 *
 * ⚠️ 2026-06 Fernando Zavala 案例：useMessageSync 4 秒轮询 readChatMessages
 * 不校验当前 WA 聊天身份。销售切到另一个聊天但 CRM 右 panel 还停在 Fernando 时，
 * tick 会把别人的对话内容写进 Fernando 的 messages 表 → "这不是他的聊天记录"。
 */
export interface MessageSyncIdentity {
  phone?: string | null;
  name?: string | null;
  waName?: string | null;
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
 * - **写入前用 verifyHeaderMatches(identity) 校验** WA Web header 当前聊天是否
 *   匹配 identity，不匹配就跳过——防销售切到另一个聊天时把别人对话写错位置
 */
export function useMessageSync(
  contactId: string | null,
  needsJump?: boolean,
  identity?: MessageSyncIdentity,
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
      // 身份校验：销售可能切到别的聊天但 panel 还停在这个 contact。
      // 不校验就会把别人的消息写错位置（Fernando Zavala case 2026-06）
      if (identity) {
        const ok = verifyHeaderMatches({
          phone: identity.phone ?? null,
          name: identity.name ?? null,
          waName: identity.waName ?? null,
        });
        if (!ok) return; // header 不匹配 → 当前可见聊天不是这个 contact，跳过
      }
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
    // identity 的具体值（primitive）也进 dep，防销售改名后老 closure 用旧值校验
  }, [contactId, needsJump, identity?.phone, identity?.name, identity?.waName]);

  const triggerSync = async () => {
    if (!contactId) return;
    setSyncing(true);
    try {
      const messages = readChatMessages(30);
      if (messages.length === 0) return;
      // 同样的 header 身份校验——手动「💾 同步当前」按钮也不能错位
      if (identity) {
        const ok = verifyHeaderMatches({
          phone: identity.phone ?? null,
          name: identity.name ?? null,
          waName: identity.waName ?? null,
        });
        if (!ok) {
          console.warn(
            '[useMessageSync] triggerSync skipped: WA header 不匹配当前 contact',
          );
          return;
        }
      }
      const result = await syncMessages(contactId, messages);
      setLastInserted(result.inserted);
      setRefreshKey((k) => k + 1);
    } finally {
      setSyncing(false);
    }
  };

  return { count, lastInserted, syncing, triggerSync };
}
