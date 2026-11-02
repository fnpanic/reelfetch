// Builds a release and (with --deploy) publishes it as a Cloudflare Worker with static assets,
// which serves the updates (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID or `wrangler login`):
//   node scripts/release.mjs [--deploy]
// Output in release/: latest.json (read by the extension and the Windows updater), the Chrome zip
// (applied in place by the updater), the Windows setup, the Firefox zip and a small download page.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { cloudflareWorker } = pkg.reelfetch ?? {};
const updateUrl = process.env.REELFETCH_UPDATE_URL ?? pkg.reelfetch?.updateUrl;
if (!updateUrl || !cloudflareWorker) throw new Error('package.json needs reelfetch.updateUrl and reelfetch.cloudflareWorker');
const v = pkg.version;
const out = join(root, 'release');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

run(process.execPath, ['scripts/build.mjs'], { env: { ...process.env, REELFETCH_UPDATE_URL: updateUrl } });
const { extensionId } = JSON.parse(readFileSync(join(root, 'dist', 'build.json'), 'utf8'));

// Windows icon: an .ico may embed PNG images directly.
const pngs = [16, 32, 48, 128].map((s) => [s, readFileSync(join(root, 'public', 'icons', `${s}.png`))]);
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(pngs.length, 4);
let offset = head.length;
pngs.forEach(([s, png], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s, e);
  head.writeUInt8(s, e + 1);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(join(root, 'installer', 'reelfetch.ico'), Buffer.concat([head, ...pngs.map(([, p]) => p)]));

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const iscc = ['C:/Program Files (x86)/Inno Setup 6/ISCC.exe', 'C:/Program Files/Inno Setup 6/ISCC.exe'].find(existsSync);
if (!iscc) throw new Error('Inno Setup 6 not found (https://jrsoftware.org/isdl.php)');
run(iscc, ['/Q', `/DAppVersion=${v}`, `/DExtensionId=${extensionId}`, `/DUpdateBase=${updateUrl}`,
  `/DSrcDir=${join(root, 'dist', 'chrome')}`, `/DOutDir=${out}`, join(root, 'installer', 'reelfetch.iss')]);

const zip = `reelfetch-chrome-${v}.zip`;
const setup = `ReelFetch-Setup-${v}.exe`;
copyFileSync(join(root, 'dist', zip), join(out, zip));
copyFileSync(join(root, 'dist', `reelfetch-firefox-${v}.zip`), join(out, `reelfetch-firefox-${v}.zip`));
const sha256 = createHash('sha256').update(readFileSync(join(out, zip))).digest('hex');
const notes = process.env.RELEASE_NOTES ?? '';
writeFileSync(join(out, 'latest.json'), JSON.stringify({ version: v, zip, sha256, setup, notes }, null, 2));
// latest.json must never be cached, or clients would miss releases.
writeFileSync(join(out, '_headers'), '/latest.json\n  Cache-Control: no-store\n  Access-Control-Allow-Origin: *\n');
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReelFetch ${v}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1c1b1a;background:#fbfaf8}
a.btn{display:inline-block;background:#e5484d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{color:#ecebe8;background:#161514}a{color:#ff6369}}</style>
<h1>ReelFetch ${v}</h1>
<p><a class="btn" href="${setup}">Download for Windows</a></p>
<p>Chrome, Edge and Brave. Run the setup and follow the one step it shows; updates install themselves afterwards.</p>
<p>Other downloads: <a href="${zip}">Chrome zip</a> · <a href="reelfetch-firefox-${v}.zip">Firefox zip</a></p>
</html>`,
);
console.log(`Release ${v} in release/ (extension id ${extensionId}).`);

if (process.argv.includes('--deploy')) {
  // One command string: npx is a .cmd on Windows and needs the shell.
  execFileSync(`npx --yes wrangler@4 deploy --name ${cloudflareWorker} --assets release --compatibility-date 2026-10-01`, {
    stdio: 'inherit',
    cwd: root,
    shell: true,
  });
  console.log(`Published to ${updateUrl}`);
}
