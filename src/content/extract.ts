/**
 * Page-world site extractor (registered for the supported sites only). Reads the site's own player
 * data, runs the matching pure extractor and posts the result to the isolated content script.
 */
import { bilibili, facebook, okru, vimeo, vk, youtube, type SiteMedia } from '../shared/sites';

(() => {
  const w = window as unknown as Record<string, any> & { __reelfetchExtract?: boolean }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (w.__reelfetchExtract) return;
  w.__reelfetchExtract = true;

  const scriptsText = () => {
    let s = '';
    for (const el of Array.from(document.scripts)) {
      if (el.src || !el.textContent) continue;
      s += el.textContent + '\n';
      if (s.length > 8e6) break;
    }
    return s;
  };
  const ogTitle = () => document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? document.title;

  function extract(): SiteMedia[] {
    const h = location.hostname;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
      const id = new URL(location.href).searchParams.get('v') ?? location.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/)?.[1];
      const fromPlayer = document.querySelector<HTMLElement & { getPlayerResponse?: () => unknown }>('#movie_player')?.getPlayerResponse?.();
      const candidates = [fromPlayer, w.ytInitialPlayerResponse] as { videoDetails?: { videoId?: string } }[];
      // After SPA navigation ytInitialPlayerResponse is stale; trust whichever matches the URL.
      const pr = candidates.find((c) => c?.videoDetails && (!id || c.videoDetails.videoId === id));
      return youtube(pr as never);
    }
    if (/(^|\.)bilibili\.(com|tv)$/.test(h))
      return bilibili(w.__playinfo__ ?? w.__INITIAL_STATE__?.playinfo, (w.__INITIAL_STATE__?.videoData?.title as string) ?? ogTitle(), location.href);
    if (/(^|\.)vimeo\.com$/.test(h)) return vimeo(w.playerConfig ?? w.vimeo?.clip_page_config?.player?.config);
    if (/(^|\.)ok\.ru$/.test(h))
      return okru(Array.from(document.querySelectorAll('[data-options]'), (e) => e.getAttribute('data-options') ?? ''));
    if (/(^|\.)(vk\.(com|ru)|vkvideo\.ru)$/.test(h)) return vk(scriptsText(), ogTitle());
    if (/(^|\.)(facebook|instagram)\.com$/.test(h)) return facebook(scriptsText(), ogTitle());
    return [];
  }

  let last = '';
  function run() {
    let items: SiteMedia[] = [];
    try {
      items = extract();
    } catch (e) {
      console.debug('[ReelFetch] extractor failed', e);
    }
    const key = JSON.stringify(items);
    if (!items.length || key === last) return;
    last = key;
    window.postMessage({ __reelfetch: 'site', items }, '*');
  }

  run();
  // Sites load player data late and navigate without page loads (SPA): re-check periodically and on URL changes.
  let href = location.href;
  let ticks = 0;
  setInterval(() => {
    if (location.href !== href) {
      href = location.href;
      last = '';
      ticks = 0;
    }
    if (ticks++ < 20 || ticks % 5 === 0) run();
  }, 1500);
  document.addEventListener('yt-navigate-finish', () => setTimeout(run, 300));
})();
