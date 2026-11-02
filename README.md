# ReelFetch

An open-source browser extension for Chrome, Edge and Firefox that **detects and downloads video and audio from web pages**:
HLS (`.m3u8`), MPEG-DASH (`.mpd`), plain media files, and anything else a player streams through Media Source Extensions.
It covers the same feature set as Video DownloadHelper and needs no companion app.

Built with React, TypeScript, Vite and [mediabunny](https://mediabunny.dev) (a pure-TypeScript remuxer: no ffmpeg/WASM, 1.3 MB unpacked).

> For lawful use only: download content you own or are permitted to save. DRM-protected media is detected and
> refused; ReelFetch does not circumvent DRM.

## Install

### From a release (easiest)

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

## Use

1. Open a page and start the video. The toolbar badge shows how many media were found.
2. Click the ReelFetch icon (or press **Alt+↑**). Every detected media is listed with its type, quality, duration,
   size and languages.
3. Click **Download**, or open the **⋮** menu for *Download As…*, *Download audio only*, *Copy URL*, *Play* and *Details*.
   Pick a quality in the drop-down when a stream offers several.
4. Watch progress in **Downloads**. Live streams show **Record** and can be stopped at any time; the recording is saved.
5. **Alt+↓** downloads the best media of the current tab right away. The right-click menu offers the same.

**No video found?** Click *No video?* → *Reload page*, or enable **stream capture** for the site. ReelFetch then
records what the player feeds into the `<video>` element (Media Source Extensions). Play the video through, then save it.
This catches players that hide their playlists.

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
| Download As… / always ask, download sub-directory | ✅ | ✅ |
| Smart naming (per-site XPath rules) | ✅ | ✅ (CSS selector or XPath) plus filename templates |
| Download history with retention, opt-in, clear | ✅ | ✅ (local only, skips private windows) |
| Completion notifications | ✅ | ✅ |
| Popup or sidebar, window size, theme, text size | ✅ | ✅ (Chrome side panel / Firefox sidebar) |
| Right-click menu with detected media | ✅ | ✅ |
| Hotkeys Alt+↑ (open) and Alt+↓ (default action) | ✅ | ✅ |
| Media sorting (smart/newest/oldest), hide duplicate sub-playlists | ✅ | ✅ |
| "No video?" force-detection reload | ✅ (also clears cookies) | ✅ (cache-bypassing reload) |
| Copy media details to clipboard | ✅ | ✅ |
| Terms notice, reset settings, reload add-on | ✅ | ✅ |
| Replay page Referer/Origin to protected CDNs | ✅ | ✅ (session `declarativeNetRequest` rules) |
| Record any MSE-fed stream (no manifest needed) | ❌ | ✅ |
| Site-specific extractors (YouTube, Facebook, Vimeo, VK, OK, Bilibili, Kick, …) | ✅ | ❌, see below |
| Conversion to MP3 (VDH: companion app with ffmpeg) | ✅ | ✅ built in, no extra app (WebCodecs decode + LAME/WASM) |
| Other transcodes via the companion app (e.g. AVI, resize) | ✅ | ❌ (lossless remux to MP4/WebM/MKV instead) |
| Premium/licence, account | ✅ | not applicable (free) |
| Languages | 33 | the same 33 (en, de hand-written; others machine-translated, review welcome) |

**Why no site-specific extractors?** VDH ships per-site scripts that scrape player internals (e.g. YouTube signature
deciphering). That is a circumvention of the site's protection, breaks whenever the site changes, and the Chrome Web
Store forbids YouTube downloaders. ReelFetch relies on generic network detection instead, which covers every site
that streams plain HLS, DASH or files, plus MSE capture as the catch-all for players that hide their streams.

**"Any stream" - what that means here:** every unprotected stream a browser can play is downloadable, either via its
manifest/file or via MSE capture of what the player plays. DRM-protected media (Widevine, PlayReady, FairPlay,
`SAMPLE-AES`) is the deliberate exception, exactly as in VDH: decrypting it would mean circumventing copy protection.

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
    page.ts        reports <video> sources, thumbnail; relays capture events
    mse-hook.ts    page-world MediaSource/SourceBuffer recorder (only on sites you enable)
    mse-save.ts    injected on demand: remuxes captured buffers and saves them
  shared/          pure logic: HLS + DASH parsers, detection, quality picking, naming, settings, types
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
npm run typecheck
npm run build
npm run e2e          # loads dist/chrome into Chromium and runs detection/download/capture end-to-end
```

`npm run e2e` needs a Chromium that allows `--load-extension` (e.g. Playwright's:
`npx playwright-core install chromium`, found automatically) and `ffprobe`; pass their paths as arguments:
`node scripts/e2e.mjs <chrome.exe> <ffprobe>`.
Test fixtures in `test/fixtures` were generated with ffmpeg (see `test/fixtures/README.md`).

## Known limitations

- MSE capture records only what is played. Seeking while recording can produce gaps.
- HLS `SAMPLE-AES` and any Widevine/PlayReady/FairPlay content is DRM and is refused by design.
- Live recordings start at the live edge (like a player), not at the beginning of the DVR window.
- Audio-only MP3 conversion applies to stream/file downloads; MSE captures are saved in their original codec.
- Firefox: unsigned add-ons only load temporarily in release builds (see Install). The Firefox build passes
  `web-ext lint` with 0 errors (remaining warnings are feature-detected Chrome-only APIs), but the automated
  in-browser test runs on Chromium only.

## License

MIT
