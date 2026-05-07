import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { uploadToCloudinary, thumbnailUrl } from '@/lib/cloudinary';
import type { Database, VehicleMediaType } from '@/lib/database.types';
import { CloudinaryImg } from './CloudinaryImg';

type MediaRow = Database['public']['Tables']['vehicle_media']['Row'];

interface Props {
  vehicleId: string;
}

const SECTIONS: { type: VehicleMediaType; label: string; accept: string; hint: string }[] = [
  {
    type: 'image',
    label: '图片',
    accept: 'image/*',
    hint: '车头 / 侧面 / 内饰 / 仪表 等',
  },
  {
    type: 'video',
    label: '视频',
    accept: 'video/*',
    hint: '介绍 / 试驾视频',
  },
  {
    type: 'spec',
    label: '配置表',
    accept: '*/*',
    hint: 'PDF / Excel / Word / PPT / HTML / 截图 / 其他任意文件',
  },
];

export function VehicleMediaManager({ vehicleId }: Props) {
  const [items, setItems] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadingPct, setUploadingPct] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from('vehicle_media')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('media_type')
      .order('sort_order')
      .order('created_at');
    if (error) setError(error.message);
    else setItems(data ?? []);
    setLoading(false);
  }, [vehicleId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFiles = async (type: VehicleMediaType, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);

    const tasks = Array.from(files).map(async (file) => {
      const tempKey = `${type}-${file.name}-${file.size}-${Date.now()}`;
      setUploadingPct((p) => ({ ...p, [tempKey]: 0 }));
      try {
        const result = await uploadToCloudinary(file, type, {
          onProgress: (pct) =>
            setUploadingPct((p) => ({ ...p, [tempKey]: pct })),
        });
        const { error } = await supabase.from('vehicle_media').insert({
          vehicle_id: vehicleId,
          media_type: type,
          url: result.secure_url,
          public_id: result.public_id,
          mime_type: file.type || null,
          file_size_bytes: result.bytes ?? file.size,
        });
        if (error) throw new Error(error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploadingPct((p) => {
          const next = { ...p };
          delete next[tempKey];
          return next;
        });
      }
    });

    await Promise.all(tasks);
    await refresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('删除这个文件？（Cloudinary 上的副本不会自动删除，只是从车型解绑）'))
      return;
    const { error } = await supabase.from('vehicle_media').delete().eq('id', id);
    if (error) {
      setError(error.message);
      return;
    }
    await refresh();
  };

  const updateCaption = async (id: string, caption: string) => {
    const trimmed = caption.trim() || null;
    const { error } = await supabase
      .from('vehicle_media')
      .update({ caption: trimmed })
      .eq('id', id);
    if (error) {
      setError(error.message);
      return;
    }
    setItems((prev) =>
      prev.map((m) => (m.id === id ? { ...m, caption: trimmed } : m)),
    );
  };

  const uploadingKeys = Object.keys(uploadingPct);

  return (
    <div className="sgc-vehicle-media">
      <div className="sgc-section-head">
        <strong>媒体资料</strong>
        <span className="sgc-muted">图片 / 视频 / 配置表 — 存储在 Cloudinary</span>
      </div>

      {loading ? (
        <div className="sgc-muted">加载中…</div>
      ) : (
        SECTIONS.map(({ type, label, accept, hint }) => {
          const list = items.filter((m) => m.media_type === type);
          return (
            <MediaSection
              key={type}
              type={type}
              label={label}
              accept={accept}
              hint={hint}
              items={list}
              onUpload={(files) => handleFiles(type, files)}
              onDelete={handleDelete}
              onCaptionChange={updateCaption}
            />
          );
        })
      )}

      {uploadingKeys.length > 0 && (
        <div className="sgc-upload-progress">
          上传中…{' '}
          {uploadingKeys
            .map((k) => `${Math.round(uploadingPct[k] * 100)}%`)
            .join(' / ')}
        </div>
      )}

      {error && <div className="sgc-error">{error}</div>}
    </div>
  );
}

interface SectionProps {
  type: VehicleMediaType;
  label: string;
  accept: string;
  hint: string;
  items: MediaRow[];
  onUpload: (files: FileList) => void;
  onDelete: (id: string) => void;
  onCaptionChange: (id: string, caption: string) => void;
}

function MediaSection({
  type,
  label,
  accept,
  hint,
  items,
  onUpload,
  onDelete,
  onCaptionChange,
}: SectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="sgc-media-section">
      <div className="sgc-media-section-head">
        <strong>
          {type === 'image' ? '🖼️' : type === 'video' ? '🎬' : '📄'} {label}
          {items.length > 0 && (
            <span className="sgc-muted"> · {items.length}</span>
          )}
        </strong>
        <button
          type="button"
          className="sgc-btn-link"
          onClick={() => inputRef.current?.click()}
        >
          + 上传
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            onUpload(e.target.files!);
            e.target.value = '';
          }}
        />
      </div>

      {items.length === 0 ? (
        <div className="sgc-muted sgc-media-empty">{hint}</div>
      ) : (
        <div className="sgc-media-grid">
          {items.map((m) => (
            <MediaThumb
              key={m.id}
              media={m}
              onDelete={() => onDelete(m.id)}
              onCaptionChange={(c) => onCaptionChange(m.id, c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ThumbProps {
  media: MediaRow;
  onDelete: () => void;
  onCaptionChange: (caption: string) => void;
}

function MediaThumb({ media, onDelete, onCaptionChange }: ThumbProps) {
  const [caption, setCaption] = useState(media.caption ?? '');

  const isImage = media.media_type === 'image';
  const isVideo = media.media_type === 'video';
  const isSpecImage = media.media_type === 'spec' && media.mime_type?.startsWith('image/');
  const showsThumb = isImage || isVideo || isSpecImage;

  return (
    <div className="sgc-media-thumb">
      <a href={media.url} target="_blank" rel="noreferrer" className="sgc-media-thumb-link">
        {showsThumb ? (
          <CloudinaryImg
            src={thumbnailUrl(media.url)}
            alt={media.caption ?? ''}
            loading="lazy"
          />
        ) : (
          <div className="sgc-media-doc-tile">
            <span className="sgc-media-doc-icon">📄</span>
            <span className="sgc-media-doc-ext">
              {extOf(media.url)}
            </span>
          </div>
        )}
        {isVideo && <span className="sgc-media-play">▶</span>}
      </a>
      <input
        className="sgc-media-caption"
        placeholder="备注"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        onBlur={() => {
          if ((media.caption ?? '') !== caption) onCaptionChange(caption);
        }}
      />
      <button
        type="button"
        className="sgc-media-delete"
        aria-label="删除"
        onClick={onDelete}
      >
        ×
      </button>
    </div>
  );
}

function extOf(url: string): string {
  const m = url.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
  return m ? m[1].toUpperCase() : 'FILE';
}
