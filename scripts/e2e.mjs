// End-to-end check of the built Chrome extension in a real Chromium:
// detection (network + <video>), analysis, Referer replay (DNR), HLS/DASH/direct downloads via the
// offscreen engine, MSE capture, and output validation with ffprobe.
// Usage: npm run build && node scripts/e2e.mjs [path-to-chromium] [path-to-ffprobe]
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const ext = join(root, 'dist', 'chrome');
const fixtures = join(root, 'test', 'fixtures');
// Explicit path, else Playwright's own Chromium, else any cached Playwright Chromium on Windows.
const cached = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const chromePath = process.argv[2] ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : cached);
const ffprobe = process.argv[3] ?? 'C:/Program Files/DownloadHelper CoApp/ffprobe.exe';
const shots = process.env.E2E_SHOTS ?? tmpdir();

const log = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  log.push({ path: url.pathname, referer: req.headers.referer ?? '' });
  let path = url.pathname;
  if (path === '/page.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>E2E Test Clip - TestTube</title>
<meta property="og:image" content="/thumb.png">
<h1 class="headline">Smart Name From Page</h1>
<video src="/direct.mp4" muted preload="metadata" width="160"></video>
<script>
  fetch('/protected/hls-fmp4/master.m3u8');
  fetch('/hls-ts-aes/index.m3u8');
  fetch('/dash/manifest.mpd');
</script>`);
  }
  if (path === '/mse.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>MSE Player</title><video id="v" muted></video><script>
  const ms = new MediaSource();
  document.getElementById('v').src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', async () => {
    const sb = ms.addSourceBuffer('video/webm; codecs="vp9,opus"');
    sb.appendBuffer(await (await fetch('/mse.webm')).arrayBuffer());
  });
</script>`);
  }
  if (path === '/audio.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>Opus Song</title><video src="/mse.webm" muted preload="none"></video>`);
  }
  if (path === '/thumb.png') {
    res.setHeader('Content-Type', 'image/png');
    return res.end(await readFile(join(root, 'public', 'icons', '128.png')));
  }
  if (path.startsWith('/protected/')) {
    // Simulates a CDN that only serves requests coming from the player page.
    if (!(req.headers.referer ?? '').includes('/page.html')) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    path = path.slice('/protected'.length);
  }
  try {
    const body = await readFile(join(fixtures, decodeURIComponent(path)));
    const type = path.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : path.endsWith('.mpd')
        ? 'application/dash+xml'
        : path.endsWith('.mp4')
          ? 'video/mp4'
          : path.endsWith('.webm')
            ? 'video/webm'
            : 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', body.byteLength);
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'rf-e2e-')), {
  executablePath: chromePath,
  headless: true,
  acceptDownloads: true,
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
    await chrome.storage.local.set({
      settings: {
        tosAccepted: true,
        historyEnabled: true,
        preferredQuality: 'highest',
        smartNaming: [{ host: '127.0.0.1', selector: 'h1.headline' }],
      },
    });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });

  const page = await ctx.newPage();
  await page.goto(`${base}/page.html`);
  const tabId = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0].id), `${base}/page.html`);

  // Wait for detection + analysis.
  let state;
  for (let i = 0; i < 40; i++) {
    state = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId);
    if (state.media.length >= 4 && state.media.every((m) => m.kind === 'direct' || m.analyzed)) break;
    await sleep(250);
  }
  const kinds = state.media.map((m) => `${m.kind}:${new URL(m.url).pathname}`).sort();
  console.log('detected:', kinds);
  const hlsMaster = state.media.find((m) => m.url.endsWith('master.m3u8'));
  check(!!hlsMaster && hlsMaster.variants?.[0]?.label === '180p', 'HLS master detected + analyzed through Referer-protected CDN');
  check(!state.media.some((m) => m.url.includes('stream_0.m3u8')), 'child playlists hidden');
  check(!!state.media.find((m) => m.kind === 'dash')?.variants?.length, 'DASH detected + analyzed');
  check(!!state.media.find((m) => m.kind === 'direct' && m.url.endsWith('direct.mp4')), 'direct <video> source detected');
  check(!!state.media.find((m) => m.url.endsWith('index.m3u8'))?.encrypted, 'AES-128 HLS flagged as encrypted');
  const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  check(badge === String(state.media.length), `badge shows ${badge}`);

  await ui.setViewportSize({ width: 460, height: 560 });
  await ui.goto(`chrome-extension://${extId}/ui/popup.html?tabId=${tabId}`);
  await ui.waitForSelector('.row');
  await ui.screenshot({ path: join(shots, 'reelfetch-popup.png') });

  // Download everything.
  for (const m of state.media) await api((id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id }), m.id);
  await api(
    (id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id, audioOnly: true }),
    state.media.find((m) => m.kind === 'dash').id,
  );
  let jobs = [];
  for (let i = 0; i < 120; i++) {
    jobs = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId)).jobs;
    if (jobs.length && jobs.every((j) => j.status !== 'running' && j.status !== 'queued')) break;
    await sleep(500);
  }
  await ui.goto(`chrome-extension://${extId}/ui/popup.html?tabId=${tabId}`);
  await ui.click('button[role=tab]:nth-child(2)');
  await ui.screenshot({ path: join(shots, 'reelfetch-downloads.png') });
  await ui.click('button[role=tab]:nth-child(4)');
  await ui.screenshot({ path: join(shots, 'reelfetch-settings.png') });

  for (const j of jobs) {
    const [d] = j.downloadIds?.length
      ? await api((id) => chrome.downloads.search({ id }), j.downloadIds[0])
      : [];
    const file = d?.filename;
    let probe = '';
    if (file && existsSync(file) && existsSync(ffprobe)) {
      probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration,format_name', '-of', 'compact', file], {
        encoding: 'utf8',
      })
        .trim()
        .replace(/\r?\n/g, ' | ');
    }
    const size = file && existsSync(file) ? (await stat(file)).size : 0;
    check(
      j.status === 'done' && size > 10_000,
      `${j.media.kind}${j.options.audioOnly ? ' (audio only)' : ''} -> ${j.filename} ${size}B ${probe} ${j.error ?? ''}`,
    );
    if (j.options.audioOnly) check(!/h264|vp9/.test(probe) && /aac/.test(probe), 'audio-only has no video stream');
    else if (j.media.kind !== 'direct') check(/h264/.test(probe) && /aac/.test(probe), `${j.media.kind} output has audio + video`);
  }
  // (Playwright renames downloaded files to GUIDs, so check the name we asked for.)
  check(jobs.every((j) => j.basename.startsWith('Smart Name From Page')), 'smart naming applied');
  const protectedHits = log.filter((l) => l.path.startsWith('/protected/'));
  check(protectedHits.length > 5 && protectedHits.every((l) => l.referer.includes('/page.html')), `Referer replayed on ${protectedHits.length} protected requests`);
  const hist = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId)).history;
  check(hist.length === jobs.length, `history recorded ${hist.length} entries`);

  // MSE capture.
  const mse = await ctx.newPage();
  await mse.goto(`${base}/mse.html`);
  const mseTab = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0].id), `${base}/mse.html`);
  await api((id) => chrome.runtime.sendMessage({ type: 'capture-site', tabId: id, enable: true }), mseTab);
  let cap;
  for (let i = 0; i < 40 && !cap; i++) {
    await sleep(250);
    const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), mseTab);
    cap = s.media.find((m) => m.kind === 'mse' && m.mse?.bytes > 100_000);
  }
  check(!!cap, `MSE stream captured (${cap?.mse?.bytes} bytes, ${cap?.mse?.mimes})`);
  if (cap) {
    const dl = mse.waitForEvent('download', { timeout: 20000 });
    await api((id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id }), cap.id);
    const d = await dl;
    const p = await d.path();
    const probe = existsSync(ffprobe)
      ? execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'compact', p], { encoding: 'utf8' }).trim().replace(/\r?\n/g, ' | ')
      : '';
    check(/vp9/.test(probe) && /opus/.test(probe) && d.suggestedFilename().endsWith('.webm'), `MSE capture saved as ${d.suggestedFilename()} ${probe}`);
  }

  // Audio-only + MP3 transcoding (WebCodecs decode + LAME worker inside the offscreen document).
  await api(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, audioFormat: 'mp3' } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });
  const audioPage = await ctx.newPage();
  await audioPage.goto(`${base}/audio.html`);
  const audioTab = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0].id), `${base}/audio.html`);
  let webm;
  for (let i = 0; i < 40 && !webm; i++) {
    await sleep(250);
    const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), audioTab);
    webm = s.media.find((m) => m.url.endsWith('mse.webm'));
  }
  check(!!webm, 'WebM <video> detected');
  if (webm) {
    await api((id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id, audioOnly: true }), webm.id);
    let job;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), audioTab);
      job = s.jobs.find((j) => j.media.id === webm.id);
      if (job && job.status !== 'running' && job.status !== 'queued') break;
    }
    const [d] = job?.downloadIds?.length ? await api((id) => chrome.downloads.search({ id }), job.downloadIds[0]) : [];
    const probe =
      d?.filename && existsSync(d.filename) && existsSync(ffprobe)
        ? execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'compact', d.filename], { encoding: 'utf8' }).trim().replace(/\r?\n/g, ' | ')
        : '';
    check(job?.status === 'done' && /codec_name=mp3/.test(probe) && !/vp9/.test(probe), `MP3 conversion: ${job?.status} ${probe} ${job?.error ?? ''}`);
  }
} finally {
  await ctx.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
