/** Stream analysis and download pipeline. Runs in the offscreen document (Chrome) or background page (Firefox). */
import { parseHls, type HlsMaster, type HlsMedia, type HlsRendition, type Segment } from '../shared/hls';
import { joinPeriods, parseMpd, type DashRep } from '../shared/dash';
import { pickByLang, pickVariant } from '../shared/quality';
import type { Job, MediaItem, Progress, Variant } from '../shared/types';
import type { Settings } from '../shared/settings';
import { sleep } from '../shared/util';
import { decryptSegment, fetchBytes, fetchText, HttpError } from './net';
import { extFor, totalFromRange } from '../shared/detect';
import { createSpool, sniffExt, type Spool } from './spool';
import { remux } from './mux';
import { convertToMp3 } from './mp3';

export type EngineSettings = Pick<
  Settings,
  'preferredQuality' | 'audioLangs' | 'subtitleLangs' | 'downloadSubtitles' | 'preferMkv' | 'audioFormat' | 'preferOriginalAudio'
>;

export interface Control {
  signal: AbortSignal;
  /** Live recording: true once the user pressed "stop" (finalize what we have). */
  stopped: () => boolean;
  onProgress: (p: Progress) => void;
  /** Called with every host we are about to fetch from, so Referer/Origin rules can be installed. */
  prepare?: (hosts: string[]) => Promise<void>;
  /** Preview mode: only fetch about this many seconds from the start (live: from the edge). */
  previewSeconds?: number;
}

export class DrmError extends Error {
  constructor() {
    super('This media is DRM protected and cannot be downloaded.');
  }
}

const CONCURRENCY = 6;

// ---------------------------------------------------------------- analysis

const label = (h?: number, bw?: number) =>
  h ? `${h}p` : bw ? `${Math.round(bw / 1000)} kbps` : 'default';

function hlsVariants(m: HlsMaster): Variant[] {
  const seen = new Set<string>();
  return m.variants
    .filter((v) => !seen.has(v.url) && seen.add(v.url))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
    .map((v) => ({
      id: v.url,
      ref: v.url,
      label: label(v.height, v.bandwidth),
      height: v.height,
      width: v.width,
      bandwidth: v.bandwidth,
      codecs: v.codecs,
    }));
}

const langsOf = (rs: { language?: string; lang?: string }[]) =>
  [...new Set(rs.map((r) => r.language ?? r.lang).filter((l): l is string => !!l))];

export async function analyze(media: MediaItem, signal?: AbortSignal): Promise<Partial<MediaItem>> {
  if (media.kind === 'hls') {
    const { text, url } = await fetchText(media.url, signal);
    const pl = parseHls(text, url);
    if (pl.kind === 'master') {
      const out: Partial<MediaItem> = {
        variants: hlsVariants(pl),
        drm: pl.drm,
        children: [...pl.variants.map((v) => v.url), ...pl.renditions.flatMap((r) => (r.uri ? [r.uri] : []))],
        audioLangs: langsOf(pl.renditions.filter((r) => r.type === 'AUDIO')),
        subtitleLangs: langsOf(pl.renditions.filter((r) => r.type === 'SUBTITLES')),
      };
      // Only follow same-origin variants automatically: a page-supplied playlist must not make us
      // fetch arbitrary (e.g. intranet) URLs with the user's cookies without a click.
      if (pl.variants[0] && new URL(pl.variants[0].url).origin === new URL(url).origin) {
        const sub = await fetchText(pl.variants[0].url, signal).catch(() => null);
        const mp = sub && parseHls(sub.text, sub.url);
        if (mp?.kind === 'media') {
          out.duration = mp.duration;
          out.live = !mp.endList;
          out.drm ||= mp.drm;
          out.encrypted = mp.encrypted;
        }
      }
      return out;
    }
    return { duration: pl.duration, live: !pl.endList, drm: pl.drm, encrypted: pl.encrypted };
  }
  if (media.kind === 'dash') {
    const { text, url } = media.manifest ? { text: media.manifest, url: media.pageUrl || 'https://localhost/' } : await fetchText(media.url, signal);
    const m = parseMpd(text, url);
    const period = m.periods.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a), m.periods[0]);
    const videos = (period?.reps ?? []).filter((r) => r.contentType === 'video');
    return {
      duration: m.duration,
      live: m.live,
      drm: m.drm,
      variants: videos
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
        .map((r) => ({
          id: r.id,
          ref: r.id,
          label: label(r.height, r.bandwidth),
          height: r.height,
          width: r.width,
          bandwidth: r.bandwidth,
          codecs: r.codecs,
        })),
      audioLangs: langsOf(period?.reps.filter((r) => r.contentType === 'audio') ?? []),
      subtitleLangs: langsOf(period?.reps.filter((r) => r.contentType === 'text') ?? []),
    };
  }
  return {};
}

