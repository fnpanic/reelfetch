import { describe, expect, it } from 'vitest';
import { bilibili, facebook, genericMeta, okru, vimeo, vk, youtube, youtubePlayerRequest } from '../src/shared/sites';

const ytBase = {
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: 'abc123',
    title: 'Never Gonna',
    lengthSeconds: '213',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/s.jpg' }, { url: 'https://i.ytimg.com/l.jpg' }] },
  },
};

describe('youtube', () => {
  it('pairs the best video per height with the original audio track', () => {
    const [m] = youtube({
      ...ytBase,
      streamingData: {
        formats: [{ itag: 18, url: 'https://gv/18', mimeType: 'video/mp4; codecs="avc1"', height: 360, qualityLabel: '360p', bitrate: 500 }],
        adaptiveFormats: [
          { itag: 137, url: 'https://gv/137', mimeType: 'video/mp4', height: 1080, qualityLabel: '1080p', bitrate: 4000, contentLength: '1000' },
          { itag: 248, url: 'https://gv/248', mimeType: 'video/webm', height: 1080, qualityLabel: '1080p', bitrate: 3000 },
          { itag: 136, url: 'https://gv/136', mimeType: 'video/mp4', height: 720, qualityLabel: '720p', bitrate: 2000 },
          { itag: 140, url: 'https://gv/140-dub', mimeType: 'audio/mp4', bitrate: 300, audioTrack: { audioIsDefault: false, displayName: 'German (dubbed)' } },
          { itag: 140, url: 'https://gv/140-orig', mimeType: 'audio/mp4', bitrate: 128, audioTrack: { audioIsDefault: true, displayName: 'English original' } },
        ],
      },
    });
    expect(m).toMatchObject({ site: 'youtube', key: 'yt:abc123', title: 'Never Gonna', duration: 213, thumbnail: 'https://i.ytimg.com/l.jpg' });
    expect(m.variants!.map((v) => [v.label, v.url, v.audioUrl])).toEqual([
      ['1080p', 'https://gv/137', 'https://gv/140-orig'],
      ['720p', 'https://gv/136', 'https://gv/140-orig'],
      ['360p', 'https://gv/18', undefined], // progressive already contains audio
    ]);
    expect(m.variants![0].size).toBe(1000);
  });

  it('falls back to turbo capture for ciphered / SABR-only formats', () => {
    const [m] = youtube({
      ...ytBase,
      streamingData: { serverAbrStreamingUrl: 'https://gv/sabr', adaptiveFormats: [{ itag: 137, signatureCipher: 's=x&url=y', mimeType: 'video/mp4' }] },
    });
    expect(m.captureOnly).toBe(true);
    expect(m.variants).toBeUndefined();
  });

  it('builds the player API request (iOS client profile)', () => {
    const r = youtubePlayerRequest('abc123');
    expect(r.url).toBe('https://www.youtube.com/youtubei/v1/player?prettyPrint=false');
    expect(r.init.headers['X-YouTube-Client-Name']).toBe('5');
    expect(JSON.parse(r.init.body)).toEqual({ videoId: 'abc123', context: { client: { clientName: 'IOS', clientVersion: '20.10.4', hl: 'en' } } });
  });

  it('uses the HLS manifest for live streams and skips unplayable videos', () => {
    expect(youtube({ ...ytBase, streamingData: { hlsManifestUrl: 'https://manifest/live.m3u8' } })[0].hls).toBe('https://manifest/live.m3u8');
    expect(youtube({ ...ytBase, playabilityStatus: { status: 'LOGIN_REQUIRED' } })).toEqual([]);
    expect(youtube(null)).toEqual([]);
  });
});

