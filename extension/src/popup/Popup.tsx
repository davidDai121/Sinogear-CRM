import { useAuth, signOut } from '@/panel/hooks/useAuth';
import { LoginForm } from '@/panel/components/LoginForm';

export function Popup() {
  const { session, user, loading } = useAuth();

  const openWhatsApp = () => {
    chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
  };

  if (loading) {
    return <div className="sgc-empty">加载中…</div>;
  }

  if (!session) {
    return <LoginForm />;
  }

  return (
    <div>
      <div className="sgc-popup-status">
        <span className="sgc-popup-dot online" />
        <span>已登录：{user?.email}</span>
      </div>

      <div className="sgc-popup-section">
        <button className="sgc-btn-primary" onClick={openWhatsApp}>
          打开 WhatsApp Web
        </button>
      </div>

      <div className="sgc-popup-section">
        <button className="sgc-btn-link" onClick={signOut}>
          登出
        </button>
      </div>
    </div>
  );
}
