/**
 * Gemini 模型预设 —— 用户可在 AI 回复区下拉选择，自动回复也读同一个设置。
 *
 * 为什么用「关键词预设」而不是写死模型名：Gemini 的模型名带版本号（3.5 Flash /
 * 3.1 Pro / 3.1 Flash-Lite …），版本会随时间变。selectModel 在 Gemini 页面上按
 * prefer 关键词匹配菜单项、按 avoid 关键词排除，这样升版本（3.5 → 3.6 Flash）也不会坏。
 *
 * 注意：这个文件不能 import 任何 chrome.* —— panel（React）和 content/auto-reply 都要用。
 */

export interface GemModelPreset {
  /** 存进 chrome.storage 的稳定 key */
  value: string;
  /** 下拉里给用户看的中文标签 */
  label: string;
  /** 菜单项命中任一即匹配（中英双语） */
  prefer: string[];
  /** 命中任一即排除 —— 用来区分 Flash vs Flash-Lite、Pro vs Flash 等 */
  avoid: string[];
}

export const GEM_MODELS: GemModelPreset[] = [
  {
    value: 'flash',
    label: '⚡ 3.5 Flash（快·默认）',
    // "3.5 Flash 多功能助理" 命中 Flash；用 avoid 把 "Flash-Lite" 排除掉
    prefer: ['Flash'],
    avoid: ['Lite', 'Flash-Lite', '极速', 'Pro', '专业', '高级', 'Advanced', 'Ultra'],
  },
  {
    value: 'pro',
    label: '🧠 Pro（最强·较慢）',
    prefer: ['Pro', '专业', '高级', 'Advanced'],
    avoid: ['Flash', 'Lite', '极速'],
  },
  {
    value: 'flash-lite',
    label: '🚀 Flash-Lite（最快·最省）',
    prefer: ['Flash-Lite', 'Lite', '极速'],
    avoid: ['Pro', '专业', '高级'],
  },
];

/** 默认模型：3.5 Flash（平衡速度与质量，比 Pro 快很多） */
export const DEFAULT_GEM_MODEL = 'flash';

/** chrome.storage.local 里存模型选择的 key */
export const GEM_MODEL_STORAGE_KEY = 'gemModel';

/** 按 value 取预设，找不到回退到默认（数组第一个 = flash） */
export function getGemModelPreset(value: string | undefined | null): GemModelPreset {
  return GEM_MODELS.find((m) => m.value === value) ?? GEM_MODELS[0];
}
