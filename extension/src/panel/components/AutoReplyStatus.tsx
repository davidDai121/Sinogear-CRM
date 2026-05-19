import { useEffect, useState } from 'react';
import {
  deleteState,
  getState,
  patchState,
  stateKey,
  type AutoReplyState,
} from '@/lib/auto-reply-state';

interface Props {
  contactId: string;
}

/**
 * 客户卡顶部的自动回复状态条。
 *
 * - scheduled：倒计时 + 取消按钮
 * - firing / sending_images / gem_running / reply_filled：进度条
 * - done：绿色 ✓ + 关闭按钮
 * - error：红色 + 重排 / 关闭
 * - cancelled / 没 state：不显示
 */
export function AutoReplyStatus({ contactId }: Props) {
  const [state, setLocalState] = useState<AutoReplyState | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  // 初次加载 + 监听 chrome.storage 变化 + 自定义事件
  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const s = await getState(contactId);
      if (!cancelled) setLocalState(s);
    };

    void refresh();

    const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (stateKey(contactId) in changes) {
        const newVal = changes[stateKey(contactId)]?.newValue;
        setLocalState((newVal as AutoReplyState | undefined) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);

    const onCustom = () => void refresh();
    window.addEventListener('sgc:auto-reply-state-changed', onCustom);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onStorage);
      window.removeEventListener('sgc:auto-reply-state-changed', onCustom);
    };
  }, [contactId]);

  // scheduled 状态下每秒滴答倒计时
  useEffect(() => {
    if (state?.phase !== 'scheduled') return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [state?.phase]);

  if (!state) return null;
  if (state.phase === 'cancelled') return null;

  const cancel = async () => {
    // 通知 SW 清掉 chrome.alarm
    await chrome.runtime.sendMessage({
      type: 'CANCEL_AUTO_REPLY',
      contactId,
    });
    // scheduled / 进行中状态都允许取消（顺手把 state 移除便于重排）
    await deleteState(contactId);
    setLocalState(null);
  };

  const dismiss = async () => {
    await deleteState(contactId);
    setLocalState(null);
  };

  const retry = async () => {
    // 重排：把 phase 重置回 scheduled，再让 SW 立即触发（fireAt=now）
    await patchState(contactId, {
      phase: 'scheduled',
      error: undefined,
    });
    await chrome.runtime.sendMessage({
      type: 'SCHEDULE_AUTO_REPLY',
      contactId,
      fireAt: Date.now() + 1000,
    });
  };

  const isFollowup = state.roundCount > 0;
  const roundLabel = isFollowup ? `续聊 #${state.roundCount}` : '首轮';

  if (state.phase === 'scheduled') {
    const remainMs = Math.max(0, state.scheduledAt - now);
    const mm = Math.floor(remainMs / 60000);
    const ss = Math.floor((remainMs % 60000) / 1000);
    return (
      <div className="sgc-auto-reply-banner sgc-auto-reply-scheduled">
        <span>
          ⏰ {roundLabel}自动回复将在 <strong>{mm}:{ss.toString().padStart(2, '0')}</strong> 后触发
          {!isFollowup && state.vehicleId && '（图 + 文字一起发）'}
          {!isFollowup && !state.vehicleId && '（无匹配车源 · 仅文字）'}
          {isFollowup && '（仅文字续 Gem 上下文）'}
        </span>
        <button type="button" className="sgc-btn-link" onClick={cancel}>
          取消
        </button>
      </div>
    );
  }

  if (state.phase === 'firing') {
    return (
      <div className="sgc-auto-reply-banner sgc-auto-reply-running">
        <span>🚀 {roundLabel}启动中…</span>
        <button type="button" className="sgc-btn-link" onClick={cancel}>
          中止
        </button>
      </div>
    );
  }

  if (state.phase === 'gem_running') {
    return (
      <div className="sgc-auto-reply-banner sgc-auto-reply-running">
        <span>🤖 Gemini 正在生成{roundLabel}回复（~1-2 分钟）…</span>
        <button type="button" className="sgc-btn-link" onClick={cancel}>
          中止
        </button>
      </div>
    );
  }

  if (state.phase === 'sending_images') {
    return (
      <div className="sgc-auto-reply-banner sgc-auto-reply-running">
        <span>📤 正在发车源图 + 回复…</span>
        <button type="button" className="sgc-btn-link" onClick={cancel}>
          中止
        </button>
      </div>
    );
  }

  if (state.phase === 'reply_filled' || state.phase === 'done') {
    return (
      <div className="sgc-auto-reply-banner sgc-auto-reply-done">
        <span>✅ {roundLabel}已自动发送</span>
        <button type="button" className="sgc-btn-link" onClick={dismiss}>
          关闭
        </button>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="sgc-auto-reply-banner sgc-auto-reply-error">
        <span>⚠️ 自动回复失败：{state.error ?? '未知错误'}</span>
        <button type="button" className="sgc-btn-link" onClick={retry}>
          重试
        </button>
        <button type="button" className="sgc-btn-link" onClick={dismiss}>
          关闭
        </button>
      </div>
    );
  }

  return null;
}
