/** MPEG-DASH MPD parser: turns every representation into a flat segment list. Needs DOMParser. */
import type { ByteRange, Segment } from './hls';

export type DashContent = 'video' | 'audio' | 'text';

export interface DashRep {
  id: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  contentType: DashContent;
  lang?: string;
  drm: boolean;
  segments: Segment[];
}

export interface DashPeriod {
  duration?: number;
  reps: DashRep[];
}

export interface DashManifest {
  live: boolean;
  duration?: number;
  drm: boolean;
  periods: DashPeriod[];
}

export function parseIsoDuration(s?: string | null): number | undefined {
  if (!s) return undefined;
  const m =
    /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
      s.trim(),
    );
  if (!m) return undefined;
  const [y, mo, w, d, h, mi, sec] = m.slice(1).map((x) => (x ? parseFloat(x) : 0));
  return ((((y * 365 + mo * 30 + w * 7 + d) * 24 + h) * 60 + mi) * 60) + sec;
}

const kids = (el: Element | null | undefined, name: string): Element[] =>
  el ? Array.from(el.children).filter((c) => c.localName === name) : [];
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0];
const num = (v: string | null | undefined) => (v != null && v !== '' ? Number(v) : undefined);

function parseRange(r?: string | null): ByteRange | undefined {
  if (!r) return undefined;
  const [a, b] = r.split('-').map(Number);
  return { offset: a, length: b - a + 1 };
}

export function fillTemplate(
  tpl: string,
  v: { RepresentationID: string; Number?: number; Bandwidth?: number; Time?: number },
): string {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)[dxX])?\$/g, (m, name, width) => {
    if (!name) return '$';
    const val = (v as Record<string, unknown>)[name];
    if (val == null) return m;
    const s = String(val);
    return width ? s.padStart(Number(width), '0') : s;
  });
}

function baseUrl(chain: (Element | undefined)[], manifestUrl: string): string {
  let url = manifestUrl;
  for (const el of chain) {
    const b = kid(el, 'BaseURL')?.textContent?.trim();
    if (b) url = new URL(b, url).toString();
  }
  return url;
}

/** Merge SegmentTemplate attributes from outer to inner level. */
function mergedTemplate(levels: (Element | undefined)[]) {
  const attrs: Record<string, string> = {};
  let timeline: Element | undefined;
  let found = false;
  for (const lvl of levels) {
    const t = kid(lvl, 'SegmentTemplate');
    if (!t) continue;
    found = true;
    for (const a of Array.from(t.attributes)) attrs[a.name] = a.value;
    timeline = kid(t, 'SegmentTimeline') ?? timeline;
  }
  return found ? { attrs, timeline } : undefined;
}

function templateSegments(
  tpl: { attrs: Record<string, string>; timeline?: Element },
  repId: string,
  bandwidth: number | undefined,
  base: string,
  periodDuration: number | undefined,
): Segment[] {
  const a = tpl.attrs;
  const timescale = num(a.timescale) ?? 1;
  const startNumber = num(a.startNumber) ?? 1;
  const pto = num(a.presentationTimeOffset) ?? 0;
  const vars = { RepresentationID: repId, Bandwidth: bandwidth };
  const init = a.initialization
    ? { url: new URL(fillTemplate(a.initialization, vars), base).toString() }
    : undefined;
  const out: Segment[] = [];
  const push = (n: number, time: number, d: number) =>
    out.push({
      url: new URL(fillTemplate(a.media, { ...vars, Number: n, Time: time }), base).toString(),
      duration: d / timescale,
      seq: n,
      map: init,
    });

  if (tpl.timeline) {
    let t = 0;
    let n = startNumber;
    const end = periodDuration != null ? pto + periodDuration * timescale : Infinity;
    for (const s of kids(tpl.timeline, 'S')) {
      t = num(s.getAttribute('t')) ?? t;
      const d = Number(s.getAttribute('d'));
      let r = num(s.getAttribute('r')) ?? 0;
      if (r < 0) r = isFinite(end) ? Math.ceil((end - t) / d) - 1 : 0;
      for (let i = 0; i <= r; i++, n++, t += d) push(n, t, d);
    }
  } else if (a.duration && periodDuration != null) {
    const d = Number(a.duration);
    const count = Math.ceil((periodDuration * timescale) / d - 1e-9);
    for (let i = 0; i < count; i++) push(startNumber + i, pto + i * d, d);
  }
  return out;
}

