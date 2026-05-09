/**
 * 客户当地时间小标签：🕐 14:23 GMT+8
 *
 * 每分钟自动刷新；夜里（22 点后或 7 点前）变灰提示"现在不太适合发消息"。
 */
import { useEffect, useMemo, useState } from 'react';
import { localTimeForPhone } from '@/lib/phone-timezones';

interface Props {
  phone: string | null | undefined;
  /** 紧凑模式：只显示 14:23，省偏移；用于客户列表表格 */
  compact?: boolean;
  className?: string;
}

export function LocalTimeBadge({ phone, compact, className }: Props) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    // 对齐到下一个整分钟（这样每个标签的 "14:00" 是真在 14:00 跳的，不是随机偏移）
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    const timeoutId = setTimeout(() => {
      setNow(new Date());
      intervalId = setInterval(() => setNow(new Date()), 60_000);
    }, msUntilNextMinute);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const lt = useMemo(() => localTimeForPhone(phone, now), [phone, now]);
  if (!lt) return null;

  const isNight = lt.hour >= 22 || lt.hour < 7;
  const title = `${lt.country} 当地时间 (${lt.timezone})${isNight ? ' — 夜间，慎发' : ''}`;

  return (
    <span
      className={`sgc-local-time ${isNight ? 'sgc-local-time-night' : ''} ${className ?? ''}`}
      title={title}
    >
      🕐 {lt.hhmm}
      {!compact && lt.offset && <span className="sgc-local-time-offset"> {lt.offset}</span>}
    </span>
  );
}
