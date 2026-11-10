/** Downloads with yt-dlp through the Windows host (installer/updater.ps1, op "ytdlp"); see docs/downloads.md. */
import { UPDATER_HOST } from '../shared/update';
import type { Job, Progress, Variant } from '../shared/types';
import { ytDlpTarget } from '../shared/util';

type HostMessage =
  | { type: 'setup' }
  | { type: 'progress'; bytes: number; total?: number | null }
  | { type: 'done'; file: string; size: number }
  | { ok: false; error: string };

const ports = new Map<string, chrome.runtime.Port>();

export function startYtdlp(
  j: Job,
  variant: Variant | undefined,
  on: { progress(p: Progress): void; done(file: string, size: number): void; error(e: string): void },
) {
  const port = chrome.runtime.connectNative(UPDATER_HOST);
  ports.set(j.id, port);
  let ended = false;
  const end = () => {
    ended = true;
    ports.delete(j.id);
    port.disconnect();
  };
  port.onMessage.addListener((m: HostMessage) => {
    if ('ok' in m) return end(), on.error(m.error);
    if (m.type === 'setup') on.progress({ bytes: 0, phase: 'setup' });
    else if (m.type === 'progress') on.progress({ bytes: m.bytes, total: m.total || undefined, phase: 'download' });
    else if (m.type === 'done') end(), on.done(m.file, m.size);
  });
  port.onDisconnect.addListener(() => {
    if (ended) return;
    ports.delete(j.id);
    on.error(chrome.runtime.lastError?.message ?? 'yt-dlp stopped unexpectedly');
  });
  port.postMessage({
    op: 'ytdlp',
    ...ytDlpTarget(j.media, j.media.kind === 'direct' ? variant?.ref : undefined),
    height: variant?.height,
    audioOnly: !!j.options.audioOnly,
    name: j.basename,
  });
}

/** Closing the port makes the host kill yt-dlp and delete its partial files. */
export function cancelYtdlp(jobId: string) {
  ports.get(jobId)?.disconnect();
  ports.delete(jobId);
}
