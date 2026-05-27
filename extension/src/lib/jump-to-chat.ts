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
 * 任一匹配即认定成功：
 *   - phone digits 出现在 header 数字里（备注名客户 header 无数字 → 这条不命中，看 name）
 *   - name / wa_name（trim 后 ≥2 字符）出现在 header 文本里（忽略大小写）
 *   - group_jid 模式下，name 通常等于群名，照样命中 name 检查
 *
 * 双重否定：两个都没命中（phone null + name 太短或不匹配）→ return false。
 * 调用方应拒绝写 DB，避免污染。
 */
export interface RequireMatch {
  phone?: string | null;
  name?: string | null;
  waName?: string | null;
}

export function verifyHeaderMatches(match: RequireMatch): boolean {
  const header = getMainHeaderText();
  if (!header) return false;

  // phone digits 匹配（用户存了备注名也能通过 — header 上 push name 后 WA 往往
  // 会在头像悬浮 / 子标题里显示号码）
  const phoneDigits = (match.phone ?? '').replace(/[^\d]/g, '');
  if (phoneDigits.length >= 6) {
    const headerDigits = header.replace(/[^\d]/g, '');
    if (headerDigits.includes(phoneDigits)) return true;
  }

  // name / wa_name 匹配（长度 ≥ 2 字符才有意义，否则"Yu"这种短名易撞)
  const candidates = [match.name, match.waName]
    .map((s) => s?.trim() ?? '')
    .filter((s) => s.length >= 2);
  const headerLower = header.toLowerCase();
  for (const c of candidates) {
    if (headerLower.includes(c.toLowerCase())) return true;
  }
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
