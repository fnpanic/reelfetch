import type { MediaItem, Variant } from './types';
import type { Settings } from './settings';
import { cleanTitle } from './naming';
import { hostOf } from './util';

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

/** How likely an item is the page's real video: no DRM/error, a stream, long, big. */
const rank = (m: MediaItem) =>
  (m.drm ? -1e15 : 0) +
  (m.error ? -1e14 : 0) +
  (m.kind === 'hls' || m.kind === 'dash' ? 1e12 : 0) +
  (m.duration ?? 0) * 1e6 +
  (m.size ?? m.mse?.bytes ?? 0) / 1e3;

/** The name the list shows for an item. */
export const mediaTitle = (m: MediaItem): string =>
  m.title || cleanTitle(m.pageTitle, hostOf(m.pageUrl)) || hostOf(m.url) || m.url;

/**
 * Items sharing a name (usually several streams of one page, all named after the page title):
 * the most likely one as `main`, the rest in `more`, which the list folds away. Group order follows `items`.
 */
export function groupByTitle(items: MediaItem[]): { main: MediaItem; more: MediaItem[] }[] {
  const groups = new Map<string, MediaItem[]>();
  for (const m of items) {
    const k = mediaTitle(m).toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return [...groups.values()].map((g) => {
    const main = g.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    return { main, more: g.filter((m) => m !== main) };
  });
}

/** Hide items that are sub-playlists of an already listed master, then sort. */
export function visibleMedia(items: MediaItem[], order: Settings['mediaOrder']): MediaItem[] {
  const children = new Set(items.flatMap((m) => m.children ?? []));
  const shown = items.filter((m) => !children.has(m.url) && !(m.kind === 'mse' && !m.mse?.bytes && !m.captureOnly));
  if (order === 'newest') return shown.sort((a, b) => b.detectedAt - a.detectedAt);
  if (order === 'oldest') return shown.sort((a, b) => a.detectedAt - b.detectedAt);
  return shown.sort((a, b) => rank(b) - rank(a) || b.detectedAt - a.detectedAt);
}
