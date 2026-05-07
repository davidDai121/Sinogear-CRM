/**
 * Cloudinary 直传（unsigned upload preset，无需后端签名）
 *
 * 配置：.env 里 VITE_CLOUDINARY_CLOUD_NAME + VITE_CLOUDINARY_UPLOAD_PRESET
 * preset 必须在 Cloudinary 后台 Settings → Upload → Upload presets 里设为 Unsigned。
 *
 * 用法：
 *   const file = ...;  // File 或 Blob
 *   const { url, public_id } = await uploadToCloudinary(file, 'image');
 *
 * 视频/PDF/Excel 都用同一个端点（auto resource type）。
 */

import type { VehicleMediaType } from './database.types';

const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined;

export interface CloudinaryUploadResult {
  url: string;
  secure_url: string;
  public_id: string;
  resource_type: 'image' | 'video' | 'raw';
  bytes: number;
  format: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface UploadOptions {
  /** 自定义 folder（覆盖 preset 的 folder 设置）；不传用 preset 默认 */
  folder?: string;
  /** 自定义 public_id（不传则 cloudinary 自动生成） */
  publicId?: string;
  /** 进度回调 0-1 */
  onProgress?: (pct: number) => void;
  /** AbortSignal 用于取消 */
  signal?: AbortSignal;
}

export class CloudinaryConfigError extends Error {
  constructor() {
    super(
      'Cloudinary 未配置。请在 .env 添加 VITE_CLOUDINARY_CLOUD_NAME + VITE_CLOUDINARY_UPLOAD_PRESET',
    );
  }
}

export function isCloudinaryConfigured(): boolean {
  return Boolean(CLOUD_NAME && UPLOAD_PRESET);
}

/** 根据 media type 推断 cloudinary resource_type 端点 */
function endpointFor(mediaType: VehicleMediaType, mime?: string): 'image' | 'video' | 'raw' | 'auto' {
  if (mediaType === 'image') return 'image';
  if (mediaType === 'video') return 'video';
  // spec：图片走 image，视频走 video，PDF/Excel 走 raw — 用 auto 让 cloudinary 自己判断
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  return 'auto';
}

/**
 * 上传 File 或 Blob 到 cloudinary。
 * 用 XMLHttpRequest 而不是 fetch 因为需要进度事件。
 */
export function uploadToCloudinary(
  file: File | Blob,
  mediaType: VehicleMediaType,
  opts: UploadOptions = {},
): Promise<CloudinaryUploadResult> {
  if (!CLOUD_NAME || !UPLOAD_PRESET) {
    return Promise.reject(new CloudinaryConfigError());
  }

  const resourceType = endpointFor(mediaType, (file as File).type);
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`;

  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', UPLOAD_PRESET);
  if (opts.folder) form.append('folder', opts.folder);
  if (opts.publicId) form.append('public_id', opts.publicId);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);

    if (opts.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) opts.onProgress!(e.loaded / e.total);
      });
    }

    if (opts.signal) {
      const onAbort = () => xhr.abort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error('Cloudinary 响应解析失败'));
        }
      } else {
        let msg = `Cloudinary 上传失败 (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.error?.message) msg = `Cloudinary: ${body.error.message}`;
        } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Cloudinary 网络错误'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(form);
  });
}

/**
 * 通过 fetch 把 blob URL（如 WhatsApp Web 的 blob:...）转成 File。
 * Phase C 用：从聊天里抓图片然后上传。
 */
export async function blobUrlToFile(blobUrl: string, filename: string): Promise<File> {
  const res = await fetch(blobUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type });
}

/**
 * 生成 Cloudinary 缩略图 URL（按宽度变换）。
 * 对 image / video 都有效（video 会取首帧）。
 */
export function thumbnailUrl(originalUrl: string, width = 240): string {
  // 把 /upload/ 替换成 /upload/c_fill,w_240,h_180,q_auto,f_auto/
  // video 缩略图：cloudinary 自动取首帧
  return originalUrl.replace(
    '/upload/',
    `/upload/c_fill,w_${width},h_${Math.round((width * 3) / 4)},q_auto,f_auto/`,
  );
}
