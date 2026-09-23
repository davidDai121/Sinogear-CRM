import { parseClaudeResponse } from './claude-parser';

// Only explicit internal directives, never ordinary customer wording such as
// “you do not need to pay yet”. Keep old saved drafts safe as well as new ones.
const INTERNAL_NO_REPLY = /^(?:NO_REPLY\b|\[NO_REPLY\]|(?:现在|本轮|当前|暂时)?\s*(?:不需要|无需|不用|不要|暂不)\s*(?:再|给客户)?\s*(?:发送(?:消息|回复)|回复客户|联系客户)|(?:No (?:es necesario|hace falta) enviar (?:un |otro |ningún )?mensaje|Não é necessário enviar (?:uma |outra |nova |nenhuma )*mensagem|(?:There is )?no need to (?:send (?:a |another |new )*message|reply)|Do not (?:send (?:a |another |new )*message|reply)))/i;

export function parseGptResponse(text: string) {
  const parsed = parseClaudeResponse(text);
  let noReplyReason: string | null = null;
  const block = text.match(/<crm_followup>\s*([\s\S]*?)\s*<\/crm_followup>/i);
  try {
    const decision = block ? JSON.parse(block[1]) : null;
    if (decision?.replyRequired === false) noReplyReason = typeof decision.reason === 'string' ? decision.reason : '本轮无需发送客户消息';
  } catch { /* Metadata validation belongs to gpt-followup. */ }
  if (parsed.reply && INTERNAL_NO_REPLY.test(parsed.reply.trim())) noReplyReason ??= '本轮无需发送客户消息，请查看下方中文说明和等待条件。';
  if (!parsed.reply) noReplyReason ??= '本轮没有客户回复，请查看内部处理说明。';
  return { ...parsed, reply: noReplyReason ? null : parsed.reply, noReplyReason };
}

export function normalizeGptReply(text: string): string {
  const parsed = parseGptResponse(text);
  if (!parsed.noReplyReason || !text.includes('[WhatsApp Reply]')) return text;
  return text.replace(/(\[WhatsApp Reply\])[\s\S]*?(?=\[Full Translation & Strategy\])/, '$1\n\n');
}
