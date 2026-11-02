/** HLS (RFC 8216 + common extensions) playlist parser. Pure, no I/O. */

export interface ByteRange {
  offset: number;
  length: number;
}

export interface SegmentKey {
  method: string; // NONE | AES-128 | SAMPLE-AES | SAMPLE-AES-CTR ...
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
}

export interface Segment {
  url: string;
  duration: number;
  seq: number;
  byteRange?: ByteRange;
  key?: SegmentKey;
  /** Initialization section (EXT-X-MAP / DASH init). */
  /** `key` is set when an AES-128 key precedes the map, i.e. the init section is encrypted too. */
  map?: { url: string; byteRange?: ByteRange; key?: SegmentKey };
  discontinuity?: boolean;
}

export interface HlsVariant {
  url: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audio?: string;
  subtitles?: string;
}

export interface HlsRendition {
  type: string; // AUDIO | VIDEO | SUBTITLES | CLOSED-CAPTIONS
  groupId: string;
  name: string;
  language?: string;
  default: boolean;
  autoselect: boolean;
  uri?: string;
}

export interface HlsMaster {
  kind: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
  drm: boolean;
}

export interface HlsMedia {
  kind: 'media';
  segments: Segment[];
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  duration: number;
  drm: boolean;
  encrypted: boolean;
}

/** Parse `A=1,B="x,y",C=0x10` attribute lists. */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function parseByteRange(s: string, prevEnd: number): ByteRange {
  const [len, off] = s.split('@');
  return { length: Number(len), offset: off != null ? Number(off) : prevEnd };
}

function ivFromHex(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function ivFromSequence(seq: number): Uint8Array {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setBigUint64(8, BigInt(seq));
  return out;
}

/** A key format is "clear" (decryptable by us) only for identity AES-128. */
function isDrmKey(attrs: Record<string, string>): boolean {
  const method = attrs.METHOD ?? 'NONE';
  if (method === 'NONE') return false;
  const fmt = attrs.KEYFORMAT;
  if (fmt && fmt !== 'identity') return true;
  return method !== 'AES-128';
}

function resolve(uri: string, base: string): string {
  return new URL(uri, base).toString();
}

function substitute(line: string, vars: Map<string, string>): string {
  return vars.size ? line.replace(/\{\$([A-Za-z0-9_-]+)\}/g, (m, n) => vars.get(n) ?? m) : line;
}

export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF/.test(text);
}

export function parseHls(text: string, baseUrl: string): HlsMaster | HlsMedia {
  if (!/^﻿?#EXTM3U/.test(text.trimStart())) throw new Error('Not an M3U8 playlist');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vars = new Map<string, string>();
  const qp = new URL(baseUrl).searchParams;
  for (const l of lines) {
    if (!l.startsWith('#EXT-X-DEFINE:')) continue;
    const a = parseAttributes(l.slice(14));
    if (a.NAME != null && a.VALUE != null) vars.set(a.NAME, a.VALUE);
    if (a.QUERYPARAM != null && qp.has(a.QUERYPARAM)) vars.set(a.QUERYPARAM, qp.get(a.QUERYPARAM)!);
  }
  const L = lines.map((l) => substitute(l, vars));
  return isMasterPlaylist(text) ? parseMaster(L, baseUrl) : parseMedia(L, baseUrl);
}

function parseMaster(lines: string[], base: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  let drm = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(l.slice(18));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      const [w, h] = (a.RESOLUTION ?? '').split('x').map(Number);
      variants.push({
        url: resolve(lines[j], base),
        bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : undefined,
        averageBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : undefined,
        width: w || undefined,
        height: h || undefined,
        codecs: a.CODECS,
        frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : undefined,
        audio: a.AUDIO,
        subtitles: a.SUBTITLES,
      });
      i = j;
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(l.slice(13));
      renditions.push({
        type: a.TYPE,
        groupId: a['GROUP-ID'],
        name: a.NAME ?? a.LANGUAGE ?? '',
        language: a.LANGUAGE,
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        uri: a.URI ? resolve(a.URI, base) : undefined,
      });
    } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
      if (isDrmKey(parseAttributes(l.slice(19)))) drm = true;
    }
  }
  return { kind: 'master', variants, renditions, drm };
}

function parseMedia(lines: string[], base: string): HlsMedia {
  const segments: Segment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let drm = false;
  let encrypted = false;
  let key: SegmentKey | undefined;
  let map: Segment['map'];
  let pendingDuration = 0;
  let pendingRange: ByteRange | undefined;
  let pendingDisc = false;
  let lastRangeEnd = 0;
  let mapRangeEnd = 0;

  for (const l of lines) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(l.slice(22));
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(l.slice(22));
    else if (l === '#EXT-X-ENDLIST') endList = true;
    else if (l.startsWith('#EXTINF:')) pendingDuration = parseFloat(l.slice(8));
    else if (l === '#EXT-X-DISCONTINUITY') pendingDisc = true;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) pendingRange = parseByteRange(l.slice(17), lastRangeEnd);
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(l.slice(11));
      if (isDrmKey(a)) drm = true;
      if ((a.METHOD ?? 'NONE') === 'NONE') key = undefined;
      else {
        if (a.METHOD === 'AES-128') encrypted = true;
        key = {
          method: a.METHOD,
          uri: a.URI ? resolve(a.URI, base) : undefined,
          iv: a.IV ? ivFromHex(a.IV) : undefined,
          keyFormat: a.KEYFORMAT,
        };
      }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(l.slice(11));
      const br = a.BYTERANGE ? parseByteRange(a.BYTERANGE, mapRangeEnd) : undefined;
      if (br) mapRangeEnd = br.offset + br.length;
      map = {
        url: resolve(a.URI, base),
        byteRange: br,
        key: key?.method === 'AES-128' ? { ...key, iv: key.iv ?? ivFromSequence(mediaSequence + segments.length) } : undefined,
      };
    } else if (!l.startsWith('#')) {
      const url = resolve(l, base);
      const seq = mediaSequence + segments.length;
      segments.push({
        url,
        duration: pendingDuration,
        seq,
        byteRange: pendingRange,
        key: key && { ...key, iv: key.iv ?? ivFromSequence(seq) },
        map,
        discontinuity: pendingDisc || undefined,
      });
      if (pendingRange) lastRangeEnd = pendingRange.offset + pendingRange.length;
      pendingDuration = 0;
      pendingRange = undefined;
      pendingDisc = false;
    }
  }
  const duration = segments.reduce((s, x) => s + x.duration, 0);
  return { kind: 'media', segments, targetDuration, mediaSequence, endList, duration, drm, encrypted };
}
