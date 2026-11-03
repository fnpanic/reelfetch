# How downloads work

This page explains what happens between clicking **Download** and the file appearing in the browser's download
list, and how to diagnose the problems that are most often reported.

## Pipeline

1. **Detection** - the background service worker sees media requests (`webRequest`), the content script reports
   `<video>`/`<audio>` sources and page metadata, and site extractors (YouTube, Vimeo, ...) report player data.
   Each find becomes an item in the popup.
2. **Naming** - the file name comes from the filename template (Settings). `{title}` is, in order of precedence:
   the text picked by a smart-naming rule for the site, the post title on feed pages (Reddit, including RedGifs
   embeds), the site extractor's title, and finally the tab title.
3. **Fetching** - every job except MSE/Turbo captures runs in ReelFetch's engine (offscreen document in
   Chrome/Edge, background page in Firefox). The engine replays the page's `Referer`/`Origin` through a session
   `declarativeNetRequest` rule and sends the site's cookies, then writes to a temporary file in the Origin Private
   File System, so multi-GB files don't sit in RAM.
   - **Plain files** (`.mp4`, `.webm`, `.mkv`, ...): one streaming request, like the browser's own downloader. If the
     connection drops or the server answers 5xx/408/429, the download resumes with a `Range` request from the
     current position (up to 5 attempts, exponential backoff). The file is saved byte-identical - no remux.
   - **YouTube's CDN** (`googlevideo.com`) throttles whole-file requests, so it is fetched in 8 MB ranges.
   - **HLS/DASH**: segments are downloaded (AES-128 decrypted where needed) and remuxed with mediabunny into MP4
     (or WebM/MKV/M4A/MP3 by settings); separate audio/video tracks are merged.
4. **Hand-over** - the finished file is passed to `chrome.downloads` as a `blob:` URL with the final name. Because
   the browser only receives the finished file, it appears in the browser's download list when the transfer is
   complete; live progress is shown in ReelFetch's **Downloads** tab.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Download shows **canceled**, file has the server's name (e.g. `abc123-silent.mp4`) | A download-manager extension (AB Download Manager, IDM integration, ...) took over a plain `http(s)` browser download. Fixed in 1.2.3: ReelFetch hands over `blob:` URLs, which those extensions ignore. | Update to 1.2.3 or later. |
| **HTTP 410** (Gone) or 403 part-way through a large file | The host's signed link expired or allows few requests, and 1.2.3 made one request per 8 MB chunk. Fixed in 1.2.4 (one streaming request). | Update to 1.2.4 or later and retry the job. If it still happens, the link expired before the download started: reload the page so the site issues a fresh link, then download again. |
| Large files are **slow** (well under the connection's speed) | 1.2.3's per-chunk requests. Fixed in 1.2.4. | Update to 1.2.4 or later. |
| Feed videos (Reddit) are named after the **subreddit** | Older than 1.2.2, or the post wasn't on the page when the video was detected. | Update; let the video start playing in the feed (that's when it is detected). |
| **HTTP 503/5xx** errors | Server-side failure. Retried automatically with backoff (about 12 s in total) before the job fails. | Use **Retry** later. |
| "DRM-protected" | Widevine/PlayReady/FairPlay or HLS `SAMPLE-AES`. | Not supported by design. |

## Updates and running downloads

The extension checks the update server periodically. With automatic updates on, an update is installed **only
while no download is running or queued**, so a release never interrupts downloads in progress.
