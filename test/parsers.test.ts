import { describe, expect, it } from 'vitest';
import { parseAttributes, parseHls, ivFromSequence } from '../src/shared/hls';
import { fillTemplate, parseIsoDuration, parseMpd } from '../src/shared/dash';
import { classify, extFor, mediaKey } from '../src/shared/detect';
import { pickByLang, pickVariant, visibleMedia } from '../src/shared/quality';
import { buildBasename, cleanTitle } from '../src/shared/naming';
import { sanitizeSegment, sanitizeSubdir, ytDlpCommand, ytDlpTarget } from '../src/shared/util';
import type { MediaItem } from '../src/shared/types';

describe('hls', () => {
  it('parses quoted attributes with commas', () => {
    expect(parseAttributes('BANDWIDTH=100,CODECS="avc1.4d,mp4a.40.2",RESOLUTION=640x360')).toEqual({
      BANDWIDTH: '100',
      CODECS: 'avc1.4d,mp4a.40.2',
      RESOLUTION: '640x360',
    });
  });

  it('parses a master playlist with renditions', () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch",LANGUAGE="de",URI="audio/de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="a"
https://cdn.example.com/1080/index.m3u8?t=1
`,
      'https://example.com/live/master.m3u8',
    );
    expect(pl.kind).toBe('master');
    if (pl.kind !== 'master') return;
    expect(pl.variants.map((v) => [v.height, v.url])).toEqual([
      [360, 'https://example.com/live/360/index.m3u8'],
      [1080, 'https://cdn.example.com/1080/index.m3u8?t=1'],
    ]);
    expect(pl.renditions[1].uri).toBe('https://example.com/live/audio/de.m3u8');
    expect(pickByLang(pl.renditions, ['de'])?.name).toBe('Deutsch');
    expect(pickByLang(pl.renditions, ['fr'])?.name).toBe('English');
  });

  it('parses media playlist: keys, byte ranges, map, live', () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"
#EXT-X-KEY:METHOD=AES-128,URI="k.bin"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@700
media.mp4
#EXTINF:4.5,
#EXT-X-BYTERANGE:500
media.mp4
#EXT-X-KEY:METHOD=NONE
#EXT-X-DISCONTINUITY
#EXTINF:2,
plain.ts
`,
      'https://h.example/v/p.m3u8',
    );
    if (pl.kind !== 'media') throw new Error('expected media');
    expect(pl.endList).toBe(false);
    expect(pl.duration).toBeCloseTo(12.5);
    expect(pl.encrypted).toBe(true);
    expect(pl.drm).toBe(false);
    const [a, b, c] = pl.segments;
    expect(a.byteRange).toEqual({ offset: 700, length: 1000 });
    expect(b.byteRange).toEqual({ offset: 1700, length: 500 });
    expect(a.map).toEqual({ url: 'https://h.example/v/init.mp4', byteRange: { offset: 0, length: 700 } });
    expect(a.key?.iv).toEqual(ivFromSequence(10));
    expect(b.key?.iv).toEqual(ivFromSequence(11));
    expect(c.key).toBeUndefined();
    expect(c.discontinuity).toBe(true);
  });

  it('flags DRM key formats and resolves EXT-X-DEFINE', () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-DEFINE:NAME="cdn",VALUE="https://x.example"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
{$cdn}/a.ts
#EXT-X-ENDLIST`,
      'https://y.example/p.m3u8',
    );
    if (pl.kind !== 'media') throw new Error();
    expect(pl.drm).toBe(true);
    expect(pl.segments[0].url).toBe('https://x.example/a.ts');
  });

  it('marks init sections encrypted only when a key precedes the map', () => {
    const pl = parseHls(
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n#EXT-X-ENDLIST`,
      'https://a.example/p.m3u8',
    );
    if (pl.kind !== 'media') throw new Error();
    expect(pl.segments[0].map?.key).toMatchObject({ method: 'AES-128', uri: 'https://a.example/k', iv: ivFromSequence(5) });
  });

  it('rejects non-playlists', () => {
    expect(() => parseHls('<html>', 'https://a.b/c')).toThrow();
  });
});

