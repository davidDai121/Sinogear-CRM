export interface ChatMessage {
  id: string;
  fromMe: boolean;
  text: string;
  timestamp: number | null;
  /** 群聊消息的发送者显示名（个人聊天恒为 null） */
  sender: string | null;
}

function findMainPane(): Element | null {
  return (
    document.querySelector('div#main') ||
    document.querySelector('[data-testid="conversation-panel"]')
  );
}

function readStrippingInjections(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('.sgc-translation, .sgc-translate-btn')
    .forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || '').trim();
}

/**
 * WA Web "你已删除这条消息" / "This message was deleted" 占位 → 内部用 [已删除] 统一表达。
 * 销售自己删了消息后，DOM 上仍有 bubble 但 text 变成占位。
 * 之前的 bug：DB 里已经 sync 过原文，[已删除] 这次没识别，prompt 仍带原文给 AI。
 */
const DELETED_PLACEHOLDER_PATTERNS = [
  /^你已删除这条消息$/,
  /^这条消息已被删除$/,
  /^此消息已被删除$/,
  /^You deleted this message$/i,
  /^This message was deleted$/i,
  /^You unsent a message$/i, // Messenger 风格兜底
];

export const DELETED_TEXT_MARKER = '[已删除]';

function isDeletedPlaceholderText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return DELETED_PLACEHOLDER_PATTERNS.some((re) => re.test(t));
}

/**
 * 剥消息末尾的 WA Web "trailing meta"：
 *   - 中文时间标记："下午2:32" / "晚上10:47" / "中午11:33" / "凌晨1:10" 等
 *   - "已编辑" 标记（可能跟时间一起："已编辑下午2:32" 或单独"已编辑"）
 *   - 英文时间（兜底）："2:32 PM" / "10:47 PM"
 *
 * 这些字串是 WA Web bubble 底部的 meta 信息，innerText 抓 selectable-text
 * 或 wrap 时会被包进 text。prompt 已经有结构化 [MM-DD HH:MM]，再带这些是噪音 +
 * 还可能跟结构化时间矛盾（如 "[05-26 23:33] ... 中午11:33" 让 AI 困惑）。
 *
 * 循环剥几次防 "已编辑下午2:32" 这种叠加 + 中间有空白。
 */
function stripTrailingMeta(text: string): string {
  let t = text;
  for (let i = 0; i < 3; i++) {
    const before = t;
    // 中文时段 + 时间：稳剥（销售/客户消息不会以"下午2:32"这种结尾）
    t = t.replace(/\s*(凌晨|清晨|早上|上午|中午|下午|晚上)\s*\d{1,2}:\d{2}\s*$/, '');
    // 英文必须带 AM/PM 标识才剥 — 避免误伤客户真的写 "let's meet at 5:00" 这种
    t = t.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM|am|pm)\s*$/, '');
    // "已编辑" / "Edited" 标记
    t = t.replace(/\s*已编辑\s*$/, '');
    t = t.replace(/\s*Edited\s*$/i, '');
    t = t.trimEnd();
    if (t === before) break;
  }
  return t;
}

