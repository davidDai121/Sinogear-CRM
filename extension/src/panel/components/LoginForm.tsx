import { useState, type FormEvent } from 'react';
import { signIn, signUp } from '../hooks/useAuth';

export function LoginForm() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, password);
      else await signUp(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sgc-form" onSubmit={submit}>
      <h2>{mode === 'signin' ? '登录' : '注册'} Sino Gear CRM</h2>

      <label className="sgc-field">
        <span>邮箱</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </label>

      <label className="sgc-field">
        <span>密码</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
        />
      </label>

      {error && <div className="sgc-error">{error}</div>}

      <button type="submit" className="sgc-btn-primary" disabled={busy}>
        {busy ? '处理中…' : mode === 'signin' ? '登录' : '注册'}
      </button>

      <button
        type="button"
        className="sgc-btn-link"
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
      >
        {mode === 'signin' ? '没有账号？注册' : '已有账号？登录'}
      </button>
    </form>
  );
}
