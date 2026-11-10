# Changelog

All notable changes to ReelFetch. Versions follow [semantic versioning](https://semver.org/); dates are release
dates. Releases are published to the update server with `npm run release:deploy` (see README → Publishing a release).

## 1.5.0 - 2026-11-10

Result of a full code, UI and security review. **Run the new Windows setup once**: the updater itself is only
replaced by a setup, and signed updates, the yt-dlp fixes and the uninstall fix live there.

### Security
- **A web page could make ReelFetch request any address with your cookies.** Stream URLs that a page merely
  reports (player data, Open Graph / JSON-LD tags) were analyzed at once. They are now fetched only when the page
  requests the stream itself or you point at the item; site-extractor reports are accepted only from the sites that
  have an extractor.
- **Signed updates.** A release carries an RSA signature; the Windows updater checks it against a pinned public key
  and refuses unsigned or older releases. Until now the update server alone decided what got installed.
- **Hostile DASH manifests** (zero segment duration, billions of repeats, gigabyte-wide number padding) hung the
  download engine. They are rejected.
- The offscreen engine and the engine-event channel no longer accept messages from content scripts.
- A tab keeps at most 500 media items and 20 inline manifests, so a page cannot exhaust the extension's storage.

### Fixed
- **The update check ran about every minute** instead of every 6 hours (the alarm was re-armed on every
  service-worker start), each time starting PowerShell for the updater ping.
- **Live recordings were deleted** when the stream paused for two minutes. A quiet stream is now saved as far as it
  got.
- **Large single-file DASH videos** (Facebook, Instagram) failed as "stalled": the file was read into memory in one
  piece without progress. They are streamed to disk like plain files.
- **Reddit / RedGifs videos went missing** after the service worker had restarted.
- Auto-update could reload forever when the browser loads the extension from a folder other than the installed
  one.
- One invalid entry in **capture sites** (for example a full `https://` address) disabled capture for all sites.
- A turbo capture cut short by closing the browser left the recorder active on that site.
- Settings changed in the background (capture toggle, picked title) were overwritten by an open sidebar.
- Windows: uninstall left the ~200 MB `tools` folder behind; a failed `yt-dlp -U` broke every yt-dlp download; a
  half-downloaded `yt-dlp.exe` was kept forever.
- CI ran on a branch that does not exist (`main`); it now runs on `master`, and only the tag build may write.

### Changed
- Light theme: darker accent red, so button and link text meets WCAG AA contrast.
- The ⋮ menu closes with Esc and when the focus leaves it.
- Finished yt-dlp downloads get a **Show download folder** button.
- The title picker and several error messages are translated.
- `release:deploy` runs typecheck and tests first and uses a pinned wrangler version.

## 1.4.2 - 2026-11-10

### Changed
- **One row per video name.** Pages that load their video as several streams (HLS, DASH, a plain file, ads) used to
  list the same name several times. The list now shows the most likely one (no DRM or error, a stream, longest,
  largest) and folds the others under **N more with the same name**. The toolbar badge, the tab count and the
  right-click menu count names, not streams.

## 1.4.1 - 2026-11-10

### Fixed
- **Retry** of a YouTube job created before 1.4.0 now uses yt-dlp too (it kept the old direct download and failed
  with `HTTP 403` again). The yt-dlp check also asks the Windows host directly when the periodic check hasn't run
  since the setup was installed.

## 1.4.0 - 2026-11-10

### Added
- **YouTube downloads with yt-dlp** (Windows setup). YouTube's CDN now often rejects ReelFetch's direct requests
  with `HTTP 403`; with the setup installed, YouTube jobs run through [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  instead, with progress and cancel in the Downloads tab. The first one sets up yt-dlp, Deno and (if not on the
  PATH) ffmpeg in `%LOCALAPPDATA%\ReelFetch	ools`, checked against their published SHA-256 sums; yt-dlp keeps
  itself up to date. Files go to the Windows Downloads folder. See docs/downloads.md.
- **⋮ → Download with yt-dlp** for any other item.

Existing installs need the 1.4.0 setup once (the self-update replaces only the extension, not the native host).

## 1.3.1 - 2026-11-09

### Added
- **Windows setup: copy button for the extension folder.** The last page shows the folder in a read-only field with a
  copy icon next to it, for pasting into "Load unpacked" again if the clipboard was overwritten. The field shows the
  folder actually installed to (before, the text always named the default folder).

### Fixed
- The setup's clipboard copy works for user names containing an apostrophe (`C:UsersO'Brien`).

### Tests
- `npm run e2e:update` no longer deletes the updater registration of a real ReelFetch install on the test machine
  (its uninstall step removed the shared registry keys, which silently stopped automatic updates). It now waits for
  the uninstaller to finish and restores the keys.

## 1.3.0 - 2026-11-09

### Added
- **Download speed and time remaining** in the Downloads tab (e.g. `12.3 MB / 80 MB · 4.1 MB/s · 0:17 left`).
- **Copy yt-dlp command** in the ⋮ menu: a ready-to-paste `yt-dlp` command with the page's Referer for streams
  and files, or the page URL for sites yt-dlp knows (YouTube, Vimeo, ...). A fallback for anything ReelFetch
  can't save itself.

### Fixed
- **Hover video previews play again.** The preview clip pointed at a temporary file that was deleted right after it
  was built, so the player got nothing (since 1.1.0).
- "Download failed" notifications no longer show private-window file names when private notifications are off.
- A resumed download on a server that ignores `Range` requests now says so instead of failing with `HTTP 200`.
- One malformed `og:video` URL no longer stops JSON-LD / Open Graph video detection on the page.
- Download history keeps a feed video's own post title (Reddit) instead of the subreddit's.
- The AES-128 key cache is capped (long live streams rotate keys).

### Tests
- e2e fetches the preview clip and checks its bytes (the old check only looked at the URL).
- Engine test for the no-`Range` resume error; unit tests for the yt-dlp command.

## 1.2.4 - 2026-11-04

### Fixed
- **Plain-file downloads are fast again and no longer fail with `HTTP 410`.** 1.2.3 fetched plain files as one
  8 MB range request after another. That paid a full round trip per chunk (large movies crawled at well under
  1 MB/s) and broke on hosts whose signed links expire or allow only a few requests (`410 Gone` for later chunks).
  Plain files are now fetched like the browser does: one streaming request, resumed with a `Range` request only
  after a dropped connection or a temporary server error (5xx/408/429, up to 5 attempts with backoff).
  YouTube's CDN (`googlevideo.com`), which throttles whole-file requests, keeps the 8 MB ranges.

### Tests
- Engine tests: a 30 MB file arrives byte-identical over a single request; a link that answers 410 on reuse still
  downloads; a connection dropped mid-file is resumed.
- e2e: the "server error" check allows for the retries.

## 1.2.3 - 2026-11-03

### Fixed
- **Downloads no longer show as "canceled" and keep ReelFetch's file name when a download-manager extension is
  installed** (e.g. AB Download Manager, IDM integration). Those extensions cancel and erase plain `http(s)`
  browser downloads and re-download the file under the server's name. ReelFetch now fetches every file itself and
  hands the finished file to the browser as a `blob:` URL, which they leave alone. A single plain file is saved
  byte-identical (no remux, any format).

### Tests
- e2e loads a mock download manager that takes over `http(s)` downloads and checks the `blob:` hand-over.
- The synthetic YouTube watch page used `http://` URLs on the HTTPS test server and only worked while the test
  Chromium's built-in HSTS list upgraded youtube.com; it now uses the request's real scheme.

## 1.2.2 - 2026-11-03

### Added
- **Reddit feeds: each video is named after its own post** instead of the subreddit page, on new Reddit
  (`shreddit-post[post-title]`) and old Reddit (`.thing[data-url]`), with the post's preview image.
  Covers Reddit-hosted videos (`v.redd.it`, `packaged-media.redd.it`, `i.redd.it`) and RedGifs embeds
  (`redgifs.com/watch|ifr/<slug>`, `api.redgifs.com/v2/gifs/<slug>/…`, `media.redgifs.com/<Slug>-….mp4`).

## 1.2.1 - 2026-11-02

### Fixed
- Settings scroll vertically again (the height cap now reaches `.app` through `#root`).

### Tests
- e2e: settings scrolling at every popup size; the self-update check verifies the reload into the new version.

## 1.2.0 - 2026-11-02

### Added
- Windows setup (`ReelFetch-Setup-<version>.exe`) with automatic updates from a Cloudflare-hosted update server,
  plus README sections for setup, updates and releases.
- Turbo capture keeps partial captures when the site stops playback and flags them.

### Fixed
- Downloads saved as `.txt` (untyped blobs), overflow scrollbars, stale UI after a service-worker restart, and
  stalled jobs holding a download slot.

## 1.1.0 - 2026-11-02

### Added
- Site extractors for YouTube, Vimeo, Bilibili, Facebook, Instagram, VK and OK.ru (split audio/video merged,
  original audio preferred); YouTube via its player API (iOS client profile) with Turbo capture as the fallback.
- Turbo capture, hover previews, on-page element picker for smart naming, default action, language preference lists.
- VDH file-type parity (54 extensions, MIME table), Vimeo config fallback, accessibility fixes.

## 1.0.0 - 2026-11-02

### Added
- First release: Chrome/Edge/Firefox MV3 extension that detects direct media, HLS and DASH (network + page),
  downloads with quality selection, merges audio/video without ffmpeg, handles AES-128 HLS, live HLS/DASH recording,
  ad-splice rebasing, MSE capture, MP3 conversion, download queue, history, notifications, 33 languages.
- DRM-protected media is detected and refused by design.
