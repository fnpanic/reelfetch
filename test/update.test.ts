// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNewer, parseRelease } from '../src/shared/update';
import { mimeForExt } from '../src/shared/detect';

describe('updates', () => {
  it('compares versions numerically', () => {
    expect(isNewer('1.10.0', '1.9.3')).toBe(true);
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.0', '1.2.1')).toBe(false);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
  });

  it('accepts only well-formed release data', () => {
    const sha = 'a'.repeat(64);
    expect(parseRelease({ version: '1.2.0', zip: 'reelfetch-chrome-1.2.0.zip', sha256: sha.toUpperCase(), setup: 'ReelFetch-Setup-1.2.0.exe' })).toEqual({
      version: '1.2.0',
      notes: undefined,
      zip: 'reelfetch-chrome-1.2.0.zip',
      sha256: sha,
      setup: 'ReelFetch-Setup-1.2.0.exe',
    });
    expect(parseRelease({ version: 'latest' })).toBeNull();
    expect(parseRelease(null)).toBeNull();
    // Paths must stay on the update server.
    expect(parseRelease({ version: '1.2.0', setup: '../evil.exe', zip: 'https://x/y.zip' })).toMatchObject({ setup: undefined, zip: undefined });
  });
});

describe('download MIME types', () => {
  // Untyped blobs are sniffed as text/plain and Chrome then saves "clip.mp4" as "clip.txt".
  it('maps every output extension to a media type', () => {
    for (const [ext, mime] of [['mp4', 'video/mp4'], ['m4a', 'audio/mp4'], ['webm', 'video/webm'], ['mkv', 'video/x-matroska'], ['mp3', 'audio/mpeg'], ['ts', 'video/mp2t'], ['vtt', 'text/vtt'], ['ogg', 'audio/ogg'], ['wav', 'audio/wav']])
      expect(mimeForExt(ext)).toBe(mime);
    expect(mimeForExt('bin')).toBe('application/octet-stream');
  });
});