function listSegments(list: Element, base: string): Segment[] {
  const timescale = num(list.getAttribute('timescale')) ?? 1;
  const dur = (num(list.getAttribute('duration')) ?? 0) / timescale;
  const initEl = kid(list, 'Initialization');
  const init = initEl
    ? {
        url: new URL(initEl.getAttribute('sourceURL') ?? '', base).toString(),
        byteRange: parseRange(initEl.getAttribute('range')),
      }
    : undefined;
  return kids(list, 'SegmentURL').map((s, i) => ({
    url: new URL(s.getAttribute('media') ?? '', base).toString(),
    byteRange: parseRange(s.getAttribute('mediaRange')),
    duration: dur,
    seq: i,
    map: init,
  }));
}

function contentTypeOf(as: Element, rep: Element): DashContent | null {
  const mime = rep.getAttribute('mimeType') ?? as.getAttribute('mimeType') ?? '';
  const ct = as.getAttribute('contentType') ?? mime.split('/')[0];
  if (ct === 'video' || ct === 'audio') return ct;
  if (ct === 'text' || /vtt|ttml/.test(mime) || (ct === 'application' && /ttml|vtt/.test(mime))) return 'text';
  return null;
}

export function parseMpd(xml: string, manifestUrl: string): DashManifest {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Not a DASH manifest');
  const live = mpd.getAttribute('type') === 'dynamic';
  const total = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));
  const periodEls = kids(mpd, 'Period');
  let manifestDrm = false;

  const periods = periodEls.map((p, pi) => {
    const start = parseIsoDuration(p.getAttribute('start')) ?? 0;
    const nextStart = parseIsoDuration(periodEls[pi + 1]?.getAttribute('start'));
    const duration =
      parseIsoDuration(p.getAttribute('duration')) ??
      (nextStart != null ? nextStart - start : total != null ? total - start : undefined);
    const reps: DashRep[] = [];
    for (const as of kids(p, 'AdaptationSet')) {
      const asDrm = kids(as, 'ContentProtection').length > 0;
      for (const rep of kids(as, 'Representation')) {
        const type = contentTypeOf(as, rep);
        if (!type) continue;
        const id = rep.getAttribute('id') ?? String(reps.length);
        const bandwidth = num(rep.getAttribute('bandwidth'));
        const base = baseUrl([mpd, p, as, rep], manifestUrl);
        const tpl = mergedTemplate([p, as, rep]);
        const list = kid(rep, 'SegmentList') ?? kid(as, 'SegmentList') ?? kid(p, 'SegmentList');
        const segments = tpl
          ? templateSegments(tpl, id, bandwidth, base, duration)
          : list
            ? listSegments(list, base)
            : [{ url: base, duration: duration ?? 0, seq: 0 }];
        const drm = asDrm || kids(rep, 'ContentProtection').length > 0;
        manifestDrm ||= drm;
        reps.push({
          id,
          bandwidth,
          width: num(rep.getAttribute('width') ?? as.getAttribute('width')),
          height: num(rep.getAttribute('height') ?? as.getAttribute('height')),
          codecs: rep.getAttribute('codecs') ?? as.getAttribute('codecs') ?? undefined,
          mimeType: rep.getAttribute('mimeType') ?? as.getAttribute('mimeType') ?? undefined,
          contentType: type,
          lang: as.getAttribute('lang') ?? undefined,
          drm,
          segments,
        });
      }
    }
    return { duration, reps };
  });
  const duration = total ?? periods.reduce((s, p) => s + (p.duration ?? 0), 0);
  return { live, duration: duration || undefined, drm: manifestDrm, periods };
}

/**
 * Pick the representation matching `wanted` in every period and join segment lists.
 * Periods are matched by content type and closest height/bandwidth.
 */
export function joinPeriods(m: DashManifest, wanted: DashRep): Segment[] {
  const out: Segment[] = [];
  for (const p of m.periods) {
    const same = p.reps.find((r) => r.id === wanted.id && r.contentType === wanted.contentType);
    const cands = p.reps.filter((r) => r.contentType === wanted.contentType && (!wanted.lang || r.lang === wanted.lang));
    const pick =
      same ??
      cands.sort(
        (a, b) =>
          Math.abs((a.height ?? 0) - (wanted.height ?? 0)) - Math.abs((b.height ?? 0) - (wanted.height ?? 0)) ||
          Math.abs((a.bandwidth ?? 0) - (wanted.bandwidth ?? 0)) - Math.abs((b.bandwidth ?? 0) - (wanted.bandwidth ?? 0)),
      )[0];
    if (!pick) continue;
    out.push(...pick.segments.map((s, i) => ({ ...s, discontinuity: i === 0 && out.length > 0 ? true : undefined })));
  }
  return out;
}
