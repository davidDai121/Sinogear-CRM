import { useEffect, useState } from 'react';
import {
  loadReplyProgress,
  type ReplyProgressMap,
} from '@/lib/reply-progress';

/**
 * 订阅回复进度表。
 *
 * 走 chrome.storage.onChanged 而不是轮询：三个 ReplySection 写进度时，左栏
 * 那 130 行要立刻跟着变（"⏳ 生成中" → "📝 待发送"）。onChanged 是即时的，
 * 而且跨组件、跨 mount 状态都能收到 —— 生成中途切走客户，那个 section 已经
 * unmount 了，但它闭包里的 setReplyProgress 照样写 storage，左栏照样更新。
 *
 * 另外挂一个 60 秒的定时重读：进度项有 TTL（generating 10 分钟、其余 24 小时），
 * 过期是"时间到了"而不是"storage 变了"，onChanged 不会触发，得自己扫。
 */
export function useReplyProgress(): ReplyProgressMap {
  const [map, setMap] = useState<ReplyProgressMap>({});

  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void loadReplyProgress().then((m) => {
        if (!cancelled) setMap(m);
      });
    };
    reload();

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && changes.replyProgress) reload();
    };
    chrome.storage.onChanged.addListener(onChanged);
    const timer = window.setInterval(reload, 60_000);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
      window.clearInterval(timer);
    };
  }, []);

  return map;
}
