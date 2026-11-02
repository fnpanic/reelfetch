import type { EngineEvent, EngineRequest } from '../shared/messages';
import { analyze, download, DrmError } from './engine';
import { clearSpools, type Spool } from './spool';
import { mimeForExt } from '../shared/detect';

interface Running {
  abort: AbortController;
  stop: boolean;
  spools: Spool[];
  urls: string[];
}

/** Clipboard write from a background context (offscreen document or Firefox background page). */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* offscreen documents have no focus: fall back to execCommand */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/** Engine request handler; `emit` delivers events to the background (and may return a reply). */
export function createEngineHost(emit: (e: EngineEvent) => Promise<unknown>) {
  const jobs = new Map<string, Running>();
  const previews = new Map<string, string>();
  const ready = clearSpools();

  async function release(jobId: string) {
    const r = jobs.get(jobId);
    if (!r) return;
    jobs.delete(jobId);
    r.urls.forEach((u) => URL.revokeObjectURL(u));
    await Promise.all(r.spools.map((s) => s.remove()));
  }

  return async function handle(req: EngineRequest): Promise<unknown> {
    await ready;
    switch (req.op) {
      case 'analyze':
        return analyze(req.media, AbortSignal.timeout(20000));
      case 'cancel':
        jobs.get(req.jobId)?.abort.abort();
        return release(req.jobId);
      case 'stop': {
        const r = jobs.get(req.jobId);
        if (r) r.stop = true;
        return;
      }
      case 'release':
        return release(req.jobId);
      case 'copy':
        return copyText(req.text);
      case 'preview': {
        const cached = previews.get(req.media.id);
        if (cached) return cached;
        const out = await download(
          { id: `preview-${req.media.id}`, media: req.media, options: {}, basename: '', status: 'running', createdAt: 0, progress: { bytes: 0 } },
          { ...req.settings, preferredQuality: '480', downloadSubtitles: false, audioFormat: 'original' },
          { signal: AbortSignal.timeout(30000), stopped: () => true, onProgress: () => {}, previewSeconds: 6 },
        );
        const url = URL.createObjectURL(new Blob([out.files[0].blob], { type: mimeForExt(out.files[0].ext) }));
        await Promise.all(out.spools.map((s) => s.remove()));
        previews.set(req.media.id, url);
        // Small LRU: previews are a few hundred KB each.
        if (previews.size > 20) {
          const [oldest] = previews.keys();
          URL.revokeObjectURL(previews.get(oldest)!);
          previews.delete(oldest);
        }
        return url;
      }
      case 'start': {
        const { job, settings } = req;
        jobs.get(job.id)?.abort.abort(); // a retry supersedes any run still winding down
        const r: Running = { abort: new AbortController(), stop: false, spools: [], urls: [] };
        jobs.set(job.id, r);
        const mine = () => jobs.get(job.id) === r;
        // Fire and forget: results travel back as events so a sleeping service worker is woken up.
        download(job, settings, {
          signal: r.abort.signal,
          stopped: () => r.stop,
          onProgress: (progress) => void emit({ jobId: job.id, type: 'progress', progress }).catch(() => {}),
          prepare: async (hosts) => void (await emit({ jobId: job.id, type: 'prepare', hosts })),
        }).then(
          async (out) => {
            if (r.abort.signal.aborted || !mine()) {
              // Canceled right as it finished: nobody will release this run, so clean up now.
              await Promise.all(out.spools.map((s) => s.remove()));
              return;
            }
            r.spools = out.spools;
            const files = out.files.map((f) => ({ url: URL.createObjectURL(new Blob([f.blob], { type: mimeForExt(f.ext) })), ext: f.ext, suffix: f.suffix }));
            r.urls = files.map((f) => f.url);
            return emit({ jobId: job.id, type: 'done', output: { files, size: out.size } });
          },
          (e: unknown) => {
            if (mine()) jobs.delete(job.id);
            if (r.abort.signal.aborted) return;
            return emit({
              jobId: job.id,
              type: 'error',
              error: e instanceof Error ? e.message : String(e),
              drm: e instanceof DrmError,
            });
          },
        );
        return;
      }
    }
  };
}
