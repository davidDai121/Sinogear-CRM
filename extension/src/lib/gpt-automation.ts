import { GPT_RESPONSE_TIMEOUT_MS, GptResponseTimeoutError, waitForCompletedGptResponse } from './gpt-response-wait';
import { readGptResponseSnapshot } from './gpt-response-dom';
import { bindSkillConversation, fillGptSkillPrompt, validateGptSkill, type GptSkill } from './gpt-skill';

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

/**
 * 后台标签的三个坑（2026-09-18 老板实测：约 90% 的新 GPT 标签要他手动点一下才完成）：
 *   - Chrome 对从未前台显示过的标签，隐藏超过约 5 分钟后冻结/强节流页面定时器，
 *     ChatGPT 的流式渲染和 Stop/Copy 按钮状态停在半路；老板一点标签页面追平，
 *     几秒内"完成"
 *   - Memory Saver 可能直接丢弃后台标签
 *   - 关标签前结果没有任何落地：SW 或消息通道在长等待里死掉就丢结果
 * 对策：创建后 autoDiscardable=false；停滞检测 → 有限唤醒（默认把标签挪进一个
 * 不抢焦点的小窗口，页面变"可见"；失败才短暂激活再切回原标签；每次运行最多
 * WAKE_MAX_ATTEMPTS 次）；关标签前先走 beforeClose 交付，失败保留标签并把结果
 * 随错误抛回；SW 重启后可用 resumeGptRun 回到还开着的标签继续读，不重发。
 */
export interface GptRunOptions {
  /** 打开的 URL：新对话用 chatgpt.com/?model=gpt-5-thinking；续聊用上次的 chat URL */
  url: string;
  /** 第一条要发给 GPT 的消息 */
  prompt: string;
  /** 前台（active tab）开 true 便于调试，默认 false 后台跑 */
  active?: boolean;
  /** 响应总超时，默认20分钟，包含查资料和最终正文生成 */
  responseTimeoutMs?: number;
  /** 是否尝试切到 GPT-5 Thinking 模型（仅新对话需要；续聊保留上次模型） */
  ensureThinking?: boolean;
  skill?: GptSkill;
  /**
   * 进度回调。SW 可以把 tab_created / sent 事件里的 tabId + baseline 落盘，
   * 自己重启后用 resumeGptRun 接着等同一个标签，不重发 prompt。
   */
  onProgress?: (event: GptRunProgress) => void | Promise<void>;
  /**
   * 关闭标签前先交付结果（SW 落盘 / 回传 UI）。抛错 → 标签保留不关，
   * 以 GptResultUnsavedError 抛出，result 挂在错误上，不丢。
   */
  beforeClose?: (result: GptRunResult) => Promise<void>;
  /**
   * 停滞时的唤醒方式，默认 'window'：先把标签挪进不抢焦点的小窗口，仍停滞
   * 再短暂激活并切回原标签；'activate' 直接走激活；'none' 不唤醒。
   */
  wake?: WakeMethod;
  /** 测试注入用的时钟；生产不传 */
  _timing?: { now: () => number; sleep: (ms: number) => Promise<void> };
}

export interface GptRunResult {
  responseText: string;
  messageId?: string;
  /** 发送后 chatgpt.com 跳转到的 chat URL（chatgpt.com/c/<uuid>） */
  chatUrl: string;
  /** 本轮用的 ChatGPT 标签；beforeClose 抛错时标签仍开着，可凭它 resumeGptRun */
  tabId: number;
}

export type WakeMethod = 'window' | 'activate' | 'none';

export type GptRunProgress =
  | { phase: 'tab_created'; tabId: number }
  | { phase: 'sent'; tabId: number; baseline: TurnAnchors }
  | { phase: 'woken'; tabId: number; method: Exclude<WakeMethod, 'none'>; attempt: number; reason: string }
  | { phase: 'completed'; tabId: number; chatUrl: string };