describe('other sites', () => {
  it('bilibili: DASH video + best audio', () => {
    const [m] = bilibili(
      {
        data: {
          dash: {
            duration: 60,
            video: [
              { id: 80, baseUrl: 'https://bv/1080-avc.m4s', height: 1080, bandwidth: 2000, codecs: 'avc1.640032' },
              { id: 80, base_url: 'https://bv/1080-hev.m4s', height: 1080, bandwidth: 1000, codecs: 'hev1.1' },
              { id: 64, baseUrl: 'https://bv/720.m4s', height: 720, bandwidth: 900, codecs: 'avc1' },
            ],
            audio: [
              { baseUrl: 'https://bv/a-low.m4s', bandwidth: 60 },
              { backupUrl: ['https://bv/a-high.m4s'], bandwidth: 190 },
            ],
          },
        },
      },
      'Title',
      'https://www.bilibili.com/video/BV1?p=1',
    );
    expect(m.variants!.map((v) => [v.height, v.url, v.audioUrl])).toEqual([
      [1080, 'https://bv/1080-avc.m4s', 'https://bv/a-high.m4s'],
      [720, 'https://bv/720.m4s', 'https://bv/a-high.m4s'],
    ]);
    expect(m.key).toBe('bili:https://www.bilibili.com/video/BV1');
  });

  it('vimeo: HLS from the default CDN plus progressive files', () => {
    const out = vimeo({
      video: { id: 7, title: 'V', duration: 30, thumbs: { base: 'https://i.vimeocdn.com/t' } },
      request: {
        files: {
          hls: { default_cdn: 'akamai', cdns: { fastly: { url: 'https://f/x.m3u8' }, akamai: { url: 'https://a/x.m3u8' } } },
          progressive: [
            { url: 'https://p/360.mp4', quality: '360p', height: 360 },
            { url: 'https://p/720.mp4', quality: '720p', height: 720 },
          ],
        },
      },
    });
    expect(out[0].hls).toBe('https://a/x.m3u8');
    expect(out[1].variants!.map((v) => v.height)).toEqual([720, 360]);
  });

  it('vimeo: falls back to the player config endpoint when the page has no inline config', () => {
    expect(vimeo(undefined, 'https://vimeo.com/76979871')).toEqual([
      { site: 'vimeo', key: 'vimeo:76979871:config', configUrl: 'https://player.vimeo.com/video/76979871/config' },
    ]);
    expect(vimeo(undefined, 'https://player.vimeo.com/video/123456?h=x')[0].configUrl).toBe('https://player.vimeo.com/video/123456/config');
    expect(vimeo(undefined, 'https://vimeo.com/about')).toEqual([]);
  });

  it('ok.ru: data-options metadata', () => {
    const metadata = JSON.stringify({
      movie: { id: '9', title: 'OK video', poster: 'https://ok/p.jpg', duration: '12' },
      videos: [
        { name: 'sd', url: 'https://ok/sd' },
        { name: 'hd', url: 'https://ok/hd' },
      ],
    });
    const [m] = okru([JSON.stringify({ flashvars: { metadata } }), 'not json']);
    expect(m.variants!.map((v) => v.label)).toEqual(['720p', '480p']);
    expect(m.duration).toBe(12);
  });

  it('vk: mp4_* and hls entries in page source', () => {
    const out = vk('var p = {"mp4_720":"https:\\/\\/vk\\/720.mp4","mp4_360":"https:\\/\\/vk\\/360.mp4","hls":"https:\\/\\/vk\\/v.m3u8"}', 'VK');
    expect(out[0].variants!.map((v) => v.url)).toEqual(['https://vk/720.mp4', 'https://vk/360.mp4']);
    expect(out[1].hls).toBe('https://vk/v.m3u8');
  });

  it('facebook / instagram: progressive pairs, video_versions and embedded DASH', () => {
    const xml = '<?xml version="1.0"?><MPD><Period><AdaptationSet><Representation><BaseURL>https://fb/v1.mp4?x=1</BaseURL></Representation></AdaptationSet></Period></MPD>';
    const src = [
      '{"browser_native_hd_url":"https:\\/\\/fb\\/hd.mp4","browser_native_sd_url":"https:\\/\\/fb\\/sd.mp4"}',
      '{"video_versions":[{"url":"https://ig/1080.mp4","width":1080,"height":1920},{"url":"https://ig/480.mp4","width":480,"height":854}]}',
      `{"dash_manifest":${JSON.stringify(xml)}}`,
    ].join('\n');
    const out = facebook(src, 'Post');
    expect(out[0].variants!.map((v) => v.label)).toEqual(['HD', 'SD']);
    expect(out[1]).toMatchObject({ site: 'instagram' });
    expect(out[1].variants![0].height).toBe(1920);
    expect(out[2].dashXml).toBe(xml);
  });

  it('generic: JSON-LD VideoObject and og:video', () => {
    const ld = JSON.stringify({ '@graph': [{ '@type': 'VideoObject', contentUrl: 'https://cdn/v.mp4' }] });
    const out = genericMeta([ld, '{broken'], { 'og:video': 'https://cdn/master.m3u8', 'og:video:url': 'https://x/player.html' }, 'Page');
    expect(out.map((o) => o.hls ?? o.variants?.[0].url)).toEqual(['https://cdn/v.mp4', 'https://cdn/master.m3u8']);
    // YouTube-style og:video pointing at an HTML embed page is not media.
    expect(genericMeta([], { 'og:video:url': 'https://www.youtube.com/embed/abc', 'og:video:type': 'text/html' })).toEqual([]);
    expect(genericMeta([], { 'og:video': 'https://cdn/stream', 'og:video:type': 'video/mp4' })).toHaveLength(1);
  });
});
