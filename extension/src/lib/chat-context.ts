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
 */
// 只 import 类型——真实实现全部惰性加载（见 realDeps）。这个模块的编排逻辑
// 要能在 node --test 里跑（scripts/test-chat-context.mjs 注入 fake deps），
// 顶层 import supabase / chrome 依赖会让测试在 import 时就崩
import type { RequireMatch } from '@/lib/jump-to-chat';
import type { ChatMessage } from '@/content/whatsapp-messages';

export type MessageSource = 'dom' | 'db' | 'guidance';

/** 身份字段子集——ContactRow 结构兼容，可以直接传整个 contact */
export interface ChatContextTarget {
  id: string;
  phone: string | null;
  name: string | null;
  wa_name: string | null;
  group_jid: string | null;
}

export interface LoadChatContextOptions {
  /**
   * true = 先 jumpToChat 到目标客户（drawer / 客户 tab 场景）；
   * false = 假定当前 WA chat 就是目标（聊天 tab ContactCard 场景），
   * 但仍会 verify —— React state 跟当前 WA chat 之间有短暂 race。
   */
  needsJump: boolean;
  /** 日志标识，如 'GPTReplySection.generate' */
  logTag: string;
  /**
   * 销售指令文本。传了这个字段（哪怕空串）表示调用方支持「按指令冷启动」：
   * DB 也没历史时，指令非空 → 返回 source='guidance' 而不是抛错。
   */
  guidance?: string;
  /**
   * true = await syncMessages 且失败时抛错（GPT 跟进保存前必须确保最新消息
   * 已入库）；默认 fire-and-forget。
   */
  awaitSync?: boolean;
  /** true = DOM 路径向上滚动补采更多历史（collectRecentChatMessages，GPT 用） */
  collectRecent?: boolean;
  /** DB 兜底 / merge 的条数，默认 50 */
  dbLimit?: number;
}

export interface ChatContext {
  messages: ChatMessage[];
  source: MessageSource;
}

export function dbRowsToChatMessages(
  rows: Array<{
    wa_message_id: string;
    direction: string;
    text: string;
    sent_at: string | null;
  }>,
): ChatMessage[] {
  return rows.map((r) => ({
    id: r.wa_message_id,
    fromMe: r.direction === 'outbound',
    text: r.text,
    timestamp: r.sent_at ? new Date(r.sent_at).getTime() : null,
    // DB 历史没存 sender；群聊 fallback 时拿不到，prompt 里仍按 fromMe 区分
    sender: null,
  }));
}

function coldStartError(supportsGuidance: boolean): Error {
  return new Error(
    supportsGuidance
      ? '当前聊天没有可读消息，且数据库里也没历史记录。请先打开 WhatsApp 聊天加载消息，「客户」tab 用「📥 导入手机聊天」导入 .txt 历史，或在下方"销售指令"里写明意图来冷启动。'
      : '当前聊天没有可读消息，且数据库里也没历史记录。请先打开 WhatsApp 聊天加载消息，或在「客户」tab 用「📥 导入手机聊天」导入 .txt 历史。',
  );
}

/** 编排逻辑的全部外部依赖——测试时注入 fake（见 scripts/test-chat-context.mjs） */
export interface ChatContextDeps {
  jumpToChat: (
    query: string,
    opts: { requireMatch: RequireMatch },
  ) => Promise<boolean>;
  verifyHeaderMatches: (requireMatch: RequireMatch) => boolean;
  waitForChatMessages: (
    timeoutMs: number,
    intervalMs: number,
    minCount: number,
  ) => Promise<ChatMessage[]>;
  collectRecentChatMessages: (
    stillOnChat: () => boolean,
  ) => Promise<ChatMessage[]>;
  loadMessages: (
    contactId: string,
    limit: number,
  ) => Promise<
    Array<{
      wa_message_id: string;
      direction: string;
      text: string;
      sent_at: string | null;
    }>
  >;
  mergeDomWithDbMessages: (
    dom: ChatMessage[],
    contactId: string,
    limit: number,
  ) => Promise<ChatMessage[]>;
  syncMessages: (
    contactId: string,
    messages: ChatMessage[],
  ) => Promise<{ error?: string } | undefined | void>;
  maybeLogReadFailure: (reason: string) => void;
}

