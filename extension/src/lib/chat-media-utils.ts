/**
 * 聊天消息中"媒体附件占位"的统一识别 + 合并工具。
 *
 * 三个 prompt 文件（claude / gpt / gem）之前各自维护一份 isMediaOnly + collapseMediaRuns
 * 副本，内容一样但容易漂移。抽到这里统一维护。
 *
 * 设计要点：
 *   - 识别占位符多源：DOM 端 readChatMessages 占位（`[图片]` / `[视频]` / `[语音]` /
 *     `[文档]` / `[贴纸]` / `[媒体]`）+ 手机端 .txt 导入占位（`IMG-...jpg (文件附件)` /
 *     `VID-...mp4 (文件附件)` 等）
 *   - mediaKind 把不同来源统一映射到 'image' / 'video' / 'audio' / 'document' /
 *     'sticker' / 'media'（无法识别）
 *   - collapseMediaRuns 按 (fromMe, kind) 双 key 分组，连续同方向同类型才合并
 *   - 合并后的 text 是人话英文短语（"sent 4 photos" / "sent 1 PDF document"），
 *     让 AI 一眼明白「谁发了几个什么」而不是再读模糊的 `[图片 × 4]` 占位
 */

import type { ChatMessage } from '@/content/whatsapp-messages';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'media';

/**
 * 判断一条消息的文本是否「只是媒体附件占位」（没真实文字内容）。
 *   - DOM 端 readChatMessages 给空 bubble 的占位：`[图片]` / `[视频]` / `[语音]` /
 *     `[文档]` / `[贴纸]` / `[媒体]` / `<媒体>`
 *   - 手机端 .txt 导入的附件文件名占位：`IMG-20260505-WA0014.jpg (文件附件)` 等
 *   - 完全空文本（兜底）
 */
export function isMediaOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\[(图片|视频|语音|文档|贴纸|媒体)\]$/.test(t)) return true;
  if (t === '<媒体>') return true;
  if (
    /^‎?(IMG|VID|VIDEO|AUD|AUDIO|DOC|PTT|STK|PHOTO|GIF)[-_].+\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|opus|m4a|mp3|pdf|docx?|xlsx?|pptx?)\s*\(文件附件\)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 从一条"媒体占位"消息里识别附件类型。非媒体消息返回 'media' 兜底。
 */
export function mediaKind(text: string): MediaKind {
  const t = text.trim();

  // DOM 占位
  if (t === '[图片]') return 'image';
  if (t === '[视频]') return 'video';
  if (t === '[语音]') return 'audio';
  if (t === '[文档]') return 'document';
  if (t === '[贴纸]') return 'sticker';
  if (t === '[媒体]' || t === '<媒体>') return 'media';

  // 导入 .txt 占位 — 看文件名前缀
  const m = t.match(/^‎?(IMG|PHOTO|GIF|VID|VIDEO|AUD|AUDIO|PTT|DOC|STK)[-_]/i);
  if (m) {
    const prefix = m[1].toUpperCase();
    if (prefix === 'IMG' || prefix === 'PHOTO' || prefix === 'GIF') return 'image';
    if (prefix === 'VID' || prefix === 'VIDEO') return 'video';
    if (prefix === 'AUD' || prefix === 'AUDIO' || prefix === 'PTT') return 'audio';
    if (prefix === 'DOC') return 'document';
    if (prefix === 'STK') return 'sticker';
  }

  // 文件扩展名兜底（导入占位某些写法）
  if (/\.(pdf|docx?|xlsx?|pptx?)\s*\(文件附件\)$/i.test(t)) return 'document';
  if (/\.(mp4|mov|webm)\s*\(文件附件\)$/i.test(t)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)\s*\(文件附件\)$/i.test(t)) return 'image';
  if (/\.(opus|m4a|mp3)\s*\(文件附件\)$/i.test(t)) return 'audio';

  return 'media';
}

/**
 * 把 N 条同类型媒体消息渲染成一句 AI 看得懂的人话占位。
 *
 * 例：
 *   ('image', 1, true) → '[Sales sent 1 photo to customer]'
 *   ('image', 4, true) → '[Sales sent 4 photos to customer]'
 *   ('video', 2, false) → '[Customer sent 2 videos]'
 *   ('document', 1, true) → '[Sales sent 1 document (PDF / spec sheet / Word / Excel)]'
 *   ('audio', 1, false) → '[Customer sent 1 voice message]'
 *   ('media', 3, true) → '[Sales sent 3 attachments]'
 */
export function formatMediaPlaceholder(kind: MediaKind, n: number, fromMe: boolean): string {
  const who = fromMe ? 'Sales sent' : 'Customer sent';
  const plural = n > 1;
  switch (kind) {
    case 'image':
      return `[${who} ${n} ${plural ? 'photos' : 'photo'}${fromMe ? ' to customer' : ''}]`;
    case 'video':
      return `[${who} ${n} ${plural ? 'videos' : 'video'}${fromMe ? ' to customer' : ''}]`;
    case 'audio':
      return `[${who} ${n} ${plural ? 'voice messages' : 'voice message'}]`;
    case 'document':
      return `[${who} ${n} ${plural ? 'documents' : 'document'} (PDF / spec sheet / Word / Excel)${fromMe ? ' to customer' : ''}]`;
    case 'sticker':
      return `[${who} ${n} ${plural ? 'stickers' : 'sticker'}]`;
    case 'media':
    default:
      return `[${who} ${n} ${plural ? 'attachments' : 'attachment'}${fromMe ? ' to customer' : ''}]`;
  }
}

/**
 * 合并连续的媒体消息：同方向、同类型连续 N 条 → 1 条带数量的人话占位。
 * 非媒体消息保留不动。这样 AI 看到的是
 *   "Sales sent 4 photos to customer"
 *   "Sales sent 1 PDF document to customer"
 * 而不是 4 行 `Sales: [图片]` 占位墙。
 */
export function collapseMediaRuns(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let run: ChatMessage[] = [];
  let runKind: MediaKind | null = null;

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const n = run.length;
    const kind = runKind ?? 'media';
    result.push({
      id: first.id + (n > 1 ? `:+${n - 1}` : ''),
      fromMe: first.fromMe,
      text: formatMediaPlaceholder(kind, n, first.fromMe),
      timestamp: last.timestamp ?? first.timestamp,
      sender: first.sender,
    });
    run = [];
    runKind = null;
  };

  for (const m of messages) {
    if (isMediaOnly(m.text)) {
      const kind = mediaKind(m.text);
      // 跟当前 run 的方向 + 类型都一致才并入，否则切断
      const sameDir = run.length === 0 || run[run.length - 1].fromMe === m.fromMe;
      const sameKind = runKind === null || runKind === kind;
      if (sameDir && sameKind) {
        run.push(m);
        runKind = kind;
      } else {
        flush();
        run.push(m);
        runKind = kind;
      }
    } else {
      flush();
      result.push(m);
    }
  }
  flush();
  return result;
}
