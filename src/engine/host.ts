import type { EngineEvent, EngineRequest } from '../shared/messages';
import { analyze, download, DrmError } from './engine';
import { clearSpools, type Spool } from './spool';

interface Running {
  abort: AbortController;
  stop: boolean;
  spools: Spool[];
  urls: string[];
}

/** Engine request handler; `emit` delivers events to the background (and may return a reply). */
export function createEngineHost(emit: (e: EngineEvent) => Promise<unknown>) {
  const jobs = new Map<string, Running>();
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
            const files = out.files.map((f) => ({ url: URL.createObjectURL(f.blob), ext: f.ext, suffix: f.suffix }));
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
