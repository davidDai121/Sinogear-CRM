/**
 * Phase C: 在 WhatsApp Web 聊天里给图片/视频加 📥 hover 按钮，
 * 点了之后捕获文件到 media-tray-store，供"保存到车型"使用。
 *
 * 做的事：
 *   1) MutationObserver 扫描 div#main 里的 message bubbles
 *   2) 单图气泡 + 视频气泡 → 注入 📥 按钮
 *   3) 相册气泡（多图网格） → 一个 📥 全部 (N 张) 按钮，点了捕获所有可见
 *   4) Lightbox / 媒体浏览器（用户点开图片后） → 也加 📥 按钮，让用户手动捕获被隐藏的 +N 张
 *
 * 已知限制：
 *   - "+N" 隐藏的图必须用户先点开浏览器滑过才会加载到 DOM
 *   - 视频缩略图 capture 的是 thumbnail（poster），原始视频文件需要播放后再捕获
 */

import { addCaptured } from '@/lib/media-tray-store';
import { readCurrentChat } from './whatsapp-dom';

const BTN_INJECTED_ATTR = 'data-sgc-mc-injected';
const BTN_CLASS = 'sgc-mc-btn';
const ALBUM_BTN_CLASS = 'sgc-mc-album-btn';
const TOOLBAR_BTN_ATTR = 'data-sgc-mc-toolbar';
const TOOLBAR_BTN_CLASS = 'sgc-mc-toolbar-btn';

let observer: MutationObserver | null = null;
let pollTimer: number | null = null;

function getMainPane(): Element | null {
  return (
    document.querySelector('div#main') ||
    document.querySelector('[data-testid="conversation-panel"]')
  );
}

/**
 * 把 blob URL 或 http URL 转成 File。
 */
async function urlToFile(url: string, filename: string, type?: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], filename, { type: type || blob.type });
}

/**
 * 从一个 <img> 元素生成缩略图 dataURL。
 */