// ---------------------------------------------------------------- planning

/** Move original-language tracks first (HLS NAME "Original", DASH Role main) and drop audio description. */
function preferOriginal<T extends { name?: string; role?: string; default?: boolean }>(items: T[], s: EngineSettings): T[] {
  if (!s.preferOriginalAudio) return items;
  const score = (t: T) =>
    (/original|orig/i.test(t.name ?? '') || t.role === 'main' ? 2 : 0) + (t.default ? 1 : 0) - (/descri|commentary/i.test(`${t.name} ${t.role}`) ? 4 : 0);
  return [...items].sort((a, b) => score(b) - score(a)).map((t, i, arr) => (i === 0 && !arr.some((x) => x.default) ? { ...t, default: true } : t));
}

/** One refresh of a live manifest. */
interface LivePoll {
  segments: Segment[];
  ended: boolean;
  /** Seconds until the next refresh. */
  wait: number;
}

interface Track {
  name: 'video' | 'audio' | 'subs';
  /** Static segment list (VOD). */
  segments?: Segment[];
  /** Whole-file download. */
  url?: string;
  /** Live stream: manifest URL and how to poll it. */
  liveUrl?: string;
  poll?: (signal: AbortSignal) => Promise<LivePoll>;
  /** Live DASH starts at the live edge (last N segments) instead of the whole time-shift window. */
  startWindow?: number;
  lang?: string;
}

const hlsPoller = (url: string) => async (signal: AbortSignal): Promise<LivePoll> => {
  const m = await loadMedia(url, signal);
  if (m.drm) throw new DrmError();
  return { segments: m.segments, ended: m.endList, wait: Math.max(1, (m.targetDuration || 4) / 2) };
};

async function loadMedia(url: string, signal: AbortSignal): Promise<HlsMedia & { url: string }> {
  const r = await fetchText(url, signal);
  const pl = parseHls(r.text, r.url);
  if (pl.kind !== 'media') throw new Error('Expected a media playlist');
  return { ...pl, url: r.url };
}

async function planHls(job: Job, s: EngineSettings, signal: AbortSignal): Promise<Track[]> {
  const r = await fetchText(job.media.url, signal);
  const pl = parseHls(r.text, r.url);
  const audioOnly = !!job.options.audioOnly;
  let videoUrl: string | null = r.url;
  let audioRendition: HlsRendition | undefined;
  let subRendition: HlsRendition | undefined;

  if (pl.kind === 'master') {
    if (pl.drm) throw new DrmError();
    const variants = pl.variants;
    if (!variants.length) throw new Error('Master playlist has no variants');
    let v = variants.find((x) => x.url === job.options.variantId);
    if (!v && audioOnly) {
      // Prefer an audio-only variant, else the cheapest one (audio is usually identical across variants).
      v =
        variants.find((x) => x.codecs && !/avc|hvc|hev|av01|vp0?9|vp8/.test(x.codecs) && !x.height) ??
        [...variants].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0];
    }
    v ??= pickVariant(variants, s.preferredQuality)!;
    videoUrl = v.url;
    if (v.audio) {
      // A chosen rendition without URI means its audio is muxed into the variant itself.
      const group = pl.renditions.filter((x) => x.type === 'AUDIO' && x.groupId === v!.audio);
      audioRendition = pickByLang(preferOriginal(group, s), s.audioLangs);
    }
    if (s.downloadSubtitles && v.subtitles) {
      const group = pl.renditions.filter((x) => x.type === 'SUBTITLES' && x.groupId === v!.subtitles && x.uri);
      subRendition = s.subtitleLangs.length ? pickByLang(group, s.subtitleLangs) : group.find((g) => g.default) ?? group[0];
    }
  }

  const tracks: Track[] = [];
  const add = async (name: Track['name'], url: string, lang?: string) => {
    const m = await loadMedia(url, signal);
    if (m.drm) throw new DrmError();
    tracks.push(m.endList ? { name, segments: m.segments, lang } : { name, liveUrl: m.url, poll: hlsPoller(m.url), lang });
  };
  if (audioOnly && audioRendition?.uri) videoUrl = null;
  if (videoUrl) await add('video', videoUrl);
  if (audioRendition?.uri) await add('audio', audioRendition.uri, audioRendition.language);
  if (subRendition?.uri && !audioOnly) await add('subs', subRendition.uri, subRendition.language);
  return tracks;
}

