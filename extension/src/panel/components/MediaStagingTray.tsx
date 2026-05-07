import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  clearCaptured,
  removeCaptured,
  subscribeCaptured,
  type CapturedMedia,
} from '@/lib/media-tray-store';
import { AssignMediaToVehicleModal } from './AssignMediaToVehicleModal';

interface Props {
  orgId: string | null;
}

/**
 * 浮动暂存盘：用户在 WhatsApp 聊天里点 📥 之后，
 * 在屏幕右下角出现一个收起式小托盘，显示已捕获的图片/视频。
 */
export function MediaStagingTray({ orgId }: Props) {
  const [items, setItems] = useState<CapturedMedia[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  useEffect(() => {
    return subscribeCaptured((arr) => {
      setItems(arr);
      // 第一次捕获时自动展开
      if (arr.length > 0) setExpanded(true);
    });
  }, []);

  if (items.length === 0) return null;

  return createPortal(
    <>
      <div className={`sgc-media-tray ${expanded ? 'expanded' : 'collapsed'}`}>
        <div className="sgc-media-tray-head" onClick={() => setExpanded(!expanded)}>
          <strong>📥 暂存 {items.length} 项</strong>
          <span className="sgc-media-tray-toggle">{expanded ? '▾' : '▸'}</span>
        </div>

        {expanded && (
          <div className="sgc-media-tray-body">
            <div className="sgc-media-tray-grid">
              {items.map((m) => (
                <TrayItem key={m.id} item={m} />
              ))}
            </div>

            <div className="sgc-media-tray-actions">
              <button
                type="button"
                className="sgc-btn-link"
                onClick={() => clearCaptured()}
              >
                清空
              </button>
              <button
                type="button"
                className="sgc-btn-primary"
                disabled={!orgId}
                onClick={() => setAssignOpen(true)}
              >
                保存到车型 ({items.length})
              </button>
            </div>
          </div>
        )}
      </div>

      {assignOpen && orgId && (
        <AssignMediaToVehicleModal
          orgId={orgId}
          items={items}
          onClose={() => setAssignOpen(false)}
        />
      )}
    </>,
    document.body,
  );
}

function TrayItem({ item }: { item: CapturedMedia }) {
  return (
    <div className="sgc-tray-item">
      {item.thumbDataUrl ? (
        <img src={item.thumbDataUrl} alt="" />
      ) : (
        <div className="sgc-tray-doc">
          {item.kind === 'video' ? '🎬' : '📄'}
        </div>
      )}
      {item.kind === 'video' && <span className="sgc-tray-play">▶</span>}
      <button
        type="button"
        className="sgc-tray-remove"
        aria-label="移除"
        onClick={() => removeCaptured(item.id)}
      >
        ×
      </button>
    </div>
  );
}
