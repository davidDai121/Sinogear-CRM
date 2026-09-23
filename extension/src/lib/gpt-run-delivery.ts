import { runGpt, resumeGptRun, GptResultUnsavedError, type GptRunOptions, type GptRunResult, type GptResumeOptions } from './gpt-automation';

const PREFIX = 'gpt.delivery.';
const TTL = 24 * 60 * 60 * 1000;
type SavedRun = {
  requestId: string; createdAt: number; sentAt?: number; url: string; skill?: GptRunOptions['skill'];
  preparation?: 'loading' | 'sending';
  state: 'starting' | 'running' | 'done' | 'error';
  tabId?: number; baseline?: GptResumeOptions['baseline']; result?: GptRunResult; error?: string;
};
const active = new Map<string, Promise<void>>();
// If disk writes fail, deliver the captured response in this worker lifetime; the GPT tab remains open.
const volatileResults = new Map<string, {result?: GptRunResult; error?: string}>();
const key = (id: string) => PREFIX + id;
const validId = (id: string) => /^[a-zA-Z0-9-]{12,100}$/.test(id);
const save = (run: SavedRun) => chrome.storage.local.set({ [key(run.requestId)]: run });
async function read(id: string): Promise<SavedRun | undefined> {
  if (!validId(id)) throw new Error('无效的 GPT 请求编号');
  return (await chrome.storage.local.get(key(id)))[key(id)];
}

async function execute(run: SavedRun, options?: GptRunOptions) {
  const hooks: Pick<GptRunOptions, 'onProgress' | 'beforeClose'> = {
    onProgress: async event => {
      if (event.phase === 'preparing') { run.preparation = event.step; await save(run); }
      if (event.phase === 'tab_created') run.tabId = event.tabId;
      if (event.phase === 'sent') { run.tabId = event.tabId; run.baseline = event.baseline; run.state = 'running'; run.sentAt ??= Date.now(); }
      if (event.phase === 'sent' || event.phase === 'tab_created') await save(run);
    },
    beforeClose: async result => { result.timing = { startedAt: run.createdAt, sentAt: run.sentAt, completedAt: Date.now() }; run.state = 'done'; run.result = result; await save(run); },
  };
  try {
    if (options) await runGpt({ ...options, ...hooks });
    else await resumeGptRun({ tabId: run.tabId!, baseline: run.baseline!, url: run.url, skill: run.skill, ...hooks });
  } catch (error) {
    if (error instanceof GptResultUnsavedError) { run.state = 'done'; run.result = error.result; volatileResults.set(run.requestId, {result:error.result}); }
    else { run.state = 'error'; run.error = error instanceof Error ? error.message : String(error); volatileResults.set(run.requestId, {error:run.error}); }
    await save(run);
  }
}
function launch(run: SavedRun, options?: GptRunOptions) {
  const task = execute(run, options).catch(error => console.error('GPT delivery persistence failed', error)).finally(() => active.delete(run.requestId));
  active.set(run.requestId, task);
}

/** A short RPC starts work; subsequent polling survives a dropped message channel. */
export async function startDeliveredGptRun(requestId: string, options: GptRunOptions) {
  if (!validId(requestId)) throw new Error('无效的 GPT 请求编号');
  if (await read(requestId)) return pollDeliveredGptRun(requestId);
  // Prune expired records only; never delete an active task or an unexpired result.
  const stored = await chrome.storage.local.get(null);
  const expired = Object.entries(stored).filter(([k, v]) => k.startsWith(PREFIX)
    && !active.has(k.slice(PREFIX.length)) && Date.now() - Number(v?.createdAt) > TTL).map(([k]) => k);
  if (expired.length) await chrome.storage.local.remove(expired);
  const run: SavedRun = { requestId, createdAt: Date.now(), url: options.url, skill: options.skill, state: 'starting' };
  await save(run);
  launch(run, options);
  return { ok: true, pending: true, requestId, preparation:run.state === 'starting' ? run.preparation : undefined };
}

export async function pollDeliveredGptRun(requestId: string) {
  const fallback = volatileResults.get(requestId);
  if (fallback?.result) return {ok:true,...fallback.result};
  if (fallback?.error) return {ok:false,error:fallback.error};
  const run = await read(requestId);
  if (!run) return { ok: false, error: '未找到 GPT 任务；请重新生成' };
  if (run.state === 'done' && run.result) return { ok: true, ...run.result };
  if (run.state === 'error') return { ok: false, error: run.error };
  if (!active.has(requestId)) {
    if (Date.now() - run.createdAt > TTL) return { ok: false, error: 'GPT 任务已过期，原页面如仍打开可手动取回' };
    if (run.tabId != null && run.baseline) launch(run);
    else return { ok: false, error: '发送阶段被中断，已保留原页面。请检查是否发送成功后再重新生成' };
  }
  return { ok: true, pending: true, requestId, preparation:run.state === 'starting' ? run.preparation : undefined };
}