describe('dash', () => {
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT1H2M3.5S')).toBeCloseTo(3723.5);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('PT0S')).toBe(0);
  });

  it('fills templates with widths', () => {
    expect(fillTemplate('$RepresentationID$/seg-$Number%05d$.m4s?b=$Bandwidth$&$$', { RepresentationID: 'v1', Number: 7, Bandwidth: 9 })).toBe(
      'v1/seg-00007.m4s?b=9&$',
    );
  });

  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>media/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
      <Representation id="v720" bandwidth="2000000" width="1280" height="720"/>
      <Representation id="v360" bandwidth="500000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="de">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="a1" bandwidth="128000">
        <SegmentTemplate timescale="10" initialization="a/init.mp4" media="a/$Time$.m4s">
          <SegmentTimeline><S t="0" d="40" r="1"/><S d="20"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
      <Representation id="s1"><BaseURL>subs/en.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="image/jpeg"><Representation id="thumbs"/></AdaptationSet>
  </Period>
</MPD>`;

  it('expands number templates, timelines, base urls and DRM', () => {
    const m = parseMpd(mpd, 'https://d.example/x/manifest.mpd');
    expect(m.duration).toBe(10);
    expect(m.drm).toBe(true);
    const reps = m.periods[0].reps;
    expect(reps.map((r) => r.id)).toEqual(['v720', 'v360', 'a1', 's1']);
    const v = reps[0];
    expect(v.drm).toBe(false);
    expect(v.segments.map((s) => s.url.split('/x/')[1])).toEqual(['media/v720/1.m4s', 'media/v720/2.m4s', 'media/v720/3.m4s']);
    expect(v.segments[0].map?.url).toBe('https://d.example/x/media/v720/init.mp4');
    const a = reps[2];
    expect(a.drm).toBe(true);
    expect(a.segments.map((s) => s.url.split('/a/')[1])).toEqual(['0.m4s', '40.m4s', '80.m4s']);
    expect(reps[3].segments[0].url).toBe('https://d.example/x/media/subs/en.vtt');
  });

  it('expands r=-1 until the period ends', () => {
    const m = parseMpd(
      `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT9S"><Period><AdaptationSet contentType="video">
      <SegmentTemplate timescale="1" media="$Number$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate>
      <Representation id="v"/></AdaptationSet></Period></MPD>`,
      'https://a.example/m.mpd',
    );
    expect(m.periods[0].reps[0].segments).toHaveLength(5);
  });
});

describe('detect', () => {
  it('classifies responses', () => {
    expect(classify({ url: 'https://a.b/x/master.m3u8?x=1' })?.kind).toBe('hls');
    expect(classify({ url: 'https://a.b/p', contentType: 'application/vnd.apple.mpegurl' })?.kind).toBe('hls');
    expect(classify({ url: 'https://a.b/m.mpd' })?.kind).toBe('dash');
    expect(classify({ url: 'https://a.b/v.mp4', contentType: 'video/mp4', contentLength: 5e6 })).toEqual({
      kind: 'direct',
      mime: 'video/mp4',
      size: 5e6,
    });
    expect(classify({ url: 'https://a.b/v', contentType: 'video/mp4', contentRange: 'bytes 0-1/90000000', contentLength: 2 })?.size).toBe(9e7);
    expect(classify({ url: 'https://a.b/seg1.ts', contentType: 'video/mp2t', contentLength: 5e6 })).toBeNull();
    expect(classify({ url: 'https://a.b/chunk.m4s', contentType: 'video/mp4', contentLength: 5e6 })).toBeNull();
    expect(classify({ url: 'https://a.b/ping.mp3', contentType: 'audio/mpeg', contentLength: 900 })).toBeNull();
    expect(classify({ url: 'https://a.b/page.html', contentType: 'text/html' })).toBeNull();
    expect(classify({ url: 'blob:https://a.b/123' })).toBeNull();
  });

  it('recognizes the same container list as VDH (AVI, WMV, MPEG, VOB, RealMedia, WMA, whole .ts files…)', () => {
    for (const f of ['a.avi', 'a.wmv', 'a.asf', 'a.mpg', 'a.m2ts', 'a.vob', 'a.rmvb', 'a.wma', 'a.amr', 'a.ape', 'a.mxf'])
      expect(classify({ url: `https://a.b/${f}`, contentLength: 5e6 })?.kind, f).toBe('direct');
    expect(classify({ url: 'https://a.b/x', contentType: 'application/vnd.rn-realmedia', contentLength: 5e6 })?.kind).toBe('direct');
    expect(classify({ url: 'https://a.b/rec.ts', contentType: 'video/mp2t', contentLength: 300e6 })?.kind).toBe('direct');
    expect(classify({ url: 'https://a.b/seg7.ts', contentType: 'video/mp2t', contentLength: 2e6 })).toBeNull();
    expect(extFor('https://a.b/stream?id=1', 'video/x-msvideo')).toBe('avi');
    expect(extFor('https://a.b/v.wmv', 'video/x-ms-wmv')).toBe('wmv');
  });

  it('dedupes range query params', () => {
    expect(mediaKey('https://a.b/v.mp4?id=1&bytestart=0&byteend=99')).toBe('https://a.b/v.mp4?id=1');
  });
});

