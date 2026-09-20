import type { GptResponseSnapshot } from './gpt-response-dom';

// Research plus spreadsheet reading can exceed the old six-minute budget.
export const GPT_RESPONSE_TIMEOUT_MS = 20 * 60 * 1000;
export class GptResponseTimeoutError extends Error {
  constructor() {
    super('ChatGPT 响应超时，尚未确认完整生成；原对话页面已保留，请打开查看，未使用半截回复');
    this.name = 'GptResponseTimeoutError';
  }
}

export interface WaitForCompletedOptions {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 页面这么久没有任何变化（正文、生成中、复制按钮三者的组合都没动）就算
   * 停滞，调用 onStalled 一次；之后重新计时，再停滞这么久会再调一次。
   * 后台标签被 Chrome 冻结/节流时正文停在半路，这是唤醒它的钩子。
   * 调用方自己限制唤醒次数。
   */
  stalledAfterMs?: number;
  onStalled?: (info: { stalledMs: number; state: GptResponseSnapshot }) => Promise<void>;
}

/** Copy controls alone can appear while a response is still streaming. */
export async function waitForCompletedGptResponse(
  read: () => Promise<GptResponseSnapshot>,
  options: WaitForCompletedOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? GPT_RESPONSE_TIMEOUT_MS);
  let candidate = '';
  let stableSince = 0;
  let signature = '';
  let lastChangeAt = now();
  while (now() < deadline) {
    const state = await read();
    const nextSignature = `${state.generating ? 1 : 0}|${state.hasCopyBtn ? 1 : 0}|${state.content}`;
    if (nextSignature !== signature) {
      signature = nextSignature;
      lastChangeAt = now();
    }
    if (state.generating || !state.hasCopyBtn || !state.content.trim()) {
      candidate = '';
    } else if (state.content !== candidate) {
      candidate = state.content;
      stableSince = now();
    } else if (now() - stableSince >= 6000) {
      return state.content;
    }
    if (options.onStalled && options.stalledAfterMs && now() - lastChangeAt >= options.stalledAfterMs) {
      await options.onStalled({ stalledMs: now() - lastChangeAt, state });
      lastChangeAt = now();
    }
    await sleep(Math.min(2000, Math.max(0, deadline - now())));
  }
  // Never promote the last streaming fragment into a completed reply on timeout.
  throw new GptResponseTimeoutError();
}
