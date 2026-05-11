import { useState, type FormEvent } from 'react';
import { signOut } from '../hooks/useAuth';

interface Props {
  email: string | null;
  onCreate: (name: string) => Promise<unknown>;
}

type Step = 'guidance' | 'confirm' | 'form';

export function OrgSetup({ email, onCreate }: Props) {
  const [step, setStep] = useState<Step>('guidance');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'guidance') {
    return (
      <div className="sgc-form">
        <h2>你还没有加入任何团队</h2>
        <div style={{ fontSize: 13, color: '#667781', marginBottom: 12 }}>
          当前登录：<strong style={{ color: '#111b21' }}>{email ?? '(未知)'}</strong>
        </div>

        <div
          style={{
            background: '#fff8e1',
            border: '1px solid #ffe082',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <strong>⚠️ 如果你是公司员工，请不要在这里建新团队</strong>
          <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
            <li>你应该被管理员邀请加入现有团队</li>
            <li>请联系管理员，让他在团队页 "👥 团队 → 邀请成员" 里发邀请</li>
            <li>邀请要发到上面这个邮箱（{email ?? '(未知)'}）</li>
            <li>建独立团队会让你看不到任何团队客户数据，且无法合并</li>
          </ul>
        </div>

        <button
          type="button"
          className="sgc-btn-primary"
          style={{ background: '#667781' }}
          onClick={() => signOut()}
        >
          换个账号登录
        </button>

        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: '1px solid #e9edef',
            fontSize: 12,
            color: '#667781',
          }}
        >
          只有团队创始人 / 管理员才需要建新团队。
          <button
            type="button"
            onClick={() => setStep('confirm')}
            style={{
              background: 'none',
              border: 'none',
              color: '#00a884',
              cursor: 'pointer',
              padding: 0,
              marginLeft: 4,
              textDecoration: 'underline',
              font: 'inherit',
            }}
          >
            我是团队创始人，要建新团队 →
          </button>
        </div>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="sgc-form">
        <h2>确认建新团队？</h2>
        <div
          style={{
            background: '#ffebee',
            border: '1px solid #ef9a9a',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <strong>请再确认一次：</strong>
          <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
            <li>新团队跟其他团队完全隔离，互相看不到客户</li>
            <li>建错之后无法自动合并数据</li>
            <li>如果你只是想加入同事的团队，<strong>不要</strong>建新团队 —— 让管理员邀请你</li>
          </ul>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="sgc-btn-primary"
            style={{ background: '#667781', flex: 1 }}
            onClick={() => setStep('guidance')}
          >
            返回
          </button>
          <button
            type="button"
            className="sgc-btn-primary"
            style={{ flex: 1 }}
            onClick={() => setStep('form')}
          >
            确认，我要建新团队
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="sgc-form" onSubmit={submit}>
      <h2>创建团队</h2>
      <p className="sgc-empty" style={{ padding: 0, textAlign: 'left' }}>
        团队成员之间共享客户数据。建好后到 "👥 团队" 邀请同事加入。
      </p>

      <label className="sgc-field">
        <span>团队名称</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="例如：Sino Gear 销售部"
          autoFocus
        />
      </label>

      {error && <div className="sgc-error">{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="sgc-btn-primary"
          style={{ background: '#667781', flex: 1 }}
          onClick={() => setStep('guidance')}
          disabled={busy}
        >
          返回
        </button>
        <button type="submit" className="sgc-btn-primary" style={{ flex: 1 }} disabled={busy}>
          {busy ? '创建中…' : '创建团队'}
        </button>
      </div>
    </form>
  );
}
