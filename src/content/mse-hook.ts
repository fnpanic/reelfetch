/**
 * Page-world script (only registered for sites where the user enabled stream capture).
 * Records every chunk the player appends to Media Source Extensions buffers, so streams that
 * use no recognizable manifest can still be saved. Captures only what gets played.
 */
(() => {
  const w = window as unknown as Record<string, unknown> & { __reelfetchHook?: boolean };
  if (w.__reelfetchHook) return;
  w.__reelfetchHook = true;

  interface Buf {
    msId: string;
    mime: string;
    chunks: ArrayBuffer[];
    bytes: number;
  }
  const sources = new Map<string, Buf[]>();
  const msIds = new WeakMap<object, string>();
  const bufs = new WeakMap<SourceBuffer, Buf>();
  const pending = new Set<string>();
  let timer = 0;

  const post = (data: Record<string, unknown>) => window.postMessage({ __reelfetch: 'mse', ...data }, '*');
  const flush = () => {
    timer = 0;
    for (const msId of pending) {
      const list = sources.get(msId) ?? [];
      post({ type: 'update', msId, bytes: list.reduce((n, b) => n + b.bytes, 0), mimes: list.map((b) => b.mime) });
    }
    pending.clear();
  };
  const schedule = (msId: string) => {
    pending.add(msId);
    if (!timer) timer = window.setTimeout(flush, 1000);
  };

  for (const name of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) {
    const Ctor = w[name] as { prototype: MediaSource } | undefined;
    if (!Ctor?.prototype?.addSourceBuffer) continue;
    const orig = Ctor.prototype.addSourceBuffer;
    Ctor.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
      const sb = orig.call(this, mime);
      let id = msIds.get(this);
      if (!id) {
        id = Math.random().toString(36).slice(2, 12);
        msIds.set(this, id);
        sources.set(id, []);
      }
      const buf: Buf = { msId: id, mime, chunks: [], bytes: 0 };
      sources.get(id)!.push(buf);
      bufs.set(sb, buf);
      schedule(id);
      return sb;
    };
  }

  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    const b = bufs.get(this);
    if (b) {
      const copy =
        data instanceof ArrayBuffer
          ? data.slice(0)
          : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
      b.chunks.push(copy);
      b.bytes += copy.byteLength;
      schedule(b.msId);
    }
    return append.call(this, data);
  };

  // Map blob: URLs to their MediaSource so turbo capture knows which capture belongs to the main <video>.
  const msByUrl = new Map<string, string>();
  const createURL = URL.createObjectURL;
  URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = createURL.call(URL, obj);
    if (!(obj instanceof Blob)) {
      let id = msIds.get(obj);
      if (!id) {
        id = Math.random().toString(36).slice(2, 12);
        msIds.set(obj, id);
        sources.set(id, []);
      }
      msByUrl.set(url, id);
    }
    return url;
  };

  /** True when a chunk starts a new init segment (fMP4 ftyp/moov, WebM EBML header). */
  const isInit = (b: ArrayBuffer) => {
    const v = new Uint8Array(b, 0, Math.min(12, b.byteLength));
    const box = String.fromCharCode(...v.subarray(4, 8));
    return box === 'ftyp' || box === 'moov' || (v[0] === 0x1a && v[1] === 0x45 && v[2] === 0xdf && v[3] === 0xa3);
  };

  type Player = HTMLElement & {
    getAvailableQualityLevels?: () => string[];
    getPlaybackQuality?: () => string;
    setPlaybackQualityRange?: (a: string, b: string) => void;
  };

  /**
   * Turbo capture: play the main video from the start at high speed (muted by the extension at tab
   * level), at the best quality the player offers, and report when it ended so the capture can be saved.
   */
  w.__reelfetchTurbo = (speed: number) => {
    let video: HTMLVideoElement | undefined;
    let started = false;
    let stop = false;
    let rate = speed;
    const pick = () =>
      Array.from(document.querySelectorAll('video'))
        .filter((v) => msByUrl.has(v.src) || msByUrl.has(v.currentSrc))
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    (w as { __reelfetchTurboStop?: () => void }).__reelfetchTurboStop = () => (stop = true);
    let idle = 0;
    const tick = window.setInterval(() => {
      if (!video?.isConnected) video = pick();
      if (!video) {
        if (++idle > 300) window.clearInterval(tick); // this frame has no captured video
        return;
      }
      const msId = msByUrl.get(video.src) ?? msByUrl.get(video.currentSrc) ?? '';
      const player = document.querySelector<Player>('#movie_player');
      const best = player?.getAvailableQualityLevels?.()?.[0];
      if (best && best !== 'auto' && player?.getPlaybackQuality?.() !== best) player?.setPlaybackQualityRange?.(best, best);
      document.querySelector<HTMLElement>('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click();
      if (document.querySelector('.ad-showing') && isFinite(video.duration)) {
        video.currentTime = video.duration; // fast-forward pre-roll ads
        return;
      }
      if (!started && video.readyState >= 1) {
        started = true;
        if (video.currentTime > 1) {
          // Resumed mid-video: forget what was buffered so the capture starts cleanly at 0.
          for (const b of sources.get(msId) ?? []) {
            const keep = b.chunks.filter(isInit).slice(0, 1);
            b.chunks = keep;
            b.bytes = keep.reduce((n, c) => n + c.byteLength, 0);
          }
        }
        video.currentTime = 0;
      }
      if (video.paused && !video.ended)
        video.play().catch(() => {
          video!.muted = true; // autoplay policy: muted playback is always allowed
          void video!.play().catch(() => {});
        });
      try {
        if (video.playbackRate !== rate) video.playbackRate = rate;
      } catch {
        rate = Math.max(1, rate / 2); // browser rejected this speed
      }
      const done = stop || (started && (video.ended || (isFinite(video.duration) && video.currentTime >= video.duration - 0.3)));
      window.postMessage({ __reelfetch: 'turbo', event: done ? 'done' : 'progress', msId, time: video.currentTime, duration: video.duration }, '*');
      if (done) {
        window.clearInterval(tick);
        video.playbackRate = 1;
        video.pause();
        flush();
      }
    }, 400);
  };

  const setKeys = HTMLMediaElement.prototype.setMediaKeys;
  if (setKeys)
    HTMLMediaElement.prototype.setMediaKeys = function (this: HTMLMediaElement, keys: MediaKeys | null) {
      if (keys) post({ type: 'drm' });
      return setKeys.call(this, keys);
    };

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__reelfetch !== 'mse-get') return;
    const list = sources.get(e.data.msId) ?? [];
    window.postMessage(
      { __reelfetch: 'mse-data', msId: e.data.msId, buffers: list.map((b) => ({ mime: b.mime, chunks: b.chunks })) },
      '*',
    );
  });
})();
