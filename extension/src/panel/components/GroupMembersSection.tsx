import { useEffect, useState } from 'react';
import { readWhatsAppData, jidToPhone } from '@/lib/whatsapp-idb';
import { jumpToChat } from '@/lib/jump-to-chat';

interface Member {
  jid: string;
  phone: string | null;
  name: string;
}

interface Props {
  groupJid: string;
}

export function GroupMembersSection({ groupJid }: Props) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    readWhatsAppData()
      .then((wa) => {
        if (cancelled) return;
        const chat = wa.chats.find((c) => c.id === groupJid);
        if (!chat) {
          setMembers([]);
          return;
        }
        const contactByJid = new Map(wa.contacts.map((c) => [c.id, c]));
        const resolved: Member[] = chat.participants.map((jid) => {
          const c = contactByJid.get(jid);
          // 名字优先：保存的 name → shortName → pushname → 手机号 → JID 截断
          const phone = jidToPhone(jid);
          const name =
            (c?.name ?? '').trim() ||
            (c?.shortName ?? '').trim() ||
            (c?.pushname ?? '').trim() ||
            phone ||
            jid.split('@')[0].slice(0, 12);
          return { jid, phone, name };
        });
        // 按 name 字母排序，"自己"（如果能识别）排最后
        resolved.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        setMembers(resolved);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [groupJid]);

  if (error) {
    return (
      <section className="sgc-drawer-section">
        <div className="sgc-section-title">群成员</div>
        <div className="sgc-error">{error}</div>
      </section>
    );
  }

  if (!members) {
    return (
      <section className="sgc-drawer-section">
        <div className="sgc-section-title">群成员</div>
        <div className="sgc-empty">读取中…</div>
      </section>
    );
  }

  if (members.length === 0) {
    return (
      <section className="sgc-drawer-section">
        <div className="sgc-section-title">群成员</div>
        <div className="sgc-empty">
          暂未读到群成员（IDB 里这个群可能没有 groupMetadata.participants — 滚动一下聊天列表 / 等同步完成后再试）
        </div>
      </section>
    );
  }

  const shown = collapsed ? members.slice(0, 6) : members;
  const hasMore = members.length > 6;

  return (
    <section className="sgc-drawer-section">
      <div className="sgc-section-title">
        群成员 <span style={{ color: '#667781', fontWeight: 'normal' }}>· {members.length} 人</span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {shown.map((m) => (
          <li
            key={m.jid}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
              borderBottom: '1px solid #f0f2f5',
              fontSize: 13,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ color: '#111b21', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.name}
              </div>
              {m.phone && (
                <div style={{ color: '#667781', fontSize: 11 }}>{m.phone}</div>
              )}
            </div>
            {m.phone && (
              <button
                type="button"
                className="sgc-btn-mini"
                onClick={() => void jumpToChat(m.phone!.replace(/^\+/, ''), { allowDeepLink: true })}
                title={`跳转到跟 ${m.name} 的 1 对 1 聊天`}
                style={{ marginLeft: 8 }}
              >
                💬
              </button>
            )}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="sgc-btn-link"
          onClick={() => setCollapsed((v) => !v)}
          style={{ marginTop: 8, fontSize: 12 }}
        >
          {collapsed ? `展开剩余 ${members.length - 6} 个` : '收起'}
        </button>
      )}
    </section>
  );
}
