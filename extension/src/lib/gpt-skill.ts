/** A verified ChatGPT skill identity. Names are for finding the picker item only. */
export interface GptSkill {
  id: string;
  name: string;
}

export const R08_SKILL_ID = '6aabac4c1240819193bc311372c9d2ab';

export function validateGptSkill(value: unknown): GptSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能配置无效');
  const skill = value as Record<string, unknown>;
  if (Object.keys(skill).sort().join(',') !== 'id,name'
    || typeof skill.id !== 'string' || !/^[a-f0-9]{32}$/.test(skill.id)
    || typeof skill.name !== 'string' || !/^[a-z0-9][a-z0-9 -]{0,79}$/.test(skill.name)) {
    throw new Error('请填写有效的 ChatGPT 技能 ID 和名称');
  }
  return { id: skill.id, name: skill.name };
}

/** CRM-owned fragment, never a ChatGPT invocation parameter. */
export function bindSkillConversation(raw: string, skill: GptSkill): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.username || url.password
    || !/^\/c\/[a-z0-9-]+\/?$/i.test(url.pathname)) throw new Error('技能未返回普通 ChatGPT 会话');
  url.hash = new URLSearchParams({ sgc_skill: skill.id }).toString();
  return url.href;
}

/** Serialized into ChatGPT by chrome.scripting; keep helpers inside this function.
 * Observed 2026-09-17: @ picker item → skillMention pill with immutable data-id.
 * No private API or forged mention HTML. A missing/wrong skill never sends a prompt.
 */
export async function fillGptSkillPrompt(skill: GptSkill, text: string): Promise<boolean> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // Observed UI: Chat mode's @ menu lists GPTs; installed skills live on Work.
  const work = document.querySelector<HTMLElement>('[role="radio"][data-tpp-toggle-value="work"]');
  if (work && visible(work) && work.getAttribute('aria-checked') !== 'true') {
    work.click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && document.querySelector('[role="radio"][data-tpp-toggle-value="work"]')?.getAttribute('aria-checked') !== 'true') await sleep(100);
    if (document.querySelector('[role="radio"][data-tpp-toggle-value="work"]')?.getAttribute('aria-checked') !== 'true') throw new Error('未能切换到技能Work入口，未发送上下文');
    await sleep(1200);
  }
  const input = Array.from(document.querySelectorAll<HTMLElement>('#prompt-textarea[contenteditable="true"]')).find(visible);
  if (!input) throw new Error('找不到 ChatGPT 技能输入框');
  const selectContents = (collapse: boolean) => {
    input.focus();
    const range = document.createRange(); range.selectNodeContents(input);
    if (collapse) range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  };
  selectContents(false);
  if (!document.execCommand('insertText', false, `@${skill.name}`)) throw new Error('无法打开技能选择器');
  const normalizedName = skill.name.replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  let selected = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    // Some ChatGPT versions resolve a full exact name directly into a pill.
    const resolved = input.querySelectorAll('[data-symbol="skillMention"]');
    if (resolved.length) {
      if (resolved.length !== 1 || resolved[0].getAttribute('data-id') !== skill.id) {
        throw new Error('选中的技能身份不匹配，未发送客户上下文');
      }
      selected = true;
      break;
    }
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('.__menu-item[data-fill]')).filter((item) =>
      visible(item) && Array.from(item.querySelectorAll('span')).some((span) =>
        (span.textContent ?? '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase() === normalizedName));
    if (candidates.length > 1) throw new Error('有多个同名技能，请在 ChatGPT 中保留唯一名称后重试');
    if (candidates.length === 1) { candidates[0].click(); selected = true; break; }
    await sleep(200);
  }
  if (!selected) throw new Error(`未找到已安装技能「${skill.name}」。请先在当前 ChatGPT 账号安装，未发送客户上下文。`);
  await sleep(500);
  const pills = input.querySelectorAll('[data-symbol="skillMention"]');
  if (pills.length !== 1 || pills[0].getAttribute('data-id') !== skill.id) {
    throw new Error('选中的技能身份不匹配，未发送客户上下文');
  }
  selectContents(true);
  if (!document.execCommand('insertText', false, `\n${text}`)) throw new Error('无法填入技能上下文');
  await sleep(1200);
  const remainingPills = input.querySelectorAll('[data-symbol="skillMention"]');
  const clone = input.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]').forEach((el) => el.remove());
  const normalize = (s: string) => s.replace(/[\s\uFEFF]+/g, '');
  if (remainingPills.length !== 1 || remainingPills[0].getAttribute('data-id') !== skill.id
    || normalize(clone.textContent ?? '') !== normalize(text)) {
    throw new Error('技能标签或客户上下文未完整保留，未发送');
  }
  return true;
}
