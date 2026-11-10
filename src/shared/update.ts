/** Self-hosted updates (Cloudflare): the release script publishes latest.json next to the files. */
declare const __UPDATE_BASE__: string;
export const UPDATE_BASE: string = typeof __UPDATE_BASE__ === 'string' ? __UPDATE_BASE__ : '';
/** Native messaging host installed by the Windows setup; it swaps the extension files on disk. */
export const UPDATER_HOST = 'app.reelfetch.updater';

export interface Release {
  version: string;
  /** Windows setup, relative to UPDATE_BASE. */
  setup?: string;
  zip?: string;
  sha256?: string;
}

export interface UpdateState {
  current: string;
  latest?: Release;
  checkedAt?: number;
  error?: string;
  /** The Windows updater is installed, so the update can be applied in place. */
  native: boolean;
  /** Version of the copy the updater manages; differs from `current` when the browser loads another folder. */
  hostVersion?: string;
  installing?: boolean;
  /** The installed host can download with yt-dlp (setup 1.4.0+). */
  ytdlp?: boolean;
}

/** True when version `a` is newer than `b` ("1.10.0" > "1.9.3"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

export function parseRelease(json: unknown): Release | null {
  const r = json as Partial<Release> | null;
  if (!r || typeof r.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(r.version)) return null;
  const rel = (p: unknown) => (typeof p === 'string' && /^[\w.\-]+$/.test(p) ? p : undefined);
  return {
    version: r.version,
    setup: rel(r.setup),
    zip: rel(r.zip),
    sha256: typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(r.sha256) ? r.sha256.toLowerCase() : undefined,
  };
}
