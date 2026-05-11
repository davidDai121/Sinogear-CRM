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

function chatOpenForQuery(query: string): boolean {
  const main = document.querySelector('div#main');
  if (!main) return false;
  const header = main.querySelector('header');
  const headerDigits = header?.textContent?.replace(/[^\d]/g, '') ?? '';
  return headerDigits.includes(query);
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
}

export async function jumpToChat(
  query: string,
  opts: JumpOptions = {},
): Promise<boolean> {
  if (chatOpenForQuery(query)) return true;

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
      if (chatOpenForQuery(query)) return true;
    }

    pressEnter(input);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (chatOpenForQuery(query)) return true;
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
