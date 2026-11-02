export const uid = (): string => crypto.randomUUID();

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** True when `host` equals `site` or is a sub-domain of it. */
export function hostMatches(host: string, site: string): boolean {
  site = site.trim().toLowerCase().replace(/^www\./, '');
  host = host.toLowerCase();
  return !!site && (host === site || host.endsWith('.' + site));
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make one path segment safe on Windows, macOS and Linux. */
export function sanitizeSegment(name: string, max = 150): string {
  let s = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > max) s = s.slice(0, max).trim();
  if (!s || RESERVED.test(s)) s = s ? `_${s}` : 'video';
  return s;
}

/** Sanitize a user sub-directory like "videos/2024"; returns '' when empty. */
export function sanitizeSubdir(dir: string): string {
  return dir
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => sanitizeSegment(p, 60))
    .join('/');
}

export function formatBytes(n?: number): string {
  if (n == null || !isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(sec?: number): string {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
