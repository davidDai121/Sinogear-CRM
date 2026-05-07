import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { thumbnailUrl } from '@/lib/cloudinary';
import { CloudinaryImg } from './CloudinaryImg';
import { canonicalizeModel } from '@/lib/vehicle-aliases';
import { readChatMessages } from '@/content/whatsapp-messages';
import { pasteFilesToWhatsApp } from '@/content/whatsapp-compose';
import type {
  Database,
  PricingTier,
} from '@/lib/database.types';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];
type MediaRow = Database['public']['Tables']['vehicle_media']['Row'];

interface Props {
  orgId: string;
  contactId: string;
}

const STORAGE_KEY = 'aiReplySelectedVehicleId';
const COLLAPSE_KEY = 'aiReplyVehiclesCollapsed';

/**
 * AIReplyTab 顶部的"相关车源"模块。
 *
 * - 自动扫最近 10 条消息 → 用 brand/model 匹配 vehicles 表
 * - 也包含客户已关注的 vehicle_interests
 * - 用户可手动从下拉里选其它车
 * - 选中后展示阶梯价格 + short_spec + 媒体缩略图（仅展示，不注入 prompt）
 *
 * 选择持久化在 chrome.storage.local（per-user，跨 tab 切换保持）
 */
export function VehicleRecommendations({ orgId, contactId }: Props) {
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [media, setMedia] = useState<Record<string, MediaRow[]>>({});
  const [interestModels, setInterestModels] = useState<string[]>([]);
  const [recentText, setRecentText] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 初始加载偏好
  useEffect(() => {
    void chrome.storage.local
      .get([STORAGE_KEY, COLLAPSE_KEY])
      .then((s) => {
        if (typeof s[STORAGE_KEY] === 'string') setSelectedId(s[STORAGE_KEY]);
        setCollapsed(Boolean(s[COLLAPSE_KEY]));
      });
  }, []);

  // 加载车源 + 媒体
  const refresh = useCallback(async () => {
    const [vRes, iRes] = await Promise.all([
      supabase
        .from('vehicles')
        .select('*')
        .eq('org_id', orgId)
        .eq('sale_status', 'available')
        .order('updated_at', { ascending: false }),
      supabase
        .from('vehicle_interests')
        .select('model')
        .eq('contact_id', contactId),
    ]);
    const rows = vRes.data ?? [];
    setVehicles(rows);
    setInterestModels((iRes.data ?? []).map((r) => r.model));

    if (rows.length > 0) {
      const ids = rows.map((v) => v.id);
      const { data: mediaRows } = await supabase
        .from('vehicle_media')
        .select('*')
        .in('vehicle_id', ids)
        .order('media_type')
        .order('sort_order')
        .order('created_at');
      const map: Record<string, MediaRow[]> = {};
      for (const m of mediaRows ?? []) {
        (map[m.vehicle_id] ||= []).push(m);
      }
      setMedia(map);
    } else {
      setMedia({});
    }
    setLoaded(true);
  }, [orgId, contactId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 读最近聊天文本
  useEffect(() => {
    const update = () => {
      const msgs = readChatMessages(10);
      setRecentText(msgs.map((m) => m.text).join(' \n '));
    };
    update();
    const h = () => update();
    window.addEventListener('sgc:chat-changed', h);
    return () => window.removeEventListener('sgc:chat-changed', h);
  }, [contactId]);

  // 匹配逻辑：字符串子串匹配（model + canonicalized + brand）
  const matched = useMemo(() => {
    if (vehicles.length === 0) return [];

    const haystack = (recentText + ' ' + interestModels.join(' ')).toLowerCase();
    if (!haystack.trim()) return [];

    const scored = vehicles.map((v) => {
      const candidates = new Set<string>();
      if (v.model) {
        candidates.add(v.model.toLowerCase());
        const canon = canonicalizeModel(v.model);
        if (canon) candidates.add(canon.toLowerCase());
      }
      if (v.brand) candidates.add(v.brand.toLowerCase());
      const brandModel = `${v.brand} ${v.model}`.toLowerCase().trim();
      if (brandModel) candidates.add(brandModel);

      let score = 0;
      for (const cand of candidates) {
        if (!cand || cand.length < 2) continue;
        // 整词或 brand+model 组合权重高
        if (haystack.includes(cand)) {
          score += cand === brandModel ? 3 : cand.length >= 4 ? 2 : 1;
        }
      }
      return { v, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.v);
  }, [vehicles, recentText, interestModels]);

  const selectVehicle = (id: string | null) => {
    setSelectedId(id);
    if (id) void chrome.storage.local.set({ [STORAGE_KEY]: id });
    else void chrome.storage.local.remove(STORAGE_KEY);
    setPickerOpen(false);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    void chrome.storage.local.set({ [COLLAPSE_KEY]: next });
  };

  const selected = selectedId ? vehicles.find((v) => v.id === selectedId) : null;
  const hasSelection = !!selected;

  // 完全没车型时不显示
  if (loaded && vehicles.length === 0) return null;

  return (
    <div className="sgc-vehicle-recs">
      <div className="sgc-vehicle-recs-head" onClick={toggleCollapsed}>
        <strong>🚗 相关车源</strong>
        {hasSelection && !collapsed && (
          <span className="sgc-muted">
            已选：{selected!.brand} {selected!.model}
          </span>
        )}
        {!hasSelection && matched.length > 0 && !collapsed && (
          <span className="sgc-muted">检测到 {matched.length} 款</span>
        )}
        <span className="sgc-vehicle-recs-toggle">{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div className="sgc-vehicle-recs-body">
          {/* 已选车的详情卡 */}
          {selected && (
            <SelectedVehicleCard
              vehicle={selected}
              media={media[selected.id] ?? []}
              onClear={() => selectVehicle(null)}
            />
          )}

          {/* 自动匹配的快选 */}
          {!selected && matched.length > 0 && (
            <div className="sgc-vehicle-recs-suggested">
              <div className="sgc-muted" style={{ fontSize: 11, marginBottom: 4 }}>
                根据最近聊天匹配
              </div>
              <div className="sgc-vehicle-recs-chips">
                {matched.slice(0, 6).map((v) => (
                  <button
                    type="button"
                    key={v.id}
                    className="sgc-vehicle-rec-chip"
                    onClick={() => selectVehicle(v.id)}
                  >
                    {v.brand} {v.model}
                    {v.year ? ` ${v.year}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 手动选择 */}
          <div className="sgc-vehicle-recs-actions">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={() => setPickerOpen(!pickerOpen)}
            >
              {pickerOpen ? '收起' : selected ? '换一个车' : '+ 手动选择'}
            </button>
          </div>

          {pickerOpen && (
            <VehiclePicker
              vehicles={vehicles}
              onPick={(id) => selectVehicle(id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface SelectedCardProps {
  vehicle: VehicleRow;
  media: MediaRow[];
  onClear: () => void;
}

function extOf(url: string, mime?: string | null): string {
  if (mime) {
    const m = mime.split('/')[1];
    if (m) return m.replace('jpeg', 'jpg').toLowerCase();
  }
  const m = url.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
  return m ? m[1].toLowerCase() : 'bin';
}

function SelectedVehicleCard({ vehicle, media, onClear }: SelectedCardProps) {
  const tiers = (vehicle.pricing_tiers ?? []) as PricingTier[];
  const images = media.filter((m) => m.media_type === 'image');
  const videos = media.filter((m) => m.media_type === 'video');
  const specs = media.filter((m) => m.media_type === 'spec');
  const [sending, setSending] = useState<string | null>(null);

  // 通用：把若干 MediaRow 下载成 File，paste 到 WA
  const sendItems = async (items: MediaRow[], label: string) => {
    if (items.length === 0) return;
    setSending(`下载中 0/${items.length}…`);
    try {
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        setSending(`下载 ${label} ${i + 1}/${items.length}…`);
        const res = await fetch(items[i].url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = extOf(items[i].url, items[i].mime_type ?? blob.type);
        const filename = `${vehicle.brand}_${vehicle.model}${items.length > 1 ? `_${i + 1}` : ''}.${ext}`;
        files.push(
          new File([blob], filename, {
            type: items[i].mime_type ?? blob.type,
          }),
        );
      }
      setSending('粘贴到聊天框…');
      const ok = pasteFilesToWhatsApp(files);
      setSending(
        ok
          ? `✓ 已粘贴 ${files.length} 项 ${label}，请查看 WA 预览框`
          : '❌ 找不到聊天输入框（请先选聊天）',
      );
      setTimeout(() => setSending(null), 2500);
    } catch (e) {
      setSending(`❌ ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setSending(null), 3000);
    }
  };

  const sendOne = (m: MediaRow) =>
    sendItems(
      [m],
      m.media_type === 'image' ? '图' : m.media_type === 'video' ? '视频' : '文件',
    );

  return (
    <div className="sgc-vehicle-rec-card">
      <div className="sgc-vehicle-rec-card-head">
        <div>
          <strong>
            {vehicle.brand} {vehicle.model}
          </strong>
          <span className="sgc-muted">
            {vehicle.year ? `${vehicle.year} ` : ''}
            {vehicle.version ?? ''}
            {vehicle.steering ? ` · ${vehicle.steering}` : ''}
          </span>
        </div>
        <button
          type="button"
          className="sgc-btn-icon"
          aria-label="清除"
          onClick={onClear}
        >
          ×
        </button>
      </div>

      {tiers.length > 0 ? (
        <div className="sgc-vehicle-rec-tiers">
          {tiers.map((t, i) => (
            <div key={i} className="sgc-vehicle-rec-tier">
              <span>{t.label}</span>
              <strong>${t.price_usd.toLocaleString()}</strong>
            </div>
          ))}
        </div>
      ) : vehicle.base_price ? (
        <div className="sgc-vehicle-rec-tiers">
          <div className="sgc-vehicle-rec-tier">
            <span>基准价</span>
            <strong>
              {vehicle.currency} {vehicle.base_price.toLocaleString()}
            </strong>
          </div>
        </div>
      ) : (
        <div className="sgc-muted" style={{ fontSize: 12 }}>
          暂无报价（去车源库填阶梯价）
        </div>
      )}

      {vehicle.short_spec && (
        <p className="sgc-vehicle-rec-spec">{vehicle.short_spec}</p>
      )}

      {images.length > 0 && (
        <MediaGroup
          label="图片"
          icon="🖼️"
          items={images}
          showThumb={true}
          onSendAll={() => sendItems(images, '图片')}
          onSendOne={sendOne}
          disabled={!!sending}
        />
      )}
      {videos.length > 0 && (
        <MediaGroup
          label="视频"
          icon="🎬"
          items={videos}
          showThumb={true}
          onSendAll={() => sendItems(videos, '视频')}
          onSendOne={sendOne}
          disabled={!!sending}
        />
      )}
      {specs.length > 0 && (
        <MediaGroup
          label="配置表"
          icon="📄"
          items={specs}
          showThumb={false}
          onSendAll={() => sendItems(specs, '配置表')}
          onSendOne={sendOne}
          disabled={!!sending}
        />
      )}

      {sending && <span className="sgc-vehicle-rec-status">{sending}</span>}
    </div>
  );
}

interface MediaGroupProps {
  label: string;
  icon: string;
  items: MediaRow[];
  showThumb: boolean;
  onSendAll: () => void;
  onSendOne: (m: MediaRow) => void;
  disabled: boolean;
}

function MediaGroup({
  label,
  icon,
  items,
  showThumb,
  onSendAll,
  onSendOne,
  disabled,
}: MediaGroupProps) {
  return (
    <div className="sgc-vehicle-rec-media-group">
      <div className="sgc-vehicle-rec-media-head">
        <span className="sgc-muted" style={{ fontSize: 11 }}>
          {icon} {label} · {items.length}
        </span>
        {items.length > 1 && (
          <button
            type="button"
            className="sgc-btn-link sgc-btn-small"
            disabled={disabled}
            onClick={onSendAll}
          >
            💬 全部
          </button>
        )}
      </div>
      <div className="sgc-vehicle-rec-media">
        {items.map((m) => (
          <div
            key={m.id}
            className="sgc-vehicle-rec-thumb-wrap"
            title={m.caption ?? ''}
          >
            {showThumb &&
            (m.media_type === 'image' || m.media_type === 'video') ? (
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="sgc-vehicle-rec-thumb"
              >
                <CloudinaryImg
                  src={thumbnailUrl(m.url, 120)}
                  alt={m.caption ?? ''}
                  loading="lazy"
                />
                {m.media_type === 'video' && (
                  <span className="sgc-vehicle-rec-thumb-play">▶</span>
                )}
              </a>
            ) : (
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="sgc-vehicle-rec-doc-tile"
              >
                <span style={{ fontSize: 18 }}>📄</span>
                <span className="sgc-muted" style={{ fontSize: 9 }}>
                  {extOf(m.url, m.mime_type).toUpperCase()}
                </span>
              </a>
            )}
            <button
              type="button"
              className="sgc-vehicle-rec-send-one"
              title={`粘贴这个${label}到聊天框`}
              disabled={disabled}
              onClick={() => onSendOne(m)}
            >
              💬
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PickerProps {
  vehicles: VehicleRow[];
  onPick: (id: string) => void;
}

function VehiclePicker({ vehicles, onPick }: PickerProps) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    if (!q.trim()) return vehicles.slice(0, 30);
    const s = q.toLowerCase();
    return vehicles
      .filter(
        (v) =>
          v.brand.toLowerCase().includes(s) ||
          v.model.toLowerCase().includes(s) ||
          (v.version?.toLowerCase().includes(s) ?? false),
      )
      .slice(0, 30);
  }, [vehicles, q]);

  return (
    <div className="sgc-vehicle-picker">
      <input
        autoFocus
        placeholder="搜车型 / 品牌"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="sgc-vehicle-picker-list">
        {filtered.length === 0 ? (
          <div className="sgc-muted" style={{ padding: 8 }}>
            没找到
          </div>
        ) : (
          filtered.map((v) => (
            <button
              type="button"
              key={v.id}
              className="sgc-vehicle-picker-item"
              onClick={() => onPick(v.id)}
            >
              <strong>
                {v.brand} {v.model}
              </strong>
              <span className="sgc-muted">
                {v.year ? `${v.year} ` : ''}
                {v.version ?? ''}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