async function planDash(job: Job, s: EngineSettings, signal: AbortSignal): Promise<Track[]> {
  const r = job.media.manifest ? { text: job.media.manifest, url: job.media.pageUrl || 'https://localhost/' } : await fetchText(job.media.url, signal);
  const m = parseMpd(r.text, r.url);
  // Live: choose from the current period only; the manifest is re-polled while recording.
  const reps = m.live ? (m.periods.at(-1)?.reps ?? []) : m.periods.flatMap((p) => p.reps);
  const pick = (type: DashRep['contentType']) => reps.filter((x) => x.contentType === type);
  const audioOnly = !!job.options.audioOnly;
  const tracks: Track[] = [];
  // A representation that is one plain file (BaseURL only) is streamed to disk like a direct download; as a single
  // "segment" it would sit in memory whole and report no progress until it is complete.
  const vod = (name: Track['name'], rep: DashRep, lang?: string): Track => {
    const segs = joinPeriods(m, rep);
    return segs.length === 1 && !segs[0].byteRange && !segs[0].map ? { name, url: segs[0].url, lang } : { name, segments: segs, lang };
  };

  const videos = pick('video');
  if (!audioOnly && videos.length) {
    const v = videos.find((x) => x.id === job.options.variantId) ?? pickVariant(videos, s.preferredQuality)!;
    if (v.drm) throw new DrmError();
    tracks.push(m.live ? dashLive(r.url, v, 'video') : vod('video', v));
  }
  const audios = pick('audio');
  if (audios.length) {
    const lang = pickByLang(preferOriginal(audios, s), s.audioLangs)?.lang;
    const best = audios
      .filter((a) => a.lang === lang)
      .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (best.drm) throw new DrmError();
    tracks.push(m.live ? { ...dashLive(r.url, best, 'audio'), lang } : vod('audio', best, lang));
  }
  const texts = pick('text');
  if (s.downloadSubtitles && texts.length && !audioOnly && !m.live) {
    const t = s.subtitleLangs.length ? pickByLang(texts, s.subtitleLangs)! : texts[0];
    tracks.push(vod('subs', t, t.lang));
  }
  if (!tracks.length) throw new Error('No downloadable representation found');
  return tracks;
}

function dashLive(url: string, wanted: DashRep, name: Track['name']): Track {
  return {
    name,
    liveUrl: url,
    startWindow: 3,
    poll: async (signal) => {
      const r = await fetchText(url, signal);
      const m = parseMpd(r.text, r.url);
      const reps = (m.periods.at(-1)?.reps ?? []).filter((x) => x.contentType === wanted.contentType);
      const rep =
        reps.find((x) => x.id === wanted.id) ??
        reps.sort((a, b) => Math.abs((a.bandwidth ?? 0) - (wanted.bandwidth ?? 0)) - Math.abs((b.bandwidth ?? 0) - (wanted.bandwidth ?? 0)))[0];
      if (rep?.drm) throw new DrmError();
      const segs = rep?.segments ?? [];
      const segDur = segs.at(-1)?.duration || 2;
      return { segments: segs, ended: !m.live, wait: Math.max(1, Math.min(m.minimumUpdatePeriod ?? segDur, segDur)) };
    },
  };
}

// ---------------------------------------------------------------- downloading

interface Counter {
  /** Known total bytes (direct/site files). */
  total?: number;
  bytes: number;
  segments: number;
  segmentsTotal: number;
  recorded: number;
}

function rangeKey(m: Segment['map']) {
  return m ? `${m.url}#${m.byteRange?.offset ?? ''}-${m.byteRange?.length ?? ''}` : '';
}

async function fetchSegment(seg: Segment, signal: AbortSignal): Promise<Uint8Array> {
  const data = await fetchBytes(seg.url, { range: seg.byteRange, signal });
  return seg.key && seg.key.method !== 'NONE' ? decryptSegment(data, seg.key, signal) : data;
}

