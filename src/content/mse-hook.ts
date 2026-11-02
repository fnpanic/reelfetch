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
