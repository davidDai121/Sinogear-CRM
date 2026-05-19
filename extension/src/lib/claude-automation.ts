/**
 * Claude.ai 网页自动化（service worker 端）
 *
 * 跟 gem-automation.ts 同一套思路，但 target 是 claude.ai：
 *   1. chrome.tabs.create 打开 claude.ai/new（或上次的 chat URL 续聊）
 *   2. 轮询 tab 状态直到 complete + 检查 auth（未登录跳 claude.ai/login）
 *   3. 注入脚本：等 .ProseMirror 输入框 → 填 prompt → 点发送（或 Enter）
 *   4. 注入脚本轮询响应：先等 Stop 按钮出现，再等它消失（流结束）
 *   5. 取最终 chat URL（claude.ai/chat/<uuid>），关闭 tab，返回结果
 *
 * 一次只跑一个任务（busy flag 串行），跟 Gem 互不干扰。
 *
 * DOM 假设（基于 2026 年的 claude.ai 结构 + 多重 fallback）：
 *   - 输入框：div.ProseMirror[contenteditable="true"]
 *   - 发送按钮：button[aria-label*="Send" i]，附近其他按钮（attach/voice）有黑名单兜底
 *   - 响应：每个 assistant 回合是一个 .font-claude-message 容器（或 .prose）
 *   - 流式：底部有 Stop 按钮 `button[aria-label*="Stop" i]`
 *   - 完成：Stop 消失 + Copy 按钮在最后一条消息下出现
 *
 * 如果 DOM 变了：调整 SELECTOR_* 常量，多重 fallback 已经留好位置
 */

export interface ClaudeRunOptions {
  /** 打开的 URL：新对话用 'https://claude.ai/new'；续聊用上次的 chat URL */
  url: string;
  /** 第一条要发给 Claude 的消息 */
  prompt: string;
  /** 前台（active tab）开 true 便于调试，默认 false 后台跑 */
  active?: boolean;
  /** 响应总超时，默认 240s（Opus 长回复可能慢） */
  responseTimeoutMs?: number;
}

export interface ClaudeRunResult {
  responseText: string;
  /** 发送后 claude.ai 跳转到的 chat URL（claude.ai/chat/<uuid>） */
  chatUrl: string;
}

let busy = false;

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  if (busy) {
    throw new Error('Claude 正在处理上一个客户，请稍后再试');
  }
  busy = true;

  let tabId: number | null = null;
  try {
    const tab = await chrome.tabs.create({
      url: opts.url,
      active: opts.active ?? false,
    });
    if (tab.id == null) throw new Error('无法创建 Claude 标签页');
    tabId = tab.id;

    await waitForTabComplete(tabId);
    await checkAuth(tabId);
    await waitForInput(tabId);
    await typeAndSend(tabId, opts.prompt);
    const responseText = await waitForResponse(
      tabId,
      opts.responseTimeoutMs ?? 240000,
    );

    const finalTab = await chrome.tabs.get(tabId);
    const chatUrl = finalTab.url ?? opts.url;

    await chrome.tabs.remove(tabId).catch(() => {});
    return { responseText, chatUrl };
  } catch (err) {
    if (tabId !== null) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
    throw err;
  } finally {
    busy = false;
  }
}

export function isBusy(): boolean {
  return busy;
}

// ── tab 阶段 ──

async function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Claude 标签页已被关闭');
    if (tab.status === 'complete') {
      // SPA hydration buffer
      await sleep(2000);
      return;
    }
    await sleep(500);
  }
  throw new Error('Claude 加载超时');
}

async function checkAuth(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  // claude.ai/login or anthropic login flow
  if (/claude\.ai\/(login|signin)/i.test(url) || /anthropic\.com/i.test(url)) {
    throw new Error('CLAUDE_AUTH_REQUIRED');
  }
  // Rate limit / error pages
  const issue = await execute<{ rateLimited: boolean; errored: boolean }>(
    tabId,
    () => {
      const bodyText = document.body?.innerText?.slice(0, 500) ?? '';
      const titleText = document.title ?? '';
      const haystack = `${titleText} ${bodyText}`;
      return {
        rateLimited:
          /reached your\s*(usage|message)\s*(limit|cap)|out of (messages|free messages)|you've sent too many|rate limit/i.test(
            haystack,
          ),
        errored: /502|503|504|something went wrong|Try again later/i.test(
          haystack,
        ),
      };
    },
  );
  if (issue?.rateLimited) {
    throw new Error('Claude 用量已满（Max 订阅触顶），请等几小时后再试');
  }
  if (issue?.errored) {
    throw new Error('claude.ai 返回错误页（5xx 或临时故障），稍后再试');
  }
}

// ── 输入 ──

