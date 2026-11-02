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
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, mkdtempSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const ext = join(root, 'dist', 'chrome');
const fixtures = join(root, 'test', 'fixtures');
// Explicit path, else Playwright's own Chromium, else any cached Playwright Chromium on Windows.
const cached = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const chromePath = process.argv[2] ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : cached);
const ffprobe = process.argv[3] ?? 'C:/Program Files/DownloadHelper CoApp/ffprobe.exe';
const shots = process.env.E2E_SHOTS ?? tmpdir();

const log = [];
let flakyDown = false; // toggled by the retry test
const LONG = 'An Extremely Long Video Title That Never Ends ' + 'Unbroken_Word_Without_Any_Spaces_'.repeat(5);
async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  log.push({ path: url.pathname, query: url.search, referer: req.headers.referer ?? '', ua: req.headers['user-agent'] ?? '' });
  let path = url.pathname;
  if (path === '/long.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>${LONG}</title><video src="/flaky.mp4?${'q'.repeat(300)}" preload="metadata"></video>`);
  }
  if (path === '/flaky.mp4') {
    if (flakyDown) {
      res.statusCode = 503;
      return res.end();
    }
    path = '/direct.mp4';
  }
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
  if (path === '/youtubei/v1/player' && req.method === 'POST') {
    // Mock of YouTube's player API (iOS client profile): direct stream URLs.
    let body = '';
    for await (const c of req) body += c;
    const { videoId, context } = JSON.parse(body);
    const origin = `https://${req.headers.host}`;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      playabilityStatus: { status: context?.client?.clientName === 'IOS' ? 'OK' : 'LOGIN_REQUIRED' },
      videoDetails: { videoId, title: 'SABR Only Video', lengthSeconds: '10' },
      streamingData: {
        adaptiveFormats: [
          { itag: 137, url: `${origin}/site-video.mp4?yt=ios`, mimeType: 'video/mp4; codecs="avc1"', height: 180, qualityLabel: '180p', bitrate: 400000 },
          { itag: 140, url: `${origin}/site-audio.m4a?yt=ios`, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 64000, audioTrack: { audioIsDefault: true } },
        ],
      },
    }));
  }
  if (path === '/watch') {
    // Synthetic YouTube watch page (www.youtube.com is mapped to this server): exercises the real
    // page-world extractor + background intake + split video/audio merge.
    const origin = `http://${req.headers.host}`;
    const pr = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { videoId: url.searchParams.get('v') ?? 'abc123', title: 'Never Gonna Give Up Testing', lengthSeconds: '10', thumbnail: { thumbnails: [{ url: `${origin}/thumb.png` }] } },
      streamingData: url.searchParams.get('v') === 'sabrOnly001' ? { serverAbrStreamingUrl: `${origin}/sabr` } : {
        adaptiveFormats: [
          { itag: 137, url: `${origin}/site-video.mp4`, mimeType: 'video/mp4; codecs="avc1"', height: 180, width: 320, qualityLabel: '180p', bitrate: 400000 },
          { itag: 140, url: `${origin}/site-audio.m4a`, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 64000, audioTrack: { audioIsDefault: true } },
        ],
      },
    };
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>Never Gonna Give Up Testing - YouTube</title><script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};</script>`);
  }
  if (path === '/turbo.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>Turbo Clip</title><video id="v" width="320"></video><script>
  const ms = new MediaSource();
  document.getElementById('v').src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', async () => {
    // Two SourceBuffers (separate video and audio), like YouTube's player.
    const feed = async (mime, url) => {
      const sb = ms.addSourceBuffer(mime);
      const data = await (await fetch(url)).arrayBuffer();
      await new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(data); });
    };
    await Promise.all([feed('video/webm; codecs="vp9"', '/turbo-v.webm'), feed('audio/webm; codecs="opus"', '/turbo-a.webm')]);
    ms.endOfStream();
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
}
const server = createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// HTTPS twin with a throwaway self-signed certificate: youtube.com is HSTS-preloaded, so the synthetic
// watch page must be served over https (the test browser maps www.youtube.com here and ignores cert errors).
let httpsPort = 0;
let httpsServer;
try {
  const certDir = mkdtempSync(join(tmpdir(), 'rf-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.youtube.com',
    '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem')], { stdio: 'ignore' });
  httpsServer = createHttpsServer({ key: readFileSync(join(certDir, 'k.pem')), cert: readFileSync(join(certDir, 'c.pem')) }, handler);
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  httpsPort = httpsServer.address().port;
} catch {
  console.log('SKIP  site-extractor test (openssl not available)');
}
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
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP www.youtube.com 127.0.0.1', '--ignore-certificate-errors'],
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
  await ui.click('.row .more');
  await ui.screenshot({ path: join(shots, 'reelfetch-menu.png') });
  await ui.click('.row .more');
  await ui.click('.footer-actions .link');
  await ui.setViewportSize({ width: 460, height: 900 });
  await ui.screenshot({ path: join(shots, 'reelfetch-help.png') });
  await ui.setViewportSize({ width: 460, height: 560 });

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
    // Chrome renames untyped blob downloads to .txt (text/plain sniffing).
    check(!d || (!/text\/plain/.test(d.mime) && /^(video|audio)\//.test(d.mime)), `${j.media.kind} saved as media type ${d?.mime}`);
    if (j.options.audioOnly) check(!/h264|vp9/.test(probe) && /aac/.test(probe), 'audio-only has no video stream');
    else if (j.media.kind !== 'direct') check(/h264/.test(probe) && /aac/.test(probe), `${j.media.kind} output has audio + video`);
  }
  // (Playwright renames downloaded files to GUIDs, so check the name we asked for.)
  check(jobs.every((j) => j.basename.startsWith('Smart Name From Page')), 'smart naming applied');
  const protectedHits = log.filter((l) => l.path.startsWith('/protected/'));
  check(protectedHits.length > 5 && protectedHits.every((l) => l.referer.includes('/page.html')), `Referer replayed on ${protectedHits.length} protected requests`);
  const hist = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId)).history;
  check(hist.length === jobs.length, `history recorded ${hist.length} entries`);

  // Long titles/URLs must never produce scrollbars (except the vertical content scroller).
  const longPage = await ctx.newPage();
  await longPage.goto(`${base}/long.html`);
  const longTab = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0].id), `${base}/long.html`);
  let flaky;
  for (let i = 0; i < 40 && !flaky; i++) {
    await sleep(250);
    flaky = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), longTab)).media.find((m) => m.url.includes('/flaky.mp4'));
  }
  check(!!flaky, 'long-title media detected');
  const overflow = () =>
    ui.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const main = document.querySelector('main');
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 0.5);
      return [document.scrollingElement.scrollWidth > W, main && main.scrollWidth > main.clientWidth, wide.length].filter(Boolean).length
        ? `${document.scrollingElement.scrollWidth}/${W} ${wide.slice(0, 3).map((e) => e.className).join(',')}`
        : '';
    });
  // Retry test: the file fails once (server down), then the UI retry must succeed.
  flakyDown = true;
  await api((id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id }), flaky.id);
  let fj;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    fj = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), longTab)).jobs.find((j) => j.media.id === flaky.id);
    if (fj?.status === 'error') break;
  }
  check(fj?.status === 'error', `failing download reported as error (${fj?.error})`);
  for (const [size, w] of [['small', 380], ['medium', 460], ['big', 600]]) {
    await api(async (s) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, popupSize: s, subdirectory: 'Sub_'.repeat(30) } });
    }, size);
    await ui.setViewportSize({ width: w, height: 600 });
    await ui.goto(`chrome-extension://${extId}/ui/popup.html?tabId=${longTab}`);
    await ui.waitForSelector('.row');
    const bad = [];
    const probe = async (name) => {
      const o = await overflow();
      if (o) bad.push(`${name}: ${o}`);
    };
    await probe('media');
    await ui.click('.row .more');
    await probe('menu');
    await ui.click('.menu button:last-child');
    await probe('details');
    for (const i of [2, 3, 4]) {
      await ui.click(`button[role=tab]:nth-child(${i})`);
      await sleep(200);
      await probe(`tab${i}`);
    }
    // Settings are taller than the popup: they must scroll vertically and reach the last section.
    const scroll = await ui.evaluate(() => {
      const main = document.querySelector('main');
      main.scrollTo(0, main.scrollHeight);
      const last = [...document.querySelectorAll('.settings section')].pop().getBoundingClientRect();
      return { scrollable: main.scrollHeight > main.clientHeight, top: main.scrollTop, lastVisible: last.bottom <= innerHeight + 1 && last.top < innerHeight };
    });
    check(scroll.scrollable && scroll.top > 0 && scroll.lastVisible, `settings scroll to the last section at size ${size} ${JSON.stringify(scroll)}`);
    if (size === 'medium') await ui.screenshot({ path: join(shots, 'reelfetch-long-settings.png') });
    check(!bad.length, `no horizontal overflow at popup size ${size} ${bad.join(' | ')}`);
  }
  await api(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, popupSize: 'medium', subdirectory: '' } });
  });

  // Retry and remove must work from the UI even after the service worker was stopped.
  await ui.setViewportSize({ width: 460, height: 600 });
  await ui.goto(`chrome-extension://${extId}/ui/popup.html?tabId=${longTab}`);
  await ui.click('button[role=tab]:nth-child(2)');
  await ui.waitForSelector('.job.error');
  const cdp = await ctx.newCDPSession(ui);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await sleep(1000);
  flakyDown = false;
  await ui.click(`.job.error button[title="${await api(() => chrome.i18n.getMessage('retry_download_button_tooltip'))}"]`);
  let retried;
  for (let i = 0; i < 40 && retried?.status !== 'done'; i++) {
    await sleep(500);
    retried = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), longTab)).jobs.find((j) => j.media.id === flaky.id);
  }
  await sleep(500);
  check(retried?.status === 'done' && (await ui.locator('.job.error').count()) === 0, `retry from the UI works after a worker restart (${retried?.status} ${retried?.error ?? ''})`);
  const rowsBefore = await ui.locator('.row').count();
  await cdp.send('ServiceWorker.stopAllWorkers');
  await sleep(1000);
  await ui.locator('.row').first().locator('button').last().click();
  await sleep(800);
  check((await ui.locator('.row').count()) === rowsBefore - 1, `remove from downloads list (${rowsBefore} -> ${await ui.locator('.row').count()})`);
  await ui.click('button[role=tab]:nth-child(3)');
  await ui.waitForSelector('.row');
  const histBefore = await ui.locator('.row').count();
  await cdp.send('ServiceWorker.stopAllWorkers');
  await sleep(1000);
  await ui.locator('.row').first().locator('button').last().click();
  await sleep(800);
  check((await ui.locator('.row').count()) === histBefore - 1, `remove from history (${histBefore} -> ${await ui.locator('.row').count()})`);

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

  // Element picker: click the headline, a smart-naming rule is saved for the site.
  await api(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, smartNaming: [] } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });
  await page.bringToFront();
  await api((id) => chrome.runtime.sendMessage({ type: 'pick-name', tabId: id }), tabId);
  await page.waitForTimeout(300);
  const h = await page.locator('h1.headline').boundingBox();
  await page.mouse.move(h.x + 5, h.y + 5);
  await page.mouse.click(h.x + 5, h.y + 5);
  await sleep(800);
  const rules = await api(async () => (await chrome.storage.local.get('settings')).settings.smartNaming);
  const sel = rules.find((r) => r.host === '127.0.0.1')?.selector;
  const picked = sel && (await page.evaluate((x) => document.querySelectorAll(x).length === 1 && document.querySelector(x).textContent, sel));
  check(picked === 'Smart Name From Page', `element picker saved rule "${sel}"`);

  // Site extractor (YouTube player data) -> merged video + audio download.
  const ytUrl = `https://www.youtube.com:${httpsPort}/watch?v=abc123`;
  const yt = await ctx.newPage();
  if (httpsPort) await yt.goto(ytUrl);
  const ytTab = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0]?.id), ytUrl);
  let ytItem;
  for (let i = 0; i < 40 && !ytItem; i++) {
    await sleep(250);
    const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), ytTab);
    ytItem = s.media.find((m) => m.site === 'youtube');
  }
  check(!!ytItem && ytItem.variants?.[0]?.audioRef?.endsWith('site-audio.m4a'), `YouTube extractor: "${ytItem?.title}" ${ytItem?.variants?.map((v) => v.label)}`);
  if (ytItem) {
    await api((id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id }), ytItem.id);
    let yj;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), ytTab);
      yj = s.jobs.find((j) => j.media.id === ytItem.id);
      if (yj && yj.status !== 'running' && yj.status !== 'queued') break;
    }
    const [d] = yj?.downloadIds?.length ? await api((id) => chrome.downloads.search({ id }), yj.downloadIds[0]) : [];
    const probe =
      d?.filename && existsSync(d.filename) && existsSync(ffprobe)
        ? execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'compact', d.filename], { encoding: 'utf8' }).trim().replace(/\r?\n/g, ' | ')
        : '';
    check(
      yj?.status === 'done' && /h264/.test(probe) && /aac/.test(probe) && yj.basename.startsWith('Never Gonna Give Up Testing'),
      `YouTube-style split download merged: ${yj?.basename} ${probe} ${yj?.error ?? ''}`,
    );
  }

  // YouTube page with SABR-only streams -> the player API (iOS profile) provides direct formats.
  if (httpsPort) {
    const sabrUrl = `https://www.youtube.com:${httpsPort}/watch?v=sabrOnly001`;
    const sp = await ctx.newPage();
    await sp.goto(sabrUrl);
    const sTab = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0]?.id), sabrUrl);
    let apiItem;
    let turboItem;
    for (let i = 0; i < 40 && !apiItem; i++) {
      await sleep(250);
      const st = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), sTab);
      apiItem = st.media.find((m) => m.site === 'youtube' && m.kind === 'direct');
      turboItem = st.media.find((m) => m.site === 'youtube' && m.captureOnly);
    }
    const apiCall = log.find((l) => l.path === '/youtubei/v1/player');
    check(
      !!apiItem && !!turboItem && /com\.google\.ios\.youtube/.test(apiCall?.ua ?? ''),
      `YouTube player API (iOS profile, UA via DNR: ${/ios/.test(apiCall?.ua ?? '')}) -> ${apiItem?.variants?.map((v) => v.label)} + turbo fallback ${!!turboItem}`,
    );
    if (apiItem) {
      await api((id) => chrome.runtime.sendMessage({ type: 'download', mediaId: id }), apiItem.id);
      let aj;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const st = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), sTab);
        aj = st.jobs.find((j) => j.media.id === apiItem.id);
        if (aj && aj.status !== 'running' && aj.status !== 'queued') break;
      }
      const cdn = log.filter((l) => l.query === '?yt=ios');
      check(
        aj?.status === 'done' && cdn.length > 0 && cdn.every((l) => /com\.google\.ios\.youtube/.test(l.ua)),
        `YouTube API download merged (${aj?.status} ${aj?.error ?? ''}), ${cdn.length} stream requests carried the iOS UA`,
      );
    }
  }

  // Hover preview: a short clip built by the engine from the HLS stream.
  const previewUrl = await api((id) => chrome.runtime.sendMessage({ type: 'preview', mediaId: id }), hlsMaster.id);
  check(typeof previewUrl === 'string' && previewUrl.startsWith('blob:'), `engine preview clip (${String(previewUrl).slice(0, 40)})`);

  // Default action: copy URL instead of downloading.
  await api(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, defaultAction: 'copy' } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });
  const jobsBefore = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId)).jobs.length;
  const act = await api((id) => chrome.runtime.sendMessage({ type: 'default-action', mediaId: id }), hlsMaster.id);
  const jobsAfter = (await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId)).jobs.length;
  check(act === 'copy' && jobsAfter === jobsBefore, `default action "copy" copies instead of downloading (${JSON.stringify(act)})`);
  await api(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, defaultAction: 'download' } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });

  // Turbo capture: reload with capture, play at 16x, save automatically when the video ends.
  const turboPage = await ctx.newPage();
  await turboPage.goto(`${base}/turbo.html`);
  const turboTab = await api((u) => chrome.tabs.query({ url: u }).then((t) => t[0].id), `${base}/turbo.html`);
  const turboDl = turboPage.waitForEvent('download', { timeout: 60000 });
  const started = Date.now();
  await api((id) => chrome.runtime.sendMessage({ type: 'turbo', tabId: id }), turboTab);
  try {
    const d = await turboDl;
    const p = await d.path();
    const probe = existsSync(ffprobe)
      ? execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'compact', p], { encoding: 'utf8' }).trim().replace(/\r?\n/g, ' | ')
      : '';
    const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), turboTab);
    const tj = s.jobs.find((j) => j.options.turbo);
    const muted = await api((id) => chrome.tabs.get(id).then((t) => t.mutedInfo?.muted), turboTab);
    check(
      /vp9/.test(probe) && /opus/.test(probe) && tj?.status === 'done' && muted === false,
      `turbo capture of a 5 s video saved in ${((Date.now() - started) / 1000).toFixed(1)} s: ${d.suggestedFilename()} ${probe} (tab unmuted again: ${muted === false})`,
    );
  } catch (e) {
    const s = await api((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), turboTab);
    const tj = s.jobs.find((j) => j.options.turbo);
    const probe = await turboPage.evaluate(() => {
      const v = document.querySelector('video');
      return { hook: typeof window.__reelfetchTurbo, t: v?.currentTime, d: v?.duration, paused: v?.paused, rate: v?.playbackRate, ended: v?.ended, src: v?.src };
    }).catch((err) => String(err));
    check(false, `turbo capture: ${e.message} job=${JSON.stringify({ status: tj?.status, progress: tj?.progress, error: tj?.error })} media=${JSON.stringify(s.media.map((m) => [m.kind, m.id, m.mse]))} page=${JSON.stringify(probe)}`);
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
  httpsServer?.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