function getMessageText(scope: Element): string {
  // 优先抓真正的消息体（有 data-pre-plain-text 属性的 .copyable-text 才是消息正文 wrapper）。
  // 不带 data-pre-plain-text 的 .copyable-text 是引用气泡 / Facebook 广告 header 卡片
  // ("Facebook 广告" / "查看详情") — 直接抓第一个 .copyable-text 会拿到 header，把正文
  // "Hi, check out the UNI-K Global..." 整段丢掉。
  //
  // ⚠️ 新版 WA Web (2026-05+) 已经放弃 `.selectable-text` class —— 所有依赖 `.selectable-text`
  // 的路径都返回空。现在 bubble 文本直接挂在 `.copyable-text` 自身的 textContent / innerText 上。
  // 改成：先试 .selectable-text（向后兼容老 WA Web），不行再退到 .copyable-text 整段读。
  const realWrap = scope.querySelector(
    '.copyable-text[data-pre-plain-text]',
  ) as HTMLElement | null;
  if (realWrap) {
    const sel = realWrap.querySelector('.selectable-text') as HTMLElement | null;
    if (sel) {
      const text = readStrippingInjections(sel);
      if (text) return text;
    }
    const wrapText = readStrippingInjections(realWrap);
    if (wrapText) return wrapText;
  }

  // FB 广告气泡 / 引用回复等多 .copyable-text 的场景：data-pre-plain-text 缺失时，
  // 挑文本最长的 — header 短（"Facebook 广告" 4 字），正文长，取最长不会错。
  // 先在 .selectable-text 里找（老 WA Web），找不到退到 .copyable-text 自身。
  const allSelectables = scope.querySelectorAll<HTMLElement>(
    '.copyable-text .selectable-text',
  );
  let longest = '';
  for (const el of allSelectables) {
    const text = readStrippingInjections(el);
    if (text.length > longest.length) longest = text;
  }
  if (longest) return longest;

  // 新 WA Web：.copyable-text 自身就是文本节点（无 .selectable-text 子层），挑最长
  const allCopyables = scope.querySelectorAll<HTMLElement>('.copyable-text');
  for (const el of allCopyables) {
    const text = readStrippingInjections(el);
    if (text.length > longest.length) longest = text;
  }
  if (longest) return longest;

  const fallback = scope.querySelector('.selectable-text') as HTMLElement | null;
  if (fallback) {
    const text = readStrippingInjections(fallback);
    if (text) return text;
  }

  const anyCopyable = scope.querySelector('.copyable-text') as HTMLElement | null;
  return anyCopyable ? readStrippingInjections(anyCopyable) : '';
}

/**
 * 判断气泡/消息 wrapper 是出站（我发的，fromMe=true）还是入站（客户发的）。
 *
 * ⚠️ 新版 WA Web（2026-06 实测）已经彻底删掉 `.message-in` / `.message-out` class
 * （`main.querySelectorAll('.message-in,.message-out').length === 0`）。单靠
 * `el.classList.contains('message-out')` 判方向会把**所有**消息当成入站 → AI prompt
 * 把销售自己发的话也归给客户，回复彻底跑偏；useMessageSync 也会把出站写成 inbound 污染 DB。
 *
 * 多信号判定（可靠度从高到低）：
 *   1. 旧 class（向后兼容老 WA Web / 仍有 message-out/in 的实例）
 *   2. 气泡尾巴 icon `tail-out` / `tail-in`（每段连续消息只有第一条带尾巴）
 *   3. 送达状态 icon（aria-label 已读/送达/已发送/待发送 / Read/Delivered/Sent / data-icon msg-*）
 *      —— 只有出站消息才显示送达回执，入站绝不会有
 *   4. 几何兜底：气泡靠右 = 出站（传入 panelCenter 时启用）
 * 都不命中默认入站 —— 连续入站消息没有任何出站信号，正好落到默认值。
 */
function isOutboundBubble(el: Element, panelCenter?: number): boolean {
  // 1. 旧 class（兼容）
  if (el.classList.contains('message-out') || el.querySelector('.message-out'))
    return true;
  if (el.classList.contains('message-in') || el.querySelector('.message-in'))
    return false;
  // 2. 气泡尾巴
  if (el.querySelector('[data-icon="tail-out"]')) return true;
  if (el.querySelector('[data-icon="tail-in"]')) return false;
  // 3. 送达状态 icon（出站独有）
  const STATUS_SEL =
    '[aria-label*="已读"],[aria-label*="送达"],[aria-label*="已发送"],[aria-label*="待发送"],' +
    '[aria-label*="Read" i],[aria-label*="Delivered" i],[aria-label*="Sent" i],[aria-label*="Pending" i],' +
    '[data-icon^="msg-"]';
  if (el.querySelector(STATUS_SEL)) return true;
  // 4. 几何兜底（上面都没命中时）：量真正的气泡内容盒子水平中心 vs 面板中心，靠右=出站。
  // ⚠️ 纯图片/视频 bubble 没有 .copyable-text，绝不能拿整个 conv-msg wrapper 来量——
  // wrapper 是整行满宽，center ≈ panelCenter，出站图永远判不出"靠右" → 错判成入站
  // （这正是"我发的图片被识别成客户发的"的根因之一）。改量 .copyable-text，没有就量
  // 最大的 img/video（排除 emoji/小 icon）。
  if (panelCenter != null) {
    let box: DOMRect | null = null;
    const cop = el.querySelector('.copyable-text') as HTMLElement | null;
    if (cop) {
      const r = cop.getBoundingClientRect();
      if (r.width > 0) box = r;
    }
    if (!box) {
      let bestArea = 0;
      el.querySelectorAll('img, video').forEach((m) => {
        const r = (m as HTMLElement).getBoundingClientRect();
        const area = r.width * r.height;
        if (r.width > 48 && r.height > 48 && area > bestArea) {
          bestArea = area;
          box = r;
        }
      });
    }
    if (box && box.width > 0) return box.left + box.width / 2 > panelCenter;
  }
  return false;
}

