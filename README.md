# ReelFetch

An open-source browser extension for Chrome, Edge and Firefox that **detects and downloads video and audio from web pages**:
HLS (`.m3u8`), MPEG-DASH (`.mpd`), plain media files, and anything else a player streams through Media Source Extensions.
It covers the same feature set as Video DownloadHelper and needs no companion app.

Built with React, TypeScript, Vite and [mediabunny](https://mediabunny.dev) (a pure-TypeScript remuxer: no ffmpeg/WASM, 1.3 MB unpacked).

> For lawful use only: download content you own or are permitted to save. DRM-protected media is detected and
> refused; ReelFetch does not circumvent DRM.

## Install

### Windows setup (easiest, with automatic updates)

1. Download **`ReelFetch-Setup-<version>.exe`** from https://reelfetch-updates.thomas-schend.workers.dev and run it
   (no admin rights needed; Windows SmartScreen may ask once because the setup is not code-signed: *More info* →
   *Run anyway*).
2. The setup copies the extension to `%LOCALAPPDATA%\ReelFetch\extension`, puts that path on the clipboard and opens
   the browser's extensions page (Chrome, else Edge, else Brave). There: switch on **Developer mode**, click
   **Load unpacked**, paste the path and pick **Select folder**. Browsers do not let any installer add an extension
   from outside their store silently, so this one confirmation is required once.
3. Done. ReelFetch checks for updates every 6 hours (Settings → **Updates** → *Check for updates* does it now) and
   installs them itself when no download is running - or shows an **Update now** banner if automatic updates are off.
   Uninstall via *Settings → Apps*; then remove the extension from the browser's extensions page.

### From a release zip

1. Download `reelfetch-chrome-<version>.zip` or `reelfetch-firefox-<version>.zip` from the
   [Releases](../../releases) page (or build it yourself, see below).
2. **Chrome / Edge / Brave / Opera:** unzip it, open `chrome://extensions` (`edge://extensions`), switch on
   **Developer mode**, click **Load unpacked** and select the unzipped folder.
3. **Firefox (140+):** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick the zip.
   To install permanently, sign the zip at [addons.mozilla.org](https://addons.mozilla.org/developers/) (unlisted is
   fine) or use Firefox Developer Edition/Nightly with `xpinstall.signatures.required = false`.
   On first open, click **Grant access** so ReelFetch can see website traffic.

### Build from source

```bash
npm install
npm run build        # -> dist/chrome, dist/firefox, dist/reelfetch-{chrome,firefox}-<version>.zip
```

Requires Node.js 20.19+ or 22.12+.

### Publishing a release (Windows setup + updates)

```bash
# bump "version" in package.json first; needs Inno Setup 6 and Cloudflare credentials
# (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or `npx wrangler login`)
npm run release          # -> release/: setup .exe, zips, latest.json, download page
npm run release:deploy   # same, then publishes release/ as the Cloudflare Worker in package.json "reelfetch"
```

How updates work: the extension (`src/background/update.ts`) reads `latest.json` from `reelfetch.updateUrl`. The setup
registers a native messaging host (`installer/updater.ps1`, allowed for this extension's fixed ID only) for Chrome,
Edge, Brave and Chromium. On *update* it downloads `latest.json` and the zip it names **from the URL fixed at install
time**, checks the SHA-256, mirrors the files into the extension folder, and the extension reloads itself. Installs
without the setup (zip, Firefox) only show a banner linking to the new download.

## Use

1. Open a page and start the video. The toolbar badge shows how many media were found.
2. Click the ReelFetch icon (or press **Alt+↑**). Every detected media is listed with its type, quality, duration,
   size and languages.
3. Click the main button (by default **Download**; configurable to *Download As…*, *Audio* or *Copy URL*), or open
   the **⋮** menu for *Download*, *Download As…*, *Download audio only*, *Copy URL*, *Play*, *Turbo capture*,
   *Pick the title from the page…* and *Details*. Pick a quality in the drop-down when a stream offers several.
   Hover a thumbnail for a short video preview (Settings → Media preview).
4. Watch progress in **Downloads**. Live streams show **Record** and can be stopped at any time; the recording is saved.
5. **Alt+↓** runs the default action on the best media of the current tab. The right-click menu offers the same.

**YouTube, Vimeo, Bilibili, Facebook, Instagram, VK, OK.ru:** site extractors read the player's own data and list
every quality with the real video title; separate video and audio streams are merged automatically, the original
(non-dubbed) audio track is preferred. When a site exposes no direct stream URLs (e.g. YouTube's ciphered / SABR
streams), the item offers **Turbo capture**.

**Turbo capture** (works on any site): ReelFetch reloads the page, plays the video *muted at up to 16× speed* from the
start at the best quality, skips YouTube pre-roll ads, records exactly what the player receives and saves it
automatically when the video ends. The speed adapts to the player's buffer: it races while plenty is buffered and
slows down before the player starves (YouTube buffers ~60 s ahead and resets itself when it runs dry), so turbo runs
as fast as the site delivers. A watchdog saves what was captured if a player stops making progress for 45 s.

**No video found?** Click *No video?* → *Reload page* (optionally clearing the site's cookies), start a *Turbo
capture*, or enable **stream capture** for the site to record what the player plays at normal speed.

## Feature parity with Video DownloadHelper

The reference feature set was taken from the shipped VDH 10.6.7.2 extension (manifest, UI strings and bundle
analysis with REA).

| Feature | VDH | ReelFetch |
|---|---|---|
| Detect direct media, HLS and DASH from network traffic | ✅ | ✅ (`webRequest`) plus `<video>`/`<source>` scan |
| Quality variants, preferred quality (highest/1080/720/480) | ✅ | ✅ |
| Merge separate audio/video, MP4 output, "prefer MKV" | ✅ (libav WASM) | ✅ (mediabunny remux, MP4/WebM/MKV, M4A/MP3/OGG audio) |
| Audio-only download, "always audio only for this website" | ✅ | ✅ |
| HLS AES-128 encrypted streams | ✅ | ✅ (WebCrypto) |
| HLS byte ranges, `EXT-X-MAP` (fMP4), `EXT-X-DEFINE`, discontinuities | ✅ | ✅ |
| DASH SegmentTemplate (`$Number$`/`$Time$`/timeline), SegmentList, SegmentBase, multi-period | ✅ | ✅ |
| Live HLS and live DASH recording with stop | ✅ | ✅ (joins at the live edge; finalizes even if the stream drops) |
| HLS discontinuities / multi-period DASH (stitched ads) | ✅ | ✅ (timestamps rebased per track) |
| DRM detection and refusal | ✅ | ✅ (HLS key formats, DASH `ContentProtection`, EME in the page) |
| Preferred audio and subtitle languages, subtitle download | ✅ | ✅ (WebVTT sidecar file) |
| Download queue, max concurrent downloads, stop/retry, open file / show folder | ✅ | ✅ |
| Works next to download-manager extensions (AB Download Manager, IDM, ...) | not checked | ✅ files reach the browser as `blob:` URLs, so they keep ReelFetch's name and aren't taken over |
| Download As… / always ask, download sub-directory | ✅ | ✅ |
| Smart naming (per-site XPath rules) | ✅ | ✅ (CSS selector or XPath) plus filename templates |
| Download history with retention, opt-in, clear | ✅ | ✅ (local only, skips private windows) |
| Completion notifications | ✅ | ✅ |
| Popup or sidebar, window size, theme, text size | ✅ | ✅ (Chrome side panel / Firefox sidebar) |
| Right-click menu with detected media | ✅ | ✅ |
| Hotkeys Alt+↑ (open) and Alt+↓ (default action) | ✅ | ✅ |
| Media sorting (smart/newest/oldest), hide duplicate sub-playlists | ✅ | ✅ |
| "No video?" force-detection reload, optionally clearing the site's cookies | ✅ | ✅ |
| Copy media details to clipboard | ✅ | ✅ |
| Terms notice, reset settings, reload add-on | ✅ | ✅ |
| Replay page Referer/Origin to protected CDNs | ✅ | ✅ (session `declarativeNetRequest` rules) |
| Site extractors: YouTube, Vimeo, Bilibili, Facebook, Instagram, VK, OK.ru | ✅ | ✅ (player data; split audio/video merged; original audio preferred) |
| Kick, TwitCasting, Chaturbate, iQIYI, Canva and other HLS/DASH sites | ✅ (per-site scripts) | ✅ via generic HLS/DASH detection |
| JSON-LD `VideoObject` / Open Graph video on any page | - | ✅ |
| YouTube via YouTube's own API (VDH: SABR client) | ✅ | ✅ player API, iOS client profile (direct streams, all qualities) + Turbo capture fallback |
| Default action (download / download as / audio / copy URL), "always copy URL" | ✅ | ✅ |
| Media preview: image or short video preview | ✅ | ✅ (engine builds a 6 s clip of HLS/DASH streams) |
| Smart naming: pick the title element on the page | ✅ (smart-naming page) | ✅ (on-page element picker) |
| Feed pages (Reddit): each video named after its own post, not the page | - | ✅ (new and old Reddit; Reddit-hosted `v.redd.it` videos and RedGifs embeds) |
| Language preference lists (add / move / remove), prefer original audio | ✅ | ✅ |
| Private browsing: warning when disabled, notifications for private downloads | ✅ | ✅ |
| "Change browser download directory" shortcut | ✅ | ✅ |
| 100-downloads milestone | ✅ | ✅ |
| Record any MSE-fed stream at normal speed (no manifest needed) | ❌ | ✅ |
| Conversion to MP3 | via companion app | ✅ built in, no extra app (WebCodecs decode + LAME/WASM) |
| Premium/licence, account, reviews, reporting to vendor servers | ✅ | not applicable (free, no servers) |
| Languages | 33 | the same 33 (en, de hand-written; others machine-translated, review welcome) |

**How YouTube works here:** when the page's player data contains plain stream URLs, they are listed and merged like
any other site. When it only offers SABR streams (today's normal case), ReelFetch asks YouTube's player API with the
iOS client profile - like VDH, it gets the stream list from YouTube's own API - and lists every quality with separate
video + audio merged (original audio preferred). The matching User-Agent is applied by a session rule scoped to the
extension's own requests. Turbo capture remains as the fallback (and can be turned off/on: Settings → YouTube player
API). The Chrome Web Store doesn't accept YouTube downloaders; install from the zip.

**"Any stream" - what that means here:** every unprotected stream a browser can play is downloadable, either via its
manifest/file or via MSE capture of what the player plays. DRM-protected media (Widevine, PlayReady, FairPlay,
`SAMPLE-AES`) is the deliberate exception, exactly as in VDH: decrypting it would mean circumventing copy protection.

## Documentation

- [How downloads work](docs/downloads.md) - pipeline from detection to the saved file, troubleshooting table
  (canceled downloads, HTTP 410, slow downloads, naming).
- [Changelog](CHANGELOG.md) - what changed in each version.

## Architecture

```
src/
  background/      service worker (Chrome) / event page (Firefox)
    index.ts       detection (webRequest + content reports), per-tab media list, badge, queue,
                   downloads, history, notifications, context menu, hotkeys, UI mode
    engine-client  routes engine calls: offscreen document (Chrome) or in-process (Firefox)
    rules.ts       session DNR rules that replay Referer/Origin for the extension's own requests
  engine/          stream pipeline (runs in a DOM context)
    engine.ts      manifest analysis, track planning (HLS/DASH), ordered parallel segment download,
                   live recording (HLS + DASH), subtitle joining, MP3 option, raw-stream fallback
    net.ts         fetch with retries and byte ranges, AES-128 decryption
    spool.ts       temp storage in OPFS (multi-GB safe), memory fallback
    mux.ts         timestamp-interleaved packet remux of 1..n inputs into MP4/WebM/MKV/M4A/…,
                   with rebasing across discontinuities
    mp3.ts         MP3 transcoding (engine only, keeps LAME out of content scripts)
    host.ts        message handler + job registry (cancel/stop/release)
  offscreen/       Chrome offscreen document hosting the engine
  content/
    page.ts        reports <video> sources, thumbnail, JSON-LD/og:video; relays capture/site events
    extract.ts     page-world site extractors glue (YouTube, Vimeo, Bilibili, Facebook/Instagram, VK, OK)
    picker.ts      on-page element picker for smart naming
    mse-hook.ts    page-world MediaSource/SourceBuffer recorder + turbo playback driver (only on enabled sites)
    mse-save.ts    injected on demand: remuxes captured buffers and saves them
  shared/          pure logic: HLS + DASH parsers, site extractors, detection, quality, naming, settings, types
  ui/              React popup/sidebar (Media, Downloads, History, Settings)
  i18n/            33 locales as flat JSON (compiled to _locales by the build)
```

How a download works: the background picks the job off the queue → a session DNR rule replays the page's Referer →
the engine fetches the manifest and plans tracks (video, separate audio, optional subtitles) → segments download six
at a time but are written in order to OPFS, decrypted when needed → mediabunny remuxes the tracks into one file →
a blob URL goes to `chrome.downloads` → once the download completes, temp files and blob URLs are released.
If remuxing ever fails (exotic codec), the raw streams (`.ts`, `.mp4`, …) are saved instead, so the data is never lost.

Plain files skip the engine and go straight to the browser's download manager (resumable, no memory use).

## Development

```bash
npm test             # unit + engine integration tests (real HLS/DASH fixtures over HTTP) + locale checks
RF_NETWORK=1 npm test  # also checks public reference streams (DASH-IF livesim2 live DASH, Mux HLS)
npx web-ext lint --source-dir dist/firefox   # Mozilla's add-on linter on the Firefox build
npm run live:detect  # real sites: what the extractors / detection find (needs internet)
npm run live:youtube # real YouTube: extractor + full turbo capture, validated with ffprobe
npm run typecheck
npm run build
npm run e2e          # loads dist/chrome into Chromium and runs detection/download/capture end-to-end
npm run e2e:update   # Windows: installs the setup, self-updates through the updater, uninstalls
```

`npm run e2e` needs a Chromium that allows `--load-extension` (e.g. Playwright's:
`npx playwright-core install chromium`, found automatically) and `ffprobe`; pass their paths as arguments:
`node scripts/e2e.mjs <chrome.exe> <ffprobe>`.
Test fixtures in `test/fixtures` were generated with ffmpeg (see `test/fixtures/README.md`).

## Known limitations

- MSE capture records only what is played. Seeking while recording can produce gaps (Turbo capture avoids this by
  playing from the start). Turbo capture follows the player's adaptive quality; it requests the best level on
  YouTube, other players may pick lower levels on slow connections.
- Live-site status (checked 2026-11-02 with `npm run live:detect` / `live:youtube` from Germany, headless Chromium):
  YouTube extractor ✅ (title/duration; today's YouTube is SABR-only, so it offers Turbo capture). YouTube Turbo
  capture produced a valid 1080p AV1 + Opus file, but only of the first ~60 s: YouTube stops playback in automated
  headless browsers (it doesn't even play at 1× there without the extension), so the watchdog saved the partial
  capture - a full-length run needs a normal browser profile. Vimeo ✅
  (title, 4 qualities - this public video is FairPlay-DRM'd by Vimeo and correctly refused), generic HLS (hls.js demo)
  ✅. Bilibili redirected the headless browser to an error page and OK.ru needs a valid video id, so those two
  extractors are covered by unit tests only; Facebook/Instagram/VK need logins and are unit-tested only. Sites change
  their page data, so an extractor can break - Turbo capture and the generic HLS/DASH detection keep working then.
- Every file is fetched by ReelFetch itself and handed to the browser's download list when complete.
  Download-manager integrations such as AB Download Manager take over plain http downloads by canceling them, which
  showed up as "canceled" jobs with the server's file name; `blob:` downloads are left alone. Because the browser only
  sees the finished file, its download list shows it once the transfer is done (progress is in ReelFetch).
- Plain files are fetched like the browser does: one streaming request, resumed with a `Range` request only if the
  connection drops. Many hosts sign file links with an expiry or a request limit and answer `410 Gone` to later
  requests, so per-chunk requests (1.2.3) failed and were slow; only YouTube's CDN, which throttles whole-file
  requests, is still fetched in 8 MB ranges.
- HLS `SAMPLE-AES` and any Widevine/PlayReady/FairPlay content is DRM and is refused by design (as in VDH).
- Live recordings start at the live edge (like a player), not at the beginning of the DVR window.
- Audio-only MP3 conversion applies to stream/file downloads; MSE captures are saved in their original codec.
- Firefox: unsigned add-ons only load temporarily in release builds (see Install). The Firefox build passes
  `web-ext lint` with 0 errors (remaining warnings are feature-detected Chrome-only APIs), but the automated
  in-browser test runs on Chromium only.

## License

MIT
