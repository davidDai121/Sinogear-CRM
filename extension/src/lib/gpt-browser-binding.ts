/** Local to a Chrome profile, additionally isolated by CRM organization and user. */
export interface GptBrowserBinding {
  defaultTemplateId: string;
  r08TemplateId: string;
}

export const gptBrowserBindingKey = (orgId: string, userId: string) =>
  `gptBrowserBinding:${orgId}:${userId}`;

export function templateOwner(templates: { created_by: string | null }[]): string {
  const owners = new Set(templates.map(t => t.created_by));
  if (owners.size !== 1 || !templates[0]?.created_by) throw new Error('无法确认 GPT 模板所属 CRM 账号，请刷新重试。');
  return templates[0].created_by;
}

export async function loadGptBrowserBinding(orgId: string, userId: string): Promise<GptBrowserBinding | null> {
  const key = gptBrowserBindingKey(orgId, userId);
  const value = (await chrome.storage.local.get(key))[key];
  if (value === undefined) return null;
  if (!value || typeof value.defaultTemplateId !== 'string' || !value.defaultTemplateId
    || typeof value.r08TemplateId !== 'string' || !value.r08TemplateId) {
    throw new Error('本浏览器 GPT 配置损坏，请在管理模板中重新保存。');
  }
  return { defaultTemplateId: value.defaultTemplateId, r08TemplateId: value.r08TemplateId };
}

export function browserAllowsTemplate(binding: GptBrowserBinding | null | undefined, templateId: string): boolean {
  return !binding || templateId === binding.defaultTemplateId || templateId === binding.r08TemplateId;
}

export function gptManualTemplateKey(orgId: string, contactId: string, binding: GptBrowserBinding | null): string {
  const legacy = `gptManualTemplate:${orgId}:${contactId}`;
  return binding ? `${legacy}:${binding.defaultTemplateId}:${binding.r08TemplateId}` : legacy;
}