function imgToThumbDataUrl(img: HTMLImageElement, maxW = 160): string | null {
  try {
    const canvas = document.createElement('canvas');
    const ratio = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0.75;
    canvas.width = Math.min(maxW, img.naturalWidth || maxW);
    canvas.height = Math.round(canvas.width * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null; // CORS-tainted (不应该发生因为 blob: 同源)
  }
}

function ts(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(
    d.getMinutes(),
  ).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * 捕获一个 <img>。kind 可选 image / spec（截屏配置表）。
 */
async function captureImg(
  img: HTMLImageElement,
  kind: 'image' | 'spec' = 'image',
): Promise<boolean> {
  if (!img.src) return false;
  // 先生成缩略图（用 DOM 里已经渲染好的）
  const thumb = imgToThumbDataUrl(img);
  try {
    const tag = kind === 'spec' ? 'spec' : '';
    const filename = `whatsapp_${tag ? tag + '_' : ''}${ts()}_${Math.random()
      .toString(36)
      .slice(2, 6)}.jpg`;
    const file = await urlToFile(img.src, filename, 'image/jpeg');
    const phone = readCurrentChat().phone;
    addCaptured({
      file,
      thumbDataUrl: thumb,
      kind,
      sourceContactPhone: phone,
    });
    return true;
  } catch (e) {
    console.warn('[sgc] capture image failed', e);
    return false;
  }
}

/**
 * 媒体批量抓取（图片/视频/PDF/Excel 等）：
 * 模拟点击 WA 多选 toolbar 的"下载"按钮，由 SW 拦截每个 chrome.downloads，
 * 把 url/filename/mime 转发回 content，content fetch blob → 按 mime 自动分类
 * → addCaptured 进 tray。
 *
 * - 图片走 image
 * - 视频走 video（这次能拿真视频，因为 WA 的"下载"是真解码下载，不是 MediaSource）
 * - 其它（PDF/Excel/Word/PPT/zip/...）走 spec
 */
type CapturedKindLocal = 'image' | 'video' | 'spec';

function kindFromMime(mime: string, filename: string): CapturedKindLocal {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  // 兜底：从文件名后缀判断
  const ext = filename.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase();
  if (ext) {
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'].includes(ext)) return 'video';
  }
  return 'spec';
}

function extFromMime(mime: string): string {
  if (!mime) return 'bin';
  const m = mime.toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (m === 'application/vnd.ms-excel') return 'xls';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (m === 'application/msword') return 'doc';
  if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (m === 'application/vnd.ms-powerpoint') return 'ppt';
  if (m === 'application/zip') return 'zip';
  if (m.startsWith('image/')) return m.split('/')[1].replace('jpeg', 'jpg');
  if (m.startsWith('video/')) return m.split('/')[1];
  if (m.startsWith('audio/')) return m.split('/')[1];
  return 'bin';
}

async function blobToImageThumb(blob: Blob, maxW = 160): Promise<string | null> {
  try {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      const ratio = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0.75;
      canvas.width = Math.min(maxW, img.naturalWidth || maxW);
      canvas.height = Math.round(canvas.width * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.7);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * 启动 bulk capture：监听 BULK_CAPTURE_DOWNLOAD 事件 + 实时 fetch 进 tray。
 * 返回 { stop, getStats }。
 */
function startBulkCapture(specForceKind?: CapturedKindLocal): {
  stop: () => Promise<void>;
  getStats: () => { ok: number; failed: number; byKind: Record<string, number> };
} {
  const phone = readCurrentChat().phone;
  let ok = 0;
  let failed = 0;
  const byKind: Record<string, number> = { image: 0, video: 0, spec: 0 };

  const handler = async (msg: unknown) => {
    if (
      typeof msg !== 'object' ||
      msg === null ||
      (msg as { type?: unknown }).type !== 'BULK_CAPTURE_DOWNLOAD'
    ) {
      return;
    }
    const m = msg as { url?: string; filename?: string; mime?: string };
    const url = m.url || '';
    if (!url) {
      failed++;
      return;
    }
    try {
      const isBlobUrl = url.startsWith('blob:');
      console.log(`[sgc/bulk] fetching ${isBlobUrl ? 'blob' : 'http'} url:`, url.slice(0, 100));
      // 非 blob: 是 WA 媒体 CDN URL，依赖签名 + cookie；带 credentials 让 cookie 跟着走
      const res = await fetch(url, isBlobUrl ? {} : { credentials: 'include' });
      if (!res.ok) {
        console.warn(`[sgc/bulk] fetch ${res.status} ${res.statusText} for`, m.filename || url);
        failed++;
        return;
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        console.warn('[sgc/bulk] empty blob for', m.filename || url);
        failed++;
        return;
      }
      const mime = m.mime || blob.type || 'application/octet-stream';
      // 文件名优先 SW 转发的；否则用 mime 推后缀
      const filename = m.filename || `wa_${ts()}.${extFromMime(mime)}`;
      const kind = specForceKind ?? kindFromMime(mime, filename);
      const thumb = kind === 'image' ? await blobToImageThumb(blob) : null;
      const file = new File([blob], filename, { type: mime });
      addCaptured({
        file,
        thumbDataUrl: thumb,
        kind,
        sourceContactPhone: phone,
      });
      ok++;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      console.log(`[sgc/bulk] captured ${kind} ${filename} (${blob.size} bytes)`);
    } catch (e) {
      console.warn('[sgc/bulk] fetch failed for', m.filename || url, e);
      failed++;
    }
  };

  chrome.runtime.onMessage.addListener(handler);

  return {
    getStats: () => ({ ok, failed, byKind: { ...byKind } }),
    stop: async () => {
      chrome.runtime.onMessage.removeListener(handler);
      try {
        await chrome.runtime.sendMessage({ type: 'BULK_CAPTURE_DISARM' });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 对一条消息触发右键 → 点"下载"/"全部下载" → SW 拦下载流。
 * 比 WA toolbar 的 ⬇ 好：那个会把多选打包成 zip，逐条点下载是单文件。
 */
async function rightClickDownloadRow(row: Element): Promise<{
  triggered: boolean;
  isAll: boolean;
}> {
  (row as HTMLElement).scrollIntoView({ block: 'center', behavior: 'auto' });
  await sleep(350);

  // 选个气泡里的可点目标（图片 / 视频 / 文档卡）
  const target =
    (row.querySelector(
      '[role="button"], img[src^="blob:"], video',
    ) as HTMLElement | null) ?? (row as HTMLElement);
  const r = target.getBoundingClientRect();
  const x = r.left + Math.min(60, r.width / 2);
  const y = r.top + Math.min(60, r.height / 2);

  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 2,
    }),
  );

  // 等菜单出现
  let menuItems: NodeListOf<Element> | null = null;
  for (let i = 0; i < 15; i++) {
    await sleep(80);
    const items = document.querySelectorAll('[role="menuitem"]');
    if (items.length > 0) {
      menuItems = items;
      break;
    }
  }
  if (!menuItems || menuItems.length === 0) {
    console.warn('[sgc/multi] right-click menu did not appear');
    return { triggered: false, isAll: false };
  }

  // 找"下载"/"全部下载"/Download/Download all
  const dl = Array.from(menuItems).find((m) => {
    const a = m.getAttribute('aria-label') || '';
    return (
      a === '下载' ||
      a === '全部下载' ||
      a === 'Download' ||
      a === 'Download all'
    );
  });

  if (!dl) {
    console.warn(
      '[sgc/multi] no 下载 in menu; options:',
      Array.from(menuItems).map((m) => m.getAttribute('aria-label')),
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { triggered: false, isAll: false };
  }

  const aria = dl.getAttribute('aria-label') || '';
  const isAll = aria === '全部下载' || aria === 'Download all';

  (dl as HTMLElement).click();
  // 关菜单（点了"下载"通常会自动关，保险起见）
  await sleep(150);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { triggered: true, isAll };
}

// 视频抓取通过 lightbox / blob: URL 不可行（WA MediaSource 流式 → 0 字节），
// 但通过 WA 原生"下载"按钮可以拿到真视频字节。所以多选 toolbar 走 bulk capture
// 能正常抓视频；inline / lightbox 入口仍然不行，已移除。

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 找当前 lightbox 里显示的"大图"。优先 naturalWidth >= 800（全清），否则取屏幕上面积最大的。
 */
function findLightboxImage(): HTMLImageElement | null {
  const allImgs = Array.from(document.querySelectorAll('img')).filter(
    (i): i is HTMLImageElement =>
      i instanceof HTMLImageElement && i.src.startsWith('blob:'),
  );
  // 先按 naturalWidth >= 800 筛选；找不到再退而求其次
  let candidates = allImgs.filter((i) => i.naturalWidth >= 800);
  if (candidates.length === 0) {
    // 取屏幕显示面积最大的（lightbox 大图通常占屏一半以上）
    candidates = allImgs.filter((i) => {
      const r = i.getBoundingClientRect();
      return r.width >= 300 && r.height >= 300;
    });
  }
  candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return br.width * br.height - ar.width * ar.height;
  });
  return candidates[0] ?? null;
}

let lastLightboxState: boolean | null = null;
function lightboxIsOpen(): boolean {
  // 多重判定：close + (download OR 上下步 OR 大视频/大图)
  const hasClose = !!document.querySelector(
    'button[aria-label="关闭"], button[aria-label="Close"]',
  );
  if (!hasClose) {
    if (lastLightboxState !== false) {
      console.log('[sgc] lightbox -> closed (no close btn)');
      lastLightboxState = false;
    }
    return false;
  }
  const hasDownload = !!document.querySelector(
    'button[aria-label="下载"], button[aria-label="Download"]',
  );
  const hasNav = !!document.querySelector(
    'button[aria-label="下一步"], button[aria-label="上一步"], button[aria-label="Next"], button[aria-label="Previous"]',
  );
  // 屏幕中央有大视频/大图（>=300px）
  const bigVideos = Array.from(document.querySelectorAll('video')).filter(
    (v) => v.getBoundingClientRect().width >= 300,
  );
  const bigImgs = Array.from(document.querySelectorAll('img')).filter(
    (i): i is HTMLImageElement =>
      i instanceof HTMLImageElement &&
      i.src.startsWith('blob:') &&
      i.getBoundingClientRect().width >= 300,
  );
  const hasBig = bigVideos.length > 0 || bigImgs.length > 0;
  // close 是必要的；其他三个任一即可
  const open = hasClose && (hasDownload || hasNav || hasBig);
  if (open !== lastLightboxState) {
    console.log(
      `[sgc] lightbox state -> ${open ? 'OPEN' : 'closed'} (close=${hasClose}, dl=${hasDownload}, nav=${hasNav}, big=${hasBig} v=${bigVideos.length} i=${bigImgs.length})`,
    );
    lastLightboxState = open;
  }
  return open;
}

async function closeLightbox() {
  const closeBtn = document.querySelector(
    'button[aria-label="关闭"]',
  ) as HTMLButtonElement | null;
  if (closeBtn) {
    closeBtn.click();
  } else {
    // fallback: ESC
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        bubbles: true,
      }),
    );
  }
  await sleep(300);
}

/**
 * 找 lightbox 里当前显示的视频元素。
 * lightbox 打开时 <video> 元素几乎肯定就是它。取屏幕上最大的 <video>。
 */
function findLightboxVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video')).filter(
    (v): v is HTMLVideoElement => v instanceof HTMLVideoElement,
  );
  if (videos.length === 0) return null;
  // 优先有 src + 屏幕显示尺寸大
  videos.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return br.width * br.height - ar.width * ar.height;
  });
  return videos[0];
}

