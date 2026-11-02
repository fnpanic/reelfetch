/** Stream analysis and download pipeline. Runs in the offscreen document (Chrome) or background page (Firefox). */
import { parseHls, type HlsMaster, type HlsMedia, type HlsRendition, type Segment } from '../shared/hls';
import { joinPeriods, parseMpd, type DashRep } from '../shared/dash';
import { pickByLang, pickVariant } from '../shared/quality';
import type { Job, MediaItem, Progress, Variant } from '../shared/types';
import type { Settings } from '../shared/settings';
import { sleep } from '../shared/util';
import { decryptSegment, fetchBytes, fetchText } from './net';
import { createSpool, sniffExt, type Spool } from './spool';
import { remux } from './mux';

export type EngineSettings = Pick<
  Settings,
  'preferredQuality' | 'audioLangs' | 'subtitleLangs' | 'downloadSubtitles' | 'preferMkv'
>;

export interface Control {
  signal: AbortSignal;
  /** Live recording: true once the user pressed "stop" (finalize what we have). */
  stopped: () => boolean;
  onProgress: (p: Progress) => void;
  /** Called with every host we are about to fetch from, so Referer/Origin rules can be installed. */
  prepare?: (hosts: string[]) => Promise<void>;
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
    const { text, url } = await fetchText(media.url, signal);
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

interface Track {
  name: 'video' | 'audio' | 'subs';
  /** Static segment list (VOD). */
  segments?: Segment[];
  /** Live HLS media playlist to poll. */
  liveUrl?: string;
  lang?: string;
}

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
      audioRendition = pickByLang(group, s.audioLangs);
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
    tracks.push(m.endList ? { name, segments: m.segments, lang } : { name, liveUrl: m.url, lang });
  };
  if (audioOnly && audioRendition?.uri) videoUrl = null;
  if (videoUrl) await add('video', videoUrl);
  if (audioRendition?.uri) await add('audio', audioRendition.uri, audioRendition.language);
  if (subRendition?.uri && !audioOnly) await add('subs', subRendition.uri, subRendition.language);
  return tracks;
}

async function planDash(job: Job, s: EngineSettings, signal: AbortSignal): Promise<Track[]> {
  const r = await fetchText(job.media.url, signal);
  const m = parseMpd(r.text, r.url);
  if (m.live) throw new Error('Live DASH streams are not supported yet - try MSE capture instead.');
  const reps = m.periods.flatMap((p) => p.reps);
  const pick = (type: DashRep['contentType']) => reps.filter((x) => x.contentType === type);
  const audioOnly = !!job.options.audioOnly;
  const tracks: Track[] = [];

  const videos = pick('video');
  if (!audioOnly && videos.length) {
    const v = videos.find((x) => x.id === job.options.variantId) ?? pickVariant(videos, s.preferredQuality)!;
    if (v.drm) throw new DrmError();
    tracks.push({ name: 'video', segments: joinPeriods(m, v) });
  }
  const audios = pick('audio');
  if (audios.length) {
    const lang = pickByLang(audios, s.audioLangs)?.lang;
    const best = audios
      .filter((a) => a.lang === lang)
      .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (best.drm) throw new DrmError();
    tracks.push({ name: 'audio', segments: joinPeriods(m, best), lang });
  }
  const texts = pick('text');
  if (s.downloadSubtitles && texts.length && !audioOnly) {
    const t = s.subtitleLangs.length ? pickByLang(texts, s.subtitleLangs)! : texts[0];
    tracks.push({ name: 'subs', segments: joinPeriods(m, t), lang: t.lang });
  }
  if (!tracks.length) throw new Error('No downloadable representation found');
  return tracks;
}

// ---------------------------------------------------------------- downloading

interface Counter {
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

async function recordLive(url: string, spool: Spool, ctl: Control, c: Counter, report: () => void, isVideo: boolean) {
  let lastSeq = -1;
  const state = { mapKey: '' };
  const hosts = new Set<string>();
  while (!ctl.stopped()) {
    let m: Awaited<ReturnType<typeof loadMedia>>;
    try {
      m = await loadMedia(url, ctl.signal);
      if (m.drm) throw new DrmError();
      const fresh = m.segments.filter((s) => s.seq > lastSeq);
      if (fresh.length) {
        // Segments may move to new CDN hosts mid-stream; they need the Referer rule too.
        const added = fresh.flatMap((s) => [s.url, s.map?.url, s.key?.uri]).filter((u): u is string => !!u)
          .map((u) => new URL(u).hostname).filter((h) => !hosts.has(h) && hosts.add(h));
        if (added.length) await ctl.prepare?.([...hosts]);
        c.segmentsTotal += fresh.length;
        await downloadSegments(fresh, spool, ctl, c, report, state, isVideo);
        lastSeq = fresh[fresh.length - 1].seq;
      }
    } catch (e) {
      // Don't throw away a recording because the stream ended or a segment expired: finalize what we have.
      if (ctl.signal.aborted || e instanceof DrmError || spool.size === 0) throw e;
      console.warn('[ReelFetch] live recording ended early', e);
      break;
    }
    if (m.endList) break;
    const wait = Math.max(1, (m.targetDuration || 4) / 2) * 1000;
    for (let t = 0; t < wait && !ctl.stopped(); t += 250) {
      ctl.signal.throwIfAborted();
      await sleep(250);
    }
  }
}

/** Download the whole resource with streaming progress. */
async function downloadDirect(url: string, spool: Spool, ctl: Control, c: Counter, report: () => void) {
  const res = await fetch(url, { credentials: 'include', signal: ctl.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await spool.append(value);
    c.bytes += value.byteLength;
    report();
  }
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
      total: job.media.kind === 'direct' ? job.media.size : undefined,
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
    if (job.media.kind === 'hls') tracks = await planHls(job, s, ctl.signal);
    else if (job.media.kind === 'dash') tracks = await planDash(job, s, ctl.signal);
    else tracks = [{ name: 'video' }];

    const hosts = new Set<string>();
    const addHost = (u?: string) => {
      if (u) hosts.add(new URL(u).hostname);
    };
    addHost(job.media.url);
    for (const t of tracks) {
      addHost(t.liveUrl);
      for (const seg of t.segments ?? []) {
        addHost(seg.url);
        addHost(seg.map?.url);
        addHost(seg.key?.uri);
      }
    }
    await ctl.prepare?.([...hosts]);

    const raw = new Map<Track, Spool>();
    if (tracks.some((t) => t.liveUrl)) phase = 'recording';
    c.segmentsTotal = tracks.reduce((n, t) => n + (t.segments?.length ?? 0), 0);
    report(true);

    await Promise.all(
      tracks.map(async (t) => {
        const sp = await temp(t.name);
        raw.set(t, sp);
        const isVideo = t.name === 'video' || !tracks.some((x) => x.name === 'video');
        if (job.media.kind === 'direct') await downloadDirect(job.media.url, sp, ctl, c, report);
        else if (t.liveUrl) await recordLive(t.liveUrl, sp, ctl, c, report, isVideo);
        else await downloadSegments(t.segments!, sp, ctl, c, report, { mapKey: '' }, isVideo);
      }),
    );

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
