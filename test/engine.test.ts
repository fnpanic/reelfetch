// @vitest-environment node
/**
 * End-to-end engine test: serves real ffmpeg-made HLS (AES-128 TS, fMP4 + separate audio) and
 * DASH fixtures over HTTP, downloads them through the engine and validates the remuxed output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { analyze, download, type EngineSettings } from '../src/engine/engine';
import type { Job, MediaItem } from '../src/shared/types';
import { Window } from 'happy-dom';

// Node fetch (no CORS, like an extension with host permissions) + happy-dom's XML parser for DASH.
globalThis.DOMParser ??= new Window().DOMParser as unknown as typeof DOMParser;

const root = join(__dirname, 'fixtures');
let server: Server;
let base = '';
const hits: string[] = [];
// Large plain file for the chunked downloader: 30 MB + a ragged tail, deterministic content.
const BIG = Uint8Array.from({ length: 30 * 2 ** 20 + 12345 }, (_, i) => (i * 31 + (i >> 13)) & 255);
let bigRequests = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    hits.push(req.url!);
    try {
      const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
      if (path === '/live.m3u8') {
        // Simulated live playlist: grows by one segment per request, ends after 4.
        const n = Math.min(4, hits.filter((h) => h === '/live.m3u8').length + 1);
        const segs = Array.from({ length: n }, (_, i) => `#EXTINF:1.0,\nhls-ts-aes/seg00${i}.ts`).join('\n');
        res.end(
          `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="hls-ts-aes/key.bin",IV=0x00112233445566778899aabbccddeeff\n${segs}\n${n === 4 ? '#EXT-X-ENDLIST' : ''}`,
        );
        return;
      }
      if (path === '/live-broken.m3u8') {
        // Live playlist whose third segment has already expired (404): recording must keep the first two.
        res.end(
          `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="hls-ts-aes/key.bin",IV=0x00112233445566778899aabbccddeeff\n#EXTINF:1.0,\nhls-ts-aes/seg000.ts\n#EXTINF:1.0,\nhls-ts-aes/seg001.ts\n#EXTINF:1.0,\nhls-ts-aes/gone.ts\n`,
        );
        return;
      }
      if (path === '/dash/live.mpd') {
        // Simulated live DASH: the timeline grows by one segment per refresh, the stream ends at 6.
        const k = hits.filter((h) => h === '/dash/live.mpd').length;
        const count = Math.min(6, k + 2);
        const audioDur = [44032, 45056, 44032, 44032, 44032, 43416];
        let mpd = await readFile(join(root, 'dash/manifest.mpd'), 'utf8');
        mpd = mpd
          .replace('type="static"', count < 6 ? 'type="dynamic" minimumUpdatePeriod="PT0.2S"' : 'type="static"')
          .replace(/mediaPresentationDuration="[^"]*"/, '')
          .replace('<S t="0" d="12800" r="5" />', `<S t="0" d="12800" r="${count - 1}" />`)
          .replace(
            /<SegmentTimeline>\s*<S t="0" d="44032" \/>[\s\S]*?<\/SegmentTimeline>/,
            `<SegmentTimeline>${audioDur.slice(0, count).map((d, i) => `<S ${i ? '' : 't="0" '}d="${d}" />`).join('')}</SegmentTimeline>`,
          );
        res.setHeader('Content-Type', 'application/dash+xml');
        res.end(mpd);
        return;
      }
      if (path === '/expiring.bin' && hits.filter((h) => h === '/expiring.bin').length > 1) {
        // Signed URL that may be used once (or has expired by the next request), like many file hosts.
        res.statusCode = 410;
        return res.end();
      }
      if ((path === '/drop.bin' || path === '/norange.bin') && (!req.headers.range || path === '/norange.bin')) {
        // Connection drops halfway through: the downloader must resume with a Range request.
        res.setHeader('Content-Length', BIG.byteLength);
        res.write(BIG.subarray(0, 10 * 2 ** 20));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      if (path === '/big.bin') bigRequests++;
      const body = /^\/(big|expiring|drop)\.bin$/.test(path) ? BIG : await readFile(join(root, path));
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        // Range support like real CDNs (exercises the chunked downloader).
        const start = Number(range[1]);
        const end = Math.min(body.byteLength - 1, range[2] ? Number(range[2]) : body.byteLength - 1);
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${body.byteLength}`);
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.setHeader('Content-Length', body.byteLength);
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const settings: EngineSettings = {
  preferredQuality: 'highest',
  audioLangs: [],
  subtitleLangs: [],
  downloadSubtitles: false,
  preferMkv: false,
  audioFormat: 'original',
  preferOriginalAudio: true,
};

function media(kind: MediaItem['kind'], path: string): MediaItem {
  return { id: 'm', tabId: 1, kind, url: `${base}/${path}`, pageUrl: '', pageTitle: '', headers: {}, detectedAt: 0 };
}

function job(m: MediaItem, opts: Job['options'] = {}): Job {
  return { id: crypto.randomUUID(), media: m, options: opts, basename: 'x', status: 'running', createdAt: 0, progress: { bytes: 0 } };
}

const ctl = () => ({ signal: new AbortController().signal, stopped: () => false, onProgress: () => {} });

async function inspect(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const tracks = await input.getTracks();
  return {
    format: (await input.getFormat()).name,
    video: tracks.filter((t) => t.isVideoTrack()).map((t) => t.codec),
    audio: tracks.filter((t) => t.isAudioTrack()).map((t) => t.codec),
    duration: await input.computeDuration(),
  };
}

describe('engine', () => {
  it('analyzes an HLS master', async () => {
    const a = await analyze(media('hls', 'hls-fmp4/master.m3u8'));
    expect(a.variants?.[0]).toMatchObject({ height: 180, label: '180p' });
    expect(a.audioLangs).toEqual(['en']);
    expect(a.children).toContain(`${base}/hls-fmp4/stream_1.m3u8`);
    expect(a.duration).toBeCloseTo(6, 0);
    expect(a.live).toBe(false);
  });

  it('downloads + decrypts AES-128 TS HLS into mp4', async () => {
    const progress: number[] = [];
    const out = await download(job(media('hls', 'hls-ts-aes/index.m3u8')), settings, {
      ...ctl(),
      onProgress: (p) => progress.push(p.segments ?? 0),
    });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].ext).toBe('mp4');
    const info = await inspect(out.files[0].blob);
    expect(info.video).toEqual(['avc']);
    expect(info.audio).toEqual(['aac']);
    expect(info.duration).toBeGreaterThan(5.5);
    expect(Math.max(...progress)).toBe(6);
  });

  it('downloads fMP4 HLS with a separate audio rendition', async () => {
    const out = await download(job(media('hls', 'hls-fmp4/master.m3u8')), settings, ctl());
    const info = await inspect(out.files[0].blob);
    expect(info).toMatchObject({ format: 'MP4', video: ['avc'], audio: ['aac'] });
    expect(info.duration).toBeGreaterThan(5.5);
  });

  it('downloads DASH (timeline template, separate A/V)', async () => {
    const a = await analyze(media('dash', 'dash/manifest.mpd'));
    expect(a.variants?.[0].height).toBe(180);
    const out = await download(job(media('dash', 'dash/manifest.mpd')), { ...settings, preferMkv: true }, ctl());
    expect(out.files[0].ext).toBe('mkv');
    const info = await inspect(out.files[0].blob);
    expect(info.video).toEqual(['avc']);
    expect(info.audio).toEqual(['aac']);
    expect(info.duration).toBeGreaterThan(5.5);
  });

  it('extracts audio only', async () => {
    const out = await download(job(media('dash', 'dash/manifest.mpd'), { audioOnly: true }), settings, ctl());
    expect(out.files[0].ext).toBe('m4a');
    const info = await inspect(out.files[0].blob);
    expect(info.video).toEqual([]);
    expect(info.audio).toEqual(['aac']);
  });

  it('records a live HLS playlist until it ends', async () => {
    const out = await download(job(media('hls', 'live.m3u8')), settings, ctl());
    const info = await inspect(out.files[0].blob);
    expect(info.duration).toBeGreaterThan(3.5);
  });

  it('rebases timestamps across HLS discontinuities', async () => {
    const out = await download(job(media('hls', 'discontinuity.m3u8')), settings, ctl());
    expect(out.files).toHaveLength(1);
    const info = await inspect(out.files[0].blob);
    expect(info.duration).toBeGreaterThan(5.5); // 2 x 3 s, not 3 s of overlapping pieces
    expect(info.duration).toBeLessThan(7);
  });

  it('joins multi-period DASH', async () => {
    const a = await analyze(media('dash', 'dash/multiperiod.mpd'));
    expect(a.duration).toBe(12);
    const out = await download(job(media('dash', 'dash/multiperiod.mpd')), settings, ctl());
    const info = await inspect(out.files[0].blob);
    expect(info.video).toEqual(['avc']);
    expect(info.duration).toBeGreaterThan(11.5);
  });

  it('records live DASH until the stream ends', async () => {
    const a = await analyze(media('dash', 'dash/live.mpd'));
    expect(a.live).toBe(true);
    const progress: string[] = [];
    const out = await download(job(media('dash', 'dash/live.mpd')), settings, {
      ...ctl(),
      onProgress: (p) => progress.push(p.phase ?? ''),
    });
    expect(progress).toContain('recording');
    const info = await inspect(out.files[0].blob);
    expect(info.video).toEqual(['avc']);
    expect(info.audio).toEqual(['aac']);
    // Joins at the live edge (last 3 segments of the 5 then listed) and follows until the end: 4 x 1 s.
    expect(info.duration).toBeGreaterThan(3.5);
    expect(info.duration).toBeLessThan(5);
  });

  it('merges separate site video + audio files (YouTube/Bilibili style)', async () => {
    const m: MediaItem = {
      ...media('direct', 'site-video.mp4'),
      variants: [{ id: 'v', ref: `${base}/site-video.mp4`, audioRef: `${base}/site-audio.m4a`, label: '180p' }],
    };
    const progress: (number | undefined)[] = [];
    const out = await download(job(m, { variantId: 'v' }), settings, { ...ctl(), onProgress: (p) => progress.push(p.total) });
    expect(progress.at(-1)).toBe(83153 + 482781); // totals learned from Content-Range
    const info = await inspect(out.files[0].blob);
    expect(info).toMatchObject({ video: ['avc'], audio: ['aac'] });
    expect(info.duration).toBeGreaterThan(9.5);
    const audio = await download(job(m, { variantId: 'v', audioOnly: true }), settings, ctl());
    expect((await inspect(audio.files[0].blob)).video).toEqual([]);
  });

  const same = async (out: Awaited<ReturnType<typeof download>>) => {
    const got = new Uint8Array(await out.files[0].blob.arrayBuffer());
    return got.byteLength === BIG.byteLength && Buffer.compare(Buffer.from(got), Buffer.from(BIG)) === 0;
  };

  it('downloads a large plain file in one request, byte-identical', async () => {
    bigRequests = 0;
    expect(await same(await download(job(media('direct', 'big.bin')), settings, ctl()))).toBe(true);
    expect(bigRequests).toBe(1);
  });

  it('uses a file URL only once (signed URLs answer 410 afterwards)', async () => {
    expect(await same(await download(job(media('direct', 'expiring.bin')), settings, ctl()))).toBe(true);
  });

  it('resumes a dropped connection with a Range request', async () => {
    expect(await same(await download(job(media('direct', 'drop.bin')), settings, ctl()))).toBe(true);
  });

  it('explains a dropped connection on a server without Range support (no "HTTP 200")', async () => {
    await expect(download(job(media('direct', 'norange.bin')), settings, ctl())).rejects.toThrow(/cannot resume/);
  });

  it('uses inline DASH manifests (Facebook style)', async () => {
    const text = (await readFile(join(root, 'dash/manifest.mpd'), 'utf8')).replace('<Period', `<BaseURL>${base}/dash/</BaseURL><Period`);
    const m: MediaItem = { ...media('dash', 'x'), url: 'about:reelfetch-1', manifest: text };
    expect((await analyze(m)).variants?.[0].height).toBe(180);
    const out = await download(job(m), settings, ctl());
    expect((await inspect(out.files[0].blob)).duration).toBeGreaterThan(5.5);
  });

  it('builds short previews', async () => {
    const out = await download(job(media('hls', 'hls-fmp4/master.m3u8')), settings, { ...ctl(), previewSeconds: 2 });
    const info = await inspect(out.files[0].blob);
    expect(info.duration).toBeGreaterThan(1.5);
    expect(info.duration).toBeLessThan(3.5);
  });

  it('keeps a live recording when a segment fails', async () => {
    const out = await download(job(media('hls', 'live-broken.m3u8')), settings, ctl());
    const info = await inspect(out.files[0].blob);
    expect(info.duration).toBeGreaterThan(1.5);
  });

  it('cancels', async () => {
    const ac = new AbortController();
    const p = download(job(media('hls', 'hls-ts-aes/index.m3u8')), settings, { ...ctl(), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  });

  it('refuses DRM', async () => {
    await expect(download(job(media('hls', 'drm.m3u8')), settings, ctl())).rejects.toThrow(/DRM/);
  });
});
