import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { uploadToCloudinary, isCloudinaryConfigured } from '@/lib/cloudinary';
import { clearCaptured, removeCaptured, type CapturedMedia } from '@/lib/media-tray-store';
import { canonicalizeModel, isNoiseModel } from '@/lib/vehicle-aliases';
import { fetchAllPaged } from '@/lib/supabase-paged';
import type { Database, VehicleMediaType } from '@/lib/database.types';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];

interface Props {
  orgId: string;
  items: CapturedMedia[];
  onClose: () => void;
}

/**
 * 把暂存盘里的媒体批量分配到一个车型。
 * 用户可：
 *   - 选已有车型
 *   - 创建新车型（只填 brand + model）
 *   - 给每项设置 media_type（默认按 kind：image / video → 同名；spec 需手动）
 */
export function AssignMediaToVehicleModal({ orgId, items, onClose }: Props) {
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newModel, setNewModel] = useState('');
  const [perItemType, setPerItemType] = useState<Record<string, VehicleMediaType>>(() => {
    const init: Record<string, VehicleMediaType> = {};
    for (const it of items) init[it.id] = it.kind;
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const cloudinaryReady = isCloudinaryConfigured();

  useEffect(() => {
    // 分页拉全集——之前没分页，>1000 车源的 org 选择不到后面的
    void fetchAllPaged<VehicleRow>((from, to) =>
      supabase
        .from('vehicles')
        .select('*')
        .eq('org_id', orgId)
        .order('updated_at', { ascending: false })
        .range(from, to),
    ).then((rows) => setVehicles(rows));
  }, [orgId]);

  // 取所有 vehicle_interests.model（客户咨询过的车型）+ 已有 vehicles
  // → datalist 候选，避免新建时打错名
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const [knownBrands, setKnownBrands] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      // vehicle_interests.model 没 org_id 列；通过客户找。但 RLS 会自动过滤当前 org 的 contacts。
      // 两个查询都分页：vehicle_interests 大 org 几千行很常见；vehicles 也可能 1000+
      const [interests, vehiclesAll] = await Promise.all([
        fetchAllPaged<{ model: string | null }>((from, to) =>
          supabase
            .from('vehicle_interests')
            .select('model')
            .range(from, to),
        ),
        fetchAllPaged<{ brand: string | null; model: string | null }>(
          (from, to) =>
            supabase
              .from('vehicles')
              .select('brand,model')
              .eq('org_id', orgId)
              .range(from, to),
        ),
      ]);
      const modelSet = new Set<string>();
      const brandSet = new Set<string>();
      for (const r of interests) {
        if (!r.model) continue;
        if (isNoiseModel(r.model)) continue;
        const canon = canonicalizeModel(r.model);
        if (canon) modelSet.add(canon);
      }
      for (const v of vehiclesAll) {
        if (v.brand) brandSet.add(v.brand);
        if (v.model) modelSet.add(v.model);
      }
      setKnownModels([...modelSet].sort());
      setKnownBrands([...brandSet].sort());
    })();
  }, [orgId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return vehicles.slice(0, 50);
    const s = search.toLowerCase();
    return vehicles
      .filter(
        (v) =>
          v.brand.toLowerCase().includes(s) ||
          v.model.toLowerCase().includes(s) ||
          (v.version?.toLowerCase().includes(s) ?? false),
      )
      .slice(0, 50);
  }, [vehicles, search]);

  const setItemType = (id: string, t: VehicleMediaType) => {
    setPerItemType((p) => ({ ...p, [id]: t }));
  };

  const handleSubmit = async () => {
    if (!cloudinaryReady) {
      setError('Cloudinary 未配置，请先在 .env 添加凭证');
      return;
    }
    setBusy(true);
    setError(null);

    let vehicleId = pickedId;
    if (mode === 'create') {
      if (!newBrand.trim() || !newModel.trim()) {
        setError('品牌和车型必填');
        setBusy(false);
        return;
      }
      const { data, error } = await supabase
        .from('vehicles')
        .insert({
          org_id: orgId,
          brand: newBrand.trim(),
          model: newModel.trim(),
        })
        .select('id')
        .single();
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      vehicleId = data.id;
    }

    if (!vehicleId) {
      setError('请选择或创建车型');
      setBusy(false);
      return;
    }

    setProgress({ done: 0, total: items.length });

    const succeeded: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const targetType = perItemType[it.id] ?? it.kind;
      try {
        const result = await uploadToCloudinary(it.file, targetType);
        const { error } = await supabase.from('vehicle_media').insert({
          vehicle_id: vehicleId,
          media_type: targetType,
          url: result.secure_url,
          public_id: result.public_id,
          mime_type: it.file.type || null,
          file_size_bytes: result.bytes ?? it.file.size,
        });
        if (error) throw new Error(error.message);
        succeeded.push(it.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`第 ${i + 1} 个失败：${msg}`);
        // 继续下一个，不中断
      }
      setProgress({ done: i + 1, total: items.length });
    }

    // 把成功的从托盘移除
    for (const id of succeeded) removeCaptured(id);

    setBusy(false);
    setProgress(null);

    if (succeeded.length === items.length) {
      // 全部成功 → 关闭 + 清空（虽然已经在 succeeded 里逐个移除）
      clearCaptured();
      onClose();
    }
    // 部分失败：保留 modal 让用户看错误，剩下的 items prop 通过父级订阅会缩水，
    // 但 modal items 是初始 snapshot — 这里就让用户关掉重来
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={busy ? undefined : onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>保存 {items.length} 项媒体到车型</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="sgc-modal-body">
          <div className="sgc-assign-mode-row">
            <label>
              <input
                type="radio"
                checked={mode === 'existing'}
                onChange={() => setMode('existing')}
                disabled={busy}
              />
              选已有车型
            </label>
            <label>
              <input
                type="radio"
                checked={mode === 'create'}
                onChange={() => setMode('create')}
                disabled={busy}
              />
              新建车型
            </label>
          </div>

          {mode === 'existing' ? (
            <div className="sgc-vehicle-picker">
              <input
                placeholder="搜车型 / 品牌"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
              />
              <div className="sgc-vehicle-picker-list">
                {filtered.length === 0 ? (
                  <div className="sgc-muted" style={{ padding: 8 }}>
                    没有车型 — 试试新建
                  </div>
                ) : (
                  filtered.map((v) => (
                    <button
                      type="button"
                      key={v.id}
                      className={`sgc-vehicle-picker-item ${pickedId === v.id ? 'active' : ''}`}
                      onClick={() => setPickedId(v.id)}
                      disabled={busy}
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
          ) : (
            <>
              <div
                className="sgc-muted"
                style={{ fontSize: 11, marginBottom: 8 }}
              >
                💡 输入框会从已有车型 + 客户咨询过的车型联想，避免一辆车两个名字
              </div>
              <div className="sgc-form-grid">
                <label className="sgc-field">
                  <span>品牌</span>
                  <input
                    list="sgc-known-brands"
                    value={newBrand}
                    onChange={(e) => setNewBrand(e.target.value)}
                    placeholder="如：Jetour"
                    disabled={busy}
                  />
                  <datalist id="sgc-known-brands">
                    {knownBrands.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </label>
                <label className="sgc-field">
                  <span>车型</span>
                  <input
                    list="sgc-known-models"
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    placeholder="如：G700"
                    disabled={busy}
                  />
                  <datalist id="sgc-known-models">
                    {knownModels.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
              </div>
            </>
          )}

          <div className="sgc-section-head" style={{ marginTop: 12 }}>
            <strong>媒体分类</strong>
            <span className="sgc-muted">默认按抓取类型；图片可改为"配置表"</span>
          </div>
          <div className="sgc-assign-items">
            {items.map((it) => (
              <div key={it.id} className="sgc-assign-item">
                {it.thumbDataUrl ? (
                  <img src={it.thumbDataUrl} alt="" />
                ) : (
                  <div className="sgc-tray-doc">
                    {it.kind === 'video' ? '🎬' : '📄'}
                  </div>
                )}
                <select
                  value={perItemType[it.id]}
                  onChange={(e) => setItemType(it.id, e.target.value as VehicleMediaType)}
                  disabled={busy}
                >
                  <option value="image">🖼️ 图片</option>
                  <option value="video">🎬 视频</option>
                  <option value="spec">📄 配置表</option>
                </select>
              </div>
            ))}
          </div>

          {error && <div className="sgc-error">{error}</div>}
          {progress && (
            <div className="sgc-upload-progress">
              上传中 {progress.done} / {progress.total}…
            </div>
          )}

          <div className="sgc-modal-actions">
            <button
              type="button"
              className="sgc-btn-link"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className="sgc-btn-primary"
              disabled={
                busy ||
                (mode === 'existing' ? !pickedId : !newBrand.trim() || !newModel.trim())
              }
              onClick={handleSubmit}
            >
              {busy ? '上传中…' : `保存 ${items.length} 项`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
