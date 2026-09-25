/** A verified ChatGPT skill identity. Names are for finding the picker item only. */
/** Normal Chat effort slider: Instant 0, Medium 1, High 2, Extra High 3. */
export type GptThinkingEffort = 'high' | 'extra_high';

export interface GptSkill {
  id: string;
  name: string;
  thinkingEffort?: GptThinkingEffort;
}

export const R08_SKILL_ID = '6aabac4c1240819193bc311372c9d2ab';

export function validateGptSkill(value: unknown): GptSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能配置无效');
  const skill = value as Record<string, unknown>;
  if (Object.keys(skill).some(key => !['id', 'name', 'thinkingEffort'].includes(key))
    || typeof skill.id !== 'string' || !/^(?:plugin_)?[a-f0-9]{32}$/.test(skill.id)
    || typeof skill.name !== 'string' || !/^[a-z0-9][a-z0-9 -]{0,79}$/i.test(skill.name)
    || (skill.thinkingEffort !== undefined && ((skill.thinkingEffort !== 'high' && skill.thinkingEffort !== 'extra_high')
      || !skill.id.startsWith('plugin_')))) {
    throw new Error('请填写有效的 ChatGPT 技能 ID 和名称');
  }
  const thinkingEffort = skill.thinkingEffort as GptThinkingEffort | undefined;
  return { id: skill.id, name: skill.name, ...(thinkingEffort ? { thinkingEffort } : {}) };
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
 * Observed 2026-09-23: plugins use ecosystemMention and plugin:plugin_<id>.
 * Older skills use skillMention and a bare immutable ID.
 * Observed 2026-09-25: the composer lost #prompt-textarea, plugins insert
 * [app-mention-path="app://plugin_<id>"], and the picker no longer marks plugins:
 * a same-name custom GPT becomes an ID-less footer chip. So each same-name item is
 * tried and only the exact identity is accepted.
 * No private API or forged mention HTML. A missing/wrong skill never sends a prompt.
 */
