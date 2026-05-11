import { useEffect, useState } from 'react';
import {
  CLOUDINARY_FREE_QUOTA_BYTES,
  fetchCloudinaryUsage,
  formatBytes,
  type CloudinaryUsage,
} from '@/lib/cloudinary-usage';

interface Props {
  orgId: string;
  refreshKey?: number;
}

export function CloudinaryUsageBadge({ orgId, refreshKey }: Props) {
  const [usage, setUsage] = useState<CloudinaryUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCloudinaryUsage(orgId)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, refreshKey]);

  if (error) return null;
  if (!usage) return null;

  const pct = (usage.totalBytes / CLOUDINARY_FREE_QUOTA_BYTES) * 100;
  const level: 'ok' | 'warn' | 'crit' = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';

  const colors = {
    ok: { bg: '#e8f5e9', fg: '#1b5e20', border: '#a5d6a7' },
    warn: { bg: '#fff8e1', fg: '#795548', border: '#ffe082' },
    crit: { bg: '#ffebee', fg: '#b71c1c', border: '#ef9a9a' },
  }[level];

  const tooltip = [
    `Cloudinary 媒体存储用量`,
    `图片: ${formatBytes(usage.byType.image)}`,
    `视频: ${formatBytes(usage.byType.video)}`,
    `配置表: ${formatBytes(usage.byType.spec)}`,
    `共 ${usage.count} 个文件`,
    `免费额度 25 GB / 月（含存储）`,
  ].join('\n');

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 500,
        cursor: 'help',
      }}
    >
      <span>📦</span>
      <span>
        {formatBytes(usage.totalBytes)} / 25 GB
        <span style={{ marginLeft: 6, opacity: 0.7 }}>({pct.toFixed(1)}%)</span>
      </span>
      {level === 'warn' && <span style={{ marginLeft: 4 }}>⚠️</span>}
      {level === 'crit' && <span style={{ marginLeft: 4 }}>🚨 接近上限</span>}
    </span>
  );
}
