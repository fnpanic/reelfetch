// Manual live check against real sites (needs internet; not part of CI):
//   npm run build && node scripts/live-check.mjs [youtube-url] [chromium] [ffprobe]
// Loads the built extension, opens the page, prints what the site extractor found, runs a turbo
// capture and validates the saved file with ffprobe.
import { chromium } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const ext = join(root, 'dist', 'chrome');
const url = process.argv[2] ?? 'https://www.youtube.com/watch?v=YE7VzlLtp-4'; // Big Buck Bunny trailer (CC-BY)
const chromePath =
  process.argv[3] ??
  (existsSync(chromium.executablePath())
    ? chromium.executablePath()
    : join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'));
const ffprobe = process.argv[4] ?? 'C:/Program Files/DownloadHelper CoApp/ffprobe.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'rf-live-')), {
  executablePath: chromePath,
  headless: true,
  acceptDownloads: true,
  locale: 'en-US',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const ui = await ctx.newPage();
  await ui.goto(`chrome-extension://${extId}/ui/popup.html`);
  const api = (fn, arg) => ui.evaluate(fn, arg);
  await api(async () => {
    await chrome.storage.local.set({ settings: { tosAccepted: true, preferredQuality: 'highest' } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // EU consent wall: decline non-essential cookies if shown.
  for (const label of ['Reject all', 'Alle ablehnen']) {
    const b = page.getByRole('button', { name: label }).first();
    if (await b.isVisible({ timeout: 4000 }).catch(() => false)) {
      await b.click();
      await page.waitForURL(/youtube\.com\/watch/, { timeout: 20000 }).catch(() => {});
      break;
    }
  }
  const tabId = await api((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url?.startsWith(u))?.id), url.split('&')[0]);
  let state;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    state = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId);
    if (state.media.some((m) => m.site === 'youtube')) break;
  }
  const yt = state.media.find((m) => m.site === 'youtube');
  console.log('extractor:', yt ? { title: yt.title, kind: yt.kind, captureOnly: !!yt.captureOnly, variants: yt.variants?.map((v) => v.label), duration: yt.duration } : 'nothing found');
  console.log('other detections:', state.media.filter((m) => m !== yt).map((m) => `${m.kind}:${m.url.slice(0, 80)}`));

  const dl = page.waitForEvent('download', { timeout: 900000 });
  const started = Date.now();
  await api(({ id, mediaId }) => chrome.runtime.sendMessage({ type: 'turbo', tabId: id, mediaId }), { id: tabId, mediaId: yt?.captureOnly ? yt.id : undefined });
  const timer = setInterval(async () => {
    const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId).catch(() => null);
    const j = s?.jobs.find((x) => x.options.turbo || x.media.captureOnly);
    const p = await page
      .evaluate(() => {
        const v = document.querySelector('video');
        return {
          t: v?.currentTime?.toFixed(1), rs: v?.readyState, paused: v?.paused, rate: v?.playbackRate, err: v?.error?.message,
          ad: !!document.querySelector('.ad-showing'), buffered: v && v.buffered.length ? v.buffered.end(v.buffered.length - 1).toFixed(1) : 0,
          q: document.querySelector('#movie_player')?.getPlaybackQuality?.(),
        };
      })
      .catch((e) => String(e).slice(0, 80));
    if (j) console.log(`  turbo: ${j.status} ${j.progress.phase ?? ''} ${(j.progress.recorded ?? 0).toFixed(1)}/${(j.progress.duration ?? 0).toFixed(1)} s ${(j.progress.bytes / 1e6).toFixed(1)} MB ${j.error ?? ''} page=${JSON.stringify(p)}`);
  }, 5000);
  const d = await dl;
  clearInterval(timer);
  const file = await d.path();
  const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'compact', file], { encoding: 'utf8' });
  console.log(`turbo capture saved "${d.suggestedFilename()}" in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(probe.trim());
} finally {
  await ctx.close();
}