/**
 * 通过 WA lightbox 抓取消息里所有图片/视频（全清版，包括 +N 隐藏的）。
 *
 * 流程：click 第一项 → 等 lightbox 出现 → 抓当前大图/视频 → 点"下一步" →
 * 等 src 变化 → 重复 → 看到重复 src 视为遍历完一圈 → ESC 关闭。
 */
async function captureMessageViaLightbox(rowEl: Element): Promise<number> {
  // 优先点 img (blob:)；否则点 video；否则点任意有意义的 img（视频 poster 等）
  let trigger: HTMLElement | null = rowEl.querySelector(
    'img[src^="blob:"]',
  ) as HTMLImageElement | null;
  if (!trigger) {
    trigger = rowEl.querySelector('video') as HTMLVideoElement | null;
  }
  if (!trigger) {
    // 视频 poster 或 https: 缩略图 — 通常 width >= 100
    const candidates = Array.from(rowEl.querySelectorAll('img')).filter(
      (i): i is HTMLImageElement =>
        i instanceof HTMLImageElement && (i.naturalWidth >= 100 || i.width >= 100),
    );
    trigger = candidates[0] ?? null;
  }
  if (!trigger) return 0;

  console.log('[sgc] lightbox: clicking trigger', trigger.tagName);
  trigger.click();

  // 等 lightbox 出现（关闭按钮 / 上一步按钮 出现）
  const start = Date.now();
  while (Date.now() - start < 3500) {
    if (lightboxIsOpen()) {
      // 看到内容（img 或 video）就够
      if (findLightboxImage() || findLightboxVideo()) break;
    }
    await sleep(150);
  }
  if (!lightboxIsOpen()) {
    console.warn('[sgc] lightbox did not open');
    return 0;
  }
  console.log('[sgc] lightbox opened');

  const seenSrcs = new Set<string>();
  let count = 0;
  let skippedVideo = 0;
  const MAX_TRAVERSE = 40;

  // 关键改动：循环只在「遇到见过的 src（绕了一圈）」或「下一步按钮没了/禁用」时停。
  // 视频抓不到不算 stagnant — 视频也有 src，看到过就 seen，下一项继续。
  for (let i = 0; i < MAX_TRAVERSE; i++) {
    let currentSrc: string | null = null;
    let isVideo = false;

    for (let j = 0; j < 30; j++) {
      const bigImg = findLightboxImage();
      if (bigImg && bigImg.naturalWidth > 0 && bigImg.complete) {
        currentSrc = bigImg.src;
        isVideo = false;
        break;
      }
      const bigVideo = findLightboxVideo();
      if (bigVideo && bigVideo.src) {
        currentSrc = bigVideo.src;
        isVideo = true;
        break;
      }
      await sleep(200);
    }

    if (!currentSrc) {
      console.log('[sgc] lightbox: no content loaded, stopping');
      break;
    }
    if (seenSrcs.has(currentSrc)) {
      console.log('[sgc] lightbox: cycled back to seen src, stopping');
      break;
    }
    seenSrcs.add(currentSrc);

    if (isVideo) {
      skippedVideo++;
      console.log(`[sgc] lightbox item ${i}: video, skipped (total skipped=${skippedVideo})`);
    } else {
      const bigImg = findLightboxImage();
      if (bigImg && (await captureImg(bigImg))) {
        count++;
        console.log(`[sgc] lightbox item ${i}: image captured (total=${count})`);
      } else {
        console.log(`[sgc] lightbox item ${i}: image capture failed`);
      }
    }

    const nextBtn = document.querySelector(
      'button[aria-label="下一步"]',
    ) as HTMLButtonElement | null;
    if (!nextBtn || nextBtn.disabled) {
      console.log('[sgc] lightbox: no next button, stopping');
      break;
    }
    nextBtn.click();
    await sleep(800);
  }
  console.log(`[sgc] lightbox traversal done: imgs=${count} skippedVideos=${skippedVideo}`);

  await closeLightbox();
  return count;
}

