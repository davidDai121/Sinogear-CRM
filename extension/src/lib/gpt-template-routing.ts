import type { ChatMessage } from '@/content/whatsapp-messages';
import { isMediaOnly } from './chat-media-utils';
import { isSalesPitch } from './sales-pitch';
import { decodeGptTemplateDescription } from './gpt-template-knowledge';
import { R08_SKILL_ID } from './gpt-skill';
import { browserAllowsTemplate, type GptBrowserBinding } from './gpt-browser-binding';

// Verified R08 GPT identities in the owners' separate ChatGPT accounts.
// Routing may recognize both; conversation reuse still requires the exact ID.
export const R08_GPT_ID = 'g-6aa7711ad9cc8191aa3d3693cfd7ad9f';
export const MENGLONG_R08_GPT_ID = 'g-6aaff2e20f848191a17b81f6786cdebe';
const R08_GPT_IDS = new Set([R08_GPT_ID, MENGLONG_R08_GPT_ID]);
const R08_SKILL_IDS = new Set([R08_SKILL_ID, 'plugin_5e838f5f90dc81919776e122e642836e']);

interface Template {
  id: string;
  name: string;
  gpt_url: string;
  is_default: boolean;
  description?: string | null;
}

export interface GptRoutingContext {
  messages: Pick<ChatMessage, 'text' | 'fromMe' | 'timestamp'>[];
  vehicleInterests: { model: string }[];
  salesGuidance?: string;
  discussionQuestion?: string;
  /** Explicit choice for this customer; takes priority over inferred topics. */
  manualTemplateId?: string;
  browserBinding?: GptBrowserBinding | null;
}

type Topic = 'r08' | 'other' | null;

/** R8 alone can mean Audi; an explicit RELY/Chery prefix disambiguates it. */
export function mentionsR08(text: string): boolean {
  return /(?:^|[^a-z0-9])r[\s_-]*0[\s_-]*8(?![a-z0-9])/i.test(text)
    || /(?:^|[^a-z0-9])(?:rely|chery)[\s_-]+(?:rely[\s_-]+)?r[\s_-]*8(?![a-z0-9])/i.test(text);
}

// Only definite model names can supersede an older R08 interest. Do not reuse
// vehicle-aliases' permissive field normalization (rely, accord, mini, radar).
const OTHER_MODELS = /(?:^|[^a-z0-9])(?:hilux|rd[\s_-]*6|atto[\s_-]*3|yuan[\s_-]+plus|qin[\s_-]+plus|seagull|rav[\s_-]*4|land[\s_-]*cruiser|prado|fortuner|hiace|d[\s_-]*max|f[\s_-]*150|jetour[\s_-]+(?:t[12]|x70|dashing)|tank[\s_-]*(?:300|400|500|700)|uni[\s_-]*[ktv]|byd[\s_-]+(?:shark|seal|dolphin|song|han|tang)|ford[\s_-]+ranger|audi[\s_-]+r[\s_-]*8)(?![a-z0-9])/i;

