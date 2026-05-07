import { useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import {
  isCloudinaryConfigured,
} from '@/lib/cloudinary';
import type {
  Database,
  VehicleCondition,
  VehicleSteering,
  FuelType,
  SaleStatus,
  PricingTier,
} from '@/lib/database.types';
import { VehicleMediaManager } from './VehicleMediaManager';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];

interface Props {
  orgId: string;
  vehicle?: VehicleRow | null;
  onClose: () => void;
  onSaved: () => void;
}

interface DraftTier {
  label: string;
  price: string; // 输入字符串，提交时转 number
}

function tiersFromRow(v: VehicleRow | null | undefined): DraftTier[] {
  const arr = (v?.pricing_tiers ?? []) as PricingTier[];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map((t) => ({
    label: t.label ?? '',
    price: t.price_usd != null ? String(t.price_usd) : '',
  }));
}

export function VehicleModal({ orgId, vehicle, onClose, onSaved }: Props) {
  // 创建后可能切到 edit 模式（拿到 id 后才能上传媒体）
  const [editingVehicle, setEditingVehicle] = useState<VehicleRow | null>(
    vehicle ?? null,
  );

  const [draft, setDraft] = useState({
    brand: vehicle?.brand ?? '',
    model: vehicle?.model ?? '',
    year: vehicle?.year?.toString() ?? '',
    version: vehicle?.version ?? '',
    vehicle_condition: vehicle?.vehicle_condition ?? ('new' as VehicleCondition),
    fuel_type: (vehicle?.fuel_type ?? '') as FuelType | '',
    steering: (vehicle?.steering ?? '') as VehicleSteering | '',
    base_price: vehicle?.base_price?.toString() ?? '',
    currency: vehicle?.currency ?? 'USD',
    logistics_cost: vehicle?.logistics_cost?.toString() ?? '',
    sale_status: vehicle?.sale_status ?? ('available' as SaleStatus),
    short_spec: vehicle?.short_spec ?? '',
  });
  const [tiers, setTiers] = useState<DraftTier[]>(tiersFromRow(vehicle));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const cloudinaryReady = isCloudinaryConfigured();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.brand.trim() || !draft.model.trim()) return;
    setBusy(true);
    setError(null);

    const validTiers: PricingTier[] = tiers
      .map((t) => ({
        label: t.label.trim(),
        price_usd: t.price ? Number(t.price) : NaN,
      }))
      .filter((t) => t.label && Number.isFinite(t.price_usd) && t.price_usd >= 0);

    const payload = {
      brand: draft.brand.trim(),
      model: draft.model.trim(),
      year: draft.year ? Number(draft.year) : null,
      version: draft.version.trim() || null,
      vehicle_condition: draft.vehicle_condition,
      fuel_type: draft.fuel_type || null,
      steering: draft.steering || null,
      base_price: draft.base_price ? Number(draft.base_price) : null,
      currency: draft.currency,
      logistics_cost: draft.logistics_cost ? Number(draft.logistics_cost) : null,
      sale_status: draft.sale_status,
      short_spec: draft.short_spec.trim() || null,
      pricing_tiers: validTiers,
    };

    if (editingVehicle) {
      const { data, error } = await supabase
        .from('vehicles')
        .update(payload)
        .eq('id', editingVehicle.id)
        .select('*')
        .single();
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      if (data) setEditingVehicle(data as VehicleRow);
    } else {
      const { data, error } = await supabase
        .from('vehicles')
        .insert({ ...payload, org_id: orgId })
        .select('*')
        .single();
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      // 创建成功 → 切到 edit 模式（保持 modal 开着，让用户上传媒体）
      if (data) setEditingVehicle(data as VehicleRow);
    }

    setBusy(false);
    onSaved();
    // 不自动关闭 — 留着让用户上传媒体；用户点 "完成" 关闭
  };

  const handleDelete = async () => {
    if (!editingVehicle) return;
    setBusy(true);
    setError(null);
    // 先删车源关联的 media（外键级联应该会处理，但保险起见手动删；vehicle_tags / vehicle_interests 引用也是 cascade）
    const { error: dErr } = await supabase
      .from('vehicles')
      .delete()
      .eq('id', editingVehicle.id);
    setBusy(false);
    if (dErr) {
      setError(`删除失败：${dErr.message}`);
      setConfirmDelete(false);
      return;
    }
    onSaved();
    onClose();
  };

  // ---- pricing tier ops ----
  const addTier = () =>
    setTiers([...tiers, { label: '', price: '' }]);
  const updateTier = (i: number, field: keyof DraftTier, value: string) => {
    const next = tiers.slice();
    next[i] = { ...next[i], [field]: value };
    setTiers(next);
  };
  const removeTier = (i: number) =>
    setTiers(tiers.filter((_, idx) => idx !== i));

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>{editingVehicle ? '编辑车源' : '新建车源'}</strong>
          <button
            className="sgc-drawer-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <form className="sgc-modal-body" onSubmit={submit}>
          <div className="sgc-form-grid">
            <label className="sgc-field">
              <span>品牌</span>
              <input
                value={draft.brand}
                onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
                placeholder="如：Jetour"
                required
                autoFocus
              />
            </label>
            <label className="sgc-field">
              <span>车型</span>
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="如：G700"
                required
              />
            </label>
            <label className="sgc-field">
              <span>年款</span>
              <input
                type="number"
                value={draft.year}
                onChange={(e) => setDraft({ ...draft, year: e.target.value })}
                placeholder="2026"
              />
            </label>
            <label className="sgc-field">
              <span>版本</span>
              <input
                value={draft.version}
                onChange={(e) => setDraft({ ...draft, version: e.target.value })}
                placeholder="如：2.0T 顶配"
              />
            </label>
            <label className="sgc-field">
              <span>新/二手</span>
              <select
                value={draft.vehicle_condition}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    vehicle_condition: e.target.value as VehicleCondition,
                  })
                }
              >
                <option value="new">新车</option>
                <option value="used">二手</option>
              </select>
            </label>
            <label className="sgc-field">
              <span>动力</span>
              <select
                value={draft.fuel_type}
                onChange={(e) =>
                  setDraft({ ...draft, fuel_type: e.target.value as FuelType })
                }
              >
                <option value="">未指定</option>
                <option value="gas">汽油</option>
                <option value="diesel">柴油</option>
                <option value="hybrid">混动</option>
                <option value="ev">纯电</option>
              </select>
            </label>
            <label className="sgc-field">
              <span>左/右舵</span>
              <select
                value={draft.steering}
                onChange={(e) =>
                  setDraft({ ...draft, steering: e.target.value as VehicleSteering })
                }
              >
                <option value="">未指定</option>
                <option value="LHD">LHD</option>
                <option value="RHD">RHD</option>
              </select>
            </label>
            <label className="sgc-field">
              <span>销售状态</span>
              <select
                value={draft.sale_status}
                onChange={(e) =>
                  setDraft({ ...draft, sale_status: e.target.value as SaleStatus })
                }
              >
                <option value="available">在售</option>
                <option value="paused">暂停</option>
                <option value="expired">已过期</option>
              </select>
            </label>
            <label className="sgc-field">
              <span>基准价 (FOB)</span>
              <input
                type="number"
                step="0.01"
                value={draft.base_price}
                onChange={(e) =>
                  setDraft({ ...draft, base_price: e.target.value })
                }
              />
            </label>
            <label className="sgc-field">
              <span>币种</span>
              <input
                value={draft.currency}
                onChange={(e) =>
                  setDraft({ ...draft, currency: e.target.value.toUpperCase() })
                }
                maxLength={3}
              />
            </label>
            <label className="sgc-field">
              <span>物流成本</span>
              <input
                type="number"
                step="0.01"
                value={draft.logistics_cost}
                onChange={(e) =>
                  setDraft({ ...draft, logistics_cost: e.target.value })
                }
              />
            </label>
          </div>

          <label className="sgc-field sgc-field-full">
            <span>配置说明</span>
            <textarea
              rows={3}
              value={draft.short_spec}
              onChange={(e) =>
                setDraft({ ...draft, short_spec: e.target.value })
              }
              placeholder="如：7 座 SUV，2.0T 涡轮增压，全景天窗，真皮座椅"
            />
          </label>

          {/* ---- 阶梯价格 ---- */}
          <div className="sgc-pricing-tiers">
            <div className="sgc-section-head">
              <strong>阶梯价格</strong>
              <span className="sgc-muted">不同条件下的报价（FOB / CIF / 批量等）</span>
            </div>
            {tiers.length === 0 && (
              <div className="sgc-muted" style={{ marginBottom: 8 }}>
                还没有阶梯价。点下面 + 添加。
              </div>
            )}
            {tiers.map((t, i) => (
              <div key={i} className="sgc-tier-row">
                <input
                  className="sgc-tier-label"
                  placeholder="如：FOB 单台 / CIF 蒙巴萨 / 10台以上"
                  value={t.label}
                  onChange={(e) => updateTier(i, 'label', e.target.value)}
                />
                <input
                  className="sgc-tier-price"
                  type="number"
                  step="0.01"
                  placeholder="USD"
                  value={t.price}
                  onChange={(e) => updateTier(i, 'price', e.target.value)}
                />
                <button
                  type="button"
                  className="sgc-btn-icon"
                  aria-label="删除"
                  onClick={() => removeTier(i)}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="sgc-btn-link" onClick={addTier}>
              + 添加阶梯价
            </button>
          </div>

          {error && <div className="sgc-error">{error}</div>}

          <div className="sgc-modal-actions">
            {editingVehicle && (
              confirmDelete ? (
                <>
                  <span className="sgc-muted" style={{ marginRight: 'auto', fontSize: 12 }}>
                    删除车源 + 关联媒体记录，不可恢复
                  </span>
                  <button
                    type="button"
                    className="sgc-btn-secondary sgc-btn-danger-bg"
                    onClick={handleDelete}
                    disabled={busy}
                  >
                    {busy ? '删除中…' : '确认删除'}
                  </button>
                  <button
                    type="button"
                    className="sgc-btn-link"
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="sgc-btn-link sgc-btn-danger-link"
                  style={{ marginRight: 'auto' }}
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  🗑 删除车源
                </button>
              )
            )}
            {!confirmDelete && (
              <>
                <button type="button" className="sgc-btn-link" onClick={onClose}>
                  {editingVehicle ? '完成' : '取消'}
                </button>
                <button
                  type="submit"
                  className="sgc-btn-primary"
                  disabled={busy || !draft.brand.trim() || !draft.model.trim()}
                >
                  {busy ? '保存中…' : editingVehicle ? '保存' : '创建'}
                </button>
              </>
            )}
          </div>
        </form>

        {/* ---- 媒体管理（创建后才显示） ---- */}
        {editingVehicle && (
          <div className="sgc-modal-section">
            {!cloudinaryReady ? (
              <div className="sgc-warn">
                Cloudinary 未配置 — 请在 .env 添加 VITE_CLOUDINARY_CLOUD_NAME +
                VITE_CLOUDINARY_UPLOAD_PRESET 后重启 dev server
              </div>
            ) : (
              <VehicleMediaManager vehicleId={editingVehicle.id} />
            )}
          </div>
        )}

        {!editingVehicle && (
          <div className="sgc-modal-section sgc-muted" style={{ fontSize: 12 }}>
            💡 保存车源后即可上传图片、视频、配置表
          </div>
        )}
      </div>
    </>
  );
}
