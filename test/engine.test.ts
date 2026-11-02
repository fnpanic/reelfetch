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
      const body = await readFile(join(root, path));
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
