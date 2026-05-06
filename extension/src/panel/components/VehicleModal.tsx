import { useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Database,
  VehicleCondition,
  VehicleSteering,
  FuelType,
  SaleStatus,
} from '@/lib/database.types';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];

interface Props {
  orgId: string;
  vehicle?: VehicleRow | null;
  onClose: () => void;
  onSaved: () => void;
}

export function VehicleModal({ orgId, vehicle, onClose, onSaved }: Props) {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.brand.trim() || !draft.model.trim()) return;
    setBusy(true);
    setError(null);

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
    };

    if (vehicle) {
      const { error } = await supabase
        .from('vehicles')
        .update(payload)
        .eq('id', vehicle.id);
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
    } else {
      const { error } = await supabase
        .from('vehicles')
        .insert({ ...payload, org_id: orgId });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
    }

    setBusy(false);
    onSaved();
    onClose();
  };

  return (
    <>
      <div className="sgc-modal-backdrop" onClick={onClose} />
      <div className="sgc-modal sgc-modal-wide" role="dialog">
        <header className="sgc-modal-header">
          <strong>{vehicle ? '编辑车源' : '新建车源'}</strong>
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

          {error && <div className="sgc-error">{error}</div>}

          <div className="sgc-modal-actions">
            <button type="button" className="sgc-btn-link" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="sgc-btn-primary"
              disabled={busy || !draft.brand.trim() || !draft.model.trim()}
            >
              {busy ? '保存中…' : vehicle ? '保存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