export async function fillGptSkillPrompt(skill: GptSkill, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const plugin = skill.id.startsWith('plugin_');
    // Plugins work in Chat; CRM sales drafting does not require Work or model changes.
    // Older UI: role=radio toggles. 2026-09-25 UI: a "Composer mode" group of aria-pressed buttons.
    const isOn = (el: Element) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
    const modeButtons = (mode: 'chat' | 'work') => [
      ...Array.from(document.querySelectorAll<HTMLElement>(mode === 'work' ? '[role="radio"][data-tpp-toggle-value="work"]'
        : '[role="radio"][data-tpp-toggle-value="chatgpt"], [role="radio"][data-tpp-toggle-value="chat"]')),
      ...Array.from(document.querySelectorAll<HTMLElement>('[role="group"][aria-label="Composer mode"] button[aria-pressed]'))
        .filter(el => el.textContent?.trim().toLowerCase() === mode),
    ];
    const chatButton = () => modeButtons('chat').find(visible);
    const workIsSelected = () => modeButtons('work').some(el => visible(el) && isOn(el));
    // 2026-09-25 UI prefixes the level with a screen-reader "Thinking effort" label,
    // and with the model version when a pinned model is selected ("5.6 Medium" on GPT-5.6 Sol).
    const effortLevel = (el: Element) => (el.textContent ?? '').trim()
      .replace(/^Thinking effort\s*/i, '').replace(/^\d+(?:\.\d+)*\s+/, '');
    const findEffort = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'))
      .find(el => visible(el) && /^(Instant|Medium|High|Extra High)$/.test(effortLevel(el)));
    if (plugin) {
      let chat = chatButton();
      // The editable composer can mount before the surface toggle finishes loading.
      const surfaceDeadline = Date.now() + 8000;
      while (!chat && Date.now() < surfaceDeadline) {
        if (findEffort() && !workIsSelected()) break;
        await sleep(100);
        chat = chatButton();
      }
      if (chat && !isOn(chat)) {
        chat.click();
        const limit = Date.now() + 5000;
        const chatIsOn = () => { const current = chatButton(); return Boolean(current && isOn(current)); };
        while (Date.now() < limit && !chatIsOn()) await sleep(100);
        if (!chatIsOn()) throw new Error('未能打开 Chat，未发送客户上下文');
        await sleep(500);
      }
      if (workIsSelected()) throw new Error('当前仍为 Work，未发送客户上下文；请切到 Chat 后重试');
    }
    const selector = '[data-symbol="skillMention"], [data-symbol="ecosystemMention"], [app-mention-path]';
    const expectedId = plugin ? `plugin:${skill.id}` : skill.id;
    const expectedSymbol = plugin ? 'ecosystemMention' : 'skillMention';
    // Uploaded plugin archives show up as app://Plugin_<id>; the hex ID is what identifies it.
    const matches = (pill: Element) => pill.hasAttribute('app-mention-path')
      ? plugin && pill.getAttribute('app-mention-path')?.toLowerCase() === `app://${skill.id}`
      : pill.getAttribute('data-id') === expectedId && pill.getAttribute('data-symbol') === expectedSymbol;
    const findInput = () => Array.from(document.querySelectorAll<HTMLElement>(
      '#prompt-textarea[contenteditable="true"], .ProseMirror[contenteditable="true"][role="textbox"]')).find(visible);
    let found = findInput();
    const inputDeadline = Date.now() + 5000;
    while (!found && Date.now() < inputDeadline) { await sleep(200); found = findInput(); }
    if (!found) throw new Error('找不到 ChatGPT 技能输入框');
    const input = found;
    const selectContents = (collapse: boolean) => {
      input.focus();
      const range = document.createRange(); range.selectNodeContents(input);
      if (collapse) range.collapse(false);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    };
    const normalizeName = (s: string | null) => (s ?? '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const normalizedName = normalizeName(skill.name);
    const candidateItems = () => Array.from(document.querySelectorAll<HTMLElement>(
      '.__menu-item[data-fill], [data-mention-list-scroll-area] button[data-list-navigation-item]')).filter((item) =>
      visible(item)
      // Only the older picker marks plugins; the new one is verified by the inserted pill.
      && (!item.matches('.__menu-item') || Boolean(item.querySelector('[data-testid="plugin-icon-wrapper"]')) === plugin)
      && Array.from(item.querySelectorAll('span')).some((span) => normalizeName(span.textContent) === normalizedName));
    // A same-name custom GPT is attached as a footer chip, e.g. "Remove Sino Gear Miles V2".
    const chips = () => Array.from(document.querySelectorAll<HTMLElement>('button[aria-label]'))
      .filter(el => normalizeName(el.getAttribute('aria-label')) === `remove ${normalizedName}`);
    let selected = false;
    let mismatched = false;
    for (let attempt = 0; attempt < 4 && !selected; attempt++) {
      if (attempt) { chips().forEach(chip => chip.click()); await sleep(300); }
      // Replaces the composer, including a wrong pill from the previous attempt.
      selectContents(false);
      if (!document.execCommand('insertText', false, `@${skill.name}`)) throw new Error('无法打开技能选择器');
      let clicked = false;
      const deadline = Date.now() + (attempt ? 4000 : 12000);
      while (Date.now() < deadline) {
        // Some ChatGPT versions resolve a full exact name directly into a pill.
        if (input.querySelectorAll(selector).length) break;
        const candidates = candidateItems();
        if (candidates.length > attempt) { candidates[attempt].click(); clicked = true; break; }
        await sleep(200);
      }
      await sleep(500);
      const pills = input.querySelectorAll(selector);
      if (pills.length === 1 && matches(pills[0]) && !chips().length) selected = true;
      else if (pills.length || chips().length) mismatched = true;
      else if (!clicked) break;
    }
    if (!selected) {
      chips().forEach(chip => chip.click());
      throw new Error(mismatched ? '选中的技能身份不匹配，未发送客户上下文'
        : `未找到已安装技能「${skill.name}」。请先在当前 ChatGPT 账号安装，未发送客户上下文。`);
    }
    selectContents(true);
    if (!document.execCommand('insertText', false, `\n${text}`)) throw new Error('无法填入技能上下文');
    await sleep(1200);
    const remainingPills = input.querySelectorAll(selector);
    const clone = input.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-inline-selection-pill], [data-inline-selection-pill-cursor-target], [app-mention-path]').forEach((el) => el.remove());
    const normalize = (s: string) => s.replace(/[\s\uFEFF]+/g, '');
    if (remainingPills.length !== 1 || !matches(remainingPills[0])
      || normalize(clone.textContent ?? '') !== normalize(text)) {
      throw new Error('技能标签或客户上下文未完整保留，未发送');
    }
    // Existing conversations restore their last submitted effort on reopening.
    // Apply the template's explicit preference in the same tab that sends the prompt.
    if (skill.thinkingEffort) {
      const targetLabel = skill.thinkingEffort === 'extra_high' ? 'Extra High' : 'High';
      const targetValue = skill.thinkingEffort === 'extra_high' ? 3 : 2;
      const effort = findEffort();
      if (!effort) throw new Error('找不到 Chat 思考强度设置，未发送；请确认使用普通 Chat 模型');
      if (effortLevel(effort) !== targetLabel) {
        // 2026-09-25 UI dropped the picker test id; its Radix menu is labelled by the trigger.
        const findPicker = () => document.querySelector('[data-testid="composer-intelligence-picker-content"]')
          ?? Array.from(document.querySelectorAll('[role="menu"]')).find(menu => effort.id && menu.getAttribute('aria-labelledby') === effort.id)
          ?? null;
        // Radix's trigger opens on pointerdown, not HTMLElement.click().
        effort.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        effort.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        await sleep(300);
        if (!findPicker()) effort.click();
        let picker = findPicker();
        const menuDeadline = Date.now() + 4000;
        while (!picker && Date.now() < menuDeadline) {
          await sleep(100);
          picker = findPicker();
        }
        // The compact picker view shows only the slider; expand it to confirm the model.
        if (picker && !picker.querySelector('[role="menuitemradio"]')) {
          picker.querySelector<HTMLElement>('[data-model-picker-view-toggle]')?.click();
          const viewDeadline = Date.now() + 2000;
          while (!findPicker()?.querySelector('[role="menuitemradio"]') && Date.now() < viewDeadline) await sleep(100);
          picker = findPicker();
        }
        const power = picker?.querySelector<HTMLElement>('[role="menuitem"][aria-label="Power"]');
        const slider = picker?.querySelector('[role="slider"]');
        const model = picker?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent?.trim();
        if (!power || !slider || slider.getAttribute('aria-valuemax') !== '3' || !['Latest', 'GPT-5.6 Sol'].includes(model ?? '')) {
          throw new Error(`无法确认普通 Chat ${targetLabel} 设置，未发送`);
        }
        for (let i = 0; i < 3 && slider.getAttribute('aria-valuenow') !== String(targetValue); i++) {
          const value = Number(slider.getAttribute('aria-valuenow'));
          if (!Number.isInteger(value) || value < 0 || value > 3) break;
          const key = value < targetValue ? 'ArrowRight' : 'ArrowLeft';
          power.focus();
          power.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
          power.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
          await sleep(100);
        }
        if (slider.getAttribute('aria-valuenow') !== String(targetValue)) throw new Error(`未能切到 ${targetLabel}，未发送`);
        power.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        power.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        input.click();
        input.focus();
        await sleep(300);
        if (effortLevel(effort) !== targetLabel) throw new Error(`${targetLabel} 设置未保留，未发送`);
      }
    }
    if (plugin && workIsSelected()) throw new Error('页面切回了 Work，未发送；请切到 Chat 后重试');
    return { ok: true };
  } catch (error) {
    // executeScript can discard a rejected promise's message. Return it explicitly.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