function topicOf(text: string): Topic {
  // Rejecting the whole model is different from comparing it. Require a clause
  // boundary after R08, so "no quiero R08 gasolina" does not drop its diesel EV
  // alternatives. If another R08 mention remains, keep the specialist.
  const withoutDeclinedR08 = text.replace(
    /(?:不要|不买|不考虑|不看|放弃|(?:don['’]t|do\s+not|no\s+longer)\s+(?:want|need)|not\s+interested\s+in|no\s+(?:quiero|busco|me\s+interesa))\s*(?:(?:the|el|la)\s+)?(?:(?:rely|chery)\s+)?r[\s_-]*0[\s_-]*8(?=\s*(?:[,，;；.!。!?？]|$))/gi,
    ' ',
  );
  if (withoutDeclinedR08 !== text && !mentionsR08(withoutDeclinedR08)) return 'other';
  // A comparison including R08 still needs the R08 knowledge and template.
  if (mentionsR08(text)) return 'r08';
  return OTHER_MODELS.test(text) ? 'other' : null;
}

function inferTopic(context: GptRoutingContext): { topic: Topic; reason: string } {
  for (const text of [context.discussionQuestion, context.salesGuidance]) {
    const topic = topicOf(text ?? '');
    if (topic) return { topic, reason: '当前销售指令' };
  }
  const messages = context.messages.slice(-50).filter((m) =>
    !isMediaOnly(m.text) && m.text.trim() !== '[已删除]' && !isSalesPitch(m.text));
  // Untimed attachments/history cannot become the newest topic merely because
  // a DB NULL timestamp put them at the end of the array.
  const timed = messages.filter((m) => m.timestamp !== null && Number.isFinite(m.timestamp))
    .sort((a, b) => b.timestamp! - a.timestamp!);
  for (const fromMe of [false, true]) {
    for (const message of timed.filter((m) => m.fromMe === fromMe)) {
      const topic = topicOf(message.text);
      if (topic) return { topic, reason: fromMe ? '最近销售聊天中的车型' : '最近客户聊天中的车型' };
    }
  }
  if (context.vehicleInterests.some((v) => mentionsR08(v.model))) {
    return { topic: 'r08', reason: '客户的 R08 车型兴趣' };
  }
  // If chronology is unavailable, use only an unambiguous topic as a fallback.
  const topics = new Set(messages.map((m) => topicOf(m.text)).filter(Boolean));
  if (topics.size === 1) return { topic: [...topics][0]!, reason: '聊天中的明确车型' };
  // A new ad lead may only say "Hello". Its R08 ad can select the specialist,
  // but only after real conversation evidence; no ad price becomes approved.
  if (topics.size === 0 && context.messages.slice(-50).some((m) => isSalesPitch(m.text) && mentionsR08(m.text))) {
    return { topic: 'r08', reason: 'R08 广告来源' };
  }
  return { topic: null, reason: '' };
}

function chatGptUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
      || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function customGptId(raw: string): string | null {
  return chatGptUrl(raw)?.pathname.match(/^\/g\/(g-[a-z0-9]+)(?:-|\/|$)/i)?.[1].toLowerCase() ?? null;
}

function templateSkill(template: { description?: string | null }) {
  try { return decodeGptTemplateDescription(template.description ?? null).skill; }
  catch { return undefined; } // Generation still fails closed in the knowledge loader.
}

export function isR08Template(template: Template): boolean {
  const gptId = customGptId(template.gpt_url);
  const skillId = templateSkill(template)?.id;
  return (skillId !== undefined && R08_SKILL_IDS.has(skillId)) || (gptId !== null && R08_GPT_IDS.has(gptId));
}

export function resolveGptTemplateRoute<T extends Template>(
  templates: T[], selectedTemplateId: string, context: GptRoutingContext,
): { template: T | null; isR08: boolean; reason: string; error: string | null } {
  const binding = context.browserBinding;
  if (binding) {
    const general = templates.find(t => t.id === binding.defaultTemplateId);
    const r08 = templates.find(t => t.id === binding.r08TemplateId);
    if (!general || !r08 || isR08Template(general) || !isR08Template(r08)) {
      return { template: null, isR08: false, reason: '', error: '本浏览器保存的 GPT 入口已不可用，请在管理模板中重新配置。' };
    }
    if (context.manualTemplateId && !browserAllowsTemplate(binding, context.manualTemplateId)) {
      return { template: null, isR08: false, reason: '', error: '手动模板不属于本浏览器配置，请恢复自动匹配。' };
    }
    templates = templates.filter(t => browserAllowsTemplate(binding, t.id));
    selectedTemplateId = binding.defaultTemplateId;
  }
  if (context.manualTemplateId) {
    const template = templates.find((t) => t.id === context.manualTemplateId) ?? null;
    return {
      template,
      isR08: !!template && isR08Template(template),
      reason: '手动选择',
      error: template ? null : '手动选择的 GPT 模板已不可用，请重新选择或恢复自动匹配。',
    };
  }
  const { topic, reason } = inferTopic(context);
  const r08Templates = templates.filter(isR08Template);
  if (topic === 'r08') {
    const template = r08Templates.find((t) => t.id === selectedTemplateId) ?? r08Templates[0] ?? null;
    return {
      template, isR08: true, reason,
      error: template ? null : '已识别 R08，但当前账号没有可用的 R08 专用模板。请在管理模板中配置 R08 GPT 后重试。',
    };
  }
  const selected = templates.find((t) => t.id === selectedTemplateId);
  const available = topic === 'other'
    ? templates.filter((t) => !isR08Template(t)) : templates;
  const template = available.find((t) => t.id === selected?.id)
    ?? available.find((t) => t.is_default) ?? available[0] ?? null;
  return { template, isR08: false, reason, error: null };
}

/** A template ID alone is insufficient: never continue another GPT's thread. */
export function isConversationForGptTemplate(
  conversation: { contact_id: string; template_id: string; chat_url: string },
  contactId: string, template: Pick<Template, 'id' | 'gpt_url' | 'description'>,
): boolean {
  if (conversation.contact_id !== contactId || conversation.template_id !== template.id) return false;
  const url = chatGptUrl(conversation.chat_url);
  if (!url || !chatGptUrl(template.gpt_url)) return false;
  const skill = templateSkill(template);
  if (skill) return url.hostname === 'chatgpt.com' && /^\/c\/[a-z0-9-]+\/?$/i.test(url.pathname)
    && new URLSearchParams(url.hash.slice(1)).get('sgc_skill') === skill.id;
  const expectedId = customGptId(template.gpt_url);
  if (expectedId) {
    return customGptId(conversation.chat_url) === expectedId
      && /^\/g\/[^/]+\/c\/[a-z0-9-]+\/?$/i.test(url.pathname);
  }
  return customGptId(conversation.chat_url) === null && /^\/c\/[a-z0-9-]+\/?$/i.test(url.pathname);
}
