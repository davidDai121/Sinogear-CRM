/** A verified ChatGPT skill identity. Names are for finding the picker item only. */
export interface GptSkill {
  id: string;
  name: string;
  thinkingEffort?: 'high';
}

export const R08_SKILL_ID = '6aabac4c1240819193bc311372c9d2ab';

export function validateGptSkill(value: unknown): GptSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能配置无效');
  const skill = value as Record<string, unknown>;
  if (Object.keys(skill).some(key => !['id', 'name', 'thinkingEffort'].includes(key))
    || typeof skill.id !== 'string' || !/^(?:plugin_)?[a-f0-9]{32}$/.test(skill.id)
    || typeof skill.name !== 'string' || !/^[a-z0-9][a-z0-9 -]{0,79}$/i.test(skill.name)
    || (skill.thinkingEffort !== undefined && (skill.thinkingEffort !== 'high' || !skill.id.startsWith('plugin_')))) {
    throw new Error('请填写有效的 ChatGPT 技能 ID 和名称');
  }
  return { id: skill.id, name: skill.name, ...(skill.thinkingEffort === 'high' ? { thinkingEffort: 'high' as const } : {}) };
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
 * No private API or forged mention HTML. A missing/wrong skill never sends a prompt.
 */
export async function fillGptSkillPrompt(skill: GptSkill, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // Plugins work in Chat; CRM sales drafting does not require Work or model changes.
    const chatSelector = '[role="radio"][data-tpp-toggle-value="chatgpt"], [role="radio"][data-tpp-toggle-value="chat"]';
    const workIsSelected = () => Array.from(document.querySelectorAll('[role="radio"][data-tpp-toggle-value="work"][aria-checked="true"]')).some(visible);
    if (skill.id.startsWith('plugin_')) {
      let chat = document.querySelector<HTMLElement>(chatSelector);
      // The editable composer can mount before the surface toggle finishes loading.
      const surfaceDeadline = Date.now() + 8000;
      while ((!chat || !visible(chat)) && Date.now() < surfaceDeadline) {
        const normalChat = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
          .some(el => visible(el) && /^(Instant|Medium|High|Extra High)$/.test(el.textContent?.trim() ?? ''));
        if (normalChat && !workIsSelected()) break;
        await sleep(100);
        chat = document.querySelector<HTMLElement>(chatSelector);
      }
      if (chat && visible(chat) && chat.getAttribute('aria-checked') !== 'true') {
        chat.click();
        const limit = Date.now() + 5000;
        while (Date.now() < limit && document.querySelector(chatSelector)?.getAttribute('aria-checked') !== 'true') await sleep(100);
        if (document.querySelector(chatSelector)?.getAttribute('aria-checked') !== 'true') throw new Error('未能打开 Chat，未发送客户上下文');
        await sleep(500);
      }
      if (workIsSelected()) throw new Error('当前仍为 Work，未发送客户上下文；请切到 Chat 后重试');
    }
    const selector = '[data-symbol="skillMention"], [data-symbol="ecosystemMention"]';
    const expectedId = skill.id.startsWith('plugin_') ? `plugin:${skill.id}` : skill.id;
    const expectedSymbol = skill.id.startsWith('plugin_') ? 'ecosystemMention' : 'skillMention';
    const matches = (pill: Element) => pill.getAttribute('data-id') === expectedId
      && pill.getAttribute('data-symbol') === expectedSymbol;
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
      const resolved = input.querySelectorAll(selector);
      if (resolved.length) {
        if (resolved.length !== 1 || !matches(resolved[0])) {
          throw new Error('选中的技能身份不匹配，未发送客户上下文');
        }
        selected = true;
        break;
      }
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('.__menu-item[data-fill]')).filter((item) =>
        visible(item) && Boolean(item.querySelector('[data-testid="plugin-icon-wrapper"]')) === skill.id.startsWith('plugin_')
        && Array.from(item.querySelectorAll('span')).some((span) =>
          (span.textContent ?? '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase() === normalizedName));
      if (candidates.length > 1) throw new Error('有多个同名技能，请在 ChatGPT 中保留唯一名称后重试');
      if (candidates.length === 1) { candidates[0].click(); selected = true; break; }
      await sleep(200);
    }
    if (!selected) throw new Error(`未找到已安装技能「${skill.name}」。请先在当前 ChatGPT 账号安装，未发送客户上下文。`);
    await sleep(500);
    const pills = input.querySelectorAll(selector);
    if (pills.length !== 1 || !matches(pills[0])) {
      throw new Error('选中的技能身份不匹配，未发送客户上下文');
    }
    selectContents(true);
    if (!document.execCommand('insertText', false, `\n${text}`)) throw new Error('无法填入技能上下文');
    await sleep(1200);
    const remainingPills = input.querySelectorAll(selector);
    const clone = input.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]').forEach((el) => el.remove());
    const normalize = (s: string) => s.replace(/[\s\uFEFF]+/g, '');
    if (remainingPills.length !== 1 || !matches(remainingPills[0])
      || normalize(clone.textContent ?? '') !== normalize(text)) {
      throw new Error('技能标签或客户上下文未完整保留，未发送');
    }
    // Existing conversations restore their last submitted effort on reopening.
    // Apply the template's explicit preference in the same tab that sends the prompt.
    if (skill.thinkingEffort === 'high') {
      const effort = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'))
        .find(el => visible(el) && /^(Instant|Medium|High|Extra High)$/.test(el.textContent?.trim() ?? ''));
      if (!effort) throw new Error('找不到 Chat 思考强度设置，未发送；请确认使用普通 Chat 模型');
      if (effort.textContent?.trim() !== 'High') {
        // Radix's trigger opens on pointerdown, not HTMLElement.click().
        effort.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        effort.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        await sleep(300);
        if (!document.querySelector('[data-testid="composer-intelligence-picker-content"]')) effort.click();
        let picker = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
        const menuDeadline = Date.now() + 4000;
        while (!picker && Date.now() < menuDeadline) {
          await sleep(100);
          picker = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
        }
        const power = picker?.querySelector<HTMLElement>('[role="menuitem"][aria-label="Power"]');
        const slider = picker?.querySelector('[role="slider"]');
        const model = picker?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent?.trim();
        if (!power || !slider || slider.getAttribute('aria-valuemax') !== '3' || !['Latest', 'GPT-5.6 Sol'].includes(model ?? '')) {
          throw new Error('无法确认普通 Chat High 设置，未发送');
        }
        for (let i = 0; i < 3 && slider.getAttribute('aria-valuenow') !== '2'; i++) {
          const value = Number(slider.getAttribute('aria-valuenow'));
          if (!Number.isInteger(value) || value < 0 || value > 3) break;
          const key = value < 2 ? 'ArrowRight' : 'ArrowLeft';
          power.focus();
          power.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
          power.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
          await sleep(100);
        }
        if (slider.getAttribute('aria-valuenow') !== '2') throw new Error('未能切到 High，未发送');
        power.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        power.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
        input.click();
        input.focus();
        await sleep(300);
        if (effort.textContent?.trim() !== 'High') throw new Error('High 设置未保留，未发送');
      }
    }
    if (skill.id.startsWith('plugin_') && workIsSelected()) throw new Error('页面切回了 Work，未发送；请切到 Chat 后重试');
    return { ok: true };
  } catch (error) {
    // executeScript can discard a rejected promise's message. Return it explicitly.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
