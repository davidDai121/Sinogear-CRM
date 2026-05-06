/**
 * 销售经理常见的客户语言。
 * Google Translate gtx endpoint 用 ISO 639-1 + 区域代码（如 zh-CN）。
 *
 * 提供：
 *   - LANG_OPTIONS：UI 下拉选项
 *   - guessLangCode：根据 contact.language 字符串推断 ISO 代码
 */

export interface LangOption {
  code: string;
  label: string;
}

export const LANG_OPTIONS: LangOption[] = [
  { code: 'en', label: '英文 English' },
  { code: 'es', label: '西班牙文 Español' },
  { code: 'fr', label: '法文 Français' },
  { code: 'ar', label: '阿拉伯文 العربية' },
  { code: 'ru', label: '俄文 Русский' },
  { code: 'pt', label: '葡萄牙文 Português' },
  { code: 'it', label: '意大利文 Italiano' },
  { code: 'tr', label: '土耳其文 Türkçe' },
  { code: 'de', label: '德文 Deutsch' },
  { code: 'vi', label: '越南文 Tiếng Việt' },
  { code: 'th', label: '泰文 ไทย' },
  { code: 'id', label: '印尼文 Bahasa Indonesia' },
  { code: 'fa', label: '波斯文 فارسی' },
  { code: 'ur', label: '乌尔都文 اردو' },
  { code: 'hi', label: '印地文 हिन्दी' },
  { code: 'bn', label: '孟加拉文 বাংলা' },
  { code: 'ja', label: '日文 日本語' },
  { code: 'ko', label: '韩文 한국어' },
  { code: 'zh-CN', label: '简体中文' },
];

/**
 * 把 contact.language 字段的值（"Spanish"/"english"/"fr"/"法语"等）映射到 ISO 代码
 */
const NAME_TO_CODE: Record<string, string> = {
  // 英文名
  english: 'en',
  spanish: 'es',
  french: 'fr',
  arabic: 'ar',
  russian: 'ru',
  portuguese: 'pt',
  italian: 'it',
  turkish: 'tr',
  german: 'de',
  vietnamese: 'vi',
  thai: 'th',
  indonesian: 'id',
  persian: 'fa',
  farsi: 'fa',
  urdu: 'ur',
  hindi: 'hi',
  bengali: 'bn',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh-CN',
  mandarin: 'zh-CN',

  // 中文名
  英文: 'en',
  英语: 'en',
  西班牙文: 'es',
  西班牙语: 'es',
  法文: 'fr',
  法语: 'fr',
  阿拉伯文: 'ar',
  阿拉伯语: 'ar',
  俄文: 'ru',
  俄语: 'ru',
  葡萄牙文: 'pt',
  葡萄牙语: 'pt',
  意大利文: 'it',
  意大利语: 'it',
  土耳其文: 'tr',
  土耳其语: 'tr',
  德文: 'de',
  德语: 'de',
  越南文: 'vi',
  越南语: 'vi',
  泰文: 'th',
  泰语: 'th',
  印尼文: 'id',
  印尼语: 'id',
  波斯文: 'fa',
  波斯语: 'fa',
  乌尔都文: 'ur',
  乌尔都语: 'ur',
  印地文: 'hi',
  印地语: 'hi',
  孟加拉文: 'bn',
  孟加拉语: 'bn',
  日文: 'ja',
  日语: 'ja',
  韩文: 'ko',
  韩语: 'ko',
  中文: 'zh-CN',
  汉语: 'zh-CN',
  普通话: 'zh-CN',
};

const VALID_CODES = new Set(LANG_OPTIONS.map((o) => o.code));

export function guessLangCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  // 已经是合法代码？
  if (VALID_CODES.has(t)) return t;
  // 简化代码：'zh' / 'cn' → zh-CN
  if (t === 'zh' || t === 'cn' || t === 'zh-cn') return 'zh-CN';
  // 名字映射
  if (NAME_TO_CODE[t]) return NAME_TO_CODE[t];
  // 取前 2 字母看是否是 ISO 639-1
  const short = t.slice(0, 2);
  if (VALID_CODES.has(short)) return short;
  return null;
}