/** 结果已经拿到，但 beforeClose 交付失败：标签保留，结果随错误一起带回 */
export class GptResultUnsavedError extends Error {
  constructor(public readonly result: GptRunResult, public readonly cause: unknown) {
    super(`GPT 回复已生成但未能交付保存（标签 ${result.tabId} 已保留）：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'GptResultUnsavedError';
  }
}

/** 不改变 UI 的默认：只在停滞时唤醒，且有上限 */
export const WAKE_MAX_ATTEMPTS = 2;
export const WAKE_MIN_INTERVAL_MS = 60 * 1000;
/** 完成等待阶段：这么久没有任何 DOM 变化算停滞 */
export const WAKE_STALLED_AFTER_MS = 60 * 1000;
/** 等"开始回复"阶段：更早唤醒，因为后台标签可能连 Stop 按钮都没渲染 */
export const WAKE_NO_SIGN_AFTER_MS = 45 * 1000;
/** 激活模式下停留多久再切回原标签（页面追平需要几秒） */
export const WAKE_ACTIVATE_DWELL_MS = 4 * 1000;
const APPEARANCE_TIMEOUT_MS = 150 * 1000;

/** 纯逻辑：本次是否允许再唤醒（上限 + 最小间隔），可单测 */
export function createWakePlanner(opts: { maxAttempts?: number; minIntervalMs?: number; now?: () => number } = {}) {
  const maxAttempts = opts.maxAttempts ?? WAKE_MAX_ATTEMPTS;
  const minIntervalMs = opts.minIntervalMs ?? WAKE_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  let attempts = 0;
  let lastAt = -Infinity;
  return {
    get attempts() { return attempts; },
    /** 允许就登记一次并返回序号（从 1 起），不允许返回 0 */
    claim(): number {
      const t = now();
      if (attempts >= maxAttempts || t - lastAt < minIntervalMs) return 0;
      attempts += 1;
      lastAt = t;
      return attempts;
    },
  };
}

let busy = false;

export async function runGpt(opts: GptRunOptions): Promise<GptRunResult> {
  if (busy) {
    throw new Error('GPT 正在处理上一个客户，请稍后再试');
  }
  busy = true;

  let tabId: number | null = null;
  try {
    const skill = opts.skill ? validateGptSkill(opts.skill) : undefined;
    const target = new URL(opts.url);
    const boundSkill = new URLSearchParams(target.hash.slice(1)).get('sgc_skill');
    if (boundSkill && boundSkill !== skill?.id) throw new Error('技能配置已变化，请刷新模板后重新生成');
    if (skill) {
      if (target.protocol !== 'https:' || target.hostname !== 'chatgpt.com' || target.username || target.password
        || !/^(?:\/|\/c\/[a-z0-9-]+\/?)$/i.test(target.pathname)) throw new Error('技能必须从普通 ChatGPT 会话启动');
      target.hash = ''; // Strip the CRM-only conversation binding before navigation.
    }
    const tab = await chrome.tabs.create({
      url: target.href,
      active: opts.active ?? false,
    });
    if (tab.id == null) throw new Error('无法创建 ChatGPT 标签页');
    tabId = tab.id;
    // Memory Saver 会丢弃后台标签；丢弃后页面重载、流式响应中断
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await opts.onProgress?.({ phase: 'tab_created', tabId });

    await waitForTabComplete(tabId);
    await checkAuth(tabId);
    await waitForInput(tabId);
    if (opts.ensureThinking) {
      await ensureThinkingModel(tabId);
    }
    // 发送前记 baseline 锚点（最后一条 assistant 消息的 data-message-id）。
    // 响应判定只认「id 变了 = 新增 turn」，绝不把续聊历史里最后一条旧响应
    // 当成本轮结果；比数 turn 个数鲁棒（不受隐藏节点/重复渲染影响）
    const baseline = await readTurnAnchors(tabId);
    await typeAndSend(tabId, opts.prompt, skill);
    let accepted = await waitForSendAccepted(tabId, baseline, 10000);
    if (!accepted) {
      // 输入被 hydration 吞了 → 重填重发一次
      await typeAndSend(tabId, opts.prompt, skill);
      accepted = await waitForSendAccepted(tabId, baseline, 10000);
    }
    if (!accepted) {
      throw new Error(
        'Prompt 没有发出去（ChatGPT 页面吞掉了输入，两次尝试都失败）——请重新生成',
      );
    }
    await opts.onProgress?.({ phase: 'sent', tabId, baseline });

    const wake = new WakeContext(tabId, opts.active ? 'none' : (opts.wake ?? 'window'), opts.onProgress, opts._timing);
    const responseText = await waitForResponse(
      tabId,
      opts.responseTimeoutMs ?? GPT_RESPONSE_TIMEOUT_MS,
      baseline,
      wake,
      opts._timing,
    );
    return await finishRun(tabId, responseText, skill, opts.url, opts);
  } catch (err) {
    await cleanupAfterError(tabId, err);
    throw err;
  } finally {
    busy = false;
  }
}

export interface GptResumeOptions {
  /** runGpt onProgress 'sent' 事件里的 tabId / baseline */
  tabId: number;
  baseline: TurnAnchors;
  /** 原始 url（拿不到最终 chat URL 时的兜底） */
  url: string;
  skill?: GptSkill;
  responseTimeoutMs?: number;
  onProgress?: GptRunOptions['onProgress'];
  beforeClose?: GptRunOptions['beforeClose'];
  wake?: WakeMethod;
  _timing?: GptRunOptions['_timing'];
}

/**
 * SW 重启 / 消息通道断掉之后，回到还开着的 ChatGPT 标签继续等结果。
 * 不重发 prompt；完成判定和 runGpt 完全一样（只认 baseline 之后的新 turn）。
 */
export async function resumeGptRun(opts: GptResumeOptions): Promise<GptRunResult> {
  if (busy) throw new Error('GPT 正在处理上一个客户，请稍后再试');
  busy = true;
  const tabId = opts.tabId;
  try {
    const skill = opts.skill ? validateGptSkill(opts.skill) : undefined;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('要恢复的 ChatGPT 标签页已不存在，请重新生成');
    if (!/^https:\/\/chatgpt\.com\//i.test(tab.url ?? '')) throw new Error('要恢复的标签页不是 ChatGPT 会话');
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    const wake = new WakeContext(tabId, opts.wake ?? 'window', opts.onProgress, opts._timing);
    const responseText = await waitForResponse(
      tabId,
      opts.responseTimeoutMs ?? GPT_RESPONSE_TIMEOUT_MS,
      opts.baseline,
      wake,
      opts._timing,
    );
    return await finishRun(tabId, responseText, skill, opts.url, opts);
  } catch (err) {
    await cleanupAfterError(tabId, err);
    throw err;
  } finally {
    busy = false;
  }
}

/**
 * 结果先交付（beforeClose）再关标签。交付失败 → 标签保留、结果随错误带回，
 * 这是"输出完成但 CRM 拿不到"的最小保留方案：页面还在，结果也在错误对象里。
 */
async function finishRun(
  tabId: number,
  responseText: string,
  skill: GptSkill | undefined,
  fallbackUrl: string,
  opts: Pick<GptRunOptions, 'beforeClose' | 'onProgress'>,
): Promise<GptRunResult> {
  const finalTab = await chrome.tabs.get(tabId);
  const messageId = (await readTurnAnchors(tabId)).lastAssistantId ?? undefined;
  const chatUrl = skill ? bindSkillConversation(finalTab.url ?? '', skill) : finalTab.url ?? fallbackUrl;
  const result: GptRunResult = { responseText, chatUrl, messageId, tabId };
  opts.onProgress?.({ phase: 'completed', tabId, chatUrl });
  if (opts.beforeClose) {
    try {
      await opts.beforeClose(result);
    } catch (cause) {
      throw new GptResultUnsavedError(result, cause);
    }
  }
  await chrome.tabs.remove(tabId).catch(() => {});
  return result;
}

async function cleanupAfterError(tabId: number | null, err: unknown): Promise<void> {
  if (tabId === null) return;
  // 超时：保留查资料的会话页；交付失败：结果就在那个标签里，更不能关
  if (err instanceof GptResponseTimeoutError || err instanceof GptResultUnsavedError) return;
  // 未交付成功的页面保留，便于用户从原会话取回。
}

export function isBusy(): boolean {
  return busy;
}

// ── 唤醒（后台标签冻结/节流时用）──

class WakeContext {
  private readonly planner;
  private ownWindowId: number | null = null;
  constructor(
    private readonly tabId: number,
    private readonly method: WakeMethod,
    private readonly onProgress: GptRunOptions['onProgress'],
    private readonly timing?: GptRunOptions['_timing'],
  ) {
    this.planner = createWakePlanner({ now: timing?.now });
  }

  /** 停滞时调用；有上限，超限静默不动 */
  async wake(reason: string): Promise<boolean> {
    if (this.method === 'none') return false;
    const attempt = this.planner.claim();
    if (attempt === 0) return false;
    // 第一次：挪进不抢焦点的小窗口（页面变可见，用户焦点不动）；
    // 已经在小窗口里还停滞、或挪窗失败：短暂激活再切回
    if (this.method === 'window' && this.ownWindowId === null && await this.moveToOwnWindow()) {
      this.onProgress?.({ phase: 'woken', tabId: this.tabId, method: 'window', attempt, reason });
      return true;
    }
    await this.activateBriefly();
    this.onProgress?.({ phase: 'woken', tabId: this.tabId, method: 'activate', attempt, reason });
    return true;
  }

  private async moveToOwnWindow(): Promise<boolean> {
    try {
      const win = await chrome.windows.create({ tabId: this.tabId, focused: false, type: 'normal', width: 520, height: 420 });
      if (win?.id == null) return false;
      this.ownWindowId = win.id;
      return true;
    } catch {
      return false;
    }
  }

  private async activateBriefly(): Promise<void> {
    const sleep = this.timing?.sleep ?? sleepMs;
    let previous: { tabId?: number; windowId?: number } = {};
    try {
      const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      previous = { tabId: focusedTab?.id, windowId: focusedTab?.windowId };
      const tab = await chrome.tabs.get(this.tabId);
      await chrome.tabs.update(this.tabId, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } catch {
      return;
    }
    await sleep(WAKE_ACTIVATE_DWELL_MS);
    // 尽量把焦点还给原来的标签（通常是 WhatsApp）；还不回去也不算失败
    try {
      const focusedWindow = await chrome.windows.getLastFocused();
      if (!focusedWindow.focused) return; // 用户已转去其他应用。
      const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (current?.id !== this.tabId) return; // 用户已转到别处，不抢回焦点。
      if (previous.tabId != null && previous.tabId !== this.tabId) await chrome.tabs.update(previous.tabId, { active: true });
      if (previous.windowId != null) await chrome.windows.update(previous.windowId, { focused: true });
    } catch {
      /* ignore */
    }
  }
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

async function fillLegacyPrompt(tabId: number, text: string): Promise<void> {
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

  // 1b. hydration 吞字检测：填完 1.2s 后内容还在吗？续聊页面历史消息
  //     hydrate 时 ProseMirror 会被 re-render 清空（prompt 静默丢失 →
  //     点发送发了个空 → 页面上最后一条还是上一轮旧响应）。被吞就快速重填
  const persisted = await execute<boolean>(
    tabId,
    (expectedLen: number) => {
      const sels = [
        '#prompt-textarea',
        '.ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
      ];
      for (const s of sels) {
        for (const el of Array.from(document.querySelectorAll(s)) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const len =
            el instanceof HTMLTextAreaElement
              ? el.value.length
              : (el.textContent ?? '').length;
          return len >= Math.max(expectedLen * 0.8, 100);
        }
      }
      return false;
    },
    [text.length],
  );
  if (!persisted) {
    await execute(
      tabId,
      (text: string) => {
        const sels = [
          '#prompt-textarea',
          '.ProseMirror',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
          'textarea',
        ];
        let input: HTMLElement | null = null;
        outer: for (const s of sels) {
          for (const el of Array.from(document.querySelectorAll(s)) as HTMLElement[]) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              input = el;
              break outer;
            }
          }
        }
        if (!input) return;
        input.focus();
        if (input instanceof HTMLTextAreaElement) {
          const desc = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          );
          desc?.set?.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        input.textContent = '';
        try {
          document.execCommand('insertText', false, text);
        } catch {
          /* fall through */
        }
        if ((input.textContent ?? '').length < Math.max(text.length * 0.8, 100)) {
          input.textContent = text;
          input.dispatchEvent(
            new InputEvent('input', { inputType: 'insertText', bubbles: true }),
          );
        }
      },
      [text],
    );
    await sleep(800);
  }

}

async function typeAndSend(tabId: number, text: string, skill?: GptSkill): Promise<void> {
  if (skill) {
    const prepared = await execute<boolean>(tabId, fillGptSkillPrompt, [skill, text]);
    if (prepared !== true) throw new Error('技能输入准备失败，未发送客户上下文');
  } else await fillLegacyPrompt(tabId, text);
  // Recheck the immutable skill ID at the final send boundary.
  const clicked = await execute<boolean>(tabId, (skillId: string | null) => {
    if (skillId) {
      const pills = document.querySelectorAll('#prompt-textarea [data-symbol="skillMention"]');
      if (pills.length !== 1 || pills[0].getAttribute('data-id') !== skillId) return false;
    }
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
  }, [skill?.id ?? null]);

  if (!clicked) throw new Error('找不到 ChatGPT 发送按钮');
}

// ── turn 锚点（防"拿回上一轮旧响应"）──

export interface TurnAnchors {
  /** 最后一条 assistant 消息的 data-message-id（没有该属性时退化为 count 字符串） */
  lastAssistantId: string | null;
  /** 最后一条 user 消息的 data-message-id */
  lastUserId: string | null;
  generating: boolean;
}

/**
 * 读对话锚点。ChatGPT 每条消息带唯一 data-message-id——"出新响应"判定用
 * 「最后一条 assistant 的 id 变了」，比数 turn 个数鲁棒（不受隐藏节点、
 * 重复渲染、testid 改版影响）。没有 id 属性时退化为 "count:N" 字符串，
 * 个数变化同样会让锚点变化。
 */
async function readTurnAnchors(tabId: number): Promise<TurnAnchors> {
  return execute<TurnAnchors>(tabId, () => {
    const lastIdOf = (sel: string): string | null => {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) return null;
      const el = els[els.length - 1];
      return el.getAttribute('data-message-id') ?? `count:${els.length}`;
    };
    let lastAssistantId = lastIdOf('[data-message-author-role="assistant"]');
    if (lastAssistantId === null) {
      // 老版 DOM 没有 author-role 属性：退化为 prose 块个数
      const prose = document.querySelectorAll('.markdown.prose, div.prose').length;
      lastAssistantId = prose > 0 ? `prose:${prose}` : null;
    }
    return {
      lastAssistantId,
      lastUserId: lastIdOf('[data-message-author-role="user"]'),
      generating: !!document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]',
      ),
    };
  });
}

/** 本轮是否已出现新 assistant 消息（锚点变了） */
function hasNewAssistant(now: TurnAnchors, baseline: TurnAnchors): boolean {
  return (
    now.lastAssistantId !== null &&
    now.lastAssistantId !== baseline.lastAssistantId
  );
}

/**
 * 发送是否真的生效：出现"停止生成"按钮，或 user/assistant 锚点变了
 * （新 turn 上屏）。都没有 = 输入被 hydration 吞了。
 */
async function waitForSendAccepted(
  tabId: number,
  baseline: TurnAnchors,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = await readTurnAnchors(tabId).catch(() => null);
    if (now) {
      if (now.generating) return true;
      if (hasNewAssistant(now, baseline)) return true;
      if (now.lastUserId !== null && now.lastUserId !== baseline.lastUserId) {
        return true;
      }
    }
    await sleep(600);
  }
  return false;
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
  baseline: TurnAnchors,
  wake: WakeContext,
  timing?: GptRunOptions['_timing'],
): Promise<string> {
  const now = timing?.now ?? Date.now;
  const sleep = timing?.sleep ?? sleepMs;
  const start = now();
  const baselineId = baseline.lastAssistantId;

  // 1. 等响应迹象出现：stop 按钮 / **新的** assistant turn（锚点 id 变了）。
  //    ⚠️ 续聊 URL 页面上历史 assistant 消息本来就在——绝不能拿"存在任意
  //    assistant 容器"当迹象，否则输入被吞时会把上一轮旧响应当成本轮结果
  //    后台标签可能连 Stop 按钮都没渲染：45 秒没迹象先唤醒一次，再等
  let appeared = false;
  let wokeForAppearance = false;
  while (now() - start < APPEARANCE_TIMEOUT_MS) {
    const has = await execute<boolean>(
      tabId,
      (prevId: string | null) => {
        const stopBtn = document.querySelector(
          'button[data-testid="stop-button"], button[data-testid="composer-speech-button"][aria-label*="Stop" i], button[aria-label*="Stop" i], button[aria-label*="停止"]',
        );
        if (stopBtn) return true;
        const els = document.querySelectorAll('[data-message-author-role="assistant"]');
        let curId: string | null = null;
        if (els.length > 0) {
          curId =
            els[els.length - 1].getAttribute('data-message-id') ?? `count:${els.length}`;
        } else {
          const prose = document.querySelectorAll('.markdown.prose, div.prose').length;
          curId = prose > 0 ? `prose:${prose}` : null;
        }
        return curId !== null && curId !== prevId;
      },
      [baselineId],
    );
    if (has) {
      appeared = true;
      break;
    }
    if (!wokeForAppearance && now() - start >= WAKE_NO_SIGN_AFTER_MS) {
      wokeForAppearance = true;
      await wake.wake('no response sign');
    }
    await sleep(1500);
  }
  if (!appeared) {
    throw new Error(`ChatGPT 未开始回复（${Math.round(APPEARANCE_TIMEOUT_MS / 1000)} 秒内无响应迹象）`);
  }

  return waitForCompletedGptResponse(
    () => execute(tabId, readGptResponseSnapshot, [baselineId]),
    {
      timeoutMs: Math.max(0, timeoutMs - (now() - start)),
      now,
      sleep,
      stalledAfterMs: WAKE_STALLED_AFTER_MS,
      onStalled: async ({ stalledMs }) => { await wake.wake(`stalled ${Math.round(stalledMs / 1000)}s`); },
    },
  );
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
const sleepMs = sleep;
