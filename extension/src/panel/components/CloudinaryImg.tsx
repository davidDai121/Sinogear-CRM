import { useEffect, useRef, useState } from 'react';

/**
 * 在 web.whatsapp.com 直接 <img src="https://res.cloudinary.com/..."> 会被 WA 的 CSP 屏蔽。
 * 解决：扩展 host_permissions 允许 cloudinary，content script 用 fetch 拿到 blob，
 *      创建 object URL 给 <img>，blob: URL CSP 默认放行。
 *
 * 简单 in-memory cache 避免同一张图反复 fetch。
 */

const cache = new Map<string, string>(); // url → object URL
const inflight = new Map<string, Promise<string>>(); // dedupe concurrent fetches

async function loadAsBlobUrl(src: string): Promise<string> {
  const cached = cache.get(src);
  if (cached) return cached;
  const pending = inflight.get(src);
  if (pending) return pending;

  const p = (async () => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    cache.set(src, url);
    inflight.delete(src);
    return url;
  })();
  inflight.set(src, p);
  return p;
}

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
}

export function CloudinaryImg({ src, alt = '', ...rest }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => cache.get(src) ?? null);
  const [error, setError] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (cache.has(src)) {
      setBlobUrl(cache.get(src)!);
      setError(false);
      return;
    }
    setBlobUrl(null);
    setError(false);
    loadAsBlobUrl(src)
      .then((u) => {
        if (!cancelled.current) setBlobUrl(u);
      })
      .catch(() => {
        if (!cancelled.current) setError(true);
      });
    return () => {
      cancelled.current = true;
    };
  }, [src]);

  if (error) {
    return (
      <span
        {...(rest as React.HTMLAttributes<HTMLSpanElement>)}
        title="加载失败"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f0f2f5',
          color: '#8696a0',
          ...(rest.style ?? {}),
        }}
      >
        ⚠
      </span>
    );
  }

  if (!blobUrl) {
    // 占位（保持 size），避免无 src 报警告
    return (
      <span
        {...(rest as React.HTMLAttributes<HTMLSpanElement>)}
        style={{
          display: 'inline-block',
          background: '#f0f2f5',
          ...(rest.style ?? {}),
        }}
      />
    );
  }

  return <img src={blobUrl} alt={alt} {...rest} />;
}
