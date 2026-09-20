import { useEffect, useState } from 'react';

export function UnresolvedChat({ name }: { name: string | null }) {
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setStatus(
      document.documentElement.getAttribute('data-sgc-bridge-injection'),
    );
    update();
    window.addEventListener('sgc:bridge-status', update);
    return () => window.removeEventListener('sgc:bridge-status', update);
  }, []);

  if (!name) {
    return <div className="sgc-empty"><p>请在 WhatsApp 选择一个聊天</p></div>;
  }
  return (
    <div className="sgc-empty" role="status">
      <p>已打开 {name}，但尚未识别到客户号码。</p>
      {status === 'error' && <p>聊天识别连接失败，请刷新 WhatsApp 页面后重试。</p>}
      <button
        type="button"
        className="sgc-btn-mini"
        disabled={status === 'loading'}
        onClick={() => window.dispatchEvent(new CustomEvent('sgc:retry-chat-identification'))}
      >
        {status === 'loading' ? '正在重新识别…' : '重新识别'}
      </button>
    </div>
  );
}