/**
 * （已弃用旧逻辑）保留以兼容现有 album 按钮调用。
 * 新版统一走 lightbox。
 */
async function captureAlbum(container: Element): Promise<number> {
  return captureMessageViaLightbox(container);
}

/**
 * 注入 📥 按钮到一个媒体元素（图片 / 视频 / 相册容器）。
 * 用 absolute 定位覆盖在右上角，hover 才显示。
 */
function injectButton(
  host: HTMLElement,
  label: string,
  onClick: (e: MouseEvent) => void,
  extraClass = '',
) {
  if (host.getAttribute(BTN_INJECTED_ATTR) === '1') return;
  host.setAttribute(BTN_INJECTED_ATTR, '1');

  // 让 host 有 relative position（不影响原有布局）
  const computed = getComputedStyle(host);
  if (computed.position === 'static') {
    host.style.position = 'relative';
  }

  const btn = document.createElement('button');
  btn.className = `${BTN_CLASS} ${extraClass}`.trim();
  btn.textContent = label;
  btn.title = '加入车源暂存';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e);
  });
  host.appendChild(btn);
}

/**
 * 找出 main pane 里所有 message bubble 的媒体元素，注入按钮。
 */
function scanAndInject() {
  const pane = getMainPane();
  if (!pane) return;

  // 单图 / 相册图片：data-id 包含 .jpg / 或 img.src 是 blob:
  // WhatsApp 图片元素：<img class="..." src="blob:..."> 在 message bubble 内
  const imgs = pane.querySelectorAll('img');
  imgs.forEach((img) => {
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.src || !img.src.startsWith('blob:')) return;
    if (img.naturalWidth < 50) return; // 滤掉小图标
    if (img.getAttribute(BTN_INJECTED_ATTR) === '1') return;

    // 找最近的 figure / div 容器作为 host（让按钮覆盖到图片上）
    const host = (img.closest('figure') ||
      img.closest('div[role="button"]') ||
      img.parentElement) as HTMLElement | null;
    if (!host) return;

    injectButton(host, '📥', async () => {
      flashButton(host, '抓取中…');
      // 走 lightbox 拿全清；如果 row 里有多张图（相册里的某张），lightbox 会遍历全部
      const row =
        (img.closest('[role="row"]') as Element | null) ||
        (img.closest('[data-id]') as Element | null) ||
        host;
      const ok = await captureMessageViaLightbox(row);
      flashButton(host, ok > 0 ? `✓ 已加 ${ok}` : '❌ 失败');
    });
  });

  // 视频：WA 用 MediaSource 流式播放，blob: 抓出来 0 字节，已经全部移除入口

  // 相册容器：一个 message bubble 里有 >= 2 个 blob: 图
  // 找带多张图的 message：用 data-id 作为锚点
  const messageNodes = pane.querySelectorAll('[data-id]');
  messageNodes.forEach((msg) => {
    const blobImgs = (msg as HTMLElement).querySelectorAll('img');
    const blobs = Array.from(blobImgs).filter(
      (i) => i.src.startsWith('blob:') && i.naturalWidth > 50,
    );
    if (blobs.length < 2) return;
    if (msg.getAttribute(`${BTN_INJECTED_ATTR}-album`) === '1') return;
    msg.setAttribute(`${BTN_INJECTED_ATTR}-album`, '1');

    // 试图读 +N 标记
    let extraHidden = 0;
    msg.querySelectorAll('span').forEach((s) => {
      const m = s.textContent?.trim().match(/^\+(\d+)$/);
      if (m) extraHidden = Math.max(extraHidden, Number(m[1]));
    });

    const total = blobs.length + extraHidden;
    const label = extraHidden > 0
      ? `📥 全部 (${blobs.length}/${total})`
      : `📥 全部 (${blobs.length})`;
    const title =
      extraHidden > 0
        ? `先点开相册让 ${extraHidden} 张隐藏图加载，再来点这里；或单张点 📥`
        : '把这个相册全部加入车源暂存';

    const host = msg as HTMLElement;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const btn = document.createElement('button');
    btn.className = `${BTN_CLASS} ${ALBUM_BTN_CLASS}`;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void captureAlbum(msg).then((ok) => {
        flashButton(host, `✓ 已加 ${ok}`);
      });
    });
    host.appendChild(btn);
  });

  // 文档气泡（PDF 等）的单条 📥 抓取已移除：
  //   WA Web 文档气泡没有 hover 能直接显示的"下载"按钮（需开预览或右键菜单），
  //   单条入口体验差。文档统一走多选 toolbar 的 📥 加入车源（用户三点 → 选择消息 →
  //   勾上 PDF / 图片 / 视频 → 点 📥 加入车源），由 SW 拦 chrome.downloads。

  // Lightbox / 媒体浏览器
  injectLightboxButton();

  // 多选模式 toolbar
  injectMultiSelectToolbarButton();
}

