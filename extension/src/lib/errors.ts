export function stringifyError(err: unknown): string {
  const raw = rawStringify(err);
  if (raw.includes('Extension context invalidated')) {
    return '扩展刚更新，请刷新此 WhatsApp 标签页（F5 / Cmd+R）';
  }
  return raw;
}

function rawStringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) {
      const code = typeof e.code === 'string' ? ` (${e.code})` : '';
      const details = typeof e.details === 'string' ? `: ${e.details}` : '';
      return `${e.message}${code}${details}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return '[object Object]';
    }
  }
  return String(err);
}
