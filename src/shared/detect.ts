import type { MediaKind } from './types';

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|flv|ogv|3gp|avi|wmv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i;
const SEGMENT_EXT = /\.(ts|m4s|m4f|m4v?seg|cmfv|cmfa|aac?seg|vtt|webvtt|srt|key)$/i;
const SEGMENT_MIME = /^(video\/mp2t|video\/iso\.segment|audio\/iso\.segment|application\/octet-stream|text\/vtt)/i;
const HLS_MIME = /mpegurl/i;
const DASH_MIME = /dash\+xml/i;

/** Smallest direct media we bother to list (avoids beacons / sounds). */
export const MIN_DIRECT_SIZE = 256 * 1024;

export interface Detection {
  kind: MediaKind;
  mime?: string;
  size?: number;
}

export interface ResponseInfo {
  url: string;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  status?: number;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** Total size from "bytes 0-99/12345". */
export function totalFromRange(range?: string): number | undefined {
  const m = range && /\/(\d+)\s*$/.exec(range);
  return m ? Number(m[1]) : undefined;
}

/** Decide whether a network response is downloadable media. */
export function classify(r: ResponseInfo): Detection | null {
  if (!/^https?:/i.test(r.url)) return null;
  const path = pathOf(r.url);
  const ct = (r.contentType ?? '').split(';')[0].trim().toLowerCase();

  if (HLS_MIME.test(ct) || /\.m3u8?$/i.test(path)) return { kind: 'hls', mime: ct || undefined };
  if (DASH_MIME.test(ct) || /\.mpd$/i.test(path)) return { kind: 'dash', mime: ct || undefined };

  if (SEGMENT_EXT.test(path)) return null;
  const isMediaMime = /^(video|audio)\//.test(ct) && !SEGMENT_MIME.test(ct);
  const isMediaExt = VIDEO_EXT.test(path) || AUDIO_EXT.test(path);
  if (!isMediaMime && !(isMediaExt && (!ct || SEGMENT_MIME.test(ct)))) return null;

  const size = totalFromRange(r.contentRange) ?? r.contentLength;
  if (size != null && size < MIN_DIRECT_SIZE) return null;
  return { kind: 'direct', mime: ct || undefined, size };
}

/** Strip query params that only select a byte range, so range requests dedupe. */
export function mediaKey(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ['range', 'bytestart', 'byteend', 'rn', 'rbuf']) u.searchParams.delete(p);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function extFromUrl(url: string): string | undefined {
  const m = /\.([a-z0-9]{2,5})$/i.exec(pathOf(url));
  return m?.[1].toLowerCase();
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
};

export function extFor(url: string, mime?: string): string {
  const e = extFromUrl(url);
  if (e && (VIDEO_EXT.test('.' + e) || AUDIO_EXT.test('.' + e))) return e;
  return (mime && MIME_EXT[mime]) || 'mp4';
}

const EXT_MIME: Record<string, string> = {
  // First (canonical) type wins over later aliases such as application/ogg.
  ...Object.fromEntries(Object.entries(MIME_EXT).reverse().map(([m, e]) => [e, m])),
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  vtt: 'text/vtt',
};

/**
 * MIME type for a file extension. Blobs handed to chrome.downloads must carry it: an untyped blob is
 * sniffed as text/plain and Chrome then renames "clip.mp4" to "clip.txt".
 */
export const mimeForExt = (ext: string) => EXT_MIME[ext] ?? 'application/octet-stream';