/** Download segments in parallel while appending strictly in order. */
async function downloadSegments(
  segments: Segment[],
  spool: Spool,
  ctl: Control,
  c: Counter,
  report: () => void,
  state: { mapKey: string },
  isVideo: boolean,
): Promise<void> {
  const inflight = new Map<number, Promise<Uint8Array>>();
  const start = (i: number) => {
    const p = fetchSegment(segments[i], ctl.signal);
    p.catch(() => {}); // awaited below, avoid unhandled-rejection noise
    inflight.set(i, p);
  };
  for (let i = 0; i < Math.min(CONCURRENCY, segments.length); i++) start(i);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const key = rangeKey(seg.map);
    if (key && key !== state.mapKey) {
      let init = await fetchBytes(seg.map!.url, { range: seg.map!.byteRange, signal: ctl.signal });
      if (seg.map!.key) init = await decryptSegment(init, seg.map!.key, ctl.signal);
      await spool.append(init);
      state.mapKey = key;
    }
    const data = await inflight.get(i)!;
    inflight.delete(i);
    if (i + CONCURRENCY < segments.length) start(i + CONCURRENCY);
    await spool.append(data);
    c.bytes += data.byteLength;
    c.segments++;
    if (isVideo) c.recorded += seg.duration;
    report();
  }
}

/** A live stream that lists nothing new for this long has ended without saying so: save what was recorded. */
const LIVE_IDLE_MS = 120_000;

async function recordLive(t: Track, spool: Spool, ctl: Control, c: Counter, report: () => void, isVideo: boolean) {
  const seen = new Set<string>();
  const segKey = (x: Segment) => `${x.url}#${x.byteRange?.offset ?? ''}`;
  const state = { mapKey: '' };
  const hosts = new Set<string>();
  let first = true;
  let lastFresh = Date.now();
  while (!ctl.stopped()) {
    let poll: LivePoll;
    report(); // still alive while the stream pauses: the background fails jobs that go silent
    try {
      poll = await t.poll!(ctl.signal);
      let fresh = poll.segments.filter((x) => !seen.has(segKey(x)));
      if (first && t.startWindow) {
        fresh.slice(0, -t.startWindow).forEach((x) => seen.add(segKey(x)));
        fresh = fresh.slice(-t.startWindow);
      }
      first = false;
      if (!fresh.length && Date.now() - lastFresh > LIVE_IDLE_MS) break;
      if (fresh.length) {
        lastFresh = Date.now();
        // Segments may move to new CDN hosts mid-stream; they need the Referer rule too.
        const added = fresh
          .flatMap((x) => [x.url, x.map?.url, x.key?.uri])
          .filter((u): u is string => !!u)
          .map((u) => new URL(u).hostname)
          .filter((h) => !hosts.has(h) && hosts.add(h));
        if (added.length) await ctl.prepare?.([...hosts]);
        c.segmentsTotal += fresh.length;
        await downloadSegments(fresh, spool, ctl, c, report, state, isVideo);
        fresh.forEach((x) => seen.add(segKey(x)));
      }
    } catch (e) {
      // Don't throw away a recording because the stream ended or a segment expired: finalize what we have.
      if (ctl.signal.aborted || e instanceof DrmError || spool.size === 0) throw e;
      console.warn('[ReelFetch] live recording ended early', e);
      break;
    }
    if (poll.ended) break;
    const wait = poll.wait * 1000;
    for (let w = 0; w < wait && !ctl.stopped(); w += 250) {
      ctl.signal.throwIfAborted();
      await sleep(250);
    }
  }
}

const CHUNK = 8 << 20;
/** CDNs that throttle whole-file requests and must be fetched in ranges (YouTube). */
const RANGE_ONLY = /(^|\.)googlevideo\.com$/;

/**
 * Download a whole file. Like the browser: one streaming request, resumed with a Range request only if the
 * connection drops. Many hosts sign file URLs with an expiry or a request limit (HTTP 410/403 later), and a
 * request per chunk also pays a round trip each time, so chunking is reserved for RANGE_ONLY CDNs.
 */
async function downloadDirect(url: string, spool: Spool, ctl: Control, c: Counter, report: () => void) {
  if (RANGE_ONLY.test(new URL(url).hostname)) return downloadRanges(url, spool, ctl, c, report);
  let total: number | undefined;
  for (let attempt = 0; ; attempt++) {
    const pos = spool.size;
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctl.signal, headers: pos ? { Range: `bytes=${pos}-` } : {} });
      // Server ignored the Range request: not retryable (HttpError 200), but say why instead of "HTTP 200".
      if (pos && res.status === 200)
        throw Object.assign(new HttpError(200, url), { message: 'The connection dropped and this server cannot resume downloads - retry the download' });
      if (!res.ok || !res.body || (pos && res.status !== 206)) throw new HttpError(res.status, url);
      if (total == null) {
        const len = Number(res.headers.get('content-length'));
        total = pos ? totalFromRange(res.headers.get('content-range') ?? undefined) : len > 0 ? len : undefined;
        if (total != null) c.total = (c.total ?? 0) + total;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await spool.append(value);
        c.bytes += value.byteLength;
        report();
      }
      if (total == null || spool.size >= total) return;
      throw new Error('Connection closed early'); // resume below
    } catch (e) {
      if (ctl.signal.aborted) throw e;
      // Resume only what makes sense: dropped connections and transient server errors.
      if (e instanceof HttpError && !(e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500)) throw e;
      if (attempt >= 5) throw e;
      await sleep(Math.min(8000, 400 * 2 ** attempt));
    }
  }
}

