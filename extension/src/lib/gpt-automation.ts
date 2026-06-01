/**
 * chatgpt.com 网页自动化（service worker 端）
 *
 * 跟 claude-automation.ts 同一套思路，target 是 chatgpt.com：
 *   1. chrome.tabs.create 打开 chatgpt.com/?model=gpt-5-thinking（或上次的 chat URL 续聊）
 *   2. 轮询 tab 状态直到 complete + 检查 auth（未登录跳 auth.openai.com / chatgpt.com/auth）
 *   3. 注入脚本：等输入框 → 切到 GPT-5 Thinking（如未切）→ 填 prompt → 点发送
 *   4. 注入脚本轮询响应：先等 Stop 按钮出现，再等它消失（流结束）
 *   5. 取最终 chat URL（chatgpt.com/c/<uuid>），关闭 tab，返回结果
 *
 * 一次只跑一个任务（busy flag 串行），跟 Gem / Claude 互不干扰。
 *
 * DOM 假设（基于 2026 年的 chatgpt.com 结构 + 多重 fallback）：
 *   - 输入框：#prompt-textarea（ProseMirror contenteditable）
 *   - 发送按钮：button[data-testid="send-button"] / button[data-testid="composer-send-button"]
 *   - 响应：[data-message-author-role="assistant"] 包裹每个 assistant 回合
 *   - 流式：底部有 Stop 按钮 button[data-testid="stop-button"] / aria-label*="Stop"
 *   - 完成：Stop 消失 + Copy 按钮 button[data-testid="copy-turn-action-button"] 在最后一条消息下出现
 *   - 模型切换器：button[data-testid="model-switcher-dropdown-button"]
 *
 * 如果 DOM 变了：调整 selector 字符串，多重 fallback 已留好位置。
 */

export interface GptRunOptions {
  /** 打开的 URL：新对话用 chatgpt.com/?model=gpt-5-thinking；续聊用上次的 chat URL */
  url: string;
  /** 第一条要发给 GPT 的消息 */
  prompt: string;
  /** 前台（active tab）开 true 便于调试，默认 false 后台跑 */
  active?: boolean;
  /** 响应总超时，默认 360s（GPT-5 Thinking 推理慢） */
  responseTimeoutMs?: number;
  /** 是否尝试切到 GPT-5 Thinking 模型（仅新对话需要；续聊保留上次模型） */
  ensureThinking?: boolean;
}

export interface GptRunResult {
  responseText: string;
  /** 发送后 chatgpt.com 跳转到的 chat URL（chatgpt.com/c/<uuid>） */
  chatUrl: string;
}

let busy = false;

