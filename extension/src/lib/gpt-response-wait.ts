import type { GptResponseSnapshot } from './gpt-response-dom';

// Research plus spreadsheet reading can exceed the old six-minute budget.
export const GPT_RESPONSE_TIMEOUT_MS = 20 * 60 * 1000;
export class GptResponseTimeoutError extends Error {
  constructor() {
    super('ChatGPT 响应超时，尚未确认完整生成；原对话页面已保留，请打开查看，未使用半截回复');
    this.name = 'GptResponseTimeoutError';
  }
}

/** Copy controls alone can appear while a response is still streaming. */
export async function waitForCompletedGptResponse(
  read: () => Promise<GptResponseSnapshot>,
  options: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? GPT_RESPONSE_TIMEOUT_MS);
  let candidate = '';
  let stableSince = 0;
  while (now() < deadline) {
    const state = await read();
    if (state.generating || !state.hasCopyBtn || !state.content.trim()) {
      candidate = '';
    } else if (state.content !== candidate) {
      candidate = state.content;
      stableSince = now();
    } else if (now() - stableSince >= 6000) {
      return state.content;
    }
    await sleep(Math.min(2000, Math.max(0, deadline - now())));
  }
  // Never promote the last streaming fragment into a completed reply on timeout.
  throw new GptResponseTimeoutError();
}
