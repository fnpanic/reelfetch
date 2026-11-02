/** Isolated-world content script: reports <video>/<audio> sources, page thumbnail, and relays MSE capture events. */
import { genericMeta } from '../shared/sites';

const send = (msg: unknown) => {
  try {
    if (chrome.runtime?.id) void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* extension was reloaded; this script is orphaned */
  }
};

let last = '';
function scan() {
  const urls = new Set<string>();
  document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video, audio, video source, audio source').forEach((el) => {
    const src = (el as HTMLMediaElement).currentSrc || el.getAttribute('src');
    if (!src) return;
    try {
      const abs = new URL(src, location.href).href;
      if (/^https?:/.test(abs)) urls.add(abs);
    } catch {
      /* ignore bad URLs */
    }
  });
  const poster = document.querySelector<HTMLVideoElement>('video[poster]')?.poster;
  const og = window === top ? document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content : undefined;
  let thumbnail: string | undefined;
  try {
    // Absolute URL: the extension UI would otherwise resolve "/x.png" against its own origin.
    thumbnail = og || poster ? new URL((og || poster)!, location.href).href : undefined;
  } catch {
    /* ignore */
  }
  const msg = { type: 'page-media', urls: [...urls], title: document.title, thumbnail };
  const key = JSON.stringify(msg);
  if (key === last || (!msg.urls.length && !msg.thumbnail)) return;
  last = key;
  send(msg);
}

let timer: ReturnType<typeof setTimeout> | undefined;
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(scan, 700);
};
scan();
new MutationObserver(later).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src'],
});
document.addEventListener('loadedmetadata', later, true);
document.addEventListener('play', later, true);

// Generic page metadata (JSON-LD VideoObject, og:video) on every site, top frame only.
let lastMeta = '';
function scanMeta() {
  if (window !== top) return;
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'), (s) => s.textContent ?? '');
  const og: Record<string, string> = {};
  document.querySelectorAll<HTMLMetaElement>('meta[property^="og:video"], meta[name^="twitter:player:stream"]').forEach((m) => {
    og[m.getAttribute('property') ?? m.name] = new URL(m.content, location.href).href;
  });
  const items = genericMeta(jsonLd, og, document.title);
  const key = JSON.stringify(items);
  if (items.length && key !== lastMeta) {
    lastMeta = key;
    send({ type: 'site-media', items });
  }
}
scanMeta();
setTimeout(scanMeta, 3000);

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.__reelfetch === 'site' && Array.isArray(e.data.items)) {
    send({ type: 'site-media', items: e.data.items.slice(0, 20) });
    return;
  }
  if (e.data?.__reelfetch === 'turbo' && typeof e.data.msId === 'string') {
    const d = e.data;
    send({ type: 'turbo', event: d.event === 'done' ? 'done' : 'progress', msId: d.msId.slice(0, 40), time: Number(d.time) || 0, duration: Number(d.duration) || 0 });
    return;
  }
  if (e.data?.__reelfetch !== 'mse') return;
  const d = e.data;
  if (d.type === 'update' && typeof d.msId === 'string' && typeof d.bytes === 'number' && Array.isArray(d.mimes))
    send({ type: 'mse-update', msId: d.msId.slice(0, 40), bytes: d.bytes, mimes: d.mimes.map(String).slice(0, 8) });
  else if (d.type === 'drm') send({ type: 'drm-detected' });
});