describe('quality & ordering', () => {
  const vs = [{ height: 1080 }, { height: 720 }, { height: 480 }, { height: 240 }];
  it('picks the preferred quality', () => {
    expect(pickVariant(vs, 'highest')?.height).toBe(1080);
    expect(pickVariant(vs, '720')?.height).toBe(720);
    expect(pickVariant([{ height: 1080 }, { height: 900 }], '480')?.height).toBe(900);
    expect(pickVariant([{ bandwidth: 1 }, { bandwidth: 5 }], '720')?.bandwidth).toBe(5);
  });

  it('hides child playlists and sorts streams first', () => {
    const base = { tabId: 1, pageUrl: '', pageTitle: '', headers: {} };
    const items = [
      { ...base, id: 'a', kind: 'direct', url: 'https://x/a.mp4', size: 1e6, detectedAt: 3 },
      { ...base, id: 'b', kind: 'hls', url: 'https://x/m.m3u8', children: ['https://x/c.m3u8'], detectedAt: 1 },
      { ...base, id: 'c', kind: 'hls', url: 'https://x/c.m3u8', detectedAt: 2 },
    ] as MediaItem[];
    expect(visibleMedia(items, 'smart').map((m) => m.id)).toEqual(['b', 'a']);
    expect(visibleMedia(items, 'newest').map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('naming', () => {
  it('sanitizes file names', () => {
    expect(sanitizeSegment('a/b:c*d?"e<f>|g')).toBe('a b c d e f g');
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('...')).toBe('video');
    expect(sanitizeSubdir('../videos//2024/')).toBe('videos/2024');
  });

  it('builds names from templates', () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(buildBasename('{host} - {title} [{quality}]', { title: 'My: clip', host: 'x.com', quality: '720p', date }, 'dl')).toBe(
      'dl/x.com - My clip [720p]',
    );
    expect(buildBasename('{title} [{quality}]', { title: 'T', host: 'h', date })).toBe('T');
    expect(buildBasename('{title}', { title: 'T', smart: 'Smart', host: 'h' })).toBe('Smart');
    expect(buildBasename('{date}_{time}', { title: 'T', host: 'h', date })).toBe('2026-01-02_03-04-05');
  });

  it('cleans site suffixes', () => {
    expect(cleanTitle('(3) Cool Video - YouTube', 'youtube.com')).toBe('Cool Video');
    expect(cleanTitle('Watch | Vimeo', 'vimeo.com')).toBe('Watch');
  });
});

describe('ytDlpCommand', () => {
  const base = { url: 'https://cdn.example/v/master.m3u8', pageUrl: 'https://example.com/watch', headers: { referer: 'https://example.com/watch' } };
  it('streams: media URL with the page Referer', () => {
    expect(ytDlpCommand(base)).toBe("yt-dlp --referer 'https://example.com/watch' 'https://cdn.example/v/master.m3u8'");
  });
  it('site extractor items and inline manifests: page URL', () => {
    expect(ytDlpCommand({ ...base, site: 'youtube' })).toBe("yt-dlp 'https://example.com/watch'");
    expect(ytDlpCommand({ ...base, url: 'about:reelfetch-12' })).toBe("yt-dlp 'https://example.com/watch'");
  });
  it('uses the chosen variant and escapes quotes', () => {
    expect(ytDlpCommand(base, "https://cdn.example/it's.mp4")).toBe("yt-dlp --referer 'https://example.com/watch' 'https://cdn.example/it%27s.mp4'");
  });
  it('target for the native host: page URL for sites and turbo items, else media URL + Referer', () => {
    expect(ytDlpTarget({ ...base, site: 'youtube' })).toEqual({ url: 'https://example.com/watch' });
    expect(ytDlpTarget({ ...base, url: 'turbo:yt:abc' })).toEqual({ url: 'https://example.com/watch' });
    expect(ytDlpTarget({ ...base, headers: {} }, 'https://cdn.example/a.mp4')).toEqual({ url: 'https://cdn.example/a.mp4', referer: 'https://example.com/watch' });
  });
});
