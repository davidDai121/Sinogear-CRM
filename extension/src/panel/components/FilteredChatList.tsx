import { useEffect, useRef, useState } from 'react';
import type { CrmContact } from '../hooks/useCrmData';
import { jumpToChat } from '@/lib/jump-to-chat';
import { stringifyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { useScope } from '../contexts/ScopeContext';
import { shortNameOf } from '../hooks/useOrgMembers';

interface Props {
  contacts: CrmContact[];
  /** 当前 WhatsApp Web 打开的聊天 phone，命中的 row 会高亮 */
  activePhone?: string | null;
  onClose: () => void;
  onAction: () => void;
  /** 乐观置顶/取消置顶（useCrmData.setPinned） */
  onSetPinned: (contactId: string, pinned: boolean) => Promise<void>;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const QUALITY_ICON: Record<string, string> = {
  big: '⭐⭐⭐',
  potential: '⭐⭐',
  normal: '⭐',
  spam: '🗑',
};

export function FilteredChatList({
  contacts,
  activePhone,
  onClose,
  onAction,
  onSetPinned,
}: Props) {
  const { handlersByContact, membersById, myUserId } = useScope();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 广告线索没有会话时，搜不到不直接重载，先问一句（存 phone） */
  const [confirmOpen, setConfirmOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    | { x: number; y: number; contact: CrmContact }
    | null
  >(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  // 置顶的永远排最前；置顶之间按最近活跃排；其他按最近活跃排
  const sorted = [...contacts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ta = a.chat?.t ?? 0;
    const tb = b.chat?.t ?? 0;
    return tb - ta;
  });

  // 关闭 context menu：点击别处 / Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const togglePin = (c: CrmContact) => {
    if (!c.contact) {
      setError('该客户还没有创建数据库记录，先打开聊天一次再置顶');
      setMenu(null);
      return;
    }
    // 乐观更新：菜单立刻收起 + 本地 state 立刻翻转；DB 写在后台
    setMenu(null);
    setError(null);
    onSetPinned(c.contact.id, !c.pinned).catch((err) => {
      setError(stringifyError(err));
    });
  };

  // 切到新聊天时如果选中行不在视野内，平滑滚到可见
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [activePhone]);

  const go = async (c: CrmContact, forceDeepLink = false) => {
    setBusyId(c.jid ?? c.phone);
    setError(null);
    setConfirmOpen(null);
    try {
      const query = c.phone.replace(/^\+/, '');
      // ⚠️ 广告线索且没有会话时不自动 deep link。
      // 2026-08-21 boss 实测反馈：点一下会弹出聊天框、几秒后整页跳转、
      // 然后提示「电话没注册 WhatsApp」。原因是 /send?phone= 会让 WA Web
      // 整个重新加载（实测约 14 秒），号码没注册还会弹错误框。
      // 这批人有 327 个，挨个点一遍等于反复重载几百次，不能用。
      // 改成搜索优先；搜不到就问一句，确认了才走 deep link。
      const noChatLead = c.isAdLead && !c.chat;

      // ⚠️ 2026-08-23：这种线索**根本不要去搜**，直接问。
      // 「广告线索·未联系」桶的判定就是 isUncontactedAdLead = isAdLead && !chat
      // （filters.ts），也就是说 WA 缓存里压根没有这个会话 —— 这一搜必然搜不到，
      // 但代价一样不少：
      //   - 号码被打进 WA 搜索框 → WhatsApp Web 拿它全库搜一遍（9,000+ 会话）
      //   - 列表重排触发 observeCurrentChat（监听整个 document.body 的
      //     childList+subtree）→ 每帧一次 readCurrentChat()，这段窗口里最多 ~340 次
      //   - readCurrentChat 缓存未命中还会触发 refreshChatNameCache() 全量读 WA IDB
      //   - jumpToChat 搜不到要走满 80+600+20×150+10×200 = 5,680ms 才 return false
      // boss 实测反馈"左边刷新特别特别慢"。这批有 141 个，挨个点一遍 = 141 次全库
      // 搜索 + 13 分钟纯等待，全是白烧。
      // 下面那个确认框的文案本来就是"这个客户还没有 WhatsApp 会话"，当即弹出即可，
      // 真要打开就点「仍然打开」走 forceDeepLink（deep link 能创建会话，搜索不能）。
      if (noChatLead && !forceDeepLink) {
        setConfirmOpen(c.phone);
        return;
      }

      const ok = await jumpToChat(query, { allowDeepLink: true });
      if (!ok) setError('未找到聊天，可能需要手动打开');
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 点客户行 → 延迟 600ms 再真正跳转。
   *
   * 2026-08-23 监控实测：10 分钟 53 次点击里 34 次是点客户行，相邻间隔中位数
   * **4 秒**，最短 1 秒 —— 销售是在「翻找」（点开、扫一眼、下一个），不是每个
   * 都要处理。但每点一次都会立刻付出全套代价：jumpToChat 把号码打进 WA 搜索框
   * 全库搜（最长 5.7 秒）+ 右侧客户卡整块重载（消息历史 / 销售信号 / 车源推荐 /
   * AI 分析对话）。为了 4 秒的一瞥付一整套加载。
   *
   * 600ms 的取舍：比人「看一眼判断不是他」的最快节奏（实测 1 秒）短，所以真正
   * 停下来的那一个不会被延迟感知到；而连着划过的中间项全部被取消。
   * 按实测节奏能砍掉约 70% 的跳转 + 客户卡加载，操作习惯完全不用改。
   */
  const pendingGoRef = useRef<number | null>(null);
  const cancelPendingGo = () => {
    if (pendingGoRef.current !== null) {
      window.clearTimeout(pendingGoRef.current);
      pendingGoRef.current = null;
    }
  };
  useEffect(() => cancelPendingGo, []);

  const goDebounced = (c: CrmContact) => {
    cancelPendingGo();
    // 立刻给视觉反馈（行高亮 + busy），不然 600ms 里像是没点中
    setBusyId(c.contact?.id ?? c.jid ?? c.phone);
    pendingGoRef.current = window.setTimeout(() => {
      pendingGoRef.current = null;
      void go(c);
    }, 600);
  };

  const ackReminder = async (c: CrmContact, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!c.contact) return;
    setBusyId(c.contact.id);
    setError(null);
    try {
      const { error: err } = await supabase
        .from('contacts')
        .update({ reminder_ack_at: new Date().toISOString() })
        .eq('id', c.contact.id);
      if (err) throw err;
      onAction();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyId(null);
    }
  };

  const disableReminder = async (c: CrmContact, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!c.contact) return;
    if (!confirm(`确认对 ${c.displayName} 永远不提醒？`)) return;
    setBusyId(c.contact.id);
    setError(null);
    try {
      const { error: err } = await supabase
        .from('contacts')
        .update({ reminder_disabled: true })
        .eq('id', c.contact.id);
      if (err) throw err;
      onAction();
    } catch (err) {
      setError(stringifyError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="sgc-filtered-list">
      <div className="sgc-filtered-list-header">
        <span>找到 {contacts.length} 个客户</span>
        <button className="sgc-filtered-list-close" onClick={onClose}>
          ×
        </button>
      </div>
      {error && <div className="sgc-filtered-list-error">{error}</div>}
      {confirmOpen && (
        <div className="sgc-sales-signal sgc-sales-signal-warning" style={{ margin: 8 }}>
          <strong>这个客户还没有 WhatsApp 会话</strong>
          <span style={{ fontSize: 12 }}>
            他填过广告表单但没点「Chat on WhatsApp」。强行打开会让 WhatsApp Web
            整页重载（约 14 秒），号码没注册的话还会报错。
            建议直接用客户卡上的「💬 发起首次联系」——那里会带上表单作答起草第一条消息。
          </span>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              type="button"
              className="sgc-btn-secondary"
              style={{ fontSize: 12, padding: '3px 10px' }}
              onClick={() => {
                const target = sorted.find((x) => x.phone === confirmOpen);
                if (target) void go(target, true);
              }}
            >
              仍然打开（会重载页面）
            </button>
            <button
              type="button"
              className="sgc-btn-mini"
              onClick={() => setConfirmOpen(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <div className="sgc-filtered-list-body">
        {sorted.length === 0 && (
          <div className="sgc-empty">没有匹配的客户</div>
        )}
        {sorted.map((c) => {
          const q = c.contact?.quality ?? 'potential';
          const id = c.contact?.id ?? c.jid ?? c.phone;
          const isBusy = busyId === id;
          const isActive =
            activePhone != null && c.phone === activePhone;
          return (
            <div
              key={id}
              ref={isActive ? activeRowRef : undefined}
              className={`sgc-filtered-row ${isActive ? 'sgc-filtered-row-active' : ''} ${c.pinned ? 'sgc-filtered-row-pinned' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, contact: c });
              }}
            >
              <button
                className="sgc-filtered-row-clickable"
                onClick={() => goDebounced(c)}
                disabled={isBusy}
              >
                <div className="sgc-filtered-row-main">
                  <div className="sgc-filtered-row-top">
                    {c.pinned && (
                      <span
                        className="sgc-filtered-row-pin"
                        title="已置顶（右键取消）"
                      >
                        📌
                      </span>
                    )}
                    <span className="sgc-filtered-row-name">
                      {c.displayName}
                    </span>
                    {(() => {
                      if (!c.contact) return null;
                      const others = (
                        handlersByContact.get(c.contact.id) ?? []
                      ).filter((u) => u !== myUserId);
                      if (others.length === 0) return null;
                      const names = others
                        .map((u) => shortNameOf(membersById.get(u)))
                        .join('、');
                      return (
                        <span
                          className="sgc-collision-tag"
                          title={`同事 ${names} 也在跟这个客户`}
                        >
                          撞单：{names}
                        </span>
                      );
                    })()}
                    <span className="sgc-filtered-row-quality">
                      {QUALITY_ICON[q]}
                    </span>
                    {c.chat?.unreadCount
                      ? (
                        <span className="sgc-filtered-row-unread">
                          {c.chat.unreadCount}
                        </span>
                      )
                      : null}
                  </div>
                  <div className="sgc-filtered-row-meta">
                    <span>{c.phone}</span>
                    {c.contact?.country && <span>· {c.contact.country}</span>}
                    {c.vehicleInterests[0] && (
                      <span>· {c.vehicleInterests[0].model}</span>
                    )}
                  </div>
                  {c.labels.length > 0 && (
                    <div className="sgc-filtered-row-tags">
                      {c.labels.slice(0, 3).map((l) => (
                        <span key={l.id} className="sgc-filtered-row-tag">
                          {l.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="sgc-filtered-row-time">
                  {c.chat?.t ? relativeTime(c.chat.t) : ''}
                </div>
              </button>
              {c.contact && c.classification?.needsReply && (
                <div className="sgc-filtered-row-actions">
                  <button
                    className="sgc-row-action"
                    onClick={(e) => ackReminder(c, e)}
                    disabled={isBusy}
                    title="标记已处理（客户下次发新消息会再提醒）"
                  >
                    ✓ 已处理
                  </button>
                  <button
                    className="sgc-row-action sgc-row-action-danger"
                    onClick={(e) => disableReminder(c, e)}
                    disabled={isBusy}
                    title="永久不再提醒此客户"
                  >
                    🔇 不提醒
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <div
          className="sgc-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="sgc-context-menu-item"
            onClick={() => void togglePin(menu.contact)}
            disabled={busyId === menu.contact.contact?.id}
          >
            {menu.contact.pinned ? '📌 取消置顶' : '📌 置顶客户'}
          </button>
        </div>
      )}
    </div>
  );
}
