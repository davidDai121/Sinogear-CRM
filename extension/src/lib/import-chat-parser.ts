/**
 * 解析 WhatsApp 手机端导出的聊天 .txt
 *
 * 支持两种时间格式（同一文件内可混用）：
 *   2026/5/7 08:46 - <发件人>: <内容>          （24h，多见于英文系统手机导出）
 *   2026/4/6 下午1:54 - <发件人>: <内容>       （中文 AM/PM）
 *
 * 多行延续：不匹配时间戳头的行视为上一条消息的续行（用 \n 拼接），
 * 这样客户首条消息后面的表单 key:value 块、客服多段回复等都能完整捕获。
 *
 * 系统行（"消息和通话已进行端到端加密"、"此聊天从 Facebook... 广告发起"、空内容）会被丢弃。
 *
 * 媒体占位 `<省略影音内容>` 替换成 `[媒体]`。
 */

export interface ParsedMessage {
  ts: Date | null;
  sender: string;
  text: string;
}

export interface ParsedChat {
  phone: string | null;            // 推断出的客户手机号（+digits 格式）
  messages: ParsedMessage[];
  customerSender: string | null;   // 手机号格式的发件人 → 客户
  meSender: string | null;         // 出现次数最多的非手机号发件人 → 自己
  senderCounts: Record<string, number>;
  totalLines: number;
}

const TS_RE =
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(?:(凌晨|早上|上午|中午|下午|晚上)\s*)?(\d{1,2}):(\d{2})\s*-\s*(.*)$/;

const SYSTEM_PATTERNS = [
  /^消息和通话已进行端到端加密/,
  /^此聊天.*广告/,
  /^.*已使用其他设备/,
  /您已删除此消息$/,
  /^已删除此消息/,
];

function parseLineDate(
  y: string,
  mo: string,
  d: string,
  period: string | undefined,
  hh: string,
  mm: string,
): Date {
  let h = parseInt(hh, 10);
  const mins = parseInt(mm, 10);
  if (period === '下午' || period === '晚上') {
    if (h < 12) h += 12;
  } else if (period === '中午') {
    if (h !== 12) h = 12;
  } else if (period === '上午' || period === '凌晨' || period === '早上') {
    if (h === 12) h = 0;
  }
  return new Date(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10), h, mins);
}

function isPhoneLike(s: string): boolean {
  // 至少 7 位数字，允许 +/空格/-，不允许字母
  const trimmed = s.trim();
  if (!/^\+?[\d\s\-]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7;
}

function isSystemLine(text: string): boolean {
  if (!text.trim()) return true;
  return SYSTEM_PATTERNS.some((re) => re.test(text.trim()));
}

export function parseExportedChat(content: string): ParsedChat {
  const lines = content.split(/\r?\n/);
  const raw: { ts: Date; sender: string; text: string }[] = [];
  let cur: { ts: Date; sender: string; text: string } | null = null;
  let inSystem = false;

  for (const line of lines) {
    const m = TS_RE.exec(line);
    if (m) {
      if (cur) raw.push(cur);
      cur = null;
      inSystem = false;

      const [, y, mo, d, period, hh, mm, after] = m;
      const ts = parseLineDate(y, mo, d, period, hh, mm);

      if (isSystemLine(after)) {
        inSystem = true;
        continue;
      }
      // 取第一个 ": " 作分隔（发件人 vs 正文）
      const idx = after.indexOf(': ');
      if (idx <= 0) {
        // "ts - 单段文本" 通常是系统通知（"此聊天..."），跳过
        inSystem = true;
        continue;
      }
      const sender = after.slice(0, idx).trim();
      const text = after.slice(idx + 2);
      cur = { ts, sender, text };
    } else {
      // 续行
      if (cur) {
        cur.text += '\n' + line;
      } else if (inSystem) {
        // 当前是系统消息的续行，丢弃
      }
    }
  }
  if (cur) raw.push(cur);

  // 统计 sender 出现次数 → 找客户（手机号格式）和自己（最多的非手机号）
  const counts: Record<string, number> = {};
  for (const m of raw) counts[m.sender] = (counts[m.sender] ?? 0) + 1;

  let customerSender: string | null = null;
  let meSender: string | null = null;
  for (const [s, c] of Object.entries(counts)) {
    if (isPhoneLike(s)) {
      if (!customerSender || c > counts[customerSender]) customerSender = s;
    } else {
      if (!meSender || c > counts[meSender]) meSender = s;
    }
  }

  // 清洗：替换媒体占位 + 去前后空白 + 丢空消息
  const messages: ParsedMessage[] = raw
    .map((m) => ({
      ts: m.ts,
      sender: m.sender,
      text: m.text.replace(/<省略影音内容>/g, '[媒体]').replace(/\s+$/g, '').trimStart(),
    }))
    .filter((m) => m.text.length > 0);

  let phone: string | null = null;
  if (customerSender) {
    const digits = customerSender.replace(/\D/g, '');
    if (digits) phone = '+' + digits;
  }

  return {
    phone,
    messages,
    customerSender,
    meSender,
    senderCounts: counts,
    totalLines: lines.length,
  };
}

/** 从文件名抓手机号作为兜底（解析失败时用）：「与+224 623 21 70 09的 WhatsApp 聊天.txt」→ +224623217009 */
export function phoneFromFilename(filename: string): string | null {
  const m = filename.match(/与\s*\+?([\d\s\-]+?)\s*的/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  return digits.length >= 7 ? '+' + digits : null;
}
