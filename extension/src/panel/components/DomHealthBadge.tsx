import { useEffect, useState } from 'react';
import { runDomHealthCheck, brokenCount, type CheckResult } from '@/lib/dom-health';

const RECHECK_MS = 60_000;

export function DomHealthBadge() {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    const run = () => setResults(runDomHealthCheck());
    run();
    const id = window.setInterval(run, RECHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  const broken = brokenCount(results);
  if (broken === 0) return null;

  return (
    <>
      <button
        type="button"
        className="sgc-topnav-toggle"
        style={{
          background: '#ffebee',
          color: '#b71c1c',
          border: '1px solid #ef9a9a',
        }}
        title="WhatsApp Web 关键 DOM 选择器有失效，点击查看详情"
        onClick={() => setShowDetail(true)}
      >
        🔴 DOM {broken}
      </button>

      {showDetail && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => setShowDetail(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 8,
              padding: 20,
              maxWidth: 560,
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto',
            }}
          >
            <h3 style={{ margin: '0 0 12px 0' }}>DOM 健康检查</h3>
            <p style={{ fontSize: 12, color: '#667781', margin: '0 0 12px 0' }}>
              WhatsApp Web 改了 DOM 时这里会变红。失效项可能让"读当前聊天 / 跳转聊天 / 提取手机号"等功能静默失败。
              请把下面的"失效项"截图发给开发者。
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f6f7f9' }}>
                  <th style={{ padding: 8, textAlign: 'left' }}>状态</th>
                  <th style={{ padding: 8, textAlign: 'left' }}>检查项</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.name} style={{ borderTop: '1px solid #e9edef' }}>
                    <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                      {r.status === 'ok' && <span style={{ color: '#1b5e20' }}>✓ OK</span>}
                      {r.status === 'broken' && <span style={{ color: '#b71c1c' }}>✗ 失效</span>}
                      {r.status === 'skipped' && <span style={{ color: '#667781' }}>— 跳过</span>}
                    </td>
                    <td style={{ padding: 8 }}>
                      <div>{r.description}</div>
                      {r.status === 'broken' && r.hint && (
                        <div style={{ fontSize: 11, color: '#b71c1c', marginTop: 4 }}>
                          影响：{r.hint}
                        </div>
                      )}
                      {r.status === 'skipped' && r.hint && (
                        <div style={{ fontSize: 11, color: '#667781', marginTop: 4 }}>
                          {r.hint}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button
                className="sgc-btn-primary"
                onClick={() => setResults(runDomHealthCheck())}
                type="button"
                style={{ marginRight: 8, background: '#667781' }}
              >
                重测
              </button>
              <button
                className="sgc-btn-primary"
                onClick={() => setShowDetail(false)}
                type="button"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