/**
 * WhatsApp 多选模式底部 toolbar — 加 "📥 加入车源" 按钮。
 * 用户在 WA 里选 N 张消息，一键全部抓到暂存盘。
 */
function findMultiSelectToolbar(): HTMLElement | null {
  const spans = document.querySelectorAll('span');
  for (const s of spans) {
    const txt = (s.textContent || '').trim();
    if (!/^已选\s*\d+\s*项$|^Selected\s+\d+/.test(txt)) continue;
    let cur: HTMLElement | null = s;
    for (let i = 0; i < 10 && cur; i++) {
      if (
        cur.querySelector(
          'button[aria-label="取消选择"], button[aria-label="Cancel selection"]',
        )
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
  }
  return null;
}

/**
 * 多选 toolbar 抓取主流程：
 *   1) 数选了几项（用于估算等多少个 download 事件）
 *   2) 找 WA 原生"下载"按钮 + 启动 bulk capture (SW 拦 chrome.downloads)
 *   3) 点 WA 下载 → 每个文件触发 onCreated → SW 取消盘写 + 转发 url 给 content
 *   4) content fetch blob → 按 mime 分到 image/video/spec → addCaptured
 *   5) 等下载事件趋稳（4s 没新事件）或超时 → 关 bulk → 退出 WA 多选
 */
function findChatPanel(): HTMLElement | null {
  const main = document.querySelector('div#main');
  if (!main) return null;
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const el = node as HTMLElement;
    const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        el.getBoundingClientRect().height > 200) {
      return el;
    }
  }
  return null;
}

