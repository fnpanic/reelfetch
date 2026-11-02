// @vitest-environment node
/**
 * Opt-in checks against public reference streams (needs internet): RF_NETWORK=1 npm test
 * - DASH-IF livesim2: live DASH with wall-clock $Number$ addressing (availabilityStartTime math)
 * - Mux test stream: real-world multi-variant HLS (analysis + partial download)
 */
import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { analyze, download, type EngineSettings } from '../src/engine/engine';
import type { Job, MediaItem } from '../src/shared/types';

globalThis.DOMParser ??= new Window().DOMParser as unknown as typeof DOMParser;

const settings: EngineSettings = {
  preferredQuality: '480',
  audioLangs: [],
  subtitleLangs: [],
  downloadSubtitles: false,
  preferMkv: false,
  audioFormat: 'original',
  preferOriginalAudio: true,
};
const media = (kind: MediaItem['kind'], url: string): MediaItem => ({
  id: 'n', tabId: 1, kind, url, pageUrl: '', pageTitle: '', headers: {}, detectedAt: 0,
});
const job = (m: MediaItem): Job => ({
  id: crypto.randomUUID(), media: m, options: {}, basename: 'x', status: 'running', createdAt: 0, progress: { bytes: 0 },
});

describe.skipIf(!process.env.RF_NETWORK)('public reference streams', () => {
  it('records live DASH (livesim2, number template) and stops on request', async () => {
    const m = media('dash', 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd');
    const a = await analyze(m);
    expect(a.live).toBe(true);
    expect(a.variants?.length).toBeGreaterThan(0);
    const started = Date.now();
    const out = await download(job(m), settings, {
      signal: new AbortController().signal,
      stopped: () => Date.now() - started > 9000,
      onProgress: () => {},
    });
    const input = new Input({ source: new BlobSource(out.files[0].blob), formats: ALL_FORMATS });
    const duration = await input.computeDuration();
    expect((await input.getVideoTracks()).length).toBe(1);
    expect((await input.getAudioTracks()).length).toBe(1);
    expect(duration).toBeGreaterThan(5);
  }, 60000);

  it('analyzes a real multi-variant HLS master', async () => {
    const a = await analyze(media('hls', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'));
    expect(a.variants!.length).toBeGreaterThan(2);
    expect(a.duration).toBeGreaterThan(500);
    expect(a.live).toBe(false);
  }, 30000);
});
