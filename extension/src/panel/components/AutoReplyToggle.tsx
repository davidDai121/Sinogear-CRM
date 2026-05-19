import { useEffect, useState } from 'react';
import {
  deleteState,
  enabledKey,
  isContactAutoReplyEnabled,
  setContactAutoReplyEnabled,
} from '@/lib/auto-reply-state';

interface Props {
  contactId: string;
}

/**
 * 客户卡顶部的"对这个客户自动回复 开/关"开关。永远显示。
 *
 * **默认状态：关闭**——销售必须对每个客户显式点 "🔔 开启" 才会触发自动回复。
 * 防止扩展全员升级后无意中对所有客户都开自动回复。
 *
 * 开 → detector / watcher / orchestrator 三处都放行；下次客户发消息（lead 或
 *      后续）会按 1 分钟延迟自动回。
 *
 * 关 → 删除 enabled 标记。同时清掉任何 in-flight state + cancel chrome.alarm
 *      （防已排但还没 fire 的偷偷开跑）。
 */
export function AutoReplyToggle({ contactId }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isContactAutoReplyEnabled(contactId).then((v) => {
      if (!cancelled) setEnabled(v);
    });

    const key = enabledKey(contactId);
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      if (key in changes) {
        const next = changes[key]?.newValue;
        setEnabled(next === true);
      }
    };
    chrome.storage.onChanged.addListener(onChange);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [contactId]);

  if (enabled === null) return null; // 加载中

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const nextEnabled = !enabled;
      await setContactAutoReplyEnabled(contactId, nextEnabled);
      if (!nextEnabled) {
        // 关掉时顺手清 in-flight 的 alarm + state（防已排队但没跑的偷偷 fire）
        await chrome.runtime
          .sendMessage({ type: 'CANCEL_AUTO_REPLY', contactId })
          .catch(() => undefined);
        await deleteState(contactId);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`sgc-auto-reply-toggle ${enabled ? 'sgc-auto-reply-toggle-on' : 'sgc-auto-reply-toggle-off'}`}
    >
      <span>
        {enabled
          ? '🔔 此客户自动回复：已开启'
          : '🔕 此客户自动回复：未开启（默认关）'}
      </span>
      <button
        type="button"
        className="sgc-btn-link"
        onClick={toggle}
        disabled={busy}
      >
        {enabled ? '🔕 关掉' : '🔔 开启自动回复'}
      </button>
    </div>
  );
}