/** Sequential 8 MB range requests (resumable per chunk) for CDNs that throttle plain requests. */
async function downloadRanges(url: string, spool: Spool, ctl: Control, c: Counter, report: () => void) {
  const res = await fetch(url, { credentials: 'include', signal: ctl.signal, headers: { Range: `bytes=0-${CHUNK - 1}` } });
  if (!res.ok || !res.body) throw new HttpError(res.status, url);
  const total = res.status === 206 ? totalFromRange(res.headers.get('content-range') ?? undefined) : undefined;
  if (total != null) c.total = (c.total ?? 0) + total;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await spool.append(value);
    c.bytes += value.byteLength;
    report();
  }
  if (total == null) return;
  for (let pos = spool.size; pos < total; pos = spool.size) {
    const data = await fetchBytes(url, { range: { offset: pos, length: Math.min(CHUNK, total - pos) }, signal: ctl.signal });
    if (!data.byteLength) throw new Error('Server returned an empty range');
    await spool.append(data);
    c.bytes += data.byteLength;
    report();
  }
}

async function truncateForPreview(tracks: Track[], seconds: number, signal: AbortSignal): Promise<Track[]> {
  const out: Track[] = [];
  for (const t of tracks) {
    if (t.name === 'subs' || t.url) continue; // whole files are previewed by the UI directly
    const segs = t.poll ? (await t.poll(signal)).segments.slice(-2) : (t.segments ?? []);
    const take: Segment[] = [];
    for (const seg of segs) {
      take.push(seg);
      if (take.reduce((n, x) => n + x.duration, 0) >= seconds || take.length >= 6) break;
    }
    out.push({ name: t.name, segments: take, lang: t.lang });
  }
  if (!out.length) throw new Error('No preview available');
  return out;
}

function joinVtt(text: string): string {
  // Segmented WebVTT repeats the header in every segment; keep only the first.
  const parts = text.split(/(?=^WEBVTT)/m);
  return parts
    .map((p, i) => (i === 0 ? p : p.replace(/^WEBVTT[^\n]*\n(?:[^\n]+\n)*\n?/, '')))
    .join('\n');
}

export interface Delivered {
  files: { blob: Blob; ext: string; suffix?: string }[];
  size: number;
  spools: Spool[];
}

