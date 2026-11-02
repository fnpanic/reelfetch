import type { ByteRange, SegmentKey } from '../shared/hls';
import { sleep } from '../shared/util';

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url.slice(0, 120)}`);
  }
}

const RETRYABLE = (s: number) => s === 408 || s === 425 || s === 429 || s >= 500;

/** Fetch with cookies, optional byte range and exponential-backoff retries. */
export async function fetchBytes(
  url: string,
  opts: { range?: ByteRange; signal?: AbortSignal; retries?: number } = {},
): Promise<Uint8Array> {
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      const headers: HeadersInit = opts.range
        ? { Range: `bytes=${opts.range.offset}-${opts.range.offset + opts.range.length - 1}` }
        : {};
      const res = await fetch(url, { headers, credentials: 'include', signal: opts.signal });
      if (!res.ok) throw new HttpError(res.status, url);
      const buf = new Uint8Array(await res.arrayBuffer());
      // Server ignored the Range header and sent the whole resource.
      if (opts.range && res.status === 200 && buf.byteLength > opts.range.length)
        return buf.subarray(opts.range.offset, opts.range.offset + opts.range.length);
      return buf;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (e instanceof HttpError && !RETRYABLE(e.status)) throw e;
      if (attempt >= retries) throw e;
      await sleep(Math.min(8000, 400 * 2 ** attempt));
    }
  }
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; url: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { credentials: 'include', signal });
      if (!res.ok) throw new HttpError(res.status, url);
      // res.url follows redirects so relative segment URIs resolve correctly.
      return { text: await res.text(), url: res.url || url };
    } catch (e) {
      if (signal?.aborted || attempt >= 3 || (e instanceof HttpError && !RETRYABLE(e.status))) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function getKey(uri: string, signal?: AbortSignal): Promise<CryptoKey> {
  let k = keyCache.get(uri);
  if (!k) {
    k = fetchBytes(uri, { signal }).then((raw) => {
      if (raw.byteLength !== 16) throw new Error(`AES key must be 16 bytes, got ${raw.byteLength}`);
      return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-CBC', false, ['decrypt']);
    });
    k.catch(() => keyCache.delete(uri));
    keyCache.set(uri, k);
  }
  return k;
}

/** Decrypt an HLS AES-128 (CBC, PKCS7) segment. */
export async function decryptSegment(data: Uint8Array, key: SegmentKey, signal?: AbortSignal): Promise<Uint8Array> {
  if (key.method !== 'AES-128' || !key.uri) throw new Error(`Unsupported encryption ${key.method}`);
  const ck = await getKey(key.uri, signal);
  const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: key.iv as BufferSource }, ck, data as BufferSource);
  return new Uint8Array(out);
}
