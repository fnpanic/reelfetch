# Changelog

All notable changes to ReelFetch. Versions follow [semantic versioning](https://semver.org/); dates are release
dates. Releases are published to the update server with `npm run release:deploy` (see README → Publishing a release).

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
