// Manual live detection check (needs internet; not part of CI):
//   npm run build && node scripts/live-detect.mjs [url ...]
// Prints what ReelFetch detects (site extractors, HLS/DASH analysis) on real pages.
import { chromium } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const ext = join(root, 'dist', 'chrome');
const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://vimeo.com/76979871',
      'https://www.bilibili.com/video/BV1GJ411x7h7/',
      'https://ok.ru/video/1450930867',
      'https://hlsjs.video-dev.org/demo/',
    ];
const chromePath = existsSync(chromium.executablePath())
  ? chromium.executablePath()
  : join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'rf-detect-')), {
  executablePath: chromePath,
  headless: true,
  locale: 'en-US',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const ui = await ctx.newPage();
  await ui.goto(`chrome-extension://${sw.url().split('/')[2]}/ui/popup.html`);
  await ui.evaluate(async () => {
    await chrome.storage.local.set({ settings: { tosAccepted: true } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });
  for (const url of urls) {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (const label of ['Reject all', 'Alle ablehnen', 'Accept all', 'Accept', 'I agree']) {
        const b = page.getByRole('button', { name: label, exact: true }).first();
        if (await b.isVisible({ timeout: 1500 }).catch(() => false)) {
          await b.click().catch(() => {});
          break;
        }
      }
      await page.evaluate(() => document.querySelector('video')?.play().catch(() => {})).catch(() => {});
      await sleep(12000);
      if (process.env.RF_DEBUG) console.log("  extractor loaded:", await page.evaluate(() => window.__reelfetchExtract ?? false));
      const tabId = await ui.evaluate((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url?.startsWith(u.slice(0, 30)))?.id), url);
      const s = await ui.evaluate((id) => chrome.runtime.sendMessage({ type: 'get-state', tabId: id }), tabId);
      console.log(`\n${url}`);
      if (!s.media.length) console.log('  (nothing detected)');
      for (const m of s.media)
        console.log(
          `  ${m.site ? `[${m.site}] ` : ''}${m.kind}${m.captureOnly ? ' (turbo)' : ''} "${(m.title ?? m.pageTitle).slice(0, 50)}" ` +
            `variants=${m.variants?.map((v) => v.label + (v.audioRef ? '+a' : '')).join(',') ?? '-'} dur=${m.duration ?? '-'} ` +
            `live=${m.live ?? '-'} drm=${m.drm ?? '-'} ${m.error ? 'ERROR ' + m.error.slice(0, 80) : ''}`,
        );
    } catch (e) {
      console.log(`\n${url}\n  failed: ${String(e).slice(0, 120)}`);
    }
    await page.close();
  }
} finally {
  await ctx.close();
}