export async function runGpt(opts: GptRunOptions): Promise<GptRunResult> {
  if (busy) {
    throw new Error('GPT 正在处理上一个客户，请稍后再试');
  }
  busy = true;

  let tabId: number | null = null;
  try {
    const tab = await chrome.tabs.create({
      url: opts.url,
      active: opts.active ?? false,
    });
    if (tab.id == null) throw new Error('无法创建 ChatGPT 标签页');
    tabId = tab.id;

    await waitForTabComplete(tabId);
    await checkAuth(tabId);
    await waitForInput(tabId);
    if (opts.ensureThinking) {
      await ensureThinkingModel(tabId);
    }
    await typeAndSend(tabId, opts.prompt);
    const responseText = await waitForResponse(
      tabId,
      opts.responseTimeoutMs ?? 360000,
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
    if (!tab) throw new Error('ChatGPT 标签页已被关闭');
    if (tab.status === 'complete') {
      // SPA hydration buffer
      await sleep(2500);
      return;
    }
    await sleep(500);
  }
  throw new Error('ChatGPT 加载超时');
}

async function checkAuth(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  // chatgpt.com/auth/login or auth.openai.com
  if (
    /chatgpt\.com\/auth/i.test(url) ||
    /auth\.openai\.com/i.test(url) ||
    /accounts\.openai\.com/i.test(url) ||
    /auth0\.openai/i.test(url)
  ) {
    throw new Error('GPT_AUTH_REQUIRED');
  }
  // 检查 "Log in" 按钮 / 错误页
  const issue = await execute<{ needLogin: boolean; rateLimited: boolean; errored: boolean }>(
    tabId,
    () => {
      const bodyText = document.body?.innerText?.slice(0, 800) ?? '';
      const titleText = document.title ?? '';
      const haystack = `${titleText} ${bodyText}`;
      // 未登录通常会显示 "Log in" 大按钮或 welcome 页。
      // 注意：CSS 没有 :contains() 伪类（jQuery 才有），用 querySelector 直接
      // 写会 SyntaxError 让整段脚本 silently 失败。改成按 innerText 文本匹配。
      let loginBtn: Element | null = document.querySelector(
        'button[data-testid="login-button"], a[href*="/auth/login"], a[href*="auth.openai.com"]',
      );
      if (!loginBtn) {
        for (const btn of Array.from(document.querySelectorAll('button, a'))) {
          const txt = (btn.textContent ?? '').trim().toLowerCase();
          if (txt === 'log in' || txt === 'sign in' || txt === 'login' || txt === '登录') {
            loginBtn = btn;
            break;
          }
        }
      }
      // 输入框检查也要逐 selector 找 visible 的（同 waitForInput 教训：
      // ChatGPT 在 ProseMirror 前藏了一个 0×0 fallback textarea）
      let inputBox: HTMLElement | null = null;
      const inputSels = [
        '#prompt-textarea',
        '.ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea[placeholder*="Ask"]',
      ];
      for (const s of inputSels) {
        const els = document.querySelectorAll(s);
        for (const el of Array.from(els) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            inputBox = el;
            break;
          }
        }
        if (inputBox) break;
      }
      return {
        needLogin: !!loginBtn && !inputBox,
        rateLimited:
          /you've reached|usage limit|too many requests|rate limit|please try again later|hit your limit/i.test(
            haystack,
          ),
        errored: /502|503|504|something went wrong|unable to load/i.test(haystack),
      };
    },
  );
  if (issue?.needLogin) {
    throw new Error('GPT_AUTH_REQUIRED');
  }
  if (issue?.rateLimited) {
    throw new Error('ChatGPT 用量已满（Plus/Free 额度触顶），请等几小时后再试');
  }
  if (issue?.errored) {
    throw new Error('chatgpt.com 返回错误页（5xx 或临时故障），稍后再试');
  }
}

// ── 模型切换（GPT-5 Thinking）──

/**
 * 尝试切到 GPT-5 Thinking。chatgpt.com 顶部有 model 切换按钮（标着当前模型名）。
 * URL ?model=gpt-5-thinking 直接命中是首选；如果 UI 上没切过去再走 DOM 点击。
 * DOM 失败不抛错 —— 默认 GPT-5 也能用。
 */
