/**
 * WhatsApp Business `msgstore.db.crypt15` 解密 — 浏览器版（Web Crypto + DecompressionStream）。
 *
 * 移植自 wa-crypt-tools (Python)。详情见姐妹仓库 sino-gear-wa-importer 的 src/decrypt.ts。
 *
 * 文件结构：
 *   [1B protobuf size]
 *   [1B 0x01 feature flag, 可选]
 *   [N BackupPrefix protobuf — 含 16B IV]
 *   [密文]
 *   [16B GCM tag]
 *   [16B MD5 完整性校验 — 跳过]
 *
 * 关键坑：64 位 hex 是 root key，不是 AES key。
 *   AES key = HMAC-SHA256(HMAC-SHA256(zero32, root), "backup encryption" || 0x01)
 */

/** 用户的 64 位 hex 推导出 32 字节 AES-256-GCM key */
async function deriveAesKey(root: Uint8Array): Promise<CryptoKey> {
  if (root.length !== 32) throw new Error(`root key 必须 32 字节，实际 ${root.length}`);

  // 用 any cast 绕过 TS 5.7+ 的 Uint8Array<ArrayBufferLike> 与 BufferSource 不兼容问题。
  // Web Crypto 运行时不在乎，DOM 类型今年刚改紧。
  const importHmacKey = (raw: BufferSource): Promise<CryptoKey> =>
    crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

  const zeroSeed = new Uint8Array(32);
  const privateKey = await crypto.subtle.sign(
    'HMAC',
    await importHmacKey(zeroSeed as unknown as BufferSource),
    root as unknown as BufferSource,
  );

  const msg = concat(textEncode('backup encryption'), new Uint8Array([0x01]));
  const aesKeyRaw = await crypto.subtle.sign(
    'HMAC',
    await importHmacKey(privateKey),
    msg as unknown as BufferSource,
  );

  return crypto.subtle.importKey(
    'raw',
    aesKeyRaw,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
}

function readVarint(buf: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const b = buf[i]!;
    value |= (b & 0x7f) << shift;
    i++;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 28) throw new Error('varint 溢出');
  }
  throw new Error('varint 越界');
}

/**
 * 抠 BackupPrefix.c15_iv.IV (field 3 → field 1)。手写解析避免依赖 protobufjs。
 *
 * 0x1a = field 3, wire type 2 (length-delimited)
 * 0x0a = field 1, wire type 2
 */
function extractIv(prefix: Uint8Array): Uint8Array {
  let i = 0;
  while (i < prefix.length) {
    const tag = prefix[i]!;
    i++;
    const wireType = tag & 0x07;
    const fieldNum = tag >> 3;

    if (wireType === 2) {
      const { value: len, next } = readVarint(prefix, i);
      i = next;
      const sub = prefix.subarray(i, i + len);
      i += len;

      if (fieldNum === 3) {
        let j = 0;
        while (j < sub.length) {
          const subTag = sub[j]!;
          j++;
          const subWire = subTag & 0x07;
          const subField = subTag >> 3;
          if (subWire === 2) {
            const { value: subLen, next: subNext } = readVarint(sub, j);
            j = subNext;
            if (subField === 1) {
              const iv = sub.subarray(j, j + subLen);
              if (iv.length !== 16) throw new Error(`IV 长度异常：${iv.length}`);
              return new Uint8Array(iv);
            }
            j += subLen;
          } else if (subWire === 0) {
            j = readVarint(sub, j).next;
          } else if (subWire === 1) {
            j += 8;
          } else if (subWire === 5) {
            j += 4;
          } else {
            throw new Error(`未知 wire type ${subWire}`);
          }
        }
      }
    } else if (wireType === 0) {
      i = readVarint(prefix, i).next;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      throw new Error(`未知 wire type ${wireType}`);
    }
  }
  throw new Error('BackupPrefix 里没找到 c15_iv.IV — 文件可能不是 crypt15');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('密钥必须是 64 位 hex（去掉空格后 64 个字符）');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function textEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * 用 DecompressionStream 解 zlib（=deflate with 2 字节 header）。
 *
 * 浏览器原生支持，不需要 pako 等额外依赖。
 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export interface DecryptResult {
  /** 明文 SQLite 文件字节 */
  sqlite: Uint8Array;
}

/**
 * 解密 .crypt15 → 明文 SQLite。失败时抛中文错误信息。
 *
 * @param file 整个 .crypt15 文件字节
 * @param hexKey 64 位 hex 密钥（可含空格）
 * @param onProgress 可选回调，给 UI 显示进度
 */
export async function decryptCrypt15(
  file: Uint8Array,
  hexKey: string,
  onProgress?: (stage: string) => void,
): Promise<DecryptResult> {
  onProgress?.('解析头部');
  if (file.length < 64) throw new Error('文件太短，不像 crypt15');

  const root = hexToBytes(hexKey);

  let off = 0;
  const protobufSize = file[off++]!;
  if (file[off] === 0x01) off++; // 可选 feature flag
  const prefix = file.subarray(off, off + protobufSize);
  off += protobufSize;

  const iv = extractIv(prefix);

  if (file.length - off < 32) throw new Error('文件结构异常：尾部不足 32 字节');
  const tagStart = file.length - 32;
  const tag = file.subarray(tagStart, file.length - 16);
  const ciphertext = file.subarray(off, tagStart);

  // GCM 需要密文 + tag 拼一起
  const ciphertextWithTag = concat(ciphertext, tag);

  onProgress?.('派生 AES key');
  const aesKey = await deriveAesKey(root);

  onProgress?.('AES-256-GCM 解密');
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
      aesKey,
      ciphertextWithTag as unknown as BufferSource,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `AES-GCM 解密失败 (${msg})。\n` +
        `最常见原因：64 位密钥写错了一位 — 回截图对一下，注意 0/o、1/l、b/d。\n` +
        `第二常见：WhatsApp 改了 crypt 版本（这工具只支持 crypt15）。`,
    );
  }

  onProgress?.('zlib 解压');
  let sqlite: Uint8Array;
  try {
    sqlite = await inflate(new Uint8Array(plaintext));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`zlib 解压失败：${msg}（GCM 通过了但内容不是 zlib）`);
  }

  const magic = new TextDecoder('ascii').decode(sqlite.subarray(0, 15));
  if (magic !== 'SQLite format 3') {
    throw new Error(`解压结果不是 SQLite 文件 (magic="${magic}")`);
  }

  return { sqlite };
}
