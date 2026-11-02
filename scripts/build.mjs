// Builds dist/chrome and dist/firefox (unpacked) plus ready-to-install zips.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'dist', 'chrome');
rmSync(join(root, 'dist'), { recursive: true, force: true });

// 1. Extension pages + background (ES modules, shared chunks).
await build({
  configFile: false,
  root: join(root, 'src'),
  publicDir: join(root, 'public'),
  plugins: [react()],
  logLevel: 'warn',
  build: {
    outDir: out,
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        popup: join(root, 'src/ui/popup.html'),
        sidebar: join(root, 'src/ui/sidebar.html'),
        offscreen: join(root, 'src/offscreen/offscreen.html'),
        background: join(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});

// 2. Content scripts must be single classic scripts.
for (const name of ['page', 'mse-hook', 'mse-save']) {
  await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'es2022',
      lib: { entry: join(root, `src/content/${name}.ts`), formats: ['iife'], name: 'reelfetch', fileName: () => `content/${name}.js` },
    },
  });
}

// 3. Locales.
for (const f of readdirSync(join(root, 'src/i18n'))) {
  const strings = JSON.parse(readFileSync(join(root, 'src/i18n', f), 'utf8'));
  const dir = join(out, '_locales', f.replace('.json', ''));
  mkdirSync(dir, { recursive: true });
  const messages = Object.fromEntries(Object.entries(strings).map(([k, v]) => [k, { message: v }]));
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages, null, 1));
}

// 4. Manifests.
const icons = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };
const common = {
  manifest_version: 3,
  name: '__MSG_appName__',
  short_name: 'ReelFetch',
  version: pkg.version,
  description: '__MSG_appDesc__',
  default_locale: 'en',
  icons,
  action: { default_icon: icons, default_title: 'ReelFetch', default_popup: 'ui/popup.html' },
  host_permissions: ['<all_urls>'],
  optional_permissions: ['downloads.open'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['content/page.js'], run_at: 'document_idle', all_frames: true }],
  commands: {
    _execute_action: { suggested_key: { default: 'Alt+Up', mac: 'Ctrl+Shift+Up' } },
    'default-action': {
      suggested_key: { default: 'Alt+Down', mac: 'Ctrl+Shift+Down' },
      description: '__MSG_cmd_default_action__',
    },
  },
};
const basePerms = [
  'tabs',
  'storage',
  'unlimitedStorage',
  'downloads',
  'webRequest',
  'webNavigation',
  'scripting',
  'declarativeNetRequestWithHostAccess',
  'notifications',
  'contextMenus',
];
const manifests = {
  chrome: {
    ...common,
    minimum_chrome_version: '116',
    background: { service_worker: 'background.js', type: 'module' },
    permissions: [...basePerms, 'offscreen', 'sidePanel'],
    side_panel: { default_path: 'ui/sidebar.html' },
  },
  firefox: {
    ...common,
    background: { scripts: ['background.js'], type: 'module' },
    permissions: basePerms,
    sidebar_action: { default_panel: 'ui/sidebar.html', default_title: 'ReelFetch', default_icon: icons, open_at_install: false },
    browser_specific_settings: {
      gecko: { id: 'reelfetch@reelfetch.app', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } },
    },
  },
};

cpSync(out, join(root, 'dist', 'firefox'), { recursive: true });
const files = (dir) =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

for (const [target, manifest] of Object.entries(manifests)) {
  const dir = join(root, 'dist', target);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (target === 'firefox') rmSync(join(dir, 'offscreen'), { recursive: true, force: true });
  const zip = Object.fromEntries(files(dir).map((f) => [relative(dir, f).replaceAll('\\', '/'), readFileSync(f)]));
  writeFileSync(join(root, 'dist', `reelfetch-${target}-${pkg.version}.zip`), zipSync(zip, { level: 9 }));
}
console.log(`Built dist/chrome, dist/firefox and zips (v${pkg.version}).`);
