import { useState, type FormEvent } from 'react';

interface Props {
  onCreate: (name: string) => Promise<unknown>;
}

export function OrgSetup({ onCreate }: Props) {
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

  return (
    <form className="sgc-form" onSubmit={submit}>
      <h2>创建团队</h2>
      <p className="sgc-empty" style={{ padding: 0, textAlign: 'left' }}>
        你还没有加入任何团队。创建一个开始使用，团队成员之间可以共享客户数据。
      </p>

      <label className="sgc-field">
        <span>团队名称</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="例如：Sino Gear 销售部"
        />
      </label>

      {error && <div className="sgc-error">{error}</div>}

      <button type="submit" className="sgc-btn-primary" disabled={busy}>
        {busy ? '创建中…' : '创建团队'}
      </button>
    </form>
  );
}
