import { useEffect, useState } from 'react';
import { readChatMessages } from '@/content/whatsapp-messages';
import { verifyHeaderMatches, type RequireMatch } from '@/lib/jump-to-chat';
import { draftHasNewEvidence, type DraftEvidence } from '@/lib/draft-freshness';

export function DraftFreshnessNotice({ evidence, identity }: { evidence?: DraftEvidence; identity: RequireMatch }) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStale(false);
    if (!evidence) return;
    const check = () => {
      if (verifyHeaderMatches(identity) && draftHasNewEvidence(evidence, readChatMessages(50))) setStale(true);
    };
    check();
    const timer = setInterval(check, 2000);
    return () => clearInterval(timer);
  }, [evidence, identity.phone, identity.name, identity.waName, identity.groupJid]);
  return stale ? <div role="status" className="sgc-gem-error">当前聊天显示与生成时不同（可能是新消息、编辑或长消息展开），请核对最新消息后再使用。</div> : null;
}
