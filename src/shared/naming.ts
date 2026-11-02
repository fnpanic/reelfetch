import { sanitizeSegment, sanitizeSubdir } from './util';

export interface NameVars {
  title: string;
  host: string;
  quality?: string;
  smart?: string;
  date?: Date;
}

/** Expand a template like "{host} - {title} [{quality}]" into "subdir/name" (no extension). */
export function buildBasename(template: string, v: NameVars, subdir = ''): string {
  const d = v.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    title: v.smart || v.title,
    pagetitle: v.title,
    smart: v.smart ?? '',
    host: v.host,
    quality: v.quality ?? '',
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
  };
  const raw = (template || '{title}')
    .replace(/\{(\w+)\}/g, (m, k: string) => map[k.toLowerCase()] ?? m)
    .replace(/\[\s*\]|\(\s*\)/g, '');
  const name = sanitizeSegment(raw);
  const dir = sanitizeSubdir(subdir);
  return dir ? `${dir}/${name}` : name;
}

/** Remove the common " - Site" / " | Site" suffix from page titles. */
export function cleanTitle(title: string, host: string): string {
  const site = host.split('.').slice(-2, -1)[0] ?? '';
  const t = title.replace(/^\(\d+\)\s*/, '').trim();
  if (!site) return t;
  const re = new RegExp(`\\s*[-|–—:·]\\s*${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^-|–—]*$`, 'i');
  return t.replace(re, '').trim() || t;
}
