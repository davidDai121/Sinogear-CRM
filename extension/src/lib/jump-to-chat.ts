import { readCurrentChat, readChatTitle } from '@/content/whatsapp-dom';

function findSearchInput(): HTMLInputElement | HTMLElement | null {
  const nativeInput = document.querySelector<HTMLInputElement>(
    'input[type="text"][role="textbox"]',
  );
  if (nativeInput) return nativeInput;

  const byPlaceholder = document.querySelector<HTMLInputElement>(
    'input[placeholder*="搜索"], input[placeholder*="Search"], input[placeholder*="search"]',
  );
  if (byPlaceholder) return byPlaceholder;

  const editable = Array.from(
    document.querySelectorAll<HTMLElement>(
      'div[contenteditable="true"][role="textbox"]',
    ),
  ).find((el) => !el.closest('footer') && !el.closest('#main'));
  return editable ?? null;
}

function setNativeInputValue(el: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function typeIntoEditable(el: HTMLElement, value: string) {
  el.focus();
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  document.execCommand('insertText', false, value);
}

function pressEnter(el: HTMLElement) {
  const opts: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function getMainHeaderText(): string {
  const main = document.querySelector('div#main');
  const header = main?.querySelector('header');
  return header?.textContent?.trim() ?? '';
}

function chatOpenForQuery(query: string): boolean {
  const main = document.querySelector('div#main');
  if (!main) return false;
  const header = main.querySelector('header');
  const headerDigits = header?.textContent?.replace(/[^\d]/g, '') ?? '';
  return headerDigits.includes(query);
}

// WA 通讯录里存了备注名的客户，header 只显示名字（如 "Aca"），头里没数字 →
// chatOpenForQuery 永远 false，触发 deep-link reload。补一个"header 文本变了
// 且非空"的兜底判定：只要点 💬 后聊天面板换了一个有内容的 header，就当成成功。
function headerChangedFrom(initial: string): boolean {
  const cur = getMainHeaderText();
  return Boolean(cur) && cur !== initial;
}

/**
 * 严格判定：当前打开的 chat header 是不是目标 contact。
 *
 * 用于 AI 自动化路径（generate / fill / bulk-extract / auto-reply）—— 这些路径调
 * syncMessages 写 DB，跨聊天污染会永久写入错位的 wa_message_id 到目标 contact。
 *
 * 五档，任一命中即认定成功。前三档比文本（快、但脆），后两档比身份（慢一点、但准）：
 *   1. phone digits 出现在 header 数字里 —— 没存备注名的客户 header 就是号码
 *   2. name / wa_name 剥 emoji 后 ≥2 字符，模糊命中 header
 *   3. name / wa_name 跟**干净标题** readChatTitle() 全等（剥 emoji 后 / 原样两种比法）
 *      —— 1 个字符的名字和纯 emoji 名只能靠这档，因为全等没有子串误撞风险
 *   4. readCurrentChat().phone 跟 contact.phone 数字全等
 *   5. readCurrentChat().groupJid 跟 contact.group_jid 全等（群聊 phone 恒 NULL，
 *      前四档里只有档 2/3 可能命中，群名一改就废，这档是群聊的兜底）
 *
 * 五档全落空 → return false，同时 console.warn 打出每一档用的信号（见 logVerifyFailure）。
 * 调用方应拒绝写 DB，避免污染。
 */
export interface RequireMatch {
  phone?: string | null;
  name?: string | null;
  waName?: string | null;
  /**
   * 群聊必传。群 contact 的 phone 恒为 NULL，phone 那两档（header 数字 /
   * readCurrentChat().phone）全部落空，只剩名字文本 —— 群名是纯 emoji 或
   * 被销售改过就没救了。传了它就能走 groupJid 全等，跟个人客户走 phone 同级。
   */
  groupJid?: string | null;
}

// 剥 Unicode emoji 并 normalize：
//   - 销售在 WA 通讯录给客户起带 emoji 爱称（"K-lonchito 🥰🥰🥰" / "🌸🌸Zouhour🌸🌸"）
//     很常见（org 里 ~2.7% contact 中招），但 WA Web header 文本经常不含这些 emoji
//     或 emoji 位置不同。整串 `headerLower.includes(candidate)` 永远不命中 →
//     verifyHeaderMatches 返 false → DOM 读不了 → AI 生成卡死 + DB 写不了。
//   - 剥范围：\p{Extended_Pictographic} 覆盖绝大多数 emoji base char；\p{Emoji_Modifier}
//     吃肤色 modifier (🏻🏼🏽🏾🏿)；️ (VS16) 切 emoji presentation；‍ (ZWJ)
//     切组合 emoji（family / profession）。**不要用 \p{Emoji}** —— 它把 # * 0-9 等
//     基础字符也算 emoji-candidate，会误剥客户名里的数字。
const EMOJI_STRIP_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200d]/gu;
function stripEmojiAndNormalize(s: string): string {
  return s.replace(EMOJI_STRIP_RE, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 只折空白 + lowercase，**保留 emoji** —— 给纯 emoji 名做原样全等比对用 */
function normalizeKeepingEmoji(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 诊断：verify 失败时把用过的信号全打出来（throttled 5s）。
 *
 * 这个函数返 false 会**同时**掐掉「DOM 读消息喂 AI」和「useMessageSync 写 DB」，
 * 而两边都只是安静地走 fallback —— 销售看到的只有一句"基于导入的历史记录（N 条）"，
 * 察觉不到 AI 正在拿几个月前的老消息回话。@DonSyekei（name="S"、wa_name 空）
 * 就这么潜伏了整整一个季度。以后至少 console 里有一行能直接看出是哪一档没过。
 */
let lastVerifyFailLogAt = 0;
function logVerifyFailure(
  match: RequireMatch,
  info: { title: string | null; headerDigits: string; currentPhone: string | null; currentGroupJid: string | null },
) {
  const now = Date.now();
  if (now - lastVerifyFailLogAt < 5000) return;
  lastVerifyFailLogAt = now;
  console.warn('[sgc/verify-header] 判定当前聊天不是这个客户 —— DOM 读取和消息同步都会被跳过', {
    contactPhone: match.phone ?? null,
    contactGroupJid: match.groupJid ?? null,
    contactName: match.name ?? null,
    contactWaName: match.waName ?? null,
    chatTitle: info.title,
    headerDigits: info.headerDigits,
    resolvedChatPhone: info.currentPhone,
    resolvedChatGroupJid: info.currentGroupJid,
  });
}

export function verifyHeaderMatches(match: RequireMatch): boolean {
  const header = getMainHeaderText();
  const title = readChatTitle();
  // header 和 title 双空 = 聊天面板压根没开，没什么可比的
  if (!header && !title) return false;

  const phoneDigits = (match.phone ?? '').replace(/[^\d]/g, '');
  const headerDigits = header.replace(/[^\d]/g, '');

  // ── 档 1：phone digits 出现在 header 数字里 ──
  // 没存备注名的客户 header 标题直接就是号码，这档最省事。
  if (phoneDigits.length >= 6 && headerDigits.includes(phoneDigits)) return true;

  // ── 档 2：name / wa_name 剥 emoji 后模糊命中 header ──
  // 销售爱给客户起带 emoji 的爱称（"K-lonchito 🥰🥰🥰"），而 header 一般不带
  // 或位置不同，所以两侧都要剥。用 includes 是因为 header 里混着状态行。
  // 代价：必须 ≥ 2 字符，否则 "s" 能命中几乎任何 header → 跨聊天污染。
  // 所以 1 字符名和纯 emoji 名（剥完为空）在这一档必然落空，交给档 3。
  const headerCore = stripEmojiAndNormalize(header);
  const fuzzy = [match.name, match.waName]
    .map((s) => stripEmojiAndNormalize(s ?? ''))
    .filter((s) => s.length >= 2);
  for (const c of fuzzy) {
    if (headerCore.includes(c)) return true;
  }

  // ── 档 3：跟**干净标题**做全等比对 ──
  // readChatTitle() 只取聊天标题（"@DonSyekei"），不含状态行和图标 aria 文案，
  // 所以可以安全地全等 —— 全等没有子串误撞问题，1 个字符也能比。
  //   - 剥 emoji 后全等：名字带 emoji 但标题不带（反之亦然）
  //   - 原样全等：纯 emoji 名（"🌸🌸"），剥完两边都空没法比，只能带 emoji 比
  if (title) {
    const titleStripped = stripEmojiAndNormalize(title);
    const titleRaw = normalizeKeepingEmoji(title);
    for (const raw of [match.name, match.waName]) {
      const v = (raw ?? '').trim();
      if (!v) continue;
      const vStripped = stripEmojiAndNormalize(v);
      // vStripped 为空 = 纯 emoji 名，空串跟空串"相等"是假阳性，跳过让下面原样比
      if (vStripped && vStripped === titleStripped) return true;
      if (normalizeKeepingEmoji(v) === titleRaw) return true;
    }
  }

  // ── 档 4 / 5：WA Web 自己的会话模型（最强，完全不依赖名字文本）──
  // readCurrentChat 走 MAIN-world fiber bridge（带 header 一致性防 stale 校验），
  // 拿不到再退 IDB name→JID 缓存。它解析出的 phone / groupJid 就是绑定这张客户卡
  // 的那个身份，跟 contact 全等即同一个会话。
  //
  // ⚠️ 为什么非要有这两档：上面全是**文本**信号，下面这类客户一条都命中不了 ——
  //   - name 只有 1 个字符（如 "S"）且不等于标题 → 档 2 被长度过滤、档 3 不全等
  //   - wa_name 为 null（contact 由 bulk-sync / .txt 导入 / FB lead 回填建的，
  //     只有 useContact 的 insert 路径会写 wa_name）→ 没有第二个候选
  //   - WA 通讯录存了备注名 → header 里一个数字都没有，档 1 也不命中
  // 三者叠加时函数 fail closed 且**完全静默**：GPTReplySection 跳过 DOM 直接吃
  // messages 表老数据，useMessageSync 也一并 return，于是这个客户的聊天记录既进
  // 不了 DB 也进不了 AI prompt，销售只看到一句"基于导入的历史记录（N 条）"。
  // 实测 @DonSyekei（+17215544721, name="S", wa_name=null）：WA 上 23 条、DB 停在
  // 2025-10 的 11 条，GPT 收到 4 条十月老消息 + "Customer reply in current history: None"。
  let currentPhone: string | null = null;
  let currentGroupJid: string | null = null;
  try {
    const cur = readCurrentChat();
    currentPhone = cur.phone;
    currentGroupJid = cur.groupJid;
  } catch {
    // readCurrentChat 走 DOM + IDB 缓存，异常时当没解析出来（保持 fail closed）
  }

  if (phoneDigits.length >= 6 && currentPhone) {
    const curDigits = currentPhone.replace(/[^\d]/g, '');
    if (curDigits.length >= 6 && curDigits === phoneDigits) return true;
  }

  // 群聊 phone 恒为 NULL，档 1/4 都救不了；groupJid 是它唯一的强身份
  const wantGroupJid = (match.groupJid ?? '').trim();
  if (wantGroupJid && currentGroupJid && currentGroupJid === wantGroupJid) return true;

  logVerifyFailure(match, {
    title,
    headerDigits,
    currentPhone,
    currentGroupJid,
  });
  return false;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const ONLY_DIGITS = /^\d+$/;

export interface JumpOptions {
  /**
   * 搜索框找不到时是否 fallback 到 WA Web 的 /send?phone= 协议。
   * - true：触发当前 tab 内 reload 跳到 send 协议（WA Web 的 ServiceWorker
   *   会快速重启 SPA 并打开/创建对应 chat）。适用于"用户点了 💬 跳转"这类
   *   主动操作。代价：CRM panel 状态会重置（Gem 草稿等已用 chrome.storage
   *   持久化，影响有限）。
   * - false（默认）：搜索失败直接 return false，不 reload。适用于批量/自动
   *   场景（bulk-extract、活性体检"实测验证"），避免反复 reload 中断脚本。
   */
  allowDeepLink?: boolean;

  /**
   * 严格身份校验（AI 自动化路径必传）。
   *
   * 跳完后 verifyHeaderMatches(requireMatch) 必须 true 才返回 true，否则 false。
   *
   * 旧的 `headerChangedFrom` 弱兜底（只要 header 变了就算成功）会导致跨聊天污染：
   * 搜索过程中 WA 临时切到错的 chat / 搜不到时停在别的 chat，header 文本变了
   * 就被当成"跳成功"，DOM 读到的是别人的消息，syncMessages 写错位到目标 contact。
   *
   * 传 requireMatch 后：
   *   - 跳完用 verifyHeaderMatches 校验（phone digits 或 name 命中 header）
   *   - 不命中 → 不再走 headerChangedFrom 兜底 → return false
   *   - 调用方拿到 false 应拒绝写 DB（避免污染）
   *
   * 不传时保持旧行为（用户主动点 💬 跳转用宽松判定，搜不到时 deepLink 自救）。
   */
  requireMatch?: RequireMatch;
}

export async function jumpToChat(
  query: string,
  opts: JumpOptions = {},
): Promise<boolean> {
  // 判定"已到位"的工厂：传了 requireMatch 用严格判定，否则用旧的 chatOpenForQuery
  const strict = opts.requireMatch;
  const isMatch = (initialHeader: string): boolean => {
    if (strict) return verifyHeaderMatches(strict);
    return chatOpenForQuery(query) || headerChangedFrom(initialHeader);
  };

  // 已经在目标 chat 上（搜都不用搜）
  if (strict ? verifyHeaderMatches(strict) : chatOpenForQuery(query)) return true;

  // 记下点 💬 之前的 header 文本——之后用来判断"聊天面板有没有切到新的"
  const initialHeader = getMainHeaderText();

  const input = findSearchInput();
  if (input) {
    input.focus();

    if (input instanceof HTMLInputElement) {
      setNativeInputValue(input, '');
      await sleep(80);
      setNativeInputValue(input, query);
    } else {
      typeIntoEditable(input, query);
    }

    await sleep(600);

    pressEnter(input);

    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (isMatch(initialHeader)) return true;
    }

    pressEnter(input);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (isMatch(initialHeader)) return true;
    }
  }

  // Fallback：WA Web 内置搜索找不到，但号码可能在 WhatsApp 注册过（手机端能搜到、
  // 或我们已经导入过该客户的 .txt 聊天历史）。走 WA Web 官方的 click-to-chat 协议
  // (/send?phone=...) 让服务端解析号码 + 创建会话。会触发当前 tab 内 reload，
  // 所以仅在调用方明确允许时启用。
  if (opts.allowDeepLink && ONLY_DIGITS.test(query)) {
    window.location.href = `${location.origin}/send?phone=${query}`;
    // navigate 已经发起，页面即将 reload — 这里 await 一段时间让浏览器走完，
    // 永远不会真的 resolve（reload 中断了 JS 执行）。返回 true 表达"已触发跳转"。
    await sleep(5000);
    return true;
  }

  return false;
}
