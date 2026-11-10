// End-to-end check of the Windows setup and the self-update path (Windows only, needs Inno Setup 6):
//   node scripts/e2e-update.mjs
// 1. builds a release whose update URL points at a local server and installs the setup into a temp folder,
// 2. publishes a fake newer version (same build, bumped version) on that server,
// 3. loads the installed extension, checks the update banner and runs the in-place update through the
//    native messaging host (download, SHA-256 check, file swap),
// 4. uninstalls and verifies that files and registry entries are gone.
// Developer mode is switched on like a real "Load unpacked" setup (without it Chromium disables an
// unpacked extension when it reloads), so the final reload into the new version is checked too.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signRelease } from './sign.mjs';

const root = resolve(import.meta.dirname, '..');
const PORT = 8765;
const base = `http://127.0.0.1:${PORT}`;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const next = pkg.version.replace(/\d+$/, (n) => String(Number(n) + 1));
const shots = process.env.E2E_SHOTS ?? tmpdir();
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
const hostKey = 'HKCU:\\Software\\Chromium\\NativeMessagingHosts\\app.reelfetch.updater';

execFileSync(process.execPath, ['scripts/release.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, REELFETCH_UPDATE_URL: base } });
// The setup and its uninstaller overwrite/delete these keys, which a real install on this machine also uses.
const realHosts = ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Chromium']
  .map((b) => `HKCU:\\Software\\${b}\\NativeMessagingHosts\\app.reelfetch.updater`)
  .map((k) => [k, ps(`if (Test-Path '${k}') { (Get-ItemProperty '${k}').'(default)' }`)])
  .filter(([, v]) => v);
const setup = join(root, 'release', `ReelFetch-Setup-${pkg.version}.exe`);
const dir = mkdtempSync(join(tmpdir(), 'rf-setup-'));
execFileSync(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${dir}`]);
const extDir = join(dir, 'extension');
const version = () => JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8')).version;
check(version() === pkg.version, `setup installed ${pkg.version} to ${dir}`);
check(ps(`Test-Path '${hostKey}'`) === 'True', 'updater registered for the browser');
const cfg = JSON.parse(readFileSync(join(dir, 'updater', 'config.json'), 'utf8'));
check(cfg.base === base && cfg.extensionDir === extDir, 'updater config is valid JSON with the right paths');

// Fake next release: the same files with a bumped version.
const srv = mkdtempSync(join(tmpdir(), 'rf-srv-'));
cpSync(join(root, 'dist', 'chrome'), join(srv, 'pkg'), { recursive: true });
const manifest = JSON.parse(readFileSync(join(srv, 'pkg', 'manifest.json'), 'utf8'));
writeFileSync(join(srv, 'pkg', 'manifest.json'), JSON.stringify({ ...manifest, version: next }, null, 2));
const zip = `reelfetch-chrome-${next}.zip`;
ps(`Compress-Archive -Path '${join(srv, 'pkg')}\\*' -DestinationPath '${join(srv, zip)}'`);
const sha256 = createHash('sha256').update(readFileSync(join(srv, zip))).digest('hex');
const latest = (extra) => writeFileSync(join(srv, 'latest.json'), JSON.stringify({ version: next, zip, sha256, setup: `ReelFetch-Setup-${next}.exe`, ...extra }));
// First a release signed for other content (what a taken-over update server could offer): must be refused.
latest({ sig: signRelease(next, 'f'.repeat(64)) });
const server = createServer(async (req, res) => {
  try {
    res.end(await readFile(join(srv, new URL(req.url, base).pathname)));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const cached = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'rf-upd-')), {
  executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath() : cached,
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  check(id === JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8')).extensionId, `fixed extension id ${id}`);
  const extPage = await ctx.newPage();
  await extPage.goto('chrome://extensions');
  await extPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const extInfo = () =>
    extPage.evaluate((x) => chrome.developerPrivate.getExtensionInfo(x).then((e) => ({ state: e.state, version: e.version })), id);
  const ui = await ctx.newPage();
  await ui.setViewportSize({ width: 460, height: 600 });
  await ui.goto(`chrome-extension://${id}/ui/popup.html`);
  await ui.evaluate(async () => {
    await chrome.storage.local.set({ settings: { tosAccepted: true } });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  });
  const st = await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'update-check' }));
  check(st.latest?.version === next && st.native === true, `update check finds ${st.latest?.version}, updater reachable: ${st.native}`);
  const tabId = await ui.evaluate(() => chrome.tabs.query({}).then((t) => t[0].id));
  await ui.goto(`chrome-extension://${id}/ui/popup.html?tabId=${tabId}`);
  await ui.waitForSelector('.banner.update');
  check(/\d+\.\d+\.\d+/.test(await ui.locator('.banner.update').innerText()), `banner: ${(await ui.locator('.banner.update').innerText()).replace(/\s+/g, ' ')}`);
  await ui.screenshot({ path: join(shots, 'reelfetch-update-banner.png') });
  await ui.click('button[role=tab]:nth-child(4)');
  await ui.evaluate(() => document.querySelector('main').scrollTo(0, 1e6));
  await ui.screenshot({ path: join(shots, 'reelfetch-update-settings.png') });
  await ui.click('button[role=tab]:nth-child(1)');
  const refused = await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'update-apply' }));
  check(/not signed/.test(refused?.error ?? '') && version() === pkg.version, `update with a wrong signature is refused (${refused?.error})`);
  latest({ sig: signRelease(next, sha256) });
  await ui.click('.banner.update button');
  for (let i = 0; i < 60 && version() !== next; i++) await sleep(500);
  check(version() === next, `in-place update installed ${version()}`);
  let after;
  for (let i = 0; i < 30 && after?.version !== next; i++) {
    await sleep(500);
    after = await extInfo().catch(() => undefined);
  }
  check(after?.state === 'ENABLED' && after?.version === next, `extension reloaded itself into ${after?.version} (${after?.state})`);
  // And it works after the reload: its pages and background answer again.
  const ui2 = await ctx.newPage();
  await ui2.goto(`chrome-extension://${id}/ui/popup.html?tabId=${tabId}`);
  const st2 = await ui2.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' })).catch((e) => ({ error: String(e) }));
  check(st2?.update?.current === next, `background runs the new version (${st2?.update?.current ?? JSON.stringify(st2)})`);
} finally {
  await ctx.close();
  server.close();
  execFileSync(join(dir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES']);
  // The uninstaller hands off to a copy of itself and returns at once: wait until it is really done.
  for (let i = 0; i < 40 && (existsSync(extDir) || ps(`Test-Path '${hostKey}'`) === 'True'); i++) await sleep(500);
  check(!existsSync(extDir) && ps(`Test-Path '${hostKey}'`) === 'False', 'uninstall removed files and registry entries');
  // The keys are shared with a real ReelFetch install on this machine: put its registration back.
  for (const [k, v] of realHosts) ps(`New-Item -Force '${k}' | Out-Null; Set-ItemProperty '${k}' '(default)' '${v.replace(/'/g, "''")}'`);
  if (realHosts.length) check(realHosts.every(([k]) => ps(`Test-Path '${k}'`) === 'True'), `restored the real install's updater registration (${realHosts.length} browsers)`);
  // dist/ was built against the local test server: restore the normal build (browsers may load it).
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'ignore' });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll setup/update checks passed');
process.exit(failures ? 1 : 0);
