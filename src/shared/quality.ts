import type { MediaItem, Variant } from './types';
import type { Settings } from './settings';

/** Variant matching the preferred quality: best at or below the target, else the smallest above it. */
export function pickVariant<V extends Pick<Variant, 'height' | 'bandwidth'>>(
  variants: V[],
  pref: Settings['preferredQuality'],
): V | undefined {
  if (!variants.length) return undefined;
  const score = (v: V) => (v.height ?? 0) * 1e9 + (v.bandwidth ?? 0);
  const sorted = [...variants].sort((a, b) => score(b) - score(a));
  if (pref === 'highest') return sorted[0];
  const target = Number(pref);
  const known = sorted.filter((v) => v.height);
  if (!known.length) return sorted[0];
  return known.find((v) => v.height! <= target) ?? known[known.length - 1];
}

/** Choose the language entry matching the user's preference list, else the default, else first. */
export function pickByLang<T extends { language?: string; lang?: string; default?: boolean }>(
  items: T[],
  langs: string[],
): T | undefined {
  const lang = (t: T) => (t.language ?? t.lang ?? '').toLowerCase();
  for (const want of langs.map((l) => l.toLowerCase().trim()).filter(Boolean)) {
    const hit = items.find((t) => lang(t) === want || lang(t).split('-')[0] === want);
    if (hit) return hit;
  }
  return items.find((t) => t.default) ?? items[0];
}

/** Hide items that are sub-playlists of an already listed master, then sort. */
export function visibleMedia(items: MediaItem[], order: Settings['mediaOrder']): MediaItem[] {
  const children = new Set(items.flatMap((m) => m.children ?? []));
  const shown = items.filter((m) => !children.has(m.url) && !(m.kind === 'mse' && !m.mse?.bytes));
  if (order === 'newest') return shown.sort((a, b) => b.detectedAt - a.detectedAt);
  if (order === 'oldest') return shown.sort((a, b) => a.detectedAt - b.detectedAt);
  const rank = (m: MediaItem) =>
    (m.drm ? -1e15 : 0) +
    (m.kind === 'hls' || m.kind === 'dash' ? 1e12 : 0) +
    (m.duration ?? 0) * 1e6 +
    (m.size ?? m.mse?.bytes ?? 0) / 1e3;
  return shown.sort((a, b) => rank(b) - rank(a) || b.detectedAt - a.detectedAt);
}