async function ensureThinkingModel(tabId: number): Promise<void> {
  try {
    const result = await execute<{ already: boolean; switched: boolean; reason: string }>(
      tabId,
      () => {
        // 找模型切换按钮（顶部 header）
        const switchBtn = document.querySelector(
          'button[data-testid="model-switcher-dropdown-button"], button[aria-haspopup="menu"][aria-label*="model" i]',
        ) as HTMLButtonElement | null;
        if (!switchBtn) return { already: false, switched: false, reason: 'no-switcher' };

        const currentLabel = (switchBtn.innerText ?? switchBtn.textContent ?? '').toLowerCase();
        if (/thinking|reasoning|思考|推理/i.test(currentLabel)) {
          return { already: true, switched: false, reason: 'already-thinking' };
        }

        // 点开 dropdown
        switchBtn.click();
        return { already: false, switched: false, reason: 'opened-menu' };
      },
    );

    if (result.already) return;
    if (!result.switched && result.reason === 'opened-menu') {
      await sleep(700);
      // 在 dropdown 里找 "Thinking" / "推理" 选项点击
      const clicked = await execute<boolean>(tabId, () => {
        // role=menuitem / role=option 是常见结构
        const items = Array.from(
          document.querySelectorAll(
            '[role="menuitem"], [role="option"], [data-testid*="model-switcher"] button',
          ),
        ) as HTMLElement[];
        for (const item of items) {
          const txt = (item.innerText ?? item.textContent ?? '').toLowerCase();
          if (/thinking|reasoning|思考|推理/i.test(txt) && !/quick|fast|instant/i.test(txt)) {
            item.click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) {
        // 关掉 dropdown 别影响后续操作
        await execute<void>(tabId, () => {
          document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
        });
      }
      await sleep(500);
    }
  } catch {
    // 切换失败不影响主流程，继续用默认模型
  }
}

// ── 输入 ──

async function waitForInput(tabId: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await execute<boolean>(tabId, () => {
      // 关键：必须逐个 selector 试 + 每个都查 visibility。
      // 不能用 querySelector('A, B, C') 因为新版 ChatGPT 在 ProseMirror 之前
      // 放了一个隐藏（0×0）的 <textarea class="wcDTda_fallbackTextarea"> 做
      // a11y / form fallback——comma-list querySelector 返回 DOM 顺序第一个，
      // 永远命中那个隐藏 textarea，visibility 检查永远 false → 30 秒超时。
      const sels = [
        '#prompt-textarea',
        '.ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        '[data-testid="composer-text-input"]',
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder]',
        'textarea',
      ];
      for (const s of sels) {
        const els = document.querySelectorAll(s);
        for (const el of Array.from(els) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    });
    if (found) {
      await sleep(500);
      return;
    }
    await sleep(800);
  }
  throw new Error('未找到 ChatGPT 输入框（DOM 可能变了，需要更新 selector）');
}

async function typeAndSend(tabId: number, text: string): Promise<void> {
  // 1. 填入输入框
  const ok = await execute<boolean>(
    tabId,
    async (text: string) => {
      const sels = [
        '#prompt-textarea',
        '.ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        '[data-testid="composer-text-input"]',
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder]',
        'textarea',
      ];
      let input: HTMLElement | null = null;
      // 逐 selector 找 + 取第一个 visible 的（同 waitForInput 注释，避免被
      // 隐藏的 fallback textarea 抢先）
      outer: for (const s of sels) {
        const els = document.querySelectorAll(s);
        for (const el of Array.from(els) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            input = el;
            break outer;
          }
        }
      }
      if (!input) return false;

      input.focus();

      if (input instanceof HTMLTextAreaElement) {
        const desc = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        );
        desc?.set?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      // ProseMirror / contenteditable：策略取决于长度。
      //
      // ⚠️ ChatGPT 的"超长粘贴自动转附件"陷阱（2026-06 案例）：
      //   - 用户长 prompt（如附 50 条聊天历史）走 paste 路径会被 ChatGPT
      //     的 onPaste handler 拦住，包成 "[Current Time] / Show in text
      //     field" attachment 卡片
      //   - 偶尔卡住、加载失败，prompt 实际发不出去
      //   - execCommand 不触发 paste 事件 → 不会被自动转附件
      // 修法：
      //   - 文本 > AUTO_ATTACH_THRESHOLD 直接走 execCommand，不走 paste
      //   - 短文本继续 paste（一次入位，快）
      //
      // ⚠️ 双重插入坑（用户实测见过 prompt 拼 2 遍）：
      //   1. dispatch paste → ProseMirror 异步处理（有时 > 100ms 才把内容塞入）
      //   2. 50ms 后查长度还是 0 → 判定"没插入" → fallback execCommand 插一遍
      //   3. 然后 ProseMirror 异步 paste 终于落地，再插一遍 → 双倍
      // 修法：
      //   - 每次插入前 hard-clear 输入框
      //   - paste 后等到 ProseMirror 真插入了，最多 800ms（覆盖慢网络/重 DOM）
      //   - 三种方法严格互斥：上一种失败先 clear 再试下一种
      //   - 兜底 final length 检查：超过预期 1.5x 说明又双倍了，强清重写

      // 4000 是 ChatGPT 自动转附件的经验阈值，留点余量取 3500
      const AUTO_ATTACH_THRESHOLD = 3500;
      const isLongText = text.length > AUTO_ATTACH_THRESHOLD;

      const hardClear = (): void => {
        input!.textContent = '';
        input!.dispatchEvent(
          new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }),
        );
      };
      const currentLen = (): number => (input!.textContent ?? '').length;
      // 80% 即可（容忍 ProseMirror trim / normalize / 换行规则化）
      const insertSuccess = (): boolean =>
        currentLen() >= Math.max(text.length * 0.8, 100);

      hardClear();
      await new Promise((r) => setTimeout(r, 30));

      let inserted = false;

      // 尝试 1：paste 事件（仅短文本——长文本会被 ChatGPT 自动转附件）
      if (!isLongText) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          input.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
          // 轮询等 paste 真落地（最多 800ms，比 50ms 鲁棒得多）
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            if (insertSuccess()) {
              inserted = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        } catch {
          inserted = false;
        }
      }

      // 尝试 2：execCommand insertText（先 hard clear，避免 paste 异步落地造成双插）
      // 长文本直接走这条（跳过 paste）
      if (!inserted) {
        hardClear();
        await new Promise((r) => setTimeout(r, 30));
        try {
          if (document.execCommand('insertText', false, text)) {
            // 长文本给更多时间消化（execCommand 内部也是异步插入大块文本）
            await new Promise((r) =>
              setTimeout(r, isLongText ? 400 : 100),
            );
            inserted = insertSuccess();
          }
        } catch {
          inserted = false;
        }
      }

      // 尝试 3：直接 textContent 兜底
      if (!inserted) {
        hardClear();
        input.textContent = text;
        input.dispatchEvent(
          new InputEvent('input', { inputType: 'insertText', bubbles: true }),
        );
      }

      // Final safety check：长度严重超标说明有双插，强清后重写一次
      if (currentLen() > text.length * 1.5) {
        hardClear();
        await new Promise((r) => setTimeout(r, 30));
        input.textContent = text;
        input.dispatchEvent(
          new InputEvent('input', { inputType: 'insertText', bubbles: true }),
        );
      }

      // 即使走 execCommand，ChatGPT 偶尔也会把长内容包成附件 chip。
      // 做最后一道防护：查找输入区里的 "Show in text field" / "查看文本"
      // attachment chip，找到就点它的 X 关闭（chip 里的文本会回到内联）
      const dismissAttachChip = (): void => {
        // ChatGPT 的 attach chip 通常是 button 或 div 带特定文案
        const chipButtons = document.querySelectorAll(
          'button[aria-label*="Remove" i], button[aria-label*="移除" i], button[aria-label*="删除" i], button[aria-label*="close" i], button[aria-label*="关闭" i]',
        );
        for (const btn of Array.from(chipButtons) as HTMLButtonElement[]) {
          // 找在输入区附近（vertical 邻近）的 X 按钮
          const r = btn.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // 只考虑在输入框上方 200px 以内的 chip
          const inputR = input!.getBoundingClientRect();
          if (r.bottom > inputR.top && r.top < inputR.bottom + 50) {
            // 文案二次验证：周围有 "Show in text field" / "查看" 等字眼
            const nearby = btn.closest(
              '[class*="chip"], [class*="attach"], [class*="file"], [class*="text-document"]',
            );
            const nearbyText = (nearby?.textContent ?? '').toLowerCase();
            if (
              /show.*text|查看.*文本|text.*field|文本.*框|current\s*time/i.test(
                nearbyText,
              )
            ) {
              btn.click();
              return;
            }
          }
        }
      };
      // 给 ChatGPT 一点时间决定要不要弹 attach chip，然后扫一遍
      await new Promise((r) => setTimeout(r, 500));
      dismissAttachChip();

      return true;
    },
    [text],
  );

  if (!ok) throw new Error('无法填入 ChatGPT 输入框');
  await sleep(1200);

  // 2. 点发送按钮
  const clicked = await execute<boolean>(tabId, () => {
    const inputSels = [
      '#prompt-textarea',
      '.ProseMirror',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[data-testid="composer-text-input"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder]',
      'textarea',
    ];
    let input: HTMLElement | null = null;
    // 逐 selector + 每个 query 多个元素挑 visible 的，避免被隐藏 fallback textarea 命中
    outerInput: for (const s of inputSels) {
      const els = document.querySelectorAll(s);
      for (const el of Array.from(els) as HTMLElement[]) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          input = el;
          break outerInput;
        }
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

      // 黑名单
      if (
        /(attach|upload|file|image|图片|文件|附件|voice|dict|mic|麦克|recording|录音|stop|停止|cancel|取消|copy|复制|edit|编辑|retry|重试|regenerate|重新生成|new\s*chat|new\s*conversation|新对话|history|历史|menu|setting|账户|profile|sidebar|侧边|toggle|model|模型|switch|share|分享|export|导出|search|tools)/i.test(
          haystack,
        )
      ) {
        return false;
      }

      // chatgpt.com 主白名单
      return (
        /send[-_]?(button|prompt|message)?/i.test(testId) ||
        /composer[-_]?send/i.test(testId) ||
        /^send$/i.test(label) ||
        /^submit$/i.test(label) ||
        /^发送$/.test(label) ||
        /send\s*(message|prompt)?/i.test(label) ||
        /发送(消息|提示)?/.test(label)
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

    // Fallback: Enter on ProseMirror
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

  if (!clicked) throw new Error('找不到 ChatGPT 发送按钮');
}

// ── 等响应 ──

/**
 * 主信号：Stop 按钮存在 → 正在写；消失 → 完成
 * GPT-5 Thinking 会先显示 "Thinking..." 折叠面板，正式回复还没出现 — 这阶段也要等
 * 后备：内容连续 N 次不变 + Copy 按钮已出现
 */
async function waitForResponse(
  tabId: number,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();

  // 1. 等响应迹象出现（assistant 容器 或 stop 按钮 或 Thinking 折叠面板）
  let appeared = false;
  while (Date.now() - start < 90000) {
    const has = await execute<boolean>(tabId, () => {
      const stopBtn = document.querySelector(
        'button[data-testid="stop-button"], button[data-testid="composer-speech-button"][aria-label*="Stop" i], button[aria-label*="Stop" i], button[aria-label*="停止"]',
      );
      const msg = document.querySelector(
        '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"], .markdown.prose, div.prose',
      );
      // GPT-5 Thinking 的思考折叠面板
      const thinking = document.querySelector(
        '[data-testid*="thinking" i], [aria-label*="Thinking" i], [aria-label*="Reasoning" i]',
      );
      return !!(stopBtn || msg || thinking);
    });
    if (has) {
      appeared = true;
      break;
    }
    await sleep(2000);
  }
  if (!appeared) {
    throw new Error('ChatGPT 未开始回复（90 秒内无响应迹象）');
  }

  // 2. 给 GPT 时间真正开始
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
        'button[data-testid="stop-button"], button[aria-label*="Stop streaming" i], button[aria-label*="Stop generating" i], button[aria-label*="Stop response" i], button[aria-label*="Stop" i], button[aria-label*="停止" i]',
      );
      // 在最后一条 assistant 消息附近找 copy 按钮（出现 = 该消息写完）
      const copyBtn = document.querySelector(
        'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy" i], button[aria-label*="复制" i]',
      );

      // 提取最后一条 assistant 消息文本，跳过 thinking/reasoning 折叠面板
      const turnSelectors = [
        '[data-message-author-role="assistant"]',
        '[data-testid^="conversation-turn-"]',
        '.markdown.prose',
        'div.prose',
      ];
      let content = '';
      for (const sel of turnSelectors) {
        const els = Array.from(
          document.querySelectorAll(sel),
        ) as HTMLElement[];
        if (els.length === 0) continue;
        const last = els[els.length - 1];

        // 克隆 + 移除 thinking 区块和按钮工具栏，只保留正文
        const clone = last.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            '[data-testid*="thinking" i], [aria-label*="Thinking" i], [aria-label*="Reasoning" i], button, [role="toolbar"]',
          )
          .forEach((el) => el.remove());
        const t = (clone.innerText ?? clone.textContent ?? '').trim();
        if (t) {
          content = t;
          break;
        }
      }

      return {
        generating: !!stopBtn,
        hasCopyBtn: !!copyBtn,
        content,
      };
    });

    if (state.generating) sawGenerating = true;

    // 主路径：曾看到 Stop + 现在消失 → 完成
    if (sawGenerating && !state.generating && state.content.length > 30) {
      await sleep(2500);
      const final = await execute<{ generating: boolean; content: string }>(
        tabId,
        () => {
          const stopBtn = document.querySelector(
            'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止" i]',
          );
          const turnSelectors = [
            '[data-message-author-role="assistant"]',
            '[data-testid^="conversation-turn-"]',
            '.markdown.prose',
            'div.prose',
          ];
          let content = '';
          for (const sel of turnSelectors) {
            const els = Array.from(
              document.querySelectorAll(sel),
            ) as HTMLElement[];
            if (els.length === 0) continue;
            const last = els[els.length - 1];
            const clone = last.cloneNode(true) as HTMLElement;
            clone
              .querySelectorAll(
                '[data-testid*="thinking" i], [aria-label*="Thinking" i], [aria-label*="Reasoning" i], button, [role="toolbar"]',
              )
              .forEach((el) => el.remove());
            const t = (clone.innerText ?? clone.textContent ?? '').trim();
            if (t) {
              content = t;
              break;
            }
          }
          return { generating: !!stopBtn, content };
        },
      );
      if (!final.generating && final.content.length >= state.content.length) {
        return final.content;
      }
      lastContent = final.content;
      stableCount = 0;
      await sleep(2500);
      continue;
    }

    // 后备：从未看到 Stop → 靠内容稳定 + Copy 按钮判定
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
  throw new Error('ChatGPT 响应超时');
}

// ── helpers ──

async function execute<T>(
  tabId: number,
  // chrome.scripting.executeScript 支持 sync 或 async 注入函数：async 时
  // 运行时会自动 await Promise 后才返回 result。类型用 T | Promise<T>
  // 让 typecheck 接受 async (...) => Promise<T>。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: any[]) => T | Promise<T>,
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
