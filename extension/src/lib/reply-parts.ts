/**
 * 把给客户的正文按空行拆成几条消息。
 *
 * 只给要求「拆条发送」的技能用（Miles V3，见 gpt-template-routing 的
 * splitsCustomerMessages）：它的空行代表「这里是下一条消息」，业务员一条一条发。
 * V2 / Gem 的空行只是同一条消息里的段落，不能拆。
 *
 * 一条消息内部的单个换行保留；只有空行（可夹空格）才算分条。
 */
export function splitReplyParts(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}