async function waitForInput(tabId: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await execute<boolean>(tabId, () => {
      const sel =
        '.ProseMirror, div[contenteditable="true"][role="textbox"], div[contenteditable="true"], textarea[placeholder], textarea';
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (found) {
      await sleep(500);
      return;
    }
    await sleep(800);
  }
  throw new Error('未找到 Claude 输入框（DOM 可能变了，需要更新 selector）');
}

async function typeAndSend(tabId: number, text: string): Promise<void> {
  // 1. 填入输入框
  const ok = await execute<boolean>(
    tabId,
    (text: string) => {
      const sels = [
        '.ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea[placeholder]',
        'textarea',
      ];
      let input: HTMLElement | null = null;
      for (const s of sels) {
        input = document.querySelector(s) as HTMLElement | null;
        if (input) {
          const r = input.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) break;
          input = null;
        }
      }
      if (!input) return false;

      input.focus();

      if (input instanceof HTMLTextAreaElement) {
        // 用原生 setter 触发 React onChange
        const desc = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        );
        desc?.set?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // ProseMirror: paste 事件最稳（execCommand insertText 在某些版本不触发 update）
        let inserted = false;
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const pasted = input.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
          // 检查输入框真的拿到了内容
          inserted = pasted && (input.innerText.length > 0 || input.textContent!.length > 0);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          try {
            inserted = document.execCommand('insertText', false, text);
          } catch {
            inserted = false;
          }
        }
        if (!inserted) {
          // 最后兜底：直接 textContent + 触发 input
          input.textContent = text;
          input.dispatchEvent(
            new InputEvent('input', { inputType: 'insertText', bubbles: true }),
          );
        }
      }
      return true;
    },
    [text],
  );

  if (!ok) throw new Error('无法填入 Claude 输入框');
  await sleep(1000);

  // 2. 点发送按钮
  //
  // 同 gem-automation 雷区：避免误点 Attach/Voice/Cancel/Stop 等按钮。
  // 策略：
  //   1. 从输入框向上找包裹整个 composer 的容器
  //   2. 容器内按 aria-label 严格匹配 send
  //   3. 黑名单排除 attach/upload/voice/stop/cancel/copy/edit/retry/new chat
  //   4. 多候选按"离输入框最近"排
  //   5. 实在找不到 fallback Enter
  const clicked = await execute<boolean>(tabId, () => {
    const inputSels = [
      '.ProseMirror',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea',
    ];
    let input: HTMLElement | null = null;
    for (const s of inputSels) {
      input = document.querySelector(s) as HTMLElement | null;
      if (input) {
        const r = input.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) break;
        input = null;
      }
    }

    function isSendCandidate(btn: HTMLButtonElement): boolean {
      if (btn.disabled) return false;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;

      const label = (btn.getAttribute('aria-label') ?? '').toLowerCase().trim();
      const testId = (btn.getAttribute('data-testid') ?? '').toLowerCase();
      const cls = (btn.className ?? '').toString().toLowerCase();
      const haystack = `${label} ${testId} ${cls}`;

      // 黑名单：明显不是发送的
      if (
        /(attach|upload|file|image|图片|文件|附件|voice|mic|麦克|recording|录音|stop|停止|cancel|取消|copy|复制|edit|编辑|retry|重试|regenerate|重新生成|new\s*chat|new\s*conversation|新对话|history|历史|menu|menu|setting|账户|profile|sidebar|侧边|toggle|model|模型|switch|share|分享|export|导出)/i.test(
          haystack,
        )
      ) {
        return false;
      }

      // 白名单：发送典型标识
      return (
        /^send$/i.test(label) ||
        /^submit$/i.test(label) ||
        /^发送$/.test(label) ||
        /send\s*(message|prompt)?/i.test(label) ||
        /发送(消息|提示)?/.test(label) ||
        /send[-_]?button/i.test(testId) ||
        /send[-_]?button/i.test(cls)
      );
    }

    // 从输入框向上找 composer 容器
    let scope: HTMLElement | Document = document;
    if (input) {
      let parent: HTMLElement | null = input.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
        const within = Array.from(
          parent.querySelectorAll('button'),
        ) as HTMLButtonElement[];
        if (within.some(isSendCandidate)) {
          scope = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }

    const candidates = (
      Array.from(scope.querySelectorAll('button')) as HTMLButtonElement[]
    ).filter(isSendCandidate);

    if (candidates.length > 0) {
      let best = candidates[0];
      if (candidates.length > 1 && input) {
        const ir = input.getBoundingClientRect();
        const inputCenter = { x: ir.right, y: ir.bottom };
        candidates.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const aDist = Math.hypot(
            ar.left + ar.width / 2 - inputCenter.x,
            ar.top + ar.height / 2 - inputCenter.y,
          );
          const bDist = Math.hypot(
            br.left + br.width / 2 - inputCenter.x,
            br.top + br.height / 2 - inputCenter.y,
          );
          return aDist - bDist;
        });
        best = candidates[0];
      }
      best.click();
      return true;
    }

    // Fallback: Enter on ProseMirror（Claude 上 Enter 是发送）
    if (input) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    }
    return false;
  });

  if (!clicked) throw new Error('找不到 Claude 发送按钮');
}