async function captureSelectedFromMultiSelect(_toolbar: Element): Promise<{
  ok: number;
  failed: number;
  picked: number;
  notFound: number;
  byKind: Record<string, number>;
}> {
  console.log('[sgc/multi] start');

  const chatPanel = findChatPanel();
  console.log('[sgc/multi] chat panel:', !!chatPanel, chatPanel?.scrollHeight);

  // 收集勾选行：(dataId, rowRef, panelY) — panelY 是行在滚动容器内的 y 偏移
  type Picked = { dataId: string; row: Element; isAlbum: boolean; panelY: number };
  const items: Picked[] = [];
  const checked = document.querySelectorAll('input[type="checkbox"]:checked');
  for (const cb of Array.from(checked)) {
    const row = cb.closest('[role="row"]');
    if (!row) continue;
    let id: string | null = null;
    let cur: Element | null = row;
    for (let i = 0; cur && i < 12; i++) {
      const dataId =
        cur.querySelector?.('[data-id]')?.getAttribute('data-id') ??
        cur.getAttribute?.('data-id');
      if (dataId) {
        id = dataId;
        break;
      }
      cur = cur.parentElement;
    }
    if (!id || items.some((x) => x.dataId === id)) continue;
    const isAlbum =
      row.querySelectorAll('img[src^="blob:"]').length >= 2 ||
      id.startsWith('album-');
    let panelY = 0;
    if (chatPanel) {
      const r = (row as HTMLElement).getBoundingClientRect();
      const pr = chatPanel.getBoundingClientRect();
      panelY = chatPanel.scrollTop + (r.top - pr.top);
    }
    items.push({ dataId: id, row, isAlbum, panelY });
  }
  console.log(
    '[sgc/multi] picked',
    items.length,
    items.map((x) => ({ id: x.dataId.slice(0, 16) + '…', album: x.isAlbum, panelY: Math.round(x.panelY) })),
  );
  if (items.length === 0) {
    return { ok: 0, failed: 0, picked: 0, notFound: 0, byKind: {} };
  }

  // 按 panelY 倒序处理（从下往上）：每条处理后下面的行已"用完"，不再受虚拟滚动影响；
  // 上面的行通常还在视口或缓冲区里
  items.sort((a, b) => b.panelY - a.panelY);

  // 启动 bulk capture（SW 拦下载）
  let armed = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'BULK_CAPTURE_ARM' });
    armed = !!r?.ok;
  } catch (e) {
    console.warn('[sgc/multi] arm failed:', e);
  }
  if (!armed) throw new Error('SW arm 失败');
  const session = startBulkCapture();

  // 不退多选！退出会触发 WA 重渲染 + 虚拟滚动踢掉非视口行 → 后续 row ref 全失效。
  // 在多选模式下右键也能调出"下载"菜单（实测可行），处理完再统一取消。

  let directOk = 0; // 单图直接 captureImg / 相册 lightbox 抓的（不走 SW，本地累加）
  let triggeredRC = 0;
  let notFound = 0;
  const skippedTypes: { kind: string; dataId: string }[] = [];

  for (const { dataId, row: origRow, isAlbum, panelY } of items) {
    // 解析当前可用 row：优先原 ref；不在 DOM 就滚回原 panelY 让 WA 重新挂载
    let row: Element | null = null;
    if (document.body.contains(origRow)) {
      row = origRow;
    } else {
      // 把 chat panel 滚到该行原位置 → WA 虚拟滚动重新 mount
      if (chatPanel && panelY > 0) {
        const targetTop = Math.max(0, panelY - chatPanel.clientHeight / 2);
        chatPanel.scrollTo({ top: targetTop, behavior: 'auto' });
        await sleep(500);
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(300);
        const fresh = document.querySelector(
          `[data-id="${CSS.escape(dataId)}"]`,
        );
        const wrapper = fresh?.closest('[role="row"]') ?? fresh ?? null;
        if (wrapper) {
          row = wrapper;
          break;
        }
      }
    }
    if (!row) {
      console.warn('[sgc/multi] row not found:', dataId);
      notFound++;
      continue;
    }
    try {
      (row as HTMLElement).scrollIntoView({ block: 'nearest' });
      await sleep(250);
    } catch {
      /* ignore */
    }

    const blobImgs = row.querySelectorAll('img[src^="blob:"]');
    const videos = row.querySelectorAll('video');
    const isPdfBubble = !!row.querySelector('[data-icon="document-PDF-icon"], [data-icon^="document-"]');
    // 视频未播放时只有 poster <img>（非 blob:）+ 视频图标
    const hasVideoIndicator =
      videos.length > 0 ||
      !!row.querySelector('[data-icon="video-pip"], [data-icon="media-play"], [data-icon="media-played"]');

    if (isAlbum || blobImgs.length >= 2) {
      // 相册：lightbox 遍历
      console.log('[sgc/multi] album → lightbox:', dataId.slice(0, 16));
      const captured = await captureMessageViaLightbox(row);
      directOk += captured;
      console.log(`[sgc/multi]   lightbox got ${captured} images`);
      await sleep(400);
    } else if (blobImgs.length === 1 && videos.length === 0) {
      // 单图：直接 captureImg(<img>)，不走 lightbox 也不走 chrome.downloads
      console.log('[sgc/multi] single image → captureImg:', dataId.slice(0, 16));
      if (await captureImg(blobImgs[0] as HTMLImageElement)) {
        directOk++;
      }
      await sleep(200);
    } else if (hasVideoIndicator) {
      // 视频：右键 → "下载"，不等下载完成（避免虚拟滚动踢出后续行）
      console.log('[sgc/multi] video → right-click:', dataId.slice(0, 16));
      const r = await rightClickDownloadRow(row);
      console.log(`[sgc/multi]   video right-click triggered=${r.triggered}`);
      if (r.triggered) triggeredRC++;
      else skippedTypes.push({ kind: 'video-no-menu', dataId });
      await sleep(300); // 短暂喘息让 WA 关菜单
    } else if (isPdfBubble) {
      // PDF：同样快速触发，不等
      console.log('[sgc/multi] pdf → right-click:', dataId.slice(0, 16));
      const r = await rightClickDownloadRow(row);
      console.log(`[sgc/multi]   pdf right-click triggered=${r.triggered} isAll=${r.isAll}`);
      if (r.triggered) triggeredRC++;
      else skippedTypes.push({ kind: 'pdf-no-menu', dataId });
      await sleep(300);
    } else {
      // 兜底：DOM 看不出明确类型（视频 poster 卸载后、不熟悉的气泡），
      // 直接试右键 → 下载，让 SW 拦
      console.log('[sgc/multi] fallback → right-click:', dataId.slice(0, 16),
        { blobImgs: blobImgs.length, videos: videos.length, pdf: isPdfBubble });
      const r = await rightClickDownloadRow(row);
      console.log(`[sgc/multi]   fallback right-click triggered=${r.triggered}`);
      if (r.triggered) triggeredRC++;
      else skippedTypes.push({ kind: 'unknown', dataId });
      await sleep(300);
    }
  }

  // 收尾：等剩余 chrome.downloads 事件（按触发数估算上限）
  console.log(
    `[sgc/multi] processed: direct=${directOk}, rc-triggered=${triggeredRC}, skipped=${skippedTypes.length}, waiting for trailing downloads...`,
  );
  if (triggeredRC > 0) {
    let last = -1;
    let stable = 0;
    // 每条最多等 ~5s，所以总等 = triggeredRC * 5s, 上限 30s
    const maxIter = Math.min(30, triggeredRC * 5);
    for (let i = 0; i < maxIter; i++) {
      await sleep(1000);
      const s = session.getStats();
      const total = s.ok + s.failed;
      if (total >= triggeredRC && total === last) break; // 全到 + 稳定一轮
      if (total === last) {
        stable++;
        if (stable >= 4 && total > 0) break; // 4s 没新增 + 至少有 1 个
      } else {
        stable = 0;
        last = total;
      }
    }
  }

  await session.stop();
  const swStats = session.getStats();

  // 处理完所有行 → 退出多选
  const cancelBtn = document.querySelector(
    'button[aria-label="取消选择"], button[aria-label="Cancel selection"]',
  ) as HTMLButtonElement | null;
  if (cancelBtn) cancelBtn.click();

  // 合并直接抓的（lightbox + 单图 captureImg）
  const merged = {
    ok: swStats.ok + directOk,
    failed: swStats.failed,
    picked: items.length,
    notFound,
    byKind: { ...swStats.byKind } as Record<string, number>,
  };
  if (directOk > 0) {
    merged.byKind.image = (merged.byKind.image ?? 0) + directOk;
  }
  // 把跳过项数也带出去
  if (skippedTypes.length > 0) {
    (merged as unknown as { _skipped?: typeof skippedTypes })._skipped = skippedTypes;
  }
  console.log('[sgc/multi] done', merged);
  return merged;
}

