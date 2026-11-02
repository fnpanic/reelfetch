// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'src', 'i18n');
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
const en = load('en.json');
const tokens = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');

// Every key the code references must exist in English.
const srcKeys = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? srcKeys(join(d, e.name))
      : /\.tsx?$/.test(e.name)
        ? [...readFileSync(join(d, e.name), 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)].map((m) => m[1])
        : [],
  );

describe('i18n', () => {
  it('has every key used in the source', () => {
    const missing = [...new Set(srcKeys(join(__dirname, '..', 'src')))].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  for (const f of readdirSync(dir).filter((f) => f !== 'en.json')) {
    it(`${f} matches en.json keys and placeholders`, () => {
      const loc = load(f);
      expect(Object.keys(loc).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) {
        expect(loc[k].trim().length, `${f}:${k} empty`).toBeGreaterThan(0);
        expect(tokens(loc[k]), `${f}:${k} placeholders`).toBe(tokens(en[k]));
      }
    });
  }
});
