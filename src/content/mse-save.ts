/** Injected on demand: pulls captured MSE buffers from the page world, remuxes and saves them. */
import { remux } from '../engine/mux';

interface SaveRequest {
  type: 'mse-save';
  msId: string;
  filename: string;
  audioOnly: boolean;
  preferMkv: boolean;
}
interface Captured {
  mime: string;
  chunks: ArrayBuffer[];
}

const w = window as unknown as { __reelfetchSave?: boolean };
if (!w.__reelfetchSave) {
  w.__reelfetchSave = true;
  chrome.runtime.onMessage.addListener((msg: SaveRequest, _s, reply) => {
    if (msg?.type !== 'mse-save') return;
    save(msg).then(reply, (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}

function fetchCaptured(msId: string): Promise<Captured[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeEventListener('message', on);
      reject(new Error('Captured data not found - reload the page with capture enabled and play the video.'));
    }, 10000);
    function on(e: MessageEvent) {
      if (e.source !== window || e.data?.__reelfetch !== 'mse-data' || e.data.msId !== msId) return;
      clearTimeout(timeout);
      removeEventListener('message', on);
      resolve(e.data.buffers as Captured[]);
    }
    addEventListener('message', on);
    postMessage({ __reelfetch: 'mse-get', msId }, '*');
  });
}

function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.style.display = 'none';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

const extOfMime = (mime: string) =>
  /webm/.test(mime) ? (/^audio/.test(mime) ? 'weba' : 'webm') : /^audio/.test(mime) ? 'm4a' : 'mp4';

async function save(msg: SaveRequest) {
  const bufs = (await fetchCaptured(msg.msId)).filter((b) => b.chunks.length);
  if (!bufs.length) throw new Error('Nothing captured yet - play the video first.');
  const blobs = bufs.map((b) => new Blob(b.chunks, { type: b.mime }));
  try {
    const r = await remux(blobs, { audioOnly: msg.audioOnly, preferMkv: msg.preferMkv, overlap: 'drop' });
    const name = `${msg.filename}.${r.ext}`;
    saveBlob(new Blob([r.buffer!]), name);
    return { ok: true, filename: name, size: r.buffer!.byteLength };
  } catch (e) {
    // Fall back to the raw buffers: each is a valid fragmented file on its own.
    console.warn('[ReelFetch] remux failed, saving raw tracks', e);
    let size = 0;
    blobs.forEach((b, i) => {
      size += b.size;
      saveBlob(b, `${msg.filename}${blobs.length > 1 ? `.track${i + 1}` : ''}.${extOfMime(bufs[i].mime)}`);
    });
    return { ok: true, filename: `${msg.filename}.${extOfMime(bufs[0].mime)}`, size };
  }
}