export async function download(job: Job, s: EngineSettings, ctl: Control): Promise<Delivered> {
  const c: Counter = { bytes: 0, segments: 0, segmentsTotal: 0, recorded: 0 };
  let last = 0;
  let phase: Progress['phase'] = 'download';
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - last < 400) return;
    last = now;
    ctl.onProgress({
      bytes: c.bytes,
      total: c.total ?? (job.media.kind === 'direct' ? job.media.size : undefined),
      segments: c.segments,
      segmentsTotal: c.segmentsTotal || undefined,
      recorded: c.recorded || undefined,
      phase,
    });
  };

  const spools: Spool[] = [];
  const run = Math.random().toString(36).slice(2, 8); // retries of one job must not share temp files
  const temp = async (n: string) => {
    const sp = await createSpool(`${job.id}-${run}-${n}`);
    spools.push(sp);
    return sp;
  };

  try {
    let tracks: Track[];
    let asIs: string | undefined; // extension of a single plain file that is saved unchanged
    if (job.media.kind === 'hls') tracks = await planHls(job, s, ctl.signal);
    else if (job.media.kind === 'dash') tracks = await planDash(job, s, ctl.signal);
    else {
      // Plain file, or a site variant with separate video + audio files (YouTube/Bilibili style).
      const v = job.media.variants?.find((x) => x.id === job.options.variantId) ?? job.media.variants?.[0];
      const videoUrl = v?.ref ?? job.media.url;
      tracks =
        job.options.audioOnly && v?.audioRef
          ? [{ name: 'audio', url: v.audioRef }]
          : [{ name: 'video', url: videoUrl }, ...(v?.audioRef ? [{ name: 'audio' as const, url: v.audioRef }] : [])];
      if (!v?.audioRef && !job.options.audioOnly) asIs = extFor(videoUrl, v?.mime ?? job.media.mime);
    }

    if (ctl.previewSeconds) tracks = await truncateForPreview(tracks, ctl.previewSeconds, ctl.signal);

    const hosts = new Set<string>();
    const addHost = (u?: string) => {
      if (u) hosts.add(new URL(u).hostname);
    };
    if (!job.media.manifest) addHost(job.media.url);
    for (const t of tracks) {
      addHost(t.url);
      addHost(t.liveUrl);
      for (const seg of t.segments ?? []) {
        addHost(seg.url);
        addHost(seg.map?.url);
        addHost(seg.key?.uri);
      }
    }
    await ctl.prepare?.([...hosts]);

    const raw = new Map<Track, Spool>();
    if (tracks.some((t) => t.poll)) phase = 'recording';
    c.segmentsTotal = tracks.reduce((n, t) => n + (t.segments?.length ?? 0), 0);
    report(true);

    await Promise.all(
      tracks.map(async (t) => {
        const sp = await temp(t.name);
        raw.set(t, sp);
        const isVideo = t.name === 'video' || !tracks.some((x) => x.name === 'video');
        if (t.url) await downloadDirect(t.url, sp, ctl, c, report);
        else if (t.poll) await recordLive(t, sp, ctl, c, report, isVideo);
        else await downloadSegments(t.segments!, sp, ctl, c, report, { mapKey: '' }, isVideo);
      }),
    );

    if (asIs) {
      // Plain file: byte-identical to the server's file, any format (no remux).
      const blob = await raw.get(tracks[0])!.file();
      if (!blob.size) throw new Error('Downloaded no data');
      phase = 'save';
      report(true);
      return { files: [{ blob, ext: asIs }], size: blob.size, spools };
    }

    phase = 'mux';
    report(true);
    const files: Delivered['files'] = [];
    const avTracks = tracks.filter((t) => t.name !== 'subs');
    const blobs = await Promise.all(avTracks.map((t) => raw.get(t)!.file()));
    if (!blobs.some((b) => b.size)) throw new Error('Downloaded no data');

    const out = await temp('out');
    let muxed = false;
    try {
      const r = await remux(
        blobs,
        {
          audioOnly: job.options.audioOnly,
          preferMkv: s.preferMkv,
          signal: ctl.signal,
          onProgress: () => report(),
        },
        out.sink(),
      );
      files.push({ blob: await out.file(), ext: r.ext });
      muxed = true;
    } catch (e) {
      await out.remove();
      if (ctl.signal.aborted) throw e;
      console.warn('[ReelFetch] remux failed, delivering raw tracks', e);
    }
    if (muxed && job.options.audioOnly && s.audioFormat === 'mp3' && files[0].ext !== 'mp3') {
      // Transcode (replaces the companion-app conversion of the original). Errors fail the job:
      // silently handing over a non-MP3 file would hide the problem.
      phase = 'convert';
      report(true);
      const mp3 = await temp('mp3');
      try {
        await convertToMp3(files[0].blob, mp3.sink(), ctl.signal);
      } catch (e) {
        throw new Error(`MP3 conversion failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      files[0] = { blob: await mp3.file(), ext: 'mp3' };
      out.size = mp3.size;
    }
    if (!muxed) {
      // Fallback: hand over the raw streams (e.g. a .ts file) which every player can open.
      for (const [i, b] of blobs.entries()) {
        if (!b.size) continue;
        const ext = sniffExt(new Uint8Array(await b.slice(0, 200).arrayBuffer()));
        files.push({ blob: b, ext, suffix: blobs.length > 1 ? `.${avTracks[i].name}` : undefined });
      }
    }

    const subs = tracks.find((t) => t.name === 'subs');
    if (subs) {
      const b = await raw.get(subs)!.file();
      const vtt = joinVtt(await b.text());
      files.push({
        blob: new Blob([vtt], { type: 'text/vtt' }),
        ext: 'vtt',
        suffix: subs.lang ? `.${subs.lang}` : undefined,
      });
    }
    phase = 'save';
    report(true);
    return { files, size: muxed ? out.size : blobs.reduce((n, b) => n + b.size, 0), spools };
  } catch (e) {
    await Promise.all(spools.map((sp) => sp.remove()));
    throw e;
  }
}
