import type { MediaKind } from './types';

// Same container list as VDH 10 (minus plain .ts, handled below: usually an HLS segment).
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|qt|mkv|flv|f4v|ogv|ogm|3gp|3g2|avi|divx|wmv|asf|mpe?g|mpe|mpv|m2v|m2ts?|mts|vob|mxf|dv|rm|rmvb|h264|y4m)$/i;
const AUDIO_EXT = /\.(mp3|mp2|m4a|aac|ac3|dts|ogg|oga|opus|wav|aiff|au|snd|voc|flac|ape|wv|wma|amr|ra|mka|weba)$/i;
/** A .ts this large is a whole recording, not an HLS segment. */
const WHOLE_TS_SIZE = 20 << 20;
const OTHER_MEDIA_MIME = /^application\/(vnd\.rn-realmedia|x-matroska|ogg|mxf)/i;
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

  const size0 = totalFromRange(r.contentRange) ?? r.contentLength;
  if (/\.ts$/i.test(path) && size0 != null && size0 >= WHOLE_TS_SIZE) return { kind: 'direct', mime: ct || 'video/mp2t', size: size0 };
  if (SEGMENT_EXT.test(path)) return null;
  const isMediaMime = (/^(video|audio)\//.test(ct) && !SEGMENT_MIME.test(ct)) || OTHER_MEDIA_MIME.test(ct);
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
  'audio/x-flac': 'flac',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/x-ms-wma': 'wma',
  'audio/amr': 'amr',
  'audio/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/x-ms-asf': 'asf',
  'video/mpeg': 'mpg',
  'video/mp2t': 'ts',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/x-m4v': 'm4v',
  'application/x-matroska': 'mkv',
  'application/vnd.rn-realmedia': 'rm',
  'application/ogg': 'ogg',
};

export function extFor(url: string, mime?: string): string {
  const e = extFromUrl(url);
  if (e && (VIDEO_EXT.test('.' + e) || AUDIO_EXT.test('.' + e))) return e;
  return (mime && MIME_EXT[mime]) || 'mp4';
}