function injectMultiSelectToolbarButton() {
  const toolbar = findMultiSelectToolbar();
  if (!toolbar) return;
  if (toolbar.getAttribute(TOOLBAR_BTN_ATTR) === '1') return;
  toolbar.setAttribute(TOOLBAR_BTN_ATTR, '1');

  const btn = document.createElement('button');
  btn.className = TOOLBAR_BTN_CLASS;
  btn.textContent = '📥 加入车源';
  btn.title =
    'WA 限制：一次只能处理 1 条消息（相册除外，整个相册算 1 条）。\n' +
    '建议每次只勾一条 / 一个相册，点击后等结果再勾下一条。';
  btn.addEventListener('click', async (e) => {
    console.log('[sgc] toolbar 加入车源 clicked');
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '抓取中…';
    try {
      const stats = await captureSelectedFromMultiSelect(toolbar);
      const parts: string[] = [];
      const k = stats.byKind;
      if (k.image) parts.push(`图 ${k.image}`);
      if (k.video) parts.push(`视频 ${k.video}`);
      if (k.spec) parts.push(`配置表 ${k.spec}`);
      if (stats.failed) parts.push(`失败 ${stats.failed}`);
      if (stats.notFound > 0) parts.push(`剩 ${stats.notFound} 条请再勾选+点击`);
      btn.textContent = stats.ok === 0
        ? `❌ 一项都没抓到${parts.length ? ` (${parts.join(' · ')})` : ''}`
        : `✓ 已加 ${stats.ok}${parts.length ? ` (${parts.join(' · ')})` : ''}`;
    } catch (err) {
      console.warn('[sgc] toolbar capture failed', err);
      btn.textContent = '❌ ' + (err instanceof Error ? err.message : '失败');
    }
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 4000);
  });
  toolbar.appendChild(btn);
}

