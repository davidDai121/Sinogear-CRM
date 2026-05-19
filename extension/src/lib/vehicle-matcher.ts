import { canonicalizeModel } from '@/lib/vehicle-aliases';
import type { Database } from '@/lib/database.types';

type VehicleRow = Database['public']['Tables']['vehicles']['Row'];

/**
 * 把一段文本（lead 表单 / 聊天消息 / 兴趣 model 字段）匹配到 vehicles 表里最相关的那辆车。
 *
 * 评分：
 *   - model + brand 都命中 → 高分
 *   - canonical model 命中 → 中分
 *   - 单 brand → 低分
 *   - 至少要 ≥ 3 分才算匹配
 *
 * 排序：分数高 → updated_at 新 → 第一名。完全没命中返回 null。
 *
 * 自动回复用：lead 文本里有 `this_qin_plus_dmi_..._target_budget` 这种 key，
 * vehicleHint 抽出来 "qin plus dmi"，本函数把它对到库存里那辆 BYD Qin Plus 上。
 */
export function matchVehicleFromText(
  text: string,
  vehicles: VehicleRow[],
): VehicleRow | null {
  if (!text || vehicles.length === 0) return null;
  const haystack = text.toLowerCase();

  const scored = vehicles.map((v) => {
    let score = 0;

    const brand = v.brand?.toLowerCase() ?? '';
    const model = v.model?.toLowerCase() ?? '';
    const canon = canonicalizeModel(v.model ?? '').toLowerCase();
    const brandModel = `${brand} ${model}`.trim();

    // 完整 brand+model 命中（最强信号）
    if (brandModel.length >= 4 && haystack.includes(brandModel)) score += 5;

    // model 单独命中（仅当 model 长度 ≥ 3，避免 "C" / "RV" 这种瞎打）
    if (model.length >= 3 && haystack.includes(model)) score += 3;

    // canonical model 命中（如 "qin plus" canon → "byd qin plus"）
    if (canon && canon !== brandModel && haystack.includes(canon)) score += 2;
    // canonical 去掉 brand 前缀（如 "BYD Qin Plus" → "qin plus"）
    const canonModelOnly = canon.replace(new RegExp(`^${brand}\\s+`, 'i'), '');
    if (
      canonModelOnly &&
      canonModelOnly !== model &&
      canonModelOnly.length >= 3 &&
      haystack.includes(canonModelOnly)
    ) {
      score += 3;
    }

    // brand 单独（弱信号；防止整页全是 "BYD" 误匹配错车型 → 加 1 分顶天）
    if (brand.length >= 3 && haystack.includes(brand)) score += 1;

    return { v, score };
  });

  const ranked = scored
    .filter((s) => s.score >= 3)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTs = a.v.updated_at ? new Date(a.v.updated_at).getTime() : 0;
      const bTs = b.v.updated_at ? new Date(b.v.updated_at).getTime() : 0;
      return bTs - aTs;
    });

  return ranked[0]?.v ?? null;
}