function findDataId(el: Element): string | null {
  // 优先：用 [data-testid^="conv-msg-"] 这个 message-group 标记的 closest()，不限层数。
  // 新版 WA Web (2026-05+) 把 data-id 挪到了 .message-in/out 的 3 层祖父之上的 wrapper。
  //
  // ⚠️ 但 conv-msg- wrapper 不一定是"单条消息"级 — 当 customer 通过 FB Ad 点过来时，
  // 销售那条 ad reply card (outbound) + 客户对 ad 的 reply (inbound) 被 WA Web 打包到
  // **同一个 conv-msg- wrapper** 内，共享同一个 data-id。bubble 自身 + 整个子树都没有
  // 独立的 message-level data-id (WA Web 不暴露)。
  //
  // 之前的实现直接返回 wrapId → 第二条 bubble 在 readChatMessages 里被 seen.has(id) 当
  // 重复跳过 → 客户的 "Hi, I'm interested in the Changan UNI-K." 这种 ad-reply 客户消息
  // 整条从 DOM 路径消失 → 写不进 messages 表 → AI prompt 看不到 → AI 完全不知道车型。
  //
  // 修法：检测同 data-id 是否被多个 conv-msg- wrapper 共享（实测 WA Web 给 FB ad-reply pair
  // 的销售 ad card 和客户回复**各自**建独立 wrapper，但 **data-id 完全相同**——它们是兄弟
  // 节点不是嵌套，单 wrapper 内就 1 个 bubble，所以"group 内 idx"不能区分）。多 wrapper
  // 共享时用 in/out 方向作 disambiguator（FB pair 必然一外一内方向不同）。
  // 单 wrapper 保留原 wrapId 不变 (历史 DB 数据 wa_message_id 用的是 32 字符 hex，
  // 不带 ::dir 后缀，保持兼容，避免一次性插入大量 dup 行)。
  const msgWrap = el.closest('[data-testid^="conv-msg-"]');
  const wrapId = msgWrap?.getAttribute('data-id');
  if (wrapId) {
    const allSameId = document.querySelectorAll(
      `[data-testid^="conv-msg-"][data-id="${CSS.escape(wrapId)}"]`,
    );
    if (allSameId.length <= 1) return wrapId;
    const dir = isOutboundBubble(el) ? 'out' : 'in';
    return `${wrapId}::${dir}`;
  }

  // 兜底：testid 不存在 / 命名变了时走层数爬，加 length 过滤防共享 wrapper
  // （单条消息的 data-id 通常 16+ 字符 hex；会话级 wrapper 一般更短或纯数字）
  let cur: Element | null = el;
  for (let i = 0; cur && i < 6; i++) {
    const id = cur.getAttribute('data-id');
    if (id && id.length >= 16) return id;
    cur = cur.parentElement;
  }
  return null;
}