/**
 * WA 全屏媒体浏览器（用户点开图片/视频后）— 浮动按钮组：
 *   📥 加入车源（图片）  📥 加入车源（配置表）
 * 配置表用于供应商把车型规格表当截屏发过来的场景。
 */
const LIGHTBOX_WRAP_ID = 'sgc-mc-lightbox-floating';

function injectLightboxButton() {
  const existing = document.getElementById(LIGHTBOX_WRAP_ID) as HTMLDivElement | null;
  const isOpen = lightboxIsOpen();

  // 视频在 lightbox 里也抓不到（MediaSource 0 字节），只给图片加按钮
  const isVideoLightbox = !!findLightboxVideo();

  if (!isOpen || isVideoLightbox) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;

  const wrap = document.createElement('div');
  wrap.id = LIGHTBOX_WRAP_ID;
  wrap.className = 'sgc-mc-lightbox-wrap';

  const makeBtn = (label: string, kind: 'image' | 'spec', extraClass: string) => {
    const b = document.createElement('button');
    b.className = `${BTN_CLASS} sgc-mc-lightbox-btn ${extraClass}`;
    b.textContent = label;
    b.title =
      kind === 'spec'
        ? '把当前图片当作"配置表"加入车源暂存（截屏的规格表选这个）'
        : '把当前图片加入车源暂存';
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.disabled = true;
      const orig = b.textContent;
      b.textContent = '抓取中…';
      let detail = '';
      try {
        const img = findLightboxImage();
        if (img) {
          const ok = await captureImg(img, kind);
          detail = ok ? '✓ 已加' : '❌ 抓不到';
        } else {
          detail = '❌ 找不到图片';
        }
      } catch (err) {
        console.error('[sgc] lightbox capture err:', err);
        detail = '❌ ' + (err instanceof Error ? err.message : String(err));
      }
      b.textContent = detail;
      setTimeout(() => {
        if (document.body.contains(b)) {
          b.textContent = orig;
          b.disabled = false;
        }
      }, 2500);
    });
    return b;
  };

  wrap.appendChild(makeBtn('📥 加入车源（图片）', 'image', 'sgc-mc-lightbox-btn-img'));
  wrap.appendChild(makeBtn('📥 加入车源（配置表）', 'spec', 'sgc-mc-lightbox-btn-spec'));
  document.body.appendChild(wrap);
}

function flashButton(host: HTMLElement, msg = '✓ 已加') {
  const flash = document.createElement('div');
  flash.className = 'sgc-mc-flash';
  flash.textContent = msg;
  host.appendChild(flash);
  setTimeout(() => flash.remove(), 1500);
}

export function initChatMediaCapture() {
  if (observer) return;

  const start = () => {
    scanAndInject();

    observer = new MutationObserver(() => {
      scanAndInject();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
    });

    // 兜底轮询（observer 不一定盖到所有变化）
    pollTimer = window.setInterval(() => scanAndInject(), 3000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

export function disposeChatMediaCapture() {
  if (observer) observer.disconnect();
  if (pollTimer != null) clearInterval(pollTimer);
  observer = null;
  pollTimer = null;
}
