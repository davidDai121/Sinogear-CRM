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
 * 捕获一个 <img>。kind 默认 image。
 */
async function captureImg(img: HTMLImageElement): Promise<boolean> {
  if (!img.src) return false;
  // 先生成缩略图（用 DOM 里已经渲染好的）
  const thumb = imgToThumbDataUrl(img);
  try {
    const filename = `whatsapp_${ts()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const file = await urlToFile(img.src, filename, 'image/jpeg');
    const phone = readCurrentChat().phone;
    addCaptured({
      file,
      thumbDataUrl: thumb,
      kind: 'image',
      sourceContactPhone: phone,
    });
    return true;
  } catch (e) {
    console.warn('[sgc] capture image failed', e);
    return false;
  }
}

/**
 * 捕获一个 <video>（取 src 或 poster）。
 * 优先抓视频本体；抓不到就抓 poster 作为图片。
 */
async function captureVideo(video: HTMLVideoElement): Promise<boolean> {
  const phone = readCurrentChat().phone;
  if (video.src) {
    try {
      const filename = `whatsapp_${ts()}_${Math.random().toString(36).slice(2, 6)}.mp4`;
      const file = await urlToFile(video.src, filename, 'video/mp4');
      addCaptured({
        file,
        thumbDataUrl: video.poster || null,
        kind: 'video',
        sourceContactPhone: phone,
      });
      return true;
    } catch (e) {
      console.warn('[sgc] capture video failed', e);
    }
  }
  // 至少抓 poster 当图片
  if (video.poster) {
    try {
      const filename = `whatsapp_thumb_${ts()}.jpg`;
      const file = await urlToFile(video.poster, filename, 'image/jpeg');
      addCaptured({
        file,
        thumbDataUrl: video.poster,
        kind: 'image',
        sourceContactPhone: phone,
      });
      return true;
    } catch (e) {
      console.warn('[sgc] capture video poster failed', e);
    }
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 找当前 lightbox 里显示的"大图"。WA lightbox 的大图 naturalWidth > 800（全清）。
 * 内联缩略图通常 < 600。
 */
function findLightboxImage(): HTMLImageElement | null {
  const candidates = Array.from(document.querySelectorAll('img'))
    .filter(
      (i): i is HTMLImageElement =>
        i instanceof HTMLImageElement &&
        i.src.startsWith('blob:') &&
        i.naturalWidth >= 800,
    );
  // 取在 viewport 中、面积最大的（可能有缩略图条 224×168 也是 1400px 原始尺寸）
  candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return br.width * br.height - ar.width * ar.height;
  });
  return candidates[0] ?? null;
}

function lightboxIsOpen(): boolean {
  // WA 的图片/视频全屏浏览器 — 用 "下载" 按钮 + "关闭" 按钮联合判定
  // (下一步/上一步 只有相册才有)
  const hasDownload = !!document.querySelector('button[aria-label="下载"], button[aria-label="Download"]');
  const hasClose = !!document.querySelector('button[aria-label="关闭"], button[aria-label="Close"]');
  return hasDownload && hasClose;
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
 * 找 lightbox 里当前显示的视频元素（如果是视频消息）。
 * lightbox 视频有 <video> 元素 + blob: src 或 src starts with media URL。
 */
function findLightboxVideo(): HTMLVideoElement | null {
  // lightbox 容器（关闭按钮的祖先）
  const closeBtn = document.querySelector('button[aria-label="关闭"]');
  if (!closeBtn) return null;
  let scope: Element | null = closeBtn;
  for (let i = 0; i < 12 && scope; i++) {
    if (
      scope.querySelector &&
      scope.querySelector('button[aria-label="下一步"], button[aria-label="上一步"]')
    ) {
      break;
    }
    scope = scope.parentElement;
  }
  if (!scope) return null;
  const v = scope.querySelector('video');
  return v instanceof HTMLVideoElement ? v : null;
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
  let stagnant = 0;
  const MAX_TRAVERSE = 30;

  for (let i = 0; i < MAX_TRAVERSE && stagnant < 2; i++) {
    // 当前 lightbox 是 image 还是 video
    let currentSrc: string | null = null;
    let captured = false;

    for (let j = 0; j < 30; j++) {
      const bigImg = findLightboxImage();
      if (bigImg && bigImg.naturalWidth > 0 && bigImg.complete) {
        currentSrc = bigImg.src;
        if (!seenSrcs.has(currentSrc)) {
          seenSrcs.add(currentSrc);
          if (await captureImg(bigImg)) {
            count++;
            captured = true;
          }
        }
        break;
      }
      const bigVideo = findLightboxVideo();
      if (bigVideo && bigVideo.src) {
        currentSrc = bigVideo.src;
        if (!seenSrcs.has(currentSrc)) {
          seenSrcs.add(currentSrc);
          if (await captureVideo(bigVideo)) {
            count++;
            captured = true;
          }
        }
        break;
      }
      await sleep(200);
    }

    if (!currentSrc) break;
    if (!captured) stagnant++;
    else stagnant = 0;

    const nextBtn = document.querySelector(
      'button[aria-label="下一步"]',
    ) as HTMLButtonElement | null;
    if (!nextBtn || nextBtn.disabled) break;
    nextBtn.click();
    await sleep(800);
  }

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

  // 视频
  const videos = pane.querySelectorAll('video');
  videos.forEach((v) => {
    if (!(v instanceof HTMLVideoElement)) return;
    if (v.getAttribute(BTN_INJECTED_ATTR) === '1') return;
    const host = (v.closest('figure') || v.parentElement) as HTMLElement | null;
    if (!host) return;
    injectButton(host, '📥', async () => {
      flashButton(host, '抓取中…');
      // 直接拿 src（已加载）；否则走 lightbox 让 WA 加载完整视频
      let ok = false;
      if (v.src) {
        ok = await captureVideo(v);
      }
      if (!ok) {
        // 找 row 走 lightbox 抓
        const row =
          (v.closest('[role="row"]') as Element | null) ||
          (v.closest('[data-id]') as Element | null) ||
          host;
        const captured = await captureMessageViaLightbox(row);
        ok = captured > 0;
      }
      flashButton(host, ok ? '✓ 已加' : '❌ 抓不到');
    });
  });

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

async function captureSelectedFromMultiSelect(): Promise<number> {
  console.log('[sgc] captureSelectedFromMultiSelect: start');
  const checked = document.querySelectorAll('input[type="checkbox"]:checked');
  console.log('[sgc] checked count =', checked.length);

  // 收集 data-id（cancel 多选后 row 引用会失效，必须用 data-id 重查）
  const dataIds: string[] = [];
  for (const cb of Array.from(checked)) {
    let cur: Element | null = cb.closest('[role="row"]') || cb.parentElement;
    let id: string | null = null;
    for (let i = 0; cur && i < 12; i++) {
      const dataId = cur.querySelector?.('[data-id]')?.getAttribute('data-id');
      if (dataId) { id = dataId; break; }
      if (cur.getAttribute && cur.getAttribute('data-id')) { id = cur.getAttribute('data-id'); break; }
      cur = cur.parentElement;
    }
    if (id && !dataIds.includes(id)) dataIds.push(id);
  }
  console.log('[sgc] data-ids collected:', dataIds);
  // 收集所有被选中的 row，以及每个 row 里第一张图（用于打开 lightbox）。
  // 注意：一旦我们 click 第一张图开 lightbox，多选模式可能会被 WA 取消（点图片会触发 select toggle）。
  // 解决方案：先收集 row references → 退出多选模式（点取消选择）→ 然后逐个 row 点首图开 lightbox 抓取。
  // 但退出多选后 row 还存在（数据不会消失），只是 checkbox 状态丢。
  const rows: Element[] = [];
  for (const cb of Array.from(checked)) {
    const row = cb.closest('[role="row"]');
    if (row && !rows.includes(row)) rows.push(row);
  }
  console.log('[sgc] rows collected =', rows.length, '(reference 仅用于 fallback)');
  if (rows.length === 0 && dataIds.length === 0) return 0;

  // 退出多选模式（不然 click 图片会被 toggle 选择，不会开 lightbox）
  const cancelBtn = document.querySelector(
    'button[aria-label="取消选择"], button[aria-label="Cancel selection"]',
  ) as HTMLButtonElement | null;
  console.log('[sgc] cancel btn?', !!cancelBtn);
  if (cancelBtn) {
    cancelBtn.click();
    await sleep(600); // 等 WA re-render
  }

  let ok = 0;
  // 用 data-id 重新查 DOM；WA 用虚拟滚动 + 懒加载，需要 scrollIntoView 触发渲染
  const rowsToProcess: Element[] = [];
  for (const id of dataIds) {
    console.log(`[sgc] re-query for data-id ${id}`);
    let row: Element | null = null;
    try {
      // 6 次 × 500ms = 3s 轮询，等媒体加载
      for (let attempt = 0; attempt < 6; attempt++) {
        const sel = `[data-id="${CSS.escape(id)}"]`;
        const fresh = document.querySelector(sel);
        const found = !!fresh;
        const inWrapper = fresh?.closest('[role="row"]');
        const imgInWrapper = inWrapper?.querySelectorAll('img').length ?? 0;
        const vidInWrapper = inWrapper?.querySelectorAll('video').length ?? 0;
        console.log(`[sgc]   attempt ${attempt + 1}: found=${found} img=${imgInWrapper} video=${vidInWrapper}`);

        if (fresh) {
          const wrapper = inWrapper || fresh;
          if (attempt === 0) {
            try {
              (fresh as HTMLElement).scrollIntoView({ block: 'center' });
              console.log(`[sgc]   scrolled into view`);
            } catch (e) { console.warn('[sgc] scrollIntoView err:', e); }
          }
          if (wrapper.querySelector('img, video')) {
            row = wrapper;
            console.log(`[sgc]   ✓ found media on attempt ${attempt + 1}`);
            break;
          }
        }
        await sleep(500);
      }
    } catch (e) {
      console.error('[sgc] re-query error for', id, e);
    }
    if (row) rowsToProcess.push(row);
    else console.warn(`[sgc] data-id ${id}: no media after 3s wait`);
  }
  // fallback：如果没拿到 data-id，用旧 row 引用（可能是 stale）
  if (rowsToProcess.length === 0) {
    rowsToProcess.push(...rows);
  }
  console.log('[sgc] rows to process =', rowsToProcess.length);

  for (let idx = 0; idx < rowsToProcess.length; idx++) {
    const row = rowsToProcess[idx];
    const inlineVideos = Array.from(row.querySelectorAll('video')).filter(
      (v): v is HTMLVideoElement =>
        v instanceof HTMLVideoElement && Boolean(v.src),
    );
    const imgsCount = row.querySelectorAll('img[src^="blob:"]').length;
    const allVideos = row.querySelectorAll('video').length;
    console.log(`[sgc] row ${idx}: imgs=${imgsCount} videos=${allVideos} inlineWithSrc=${inlineVideos.length}`);

    let inlineOk = 0;
    for (const v of inlineVideos) {
      if (await captureVideo(v)) inlineOk++;
    }
    if (inlineOk > 0) {
      console.log(`[sgc] row ${idx}: inline video captured ${inlineOk}`);
      ok += inlineOk;
      await sleep(300);
      continue;
    }

    // 视频未播放时可能只有 poster <img>（非 blob:）— 也算 hasMedia
    const hasMedia = !!row.querySelector('img, video');
    if (hasMedia) {
      console.log(`[sgc] row ${idx}: trying lightbox...`);
      const captured = await captureMessageViaLightbox(row);
      console.log(`[sgc] row ${idx}: lightbox captured ${captured}`);
      ok += captured;
      await sleep(300);
    } else {
      console.log(`[sgc] row ${idx}: no media to capture (text only?)`);
    }
  }
  console.log('[sgc] captureSelectedFromMultiSelect: done, total =', ok);
  return ok;
}

function injectMultiSelectToolbarButton() {
  const toolbar = findMultiSelectToolbar();
  if (!toolbar) return;
  if (toolbar.getAttribute(TOOLBAR_BTN_ATTR) === '1') return;
  toolbar.setAttribute(TOOLBAR_BTN_ATTR, '1');

  const btn = document.createElement('button');
  btn.className = TOOLBAR_BTN_CLASS;
  btn.textContent = '📥 加入车源';
  btn.title = '把选中的图片/视频加入车源暂存';
  btn.addEventListener('click', async (e) => {
    console.log('[sgc] toolbar 加入车源 clicked');
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '抓取中…';
    try {
      const ok = await captureSelectedFromMultiSelect();
      btn.textContent = `✓ 已加 ${ok}`;
    } catch (err) {
      console.warn('[sgc] toolbar capture failed', err);
      btn.textContent = '❌ 失败';
    }
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1500);
  });
  toolbar.appendChild(btn);
}

/**
 * WA 全屏媒体浏览器（用户点开图片/视频后）— 浮动 "📥 抓这张" 按钮。
 * 用 body 直接子元素 + position:fixed，跟随 lightbox 状态自动显示/隐藏。
 */
const LIGHTBOX_BTN_ID = 'sgc-mc-lightbox-floating';

function injectLightboxButton() {
  const existing = document.getElementById(LIGHTBOX_BTN_ID) as HTMLButtonElement | null;
  const isOpen = lightboxIsOpen();

  if (!isOpen) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    // 已注入：根据当前内容更新文案（图片 vs 视频）
    const v = findLightboxVideo();
    const desired = v ? '📥 加入车源（视频）' : '📥 加入车源（图片）';
    if (!existing.disabled && existing.textContent !== desired && !existing.textContent?.startsWith('✓') && !existing.textContent?.startsWith('❌') && existing.textContent !== '抓取中…') {
      existing.textContent = desired;
    }
    return;
  }

  const btn = document.createElement('button');
  btn.id = LIGHTBOX_BTN_ID;
  btn.className = `${BTN_CLASS} sgc-mc-lightbox-btn`;
  const initialVideo = findLightboxVideo();
  btn.textContent = initialVideo ? '📥 加入车源（视频）' : '📥 加入车源（图片）';
  btn.title = '把当前查看的图片/视频加入车源暂存';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = '抓取中…';
    let ok = false;
    let detail = '';
    try {
      const video = findLightboxVideo();
      const img = findLightboxImage();
      if (video) {
        if (!video.src) {
          detail = '视频还没加载（点播放后再试）';
        } else {
          ok = await captureVideo(video);
          detail = ok ? '✓ 视频已加' : '❌ 视频抓不到';
        }
      } else if (img) {
        ok = await captureImg(img);
        detail = ok ? '✓ 图片已加' : '❌ 图片抓不到';
      } else {
        detail = '❌ 找不到媒体';
      }
    } catch (err) {
      console.error('[sgc] lightbox capture err:', err);
      detail = '❌ ' + (err instanceof Error ? err.message : String(err));
    }
    btn.textContent = detail;
    setTimeout(() => {
      if (document.getElementById(LIGHTBOX_BTN_ID) === btn) {
        const v = findLightboxVideo();
        btn.textContent = v ? '📥 加入车源（视频）' : '📥 加入车源（图片）';
        btn.disabled = false;
      }
    }, 2500);
  });
  document.body.appendChild(btn);
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
