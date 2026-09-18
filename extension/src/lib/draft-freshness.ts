import type { ChatMessage } from '../content/whatsapp-messages';
export function evidenceKey(m: ChatMessage): string {
  let hash = 2166136261;
  for (const c of JSON.stringify([m.fromMe, m.text, m.timestamp])) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `${m.id}:${hash >>> 0}`;
}
export interface DraftEvidence { keys: string[]; newestAt: number; }
export function snapshotDraftEvidence(messages: ChatMessage[]): DraftEvidence {
  return { keys: messages.map(evidenceKey), newestAt: Math.max(0, ...messages.map(m => m.timestamp ?? 0)) };
}
export function draftHasNewEvidence(snapshot: DraftEvidence, messages: ChatMessage[]): boolean {
  const keys = new Set(snapshot.keys);
  return messages.some(m => !keys.has(evidenceKey(m)) && (
    snapshot.keys.some(k => k.startsWith(`${m.id}:`)) || !m.timestamp || m.timestamp >= snapshot.newestAt
  ));
}
