/**
 * Temporary file storage for downloads. Uses the Origin Private File System so multi-GB
 * streams don't sit in RAM; falls back to memory where OPFS is unavailable (tests, old browsers).
 */
import type { StreamTargetChunk } from 'mediabunny';

const DIR = 'reelfetch-tmp';

export interface Spool {
  name: string;
  size: number;
  /** Sequential append. */
  append(data: Uint8Array): Promise<void>;
  /** Random-access sink for mediabunny's StreamTarget; closed by the muxer. */
  sink(): WritableStream<StreamTargetChunk>;
  /** Close (if still open) and return the contents. */
  file(): Promise<Blob>;
  remove(): Promise<void>;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return null;
  }
}

/** Remove leftovers from a previous session (the engine host was restarted, so nothing is in use). */
export async function clearSpools(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DIR, { recursive: true });
  } catch {
    /* nothing to clear */
  }
}

export async function createSpool(name: string): Promise<Spool> {
  const d = await dir();
  if (d) {
    try {
      const handle = await d.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      return opfsSpool(name, d, handle, w);
    } catch {
      /* createWritable unsupported in this context */
    }
  }
  return memorySpool(name);
}

function opfsSpool(
  name: string,
  d: FileSystemDirectoryHandle,
  handle: FileSystemFileHandle,
  w: FileSystemWritableFileStream,
): Spool {
  let closed = false; // tracks the underlying writable, also when the muxer owns it via sink()
  let pos = 0;
  const close = () => {
    closed = true;
    return w.close();
  };
  const s: Spool = {
    name,
    size: 0,
    async append(data) {
      await w.write({ type: 'write', position: pos, data: data as BufferSource });
      pos += data.byteLength;
      s.size = pos;
    },
    sink() {
      return new WritableStream<StreamTargetChunk>({
        write: (c) => {
          s.size = Math.max(s.size, c.position + c.data.byteLength);
          return w.write({ type: 'write', position: c.position, data: c.data });
        },
        close,
        abort: () => {
          closed = true;
          return w.abort();
        },
      });
    },
    async file() {
      if (!closed) await close();
      return handle.getFile();
    },
    async remove() {
      if (!closed) {
        closed = true;
        await w.abort().catch(() => {});
      }
      await d.removeEntry(name).catch(() => {});
    },
  };
  return s;
}

function memorySpool(name: string): Spool {
  let buf = new Uint8Array(1 << 20);
  const grow = (need: number) => {
    if (need <= buf.byteLength) return;
    const next = new Uint8Array(Math.max(need, buf.byteLength * 2));
    next.set(buf);
    buf = next;
  };
  const s: Spool = {
    name,
    size: 0,
    async append(data) {
      grow(s.size + data.byteLength);
      buf.set(data, s.size);
      s.size += data.byteLength;
    },
    sink() {
      return new WritableStream<StreamTargetChunk>({
        write(c) {
          grow(c.position + c.data.byteLength);
          buf.set(c.data, c.position);
          s.size = Math.max(s.size, c.position + c.data.byteLength);
        },
      });
    },
    async file() {
      return new Blob([buf.subarray(0, s.size)]);
    },
    async remove() {
      buf = new Uint8Array(0);
    },
  };
  return s;
}

/** Guess a container extension from the first bytes. */
export function sniffExt(head: Uint8Array): string {
  const str = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n));
  if (head[0] === 0x47 && (head.byteLength < 189 || head[188] === 0x47)) return 'ts';
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(str(4, 4))) return 'mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (str(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xf6) === 0xf0)) return 'aac';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  if (str(0, 6) === 'WEBVTT') return 'vtt';
  return 'bin';
}
