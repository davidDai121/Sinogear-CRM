import { useEffect, useState } from 'react';
import { checkVersion, type VersionCheckResult } from '@/lib/version-check';
import { signOut } from '../hooks/useAuth';

interface Props {
  children: React.ReactNode;
}

const RECHECK_MS = 5 * 60 * 1000; // 每 5 分钟重测一次（boss 推新版后销售自动解封需要时间）

export function VersionGate({ children }: Props) {
  const [result, setResult] = useState<VersionCheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      void checkVersion().then((r) => {
        if (!cancelled) setResult(r);
      });
    };
    run();
    const id = window.setInterval(run, RECHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // 首次检测中 — 短暂 loading
  if (!result) {
    return (
      <div className="sgc-shell sgc-shell-overlay">
        <div className="sgc-empty">检查版本中…</div>
      </div>
    );
  }

  // 放行
  if (result.status === 'dev' || result.status === 'ok') {
    return <>{children}</>;
  }

  // 拦截
  const isMismatch = result.status === 'mismatch';
  const title = isMismatch ? '⚠️ 版本不匹配，请更新' : '⚠️ 无法验证版本，请检查网络';
  const explanation = isMismatch
    ? '管理员已发布新版扩展，你目前用的是旧版。功能在新版里有重要修复 / 改动，必须更新后才能继续使用。'
    : '扩展启动时无法连到服务器读"必须使用的版本号"，且本地也没有最近一次缓存。请确认网络通畅后刷新 WhatsApp Web 重试。';

  return (
    <div className="sgc-shell sgc-shell-overlay">
      <div
        className="sgc-overlay-card"
        style={{ maxWidth: 560, padding: 24, lineHeight: 1.6 }}
      >
        <h2 style={{ margin: '0 0 12px 0', color: '#b71c1c' }}>{title}</h2>
        <p style={{ margin: '0 0 16px 0', color: '#111b21' }}>{explanation}</p>

        <div
          style={{
            background: '#f6f7f9',
            border: '1px solid #e9edef',
            borderRadius: 6,
            padding: 12,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div>
            你的版本：<code style={{ color: '#b71c1c' }}>{result.buildVersion}</code>
          </div>
          <div>
            要求版本：
            <code style={{ color: '#1b5e20' }}>{result.requiredVersion ?? '(未知)'}</code>
            {result.source === 'cache' && (
              <span style={{ color: '#667781', marginLeft: 6 }}>(本地缓存)</span>
            )}
          </div>
        </div>

        {isMismatch && (
          <div style={{ background: '#fff8e1', border: '1px solid #ffe082', borderRadius: 6, padding: 12, marginBottom: 16, fontSize: 13 }}>
            <strong>更新步骤：</strong>
            <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
              <li>找管理员要最新的 zip（或新版下载链接）</li>
              <li>解压到原来同一个文件夹（覆盖旧文件）</li>
              <li>打开 <code>chrome://extensions/</code> → 找到 Sino Gear CRM → 点 ↻ 重新加载</li>
              <li>回 WhatsApp Web 标签页 <kbd>F5</kbd> 刷新一次</li>
            </ol>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="sgc-btn-primary"
            onClick={() => {
              setResult(null);
              void checkVersion().then(setResult);
            }}
          >
            重试检测
          </button>
          <button
            type="button"
            className="sgc-btn-primary"
            style={{ background: '#667781' }}
            onClick={() => signOut()}
          >
            登出
          </button>
        </div>
      </div>
    </div>
  );
}
