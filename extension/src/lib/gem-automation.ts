/**
 * Gemini Gem 自动化（service worker 端）
 *
 * 流程：
 *   1. chrome.tabs.create 打开 Gem URL（背景或前景）
 *   2. 轮询 tab 状态直到 complete + 检查 auth
 *   3. 注入脚本：等输入框 → 填 prompt → 点发送
 *   4. 注入脚本轮询 .model-response-text，内容稳定 3 次 + 5s 确认
 *   5. 取最终 chat URL，关闭 tab，返回结果
 *
 * 一次只跑一个 Gem 任务（busy flag 串行）。
 */

export interface GemRunOptions {
  url: string;
  prompt: string;
  active?: boolean;
  responseTimeoutMs?: number;
  /**
   * 想要切换到的模型名关键词列表。匹配任一即可。
   * 例如 ['Pro', '专业', '高级', 'Advanced'] 在中英文界面都能找到 Pro 模型。
   */
  preferModel?: string[];
}

export interface GemRunResult {
  responseText: string;
  chatUrl: string;
  modelSelected: string | null;
}

let busy = false;

export async function runGem(opts: GemRunOptions): Promise<GemRunResult> {
  if (busy) {
    throw new Error('Gemini 正在处理上一个客户，请稍后再试');
  }
  busy = true;

  let tabId: number | null = null;
  try {
    const tab = await chrome.tabs.create({
      url: opts.url,
      active: opts.active ?? false,
    });
    if (tab.id == null) throw new Error('无法创建 Gemini 标签页');
    tabId = tab.id;

    await waitForTabComplete(tabId);
    await checkAuth(tabId);
    await waitForInput(tabId);
    const modelSelected =
      opts.preferModel && opts.preferModel.length
        ? await selectModel(tabId, opts.preferModel)
        : null;
    await typeAndSend(tabId, opts.prompt);
    const responseText = await waitForResponse(
      tabId,
      opts.responseTimeoutMs ?? 240000,
    );

    const finalTab = await chrome.tabs.get(tabId);
    const chatUrl = finalTab.url ?? opts.url;

    await chrome.tabs.remove(tabId).catch(() => {});
    return { responseText, chatUrl, modelSelected };
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
    if (!tab) throw new Error('Gemini 标签页已被关闭');
    if (tab.status === 'complete') {
      // give SPA a beat to render
      await sleep(2000);
      return;
    }
    await sleep(500);
  }
  throw new Error('Gemini 加载超时');
}

async function checkAuth(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  if (url.includes('accounts.google.com') || url.includes('signin')) {
    throw new Error('GEMINI_AUTH_REQUIRED');
  }
  // Detect Google 5xx error pages
  const errorOnPage = await execute<boolean>(tabId, () => {
    const text =
      document.title + ' ' + (document.body?.innerText?.slice(0, 200) ?? '');
    return /502|503|Server Error|That's an error/i.test(text);
  });
  if (errorOnPage) {
    throw new Error('Gemini 返回 502/503，可能是登录过期');
  }
}

// ── 输入 ──

async function waitForInput(tabId: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await execute<boolean>(tabId, () => {
      const sel =
        '.ql-editor, rich-textarea [contenteditable="true"], [contenteditable="true"], textarea, [role="textbox"]';
      return !!document.querySelector(sel);
    });
    if (found) {
      await sleep(500);
      return;
    }
    await sleep(800);
  }
  throw new Error('未找到 Gemini 输入框');
}

/**
 * 尝试在 Gemini 页面切换模型（如 "Pro"）。
 * Best-effort：找不到下拉就 silent skip，返回选中的模型名（或 null）。
 *
 * 流程：
 *   1. 找模型触发器按钮（中文显示"快速 v"，英文显示"Flash"等；文字短）
 *   2. 点开，等菜单出现
 *   3. 在菜单 ([role=menuitem|option]) 里找匹配 prefer 任一关键词、且不含 Flash/快速 的项 → 点击
 *
 * 适配 Gemini 3：菜单项有 快速 / 思考 / Pro / Google AI Ultra
 */