// ── 等响应 ──

/**
 * 主信号：Stop 按钮存在 → 正在写；消失 → 完成
 * 后备：内容连续 6 次（18s）不变 + 至少 100 字符 + Copy 按钮已出现
 */
async function waitForResponse(
  tabId: number,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();

  // 1. 等响应元素或 stop 按钮出现（Claude 开始写）
  let appeared = false;
  while (Date.now() - start < 60000) {
    const has = await execute<boolean>(tabId, () => {
      const stopBtn = document.querySelector(
        'button[aria-label*="Stop" i], button[aria-label*="停止"]',
      );
      // assistant 消息容器候选（多种 class 兜底）
      const msg = document.querySelector(
        '.font-claude-message, [data-test-render-count], div[class*="message-content"], div.prose',
      );
      return !!(stopBtn || msg);
    });
    if (has) {
      appeared = true;
      break;
    }
    await sleep(2000);
  }
  if (!appeared) {
    throw new Error('Claude 未开始回复（60 秒内无响应迹象）');
  }

  // 2. 给 Claude 时间真正开始（避免误判第一帧空状态）
  await sleep(3000);

  let lastContent = '';
  let stableCount = 0;
  let sawGenerating = false;

  while (Date.now() - start < timeoutMs) {
    const state = await execute<{
      generating: boolean;
      hasCopyBtn: boolean;
      content: string;
    }>(tabId, () => {
      const stopBtn = document.querySelector(
        'button[aria-label*="Stop response" i], button[aria-label*="Stop generating" i], button[aria-label*="Stop" i], button[aria-label*="停止" i]',
      );
      // 在底部最近一个 assistant 消息里找 copy 按钮（出现 = 该消息写完）
      const copyBtn = document.querySelector(
        'button[aria-label*="Copy" i], button[aria-label*="复制" i], button[data-testid*="copy" i]',
      );

      // 提取最后一条 assistant 消息文本
      // 多种候选 selector，依次尝试
      const msgSelectors = [
        '.font-claude-message',
        '[data-test-render-count]',
        'div[class*="message-content"]',
        'div.prose',
      ];
      let content = '';
      for (const sel of msgSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const last = els[els.length - 1] as HTMLElement;
          const t = (last.innerText ?? last.textContent ?? '').trim();
          if (t) {
            content = t;
            break;
          }
        }
      }

      return {
        generating: !!stopBtn,
        hasCopyBtn: !!copyBtn,
        content,
      };
    });

    if (state.generating) sawGenerating = true;

    // 主路径：曾看到生成中 + 现在消失 → 完成
    if (sawGenerating && !state.generating && state.content.length > 30) {
      // 再等 2s 避免按钮闪一下又回来
      await sleep(2500);
      const final = await execute<{ generating: boolean; content: string }>(
        tabId,
        () => {
          const stopBtn = document.querySelector(
            'button[aria-label*="Stop" i], button[aria-label*="停止" i]',
          );
          const msgSelectors = [
            '.font-claude-message',
            '[data-test-render-count]',
            'div[class*="message-content"]',
            'div.prose',
          ];
          let content = '';
          for (const sel of msgSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              const last = els[els.length - 1] as HTMLElement;
              const t = (last.innerText ?? last.textContent ?? '').trim();
              if (t) {
                content = t;
                break;
              }
            }
          }
          return { generating: !!stopBtn, content };
        },
      );
      if (!final.generating && final.content.length >= state.content.length) {
        return final.content;
      }
      // 又开始生成了 → 继续等
      lastContent = final.content;
      stableCount = 0;
      await sleep(2500);
      continue;
    }

    // 后备：从未看到 Stop 按钮（可能 DOM 变了）→ 靠内容稳定 + Copy 按钮判定
    if (!sawGenerating) {
      if (
        state.content &&
        state.content.length > 100 &&
        state.content === lastContent &&
        state.hasCopyBtn
      ) {
        stableCount++;
        if (stableCount >= 3) return state.content;
      } else {
        stableCount = 0;
      }
    }

    lastContent = state.content;
    await sleep(3000);
  }

  if (lastContent && lastContent.length > 50) {
    return lastContent;
  }
  throw new Error('Claude 响应超时');
}

// ── helpers ──

async function execute<T>(
  tabId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: any[]) => T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[] = [],
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return results[0]?.result as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