function parsePrePlainText(pre: string): number | null {
  const m = pre.match(/\[([^\]]+)\]/);
  if (!m) return null;
  const inner = m[1].trim();

  const parts = inner.split(',').map((s) => s.trim());
  if (parts.length !== 2) return null;
  const [timePart, datePart] = parts;

  // 时间解析：先 try 中文时段（凌晨/清晨/早上/上午/中午/下午/晚上 + h:m），
  // 不匹配再 try 英文 AM/PM / 24h。
  // ⚠️ 这块 long-standing bug：之前只识别英文 AM/PM，中文 WA Web 的 "下午5:18"
  // 被错 parse 成 5:18（实际应该 17:18），所有 PM 时间错 12 小时。
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  const cnMatch = timePart.match(
    /^(凌晨|清晨|早上|上午|中午|下午|晚上)(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (cnMatch) {
    const period = cnMatch[1];
    hours = Number(cnMatch[2]);
    minutes = Number(cnMatch[3]);
    seconds = cnMatch[4] ? Number(cnMatch[4]) : 0;
    // WA Web 中文时段映射（基于实测真实数据）：
    //   凌晨/早上/上午 = AM（1-11 保持；"上午12:??" 极少见，视为 0:??）
    //   中午 11-12 = 上午末 / noon（11:33 是 11:33 AM，12:30 是 12:30 PM noon）— 不 +12
    //   下午 1-5 = PM（+12）
    //   晚上 6-11 = PM（+12）
    // ⚠️ 之前的 bug：把"中午"放到 PM 分支，"中午11:33" 被错 +12 成 23:33（应该 11:33）
    if (period === '下午' || period === '晚上') {
      if (hours < 12) hours += 12;
    } else if (period === '中午') {
      // 中午 11:?? 保持 11，中午 12:?? 保持 12（noon），不 +12
      // hours 不变
    } else {
      // 凌晨 / 清晨 / 早上 / 上午
      if (hours === 12) hours = 0;
    }
  } else {
    const enMatch = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/);
    if (!enMatch) return null;
    hours = Number(enMatch[1]);
    minutes = Number(enMatch[2]);
    seconds = enMatch[3] ? Number(enMatch[3]) : 0;
    const meridiem = enMatch[4]?.toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
  }

  const numbers = datePart.match(/\d+/g)?.map(Number);
  if (!numbers || numbers.length < 3) return null;

  let year: number, month: number, day: number;
  const yearIdx = numbers.findIndex((n) => n >= 1900);
  if (yearIdx === -1) return null;

  year = numbers[yearIdx];
  const others = numbers.filter((_, i) => i !== yearIdx);
  if (others.length < 2) return null;

  if (yearIdx === 0) {
    [month, day] = others;
  } else {
    if (datePart.includes('.') || datePart.includes('/') && /^\d+\/\d+\/\d+$/.test(datePart)) {
      [month, day] = others;
      if (month > 12 && day <= 12) {
        const tmp = month;
        month = day;
        day = tmp;
      }
    } else {
      [month, day] = others;
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day, hours, minutes, seconds);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function getMessageTimestamp(
  scope: Element,
  contextDate?: { y: number; m: number; d: number } | null,
): number | null {
  // 优先：data-pre-plain-text（带 caption 的消息都有，含完整日期 + 时间）
  const copyable = scope.querySelector('.copyable-text[data-pre-plain-text]') as HTMLElement | null;
  const pre = copyable?.getAttribute('data-pre-plain-text');
  if (pre) {
    const ts = parsePrePlainText(pre);
    if (ts) return ts;
  }

  // Fallback：纯媒体 bubble（图/视频/PDF 无 caption）没有 data-pre-plain-text。
  // WA Web 仍然在 bubble 底部渲染了时间（如 <span>下午2:11</span>），跟上方
  // 最近的 date header span（如 "2026年5月18日" / "星期四" / "今天"）合成完整 timestamp。
  // 没 contextDate 时无法判定日期 — 退回 null，让上层（formatTimestamp）显示 ??-?? ??:??。
  if (!contextDate) return null;
  const meta = scope.querySelector('[data-testid="msg-meta"]');
  if (!meta) return null;
  const spans = Array.from(meta.querySelectorAll('span'));
  for (const s of spans) {
    const text = s.textContent?.trim() ?? '';
    const parsed = parseChineseTime(text);
    if (parsed) {
      const d = new Date(contextDate.y, contextDate.m - 1, contextDate.d, parsed.h, parsed.m, 0);
      const t = d.getTime();
      return isNaN(t) ? null : t;
    }
  }
  return null;
}

/**
 * 解析 WA Web 中文时间字串："下午2:11" / "上午10:51" / "晚上11:58" 等 → {h, m} (24h)。
 * 不匹配时返回 null。
 *
 * 时段映射（按 WA Web / 中国习惯）：
 *   凌晨/清晨/早上/上午 → AM（h 保持 1-11）；上午12 → 0
 *   中午 → 12
 *   下午/晚上 → PM（h < 12 时 +12）；12 保持
 */
function parseChineseTime(str: string): { h: number; m: number } | null {
  // 形如 "下午2:11" / "10:51" / "23:30"（也兼容无时段的 24h 格式）
  const m = str.match(/^(凌晨|清晨|早上|上午|中午|下午|晚上)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const period = m[1];
  let h = Number(m[2]);
  const min = Number(m[3]);
  if (!isFinite(h) || !isFinite(min) || min < 0 || min > 59 || h < 0 || h > 23) return null;
  if (period === '中午') {
    h = h === 12 ? 12 : h;
  } else if (period === '凌晨' || period === '清晨' || period === '早上' || period === '上午') {
    if (h === 12) h = 0;
  } else if (period === '下午' || period === '晚上') {
    if (h < 12) h += 12;
  }
  // 无时段（24h）— 不做调整
  return { h, m: min };
}

/**
 * 解析 WA Web 日期分隔栏文本，返回 {y, m, d}。
 * 支持：
 *   - "2026年5月18日"
 *   - "5月18日"（同年）
 *   - "今天" / "昨天" / "前天"
 *   - "星期一"~"星期日" / "星期天" / "周一"~"周日"（反推过去最近的那天）
 *
 * 不匹配返回 null。今天的判断走 caller 传入的 today 参数（便于测试）。
 */
function parseDateHeader(
  text: string,
  today: Date = new Date(),
): { y: number; m: number; d: number } | null {
  const t = text.trim();
  if (!t) return null;
  if (t === '今天') {
    return { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
  }
  if (t === '昨天') {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  if (t === '前天') {
    const d = new Date(today);
    d.setDate(d.getDate() - 2);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  // "星期X" / "周X"（CN day names）
  const wkMatch = t.match(/^(?:星期|周)([一二三四五六日天])$/);
  if (wkMatch) {
    const map: Record<string, number> = {
      日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    };
    const target = map[wkMatch[1]];
    if (target === undefined) return null;
    const todayDow = today.getDay();
    let delta = todayDow - target;
    if (delta <= 0) delta += 7; // 找过去最近的那个星期X
    const d = new Date(today);
    d.setDate(d.getDate() - delta);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  // "2026年5月18日" 或 "5月18日"
  const dm = t.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/);
  if (dm) {
    const year = dm[1] ? Number(dm[1]) : today.getFullYear();
    const mon = Number(dm[2]);
    const day = Number(dm[3]);
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return { y: year, m: mon, d: day };
  }
  return null;
}

/**
 * 从 data-pre-plain-text 解析发送者名（仅群聊有意义）。
 * 格式："[2:46 PM, 5/9/2026] Aca: " 或 "[14:46, 9/5/2026] Aca: "
 * 个人聊天里这部分会是空（或 "You: " / 收件人手机号），返回 null。
 */
function getMessageSender(scope: Element): string | null {
  const copyable = scope.querySelector('.copyable-text[data-pre-plain-text]') as HTMLElement | null;
  const pre = copyable?.getAttribute('data-pre-plain-text');
  if (!pre) return null;
  // 取最后一个 ']' 之后到 ':' 之前的部分作为发送者
  const idx = pre.lastIndexOf(']');
  if (idx < 0) return null;
  const after = pre.slice(idx + 1).trim();
  const colonIdx = after.indexOf(':');
  if (colonIdx < 0) return null;
  const name = after.slice(0, colonIdx).trim();
  if (!name) return null;
  // "You" / 手机号 / "~" 开头的 push name 都不当作群成员名
  if (/^you$/i.test(name) || /^\+?\d[\d\s\-()]{4,}$/.test(name)) return null;
  return name;
}

/**
 * 探测空文本 bubble 的媒体类型（图/视频/音频/文档），返回中文占位符。
 *
 * 原本 readChatMessages 对空文本直接 `continue`，导致销售/客户发的图、视频、
 * 语音根本不入 messages 表 → AI prompt 看不到"我给客户发了 N 张图"这种关键
 * 上下文（销售刚发完车型图，AI 完全不知道）。
 *
 * 现在改成：探测 bubble 里有什么元素，返回对应占位符（沿用导入 .txt 的 `[媒体]`
 * 风格但带类型）。下游 isMediaOnly + collapseMediaRuns 识别这些占位合并成
 * "Sales sent N photos" 等人话给 AI。
 *
 * DOM selector 都是基于 WA Web 当前版本的观察，可能随版本漂移；都加了 fallback。
 */
function detectMediaKind(scope: Element): string {
  // 图片：bubble 内 <img> 排除 emoji / avatar / sticker icon
  const imgs = Array.from(scope.querySelectorAll('img'));
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    // emoji / wa avatar / 占位图通常 url 短或带 emoji/avatar 字样
    if (src.startsWith('blob:') || src.includes('/web-pack/') || src.startsWith('data:image/webp')) {
      // blob: 多数是真附件；data:image/webp 是 sticker
      if (src.startsWith('data:image/webp')) return '[贴纸]';
      if (src.startsWith('blob:')) return '[图片]';
    }
  }

  // 视频：<video> 元素或 video icon
  if (scope.querySelector('video')) return '[视频]';

  // 语音 / 音频：[data-testid*="audio"] 或 audio 元素
  if (
    scope.querySelector('audio') ||
    scope.querySelector('[data-testid*="audio" i]') ||
    scope.querySelector('[aria-label*="语音" i], [aria-label*="voice" i], [aria-label*="audio" i]')
  ) {
    return '[语音]';
  }

  // 文档（PDF/Excel/Word 等）：通常有 download icon 或 [data-testid*="document"]
  if (
    scope.querySelector('[data-testid*="document" i]') ||
    scope.querySelector('[data-icon="document"]') ||
    scope.querySelector('[aria-label*="document" i], [aria-label*="文档" i], [aria-label*="文件" i]')
  ) {
    return '[文档]';
  }

  // 兜底
  return '[媒体]';
}

export function readChatMessages(limit = 30): ChatMessage[] {
  const main = findMainPane();
  if (!main) return [];

  const panel =
    main.querySelector('[data-testid="conversation-panel-messages"]') ?? main;

  // 一次性收集 bubble + 候选 date header span，按 DOM 顺序合并遍历。
  // 维护 currentDate：每次遇到日期分隔栏（"2026年5月18日" / "星期四" / "今天" / "昨天"）就更新。
  // bubble 用最近的 currentDate 推断 sent_at（仅 fallback，pre-plain-text 优先）。
  let bubbles = Array.from(panel.querySelectorAll<Element>('.message-in, .message-out'));
  // 兜底：FB ad-originated chats / WA Web 某些版本里 message-in/out class 命名
  // 可能不同。conv-msg- wrapper 是消息级 testid，命中后用 querySelector 反查
  // 子树里的 .message-in / .message-out 子层（如果有）来判方向；没有就根据
  // wrapper 自身 class 判（少数 case fromMe 可能不准但不丢消息）
  if (bubbles.length === 0) {
    const wrappers = Array.from(
      panel.querySelectorAll<Element>('[data-testid^="conv-msg-"]'),
    );
    if (wrappers.length > 0) {
      bubbles = wrappers.map((w) => {
        const innerOut = w.querySelector('.message-out');
        const innerIn = w.querySelector('.message-in');
        return innerOut || innerIn || w; // 子层有就用子层（带 class），没有就 wrapper 本身
      });
    }
  }

  // Date header span：dir="auto" + 文本长度短 + 匹配日期格式
  const today = new Date();
  const dateHeaders = Array.from(
    panel.querySelectorAll<HTMLElement>('span[dir="auto"]'),
  ).filter((s) => {
    const t = s.textContent?.trim() ?? '';
    return t.length > 0 && t.length < 16 && parseDateHeader(t, today) !== null;
  });

  // 按 DOM 顺序合并 bubbles + date headers
  const all: Element[] = [...bubbles, ...dateHeaders];
  all.sort((a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const messages: ChatMessage[] = [];
  const seen = new Set<string>();
  let currentDate: { y: number; m: number; d: number } | null = null;

  // 几何兜底用的消息面板水平中心（isOutboundBubble 的最后一档信号）
  const panelRect = (panel as HTMLElement).getBoundingClientRect?.();
  const panelCenter =
    panelRect && panelRect.width > 0
      ? panelRect.left + panelRect.width / 2
      : undefined;

  for (const el of all) {
    // Date header span
    if (el.tagName === 'SPAN') {
      const text = el.textContent?.trim() ?? '';
      const parsed = parseDateHeader(text, today);
      if (parsed) currentDate = parsed;
      continue;
    }

    // Message bubble (.message-in / .message-out)
    // 过滤嵌套引用：bubble 在另一个 bubble 内（quoted reply）— 不算独立消息
    // 嵌套的内层 .message-in/out 是销售引用客户原话 / 客户引用销售 的引用预览，方向跟外层反着。
    let cur = el.parentElement;
    let isNested = false;
    while (cur && cur !== panel) {
      if (cur.classList.contains('message-in') || cur.classList.contains('message-out')) {
        isNested = true;
        break;
      }
      cur = cur.parentElement;
    }
    if (isNested) continue;

    const id = findDataId(el);
    if (!id || seen.has(id)) continue;

    let text = getMessageText(el);
    if (!text) text = detectMediaKind(el);
    // 剥末尾的 WA Web bubble meta（"下午2:32" / "已编辑" 等），避免跟前面结构化
    // [MM-DD HH:MM] 重复 + 矛盾。先剥再判删除占位（防 "你已删除这条消息中午11:31"
    // 因尾巴匹配不上而失败）
    text = stripTrailingMeta(text);
    if (isDeletedPlaceholderText(text)) text = DELETED_TEXT_MARKER;

    seen.add(id);
    const fromMe = isOutboundBubble(el, panelCenter);
    messages.push({
      id,
      fromMe,
      text,
      timestamp: getMessageTimestamp(el, currentDate),
      sender: fromMe ? null : getMessageSender(el),
    });
  }

  return messages.slice(-limit);
}

/**
 * 自动诊断：cold-start "没有可读消息" 场景下打到 console 让 boss 复制发我。
 * 调用方在抛 cold-start 错前调一下。throttled 5s 避免刷屏。
 */
let lastReadFailureLogAt = 0;
export function maybeLogReadFailure(reason: string): void {
  const now = Date.now();
  if (now - lastReadFailureLogAt < 5000) return;
  lastReadFailureLogAt = now;
  try {
    const main = findMainPane();
    if (!main) {
      console.log('[sgc/read-failure]', reason, { hasMain: false });
      return;
    }
    const panel =
      main.querySelector('[data-testid="conversation-panel-messages"]') ?? main;
    const inOutCount = panel.querySelectorAll('.message-in, .message-out')
      .length;
    const convMsgCount = panel.querySelectorAll('[data-testid^="conv-msg-"]')
      .length;
    const allDataIdCount = panel.querySelectorAll('[data-id]').length;
    const roleRowCount = panel.querySelectorAll('[role="row"]').length;
    const firstDataIds = Array.from(panel.querySelectorAll('[data-id]'))
      .slice(0, 5)
      .map((el) => el.getAttribute('data-id'));
    console.log('[sgc/read-failure]', reason, {
      hasMain: true,
      panelTestId: !!main.querySelector(
        '[data-testid="conversation-panel-messages"]',
      ),
      inOutCount,
      convMsgCount,
      allDataIdCount,
      roleRowCount,
      firstDataIds,
      panelClass:
        typeof (panel as HTMLElement).className === 'string'
          ? (panel as HTMLElement).className.slice(0, 100)
          : null,
    });
  } catch (err) {
    console.warn('[sgc/read-failure] inspect failed:', err);
  }
}

export function chatFingerprint(messages: ChatMessage[]): string {
  if (!messages.length) return 'empty';
  const tail = messages.slice(-5).map((m) => m.id).join('|');
  return `${messages.length}:${tail}`;
}

/**
 * 轮询 readChatMessages，等待消息渲染完成。
 * 用于 jumpToChat 之后，避免 800ms 固定等待对冷加载聊天不够。
 *
 * ⚠️ 之前是"count >= minCount 就返回"——WA Web 渲染消息是从下往上慢慢出现的，
 * 销售刚发完图就点 Generate 时 DOM 上常常只有最新 1 条 bubble，函数立刻返回，
 * AI prompt 就只有这 1 条上下文，整段聊天历史全丢。
 *
 * 改成"count 稳定 STABLE_POLLS 次后才返回"：每 POLL_INTERVAL ms 读一次，count
 * 不再增长就认为 DOM 渲染完毕。chat 真的只有 1 条消息也只多等 STABLE_POLLS *
 * POLL_INTERVAL ≈ 600ms，可接受。
 */
export async function waitForChatMessages(
  timeoutMs = 5000,
  limit = 30,
  minCount = 1,
): Promise<ChatMessage[]> {
  const POLL_INTERVAL = 200;
  const STABLE_POLLS = 3;
  const start = Date.now();
  let last: ChatMessage[] = [];
  let stableHits = 0;
  let prevLen = -1;
  while (Date.now() - start < timeoutMs) {
    last = readChatMessages(limit);
    if (last.length >= minCount) {
      if (last.length === prevLen) {
        stableHits++;
        if (stableHits >= STABLE_POLLS) return last;
      } else {
        stableHits = 0;
        prevLen = last.length;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return last;
}