async function selectModel(
  tabId: number,
  prefer: string[],
): Promise<string | null> {
  // Step 1: open the dropdown
  const opened = await execute<{
    ok: boolean;
    currentLabel: string | null;
  }>(
    tabId,
    () => {
      const buttons = Array.from(
        document.querySelectorAll('button'),
      ) as HTMLButtonElement[];
      const candidates = buttons.filter((btn) => {
        const text = (btn.textContent ?? '').trim();
        const label = btn.getAttribute('aria-label') ?? '';
        const both = `${text} ${label}`;
        // 触发器文字短，且包含模型相关字眼（中英双语）
        const isModelTrigger =
          /(Flash|Pro|Advanced|快速|思考|高级|专业|Ultra|Gemini\s*[23])/i.test(
            both,
          );
        return isModelTrigger && text.length > 0 && text.length < 30;
      });
      if (candidates.length === 0) {
        return { ok: false, currentLabel: null };
      }
      // 触发器通常在输入框旁边（DOM 后段），且 viewport 内可见。
      // 取最后一个可见的：
      const visible = candidates.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0;
      });
      const trigger = visible[visible.length - 1] ?? candidates[candidates.length - 1];
      const currentLabel = (trigger.textContent ?? '').trim();
      trigger.click();
      return { ok: true, currentLabel };
    },
    [],
  );

  if (!opened.ok) return null;

  // Wait for the menu to render
  await sleep(500);

  // Step 2: click the option matching any `prefer` keyword
  const picked = await execute<string | null>(
    tabId,
    (prefers: string[]) => {
      const items = Array.from(
        document.querySelectorAll('[role="menuitem"], [role="option"]'),
      ) as HTMLElement[];
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const target = items.find((el) => {
        if (!isVisible(el)) return false;
        const text = (el.textContent ?? '').trim();
        // 排除 Flash / 快速（当前选中的或不想要的）
        if (/(Flash|快速)/i.test(text)) return false;
        // 必须匹配任一 prefer 关键词
        return prefers.some((p) => {
          const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // 中文关键词不需要 word boundary（\b 对 CJK 不工作）
          const pattern = /[一-龥]/.test(p)
            ? new RegExp(escaped, 'i')
            : new RegExp(`\\b${escaped}\\b`, 'i');
          return pattern.test(text);
        });
      });
      if (target) {
        target.click();
        const t = (target.textContent ?? '').trim();
        return t.slice(0, 60);
      }
      return null;
    },
    [prefer],
  );

  // Wait for the UI to settle on the new model
  await sleep(500);

  // 关闭 menu（如果还开着）
  await execute<void>(tabId, () => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });

  return picked;
}

async function typeAndSend(tabId: number, text: string): Promise<void> {
  const ok = await execute<boolean>(
    tabId,
    (text: string) => {
      const sels = [
        '.ql-editor',
        'rich-textarea [contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
      ];
      let input: HTMLElement | null = null;
      for (const s of sels) {
        input = document.querySelector(s) as HTMLElement | null;
        if (input) break;
      }
      if (!input) return false;

      input.focus();

      if (input instanceof HTMLTextAreaElement) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // contenteditable: try execCommand first, then paste event fallback
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, text);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          input.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    },
    [text],
  );

  if (!ok) throw new Error('无法填入 Gemini 输入框');
  await sleep(800);

  // Click send button
  const clicked = await execute<boolean>(tabId, () => {
    const btn = document.querySelector(
      'button[aria-label*="Send" i], button[aria-label*="发送"], button[aria-label*="Submit" i]',
    ) as HTMLElement | null;
    if (btn && !(btn as HTMLButtonElement).disabled) {
      btn.click();
      return true;
    }
    // Fallback: simulate Enter on input
    const sels = [
      '.ql-editor',
      'rich-textarea [contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
    ];
    for (const s of sels) {
      const input = document.querySelector(s) as HTMLElement | null;
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
    }
    return false;
  });

  if (!clicked) throw new Error('找不到 Gemini 发送按钮');
}

// ── 等响应 ──

/**
 * 主信号：检测"停止生成"按钮是否还在。
 *   - Gem 还在写 → 停止按钮存在
 *   - 写完  → 停止按钮消失，复制/重试按钮出现
 *
 * 后备信号（按钮检测不到时）：内容连续 6 次（18s）不变 + 至少 200 字符 + 复制按钮出现。
 */
async function waitForResponse(
  tabId: number,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();

  // 1. 等响应元素出现（Gem 开始写）
  let appeared = false;
  while (Date.now() - start < 60000) {
    const has = await execute<boolean>(tabId, () => {
      return !!document.querySelector('.model-response-text');
    });
    if (has) {
      appeared = true;
      break;
    }
    await sleep(2000);
  }
  if (!appeared) {
    throw new Error('Gem 未开始回复（60 秒内无响应元素）');
  }

  // 2. 给 Gem 一点时间真正开始（避免误判第一帧空状态为"完成"）
  await sleep(4000);

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
        'button[aria-label*="Stop" i], button[aria-label*="停止"], button[aria-label*="Cancel" i], button[aria-label*="取消" i]',
      );
      const copyBtn = document.querySelector(
        'message-actions button[aria-label*="Copy" i], message-actions button[aria-label*="复制"], button[data-test-id="copy-button"]',
      );
      const els = document.querySelectorAll('.model-response-text');
      const last = els[els.length - 1];
      return {
        generating: !!stopBtn,
        hasCopyBtn: !!copyBtn,
        content: last?.textContent?.trim() ?? '',
      };
    });

    if (state.generating) sawGenerating = true;

    // 主路径：曾看到生成中信号 + 现在消失 → 完成
    if (sawGenerating && !state.generating && state.content.length > 50) {
      // 再等 3s 避免按钮闪一下又回来（thinking → 继续生成）
      await sleep(3000);
      const final = await execute<{ generating: boolean; content: string }>(
        tabId,
        () => {
          const stopBtn = document.querySelector(
            'button[aria-label*="Stop" i], button[aria-label*="停止"], button[aria-label*="Cancel" i]',
          );
          const els = document.querySelectorAll('.model-response-text');
          const last = els[els.length - 1];
          return {
            generating: !!stopBtn,
            content: last?.textContent?.trim() ?? '',
          };
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

    // 后备路径：从未看到停止按钮（可能 DOM 变了），靠内容稳定 + 复制按钮判定
    if (!sawGenerating) {
      if (
        state.content &&
        state.content.length > 200 &&
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

  if (lastContent && lastContent.length > 100) {
    return lastContent;
  }
  throw new Error('Gem 响应超时');
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
