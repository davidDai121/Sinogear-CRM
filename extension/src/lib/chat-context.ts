/**
 * 共享的「读当前客户聊天上下文喂 AI」逻辑。
 *
 * 之前 GPTReplySection / GemReplySection / TagsSection / ContactTasksSection
 * 各自复制了一份「jumpToChat + 身份校验 + DOM 读取 + syncMessages + DB 兜底」，
 * 四份轻微漂移：TagsSection / ContactTasksSection 漏传 requireMatch、
 * syncMessages 前没做 verifyHeaderMatches —— 正是 CLAUDE.md 里 P0 级的
 * 跨聊天污染洞（auto-reply 2026-06-20 修过同款）。统一到这里之后：
 *
 * - jumpToChat 一律带 requireMatch（phone / name / waName / groupJid 五档校验）
 * - 写 messages 表前一律再 verify 一次（防 generate 期间用户切走 WA chat）
 * - DOM 空时统一 fallback 到 messages 表（导入的历史）
 * - 冷启动（DB 也空）统一报错文案；支持销售指令的调用方可按指令冷开
 *
 * ⚠️ jumpToChat 不开 deep-link fallback —— deep link 会整页 reload，
 * 中断正在跑的 AI 调用。
 *
 * 编排逻辑本体在 chat-context-core.ts（纯逻辑、可单测）；这里静态 import
 * 真实依赖后注入。**必须静态 import**：动态 import 会让 Vite 生成新的异步
 * chunk，content script 里 CSS 预加载按页面 origin 解析，报
 * "Unable to preload CSS for /assets/styles-*.css"（2026-09-18 实测踩过）。
 */
import {
  jumpToChat,
  verifyHeaderMatches,
} from '@/lib/jump-to-chat';
import {
  waitForChatMessages,
  maybeLogReadFailure,
} from '@/content/whatsapp-messages';
import { collectRecentChatMessages } from '@/content/whatsapp-message-snapshot';
import {
  loadMessages,
  mergeDomWithDbMessages,
  syncMessages,
} from '@/lib/message-sync';
import {
  loadChatContextWith,
  type ChatContextDeps,
  type ChatContextTarget,
  type LoadChatContextOptions,
  type ChatContext,
} from '@/lib/chat-context-core';

export {
  dbRowsToChatMessages,
  loadChatContextWith,
  type ChatContextDeps,
  type ChatContextTarget,
  type LoadChatContextOptions,
  type ChatContext,
  type MessageSource,
} from '@/lib/chat-context-core';

const realDeps: ChatContextDeps = {
  jumpToChat,
  verifyHeaderMatches,
  waitForChatMessages,
  maybeLogReadFailure,
  collectRecentChatMessages,
  loadMessages,
  mergeDomWithDbMessages,
  syncMessages,
};

export function loadChatContext(
  target: ChatContextTarget,
  opts: LoadChatContextOptions,
): Promise<ChatContext> {
  return loadChatContextWith(realDeps, target, opts);
}

/**
 * 群聊：从 WA IDB 拉成员名单（喂 AI prompt 用）。
 * 之前 GPT / Gem 各写了一份完全相同的实现。拿不到成员不致命，返回 undefined。
 * whatsapp-idb 的动态 import 是原有代码就在用的模式（该 chunk 无 CSS，安全）。
 */
export async function loadGroupMemberNames(
  groupJid: string | null,
): Promise<string[] | undefined> {
  if (!groupJid) return undefined;
  try {
    const { readWhatsAppData } = await import('@/lib/whatsapp-idb');
    const wa = await readWhatsAppData();
    const chat = wa.chats.find((c) => c.id === groupJid);
    if (!chat) return undefined;
    const contactByJid = new Map(wa.contacts.map((c) => [c.id, c]));
    return chat.participants.map((jid) => {
      const c = contactByJid.get(jid);
      return (
        (c?.name ?? '').trim() ||
        (c?.shortName ?? '').trim() ||
        (c?.pushname ?? '').trim() ||
        jid.split('@')[0]
      );
    });
  } catch {
    return undefined;
  }
}
