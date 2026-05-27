/**
 * AI 回复 done card 顶部的"生成时间"徽章。
 *
 * 设计目的：之前 done card 没显示什么时候生成的，用户切回客户看到一个 done card
 * 不知道是"5 秒前刚跑完的"还是"1 小时前看过的 stale 状态"。
 *
 * 用户实测踩过这个坑：18:26 切回客户，看到 done card 里 prompt 顶部是 [Current Time]
 * 17:26（usePersistedReplyStatus 持久化的 1 小时前那次的内容），以为是当下生成的，
 * 抱怨"为什么时间错了 + 缺消息"。其实是 1 小时前的 snapshot，不是当下的。
 *
 * 显示规则：
 *   - 没 generatedAt：不渲染（极少见，老 storage 数据迁移期可能）
 *   - < 30 秒：不渲染（刚跑完的，没必要打扰）
 *   - 30 秒 ~ 10 分钟：💾 灰色提示
 *   - > 10 分钟：⚠️ 橙色警告 + 提示重新生成
 */

interface Props {
  generatedAt?: number;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分钟` : ''}前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) return '今天';
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate()
  ) {
    return '昨天';
  }
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

export function GeneratedAtBadge({ generatedAt }: Props) {
  if (!generatedAt) return null;
  const ageMs = Date.now() - generatedAt;
  // < 30 秒：跑完没几秒，没必要打扰
  if (ageMs < 30 * 1000) return null;
  const stale = ageMs > 10 * 60 * 1000;
  const dayPart = formatDay(generatedAt);
  const label = `${dayPart === '今天' ? '' : dayPart + ' '}${formatClock(generatedAt)}`;
  return (
    <div
      className="sgc-gem-progress"
      style={
        stale
          ? {
              background: '#fef3c7',
              borderLeft: '3px solid #f59e0b',
              padding: '6px 10px',
              color: '#92400e',
              fontWeight: 500,
            }
          : { color: '#667781' }
      }
    >
      {stale ? '⚠️' : '💾'} 生成于 {label}（{formatRelative(generatedAt)}）
      {stale && (
        <>
          {' — '}这是之前的回复，可能不含最新消息。点上方按钮重新生成。
        </>
      )}
    </div>
  );
}