async function realDeps(): Promise<ChatContextDeps> {
  const [jump, msgs, snapshot, sync] = await Promise.all([
    import('@/lib/jump-to-chat'),
    import('@/content/whatsapp-messages'),
    import('@/content/whatsapp-message-snapshot'),
    import('@/lib/message-sync'),
  ]);
  return {
    jumpToChat: jump.jumpToChat,
    verifyHeaderMatches: jump.verifyHeaderMatches,
    waitForChatMessages: msgs.waitForChatMessages,
    maybeLogReadFailure: msgs.maybeLogReadFailure,
    collectRecentChatMessages: snapshot.collectRecentChatMessages,
    loadMessages: sync.loadMessages,
    mergeDomWithDbMessages: sync.mergeDomWithDbMessages,
    syncMessages: sync.syncMessages,
  };
}

/**
 * 读目标客户的聊天消息：DOM 优先（持久化 + merge DB 补齐），DOM 空时
 * fallback 纯 DB，两边都空按 guidance 冷启动或抛错。
 *
 * DOM 路径必须 merge DB：WA Web 渲染消息从下往上慢慢出现，销售刚发完图
 * 就点 Generate 时 DOM 可能只有最新 1 条 bubble，DB 兜底把老消息加回来。
 * 同时 syncMessages 让本次 DOM 持久化，下次即使 DOM 全丢（虚拟滚动）也能
 * 从 DB 完整恢复。
 */
export async function loadChatContext(
  target: ChatContextTarget,
  opts: LoadChatContextOptions,
): Promise<ChatContext> {
  return loadChatContextWith(await realDeps(), target, opts);
}

export async function loadChatContextWith(
  deps: ChatContextDeps,
  target: ChatContextTarget,
  opts: LoadChatContextOptions,
): Promise<ChatContext> {
  const {
    jumpToChat,
    verifyHeaderMatches,
    waitForChatMessages,
    collectRecentChatMessages,
    loadMessages,
    mergeDomWithDbMessages,
    syncMessages,
    maybeLogReadFailure,
  } = deps;
  // 严格身份校验 —— 必传，防止 jumpToChat 跳错 chat 后 DOM 读到的是别人的
  // 消息被 syncMessages 写错位到当前 contact，永久污染 messages 表
  const requireMatch: RequireMatch = {
    phone: target.phone,
    name: target.name,
    waName: target.wa_name,
    groupJid: target.group_jid,
  };
  const dbLimit = opts.dbLimit ?? 50;

  let dom: ChatMessage[] = [];
  if (opts.needsJump) {
    // 个人按手机号跳，群按群名跳（jumpToChat 会按搜索匹配上）
    const query = target.phone
      ? target.phone.replace(/^\+/, '')
      : target.name?.trim() || target.wa_name?.trim() || '';
    if (query) {
      const ok = await jumpToChat(query, { requireMatch });
      if (ok) dom = await waitForChatMessages(5000, 30, 1);
    } else {
      dom = await waitForChatMessages(5000, 30, 1);
    }
  } else if (verifyHeaderMatches(requireMatch)) {
    dom = await waitForChatMessages(5000, 30, 1);
  }

  // 写 DB 前最后一次 sanity check（防 race：期间用户手动切走 WA chat）
  if (dom.length > 0 && !verifyHeaderMatches(requireMatch)) {
    console.warn(
      `[${opts.logTag}] DOM 不再是目标客户（用户切了 WA chat？），放弃 DOM 消息走 DB`,
      { contactId: target.id, phone: target.phone },
    );
    dom = [];
  }

  if (opts.collectRecent && verifyHeaderMatches(requireMatch)) {
    dom = await collectRecentChatMessages(() =>
      verifyHeaderMatches(requireMatch),
    );
  }

  if (dom.length > 0) {
    if (opts.awaitSync) {
      const synced = await syncMessages(target.id, dom);
      if (synced?.error) {
        throw new Error(`最新消息未同步，未用旧记录判断跟进：${synced.error}`);
      }
    } else {
      void syncMessages(target.id, dom);
    }
    const merged = await mergeDomWithDbMessages(dom, target.id, dbLimit);
    return { messages: merged, source: 'dom' };
  }

  // DOM 空 → 纯 DB（导入的历史 + 之前 useMessageSync 同步过的）
  const rows = await loadMessages(target.id, dbLimit);
  if (rows.length === 0) {
    if (opts.guidance?.trim()) {
      // 冷启动：完全没历史，但销售指令里写了意图 → 按指令冷开
      //（用于新客户首条开场白，如 FB lead 注册没说话就要主动推车）
      return { messages: [], source: 'guidance' };
    }
    maybeLogReadFailure(`${opts.logTag} cold-start`);
    throw coldStartError(opts.guidance !== undefined);
  }
  return { messages: dbRowsToChatMessages(rows), source: 'db' };
}

/**
 * 群聊：从 WA IDB 拉成员名单（喂 AI prompt 用）。
 * 之前 GPT / Gem 各写了一份完全相同的实现。拿不到成员不致命，返回 undefined。
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
