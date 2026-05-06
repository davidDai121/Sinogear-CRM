import { useEffect, useState } from 'react';
import type { Database } from '@/lib/database.types';
import { TranslateReplyPanel } from './TranslateReplyPanel';
import { GemReplySection } from './GemReplySection';

type ContactRow = Database['public']['Tables']['contacts']['Row'];

type Mode = 'translate' | 'gem';

const STORAGE_KEY = 'aiReplyMode';

interface Props {
  orgId: string;
  contact: ContactRow;
  needsJump?: boolean;
}

/**
 * 客户卡 "AI 回复" tab 的内容。
 * 顶部下拉切换两种模式：
 *   - translate: 直接翻译（输入中文 → 翻译成客户语言 → 填入聊天框）
 *   - gem: Gemini Gem AI 回复（生成结构化回复）
 *
 * 模式选择持久化在 chrome.storage.local（per-user 偏好）
 */
export function AIReplyTab({ orgId, contact, needsJump }: Props) {
  const [mode, setMode] = useState<Mode>('gem');

  useEffect(() => {
    void chrome.storage.local.get(STORAGE_KEY).then((s) => {
      const v = s[STORAGE_KEY];
      if (v === 'translate' || v === 'gem') setMode(v);
    });
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    void chrome.storage.local.set({ [STORAGE_KEY]: next });
  };

  return (
    <div className="sgc-ai-reply-tab">
      <div className="sgc-ai-mode-row">
        <label>
          <span className="sgc-muted">模式</span>
          <select
            value={mode}
            onChange={(e) => switchMode(e.target.value as Mode)}
          >
            <option value="translate">🌐 直接翻译（输入文字 → 翻成客户语言）</option>
            <option value="gem">🤖 Gemini Gem 回复（结构化分析）</option>
          </select>
        </label>
      </div>

      {mode === 'translate' && (
        <TranslateReplyPanel
          contactLanguage={contact.language}
          contactPhone={contact.phone}
          needsJump={needsJump}
        />
      )}

      {mode === 'gem' && (
        <GemReplySection
          orgId={orgId}
          contact={contact}
          needsJump={needsJump}
        />
      )}
    </div>
  );
}
