/** Request the MAIN-world reader without silently accepting a failed injection. */
export function installChatBridgeClient(refresh: () => void): () => void {
  let disposed = false;
  let pending: Promise<void> | null = null;
  const state = (value: string) => {
    document.documentElement.setAttribute('data-sgc-bridge-injection', value);
    window.dispatchEvent(new CustomEvent('sgc:bridge-status'));
  };

  const inject = async () => {
    for (let attempt = 1; attempt <= 3 && !disposed; attempt++) {
      state('loading');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage({ type: 'INJECT_FIBER_BRIDGE' }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('聊天识别连接超时')), 5000);
          }),
        ]);
        if (response?.ok !== true) {
          throw new Error(response?.error || '聊天识别连接未返回成功状态');
        }
        if (disposed) return;
        state('ready');
        refresh();
        return;
      } catch (error) {
        if (disposed) return;
        console.warn(`[sgc/bridge] 注入失败 (${attempt}/3)`, error);
        if (attempt === 3) {
          state('error');
          refresh();
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (attempt < 3 && !disposed) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  };

  const retry = () => {
    if (disposed || pending) return;
    pending = inject().finally(() => { pending = null; });
  };
  window.addEventListener('sgc:retry-chat-identification', retry);
  retry();
  return () => {
    disposed = true;
    window.removeEventListener('sgc:retry-chat-identification', retry);
  };
}
