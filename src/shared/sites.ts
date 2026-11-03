/**
 * Site extractors: turn a site's own player data into downloadable media. Pure functions so they are
 * unit-testable; the page-world glue (content/extract.ts) only collects the data and posts the result.
 */

export interface SiteVariant {
  label: string;
  url: string;
  /** Separate audio stream to merge (DASH-style sites). */
  audioUrl?: string;
  height?: number;
  width?: number;
  bandwidth?: number;
  mime?: string;
  size?: number;
}

export interface SiteMedia {
  site: string;
  /** Stable id within the page (video id), used to dedupe across re-scans. */
  key: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  hls?: string;
  dash?: string;
  /** Inline MPD text. */
  dashXml?: string;
  variants?: SiteVariant[];
  /** Player config JSON to fetch with extension privileges (Vimeo's new pages carry no inline config). */
  configUrl?: string;
  /** No direct stream URLs available: offer turbo capture. */
  captureOnly?: boolean;
  drm?: boolean;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u);
const num = (v: unknown) => (v == null || v === '' || isNaN(Number(v)) ? undefined : Number(v));
const byQuality = (a: SiteVariant, b: SiteVariant) =>
  (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0);

/** Keep the best variant per height. */
function dedupeHeights(vs: SiteVariant[]): SiteVariant[] {
  const seen = new Set<number | undefined>();
  return vs.sort(byQuality).filter((v) => !seen.has(v.height) && seen.add(v.height));
}

// ------------------------------------------------------------------ YouTube

/**
 * YouTube player API request (InnerTube, iOS client profile). Like VDH, this asks YouTube's own API for
 * the stream list; the iOS profile returns plain stream URLs where the web page only offers SABR.
 */
export const YT_IOS = {
  clientName: 'IOS',
  clientId: '5',
  clientVersion: '20.10.4',
  userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
};

export function youtubePlayerRequest(videoId: string, origin = 'https://www.youtube.com') {
  return {
    url: `${origin}/youtubei/v1/player?prettyPrint=false`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': YT_IOS.clientId,
        'X-YouTube-Client-Version': YT_IOS.clientVersion,
      },
      body: JSON.stringify({ videoId, context: { client: { clientName: YT_IOS.clientName, clientVersion: YT_IOS.clientVersion, hl: 'en' } } }),
    } satisfies RequestInit,
  };
}

export function youtube(pr: Json | null | undefined): SiteMedia[] {
  if (!pr?.videoDetails) return [];
  const vd = pr.videoDetails;
  const sd = pr.streamingData ?? {};
  const base: SiteMedia = {
    site: 'youtube',
    key: `yt:${vd.videoId}`,
    title: vd.title,
    duration: num(vd.lengthSeconds),
    thumbnail: vd.thumbnail?.thumbnails?.at(-1)?.url,
    drm: !!sd.drmFamilies?.length,
  };
  if (pr.playabilityStatus?.status && pr.playabilityStatus.status !== 'OK') return [];
  if (isHttp(sd.hlsManifestUrl)) return [{ ...base, hls: sd.hlsManifestUrl }];
  if (isHttp(sd.dashManifestUrl)) return [{ ...base, dash: sd.dashManifestUrl }];

  const fmts: Json[] = [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])].filter((f) => isHttp(f.url));
  const audios = fmts
    .filter((f) => /^audio\//.test(f.mimeType ?? ''))
    // Original-language track first (dubbed tracks are not "default"), then quality.
    .sort((a, b) => Number(!!b.audioTrack?.audioIsDefault) - Number(!!a.audioTrack?.audioIsDefault) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const bestAudio = audios[0];
  const variants: SiteVariant[] = [];
  for (const f of fmts) {
    const mime = String(f.mimeType ?? '');
    if (!/^video\//.test(mime)) continue;
    const muxed = (sd.formats ?? []).includes(f); // progressive: already has audio
    if (!muxed && !bestAudio) continue;
    variants.push({
      label: f.qualityLabel ?? `${f.height}p`,
      url: f.url,
      audioUrl: muxed ? undefined : bestAudio.url,
      height: num(f.height),
      width: num(f.width),
      bandwidth: num(f.bitrate),
      mime: mime.split(';')[0],
      size: num(f.contentLength),
    });
  }
  if (!variants.length && bestAudio)
    variants.push({ label: 'audio', url: bestAudio.url, mime: bestAudio.mimeType?.split(';')[0], bandwidth: num(bestAudio.bitrate) });
  if (variants.length) return [{ ...base, variants: dedupeHeights(variants) }];
  // Ciphered/SABR-only formats: the player itself can still play it, so capture what it plays.
  return [{ ...base, captureOnly: true }];
}

// ------------------------------------------------------------------ Bilibili

export function bilibili(playinfo: Json | null | undefined, title?: string, pageUrl = ''): SiteMedia[] {
  const data = playinfo?.data ?? playinfo?.result?.video_info ?? playinfo;
  if (!data) return [];
  const dash = data.dash;
  const key = `bili:${pageUrl.split('?')[0]}`;
  const url = (x: Json) => [x.baseUrl, x.base_url, ...(x.backupUrl ?? x.backup_url ?? [])].find(isHttp);
  if (dash?.video?.length) {
    const audios: Json[] = [...(dash.audio ?? []), ...(dash.dolby?.audio ?? []), ...(dash.flac?.audio ? [dash.flac.audio] : [])]
      .filter((a) => url(a))
      .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    const variants = (dash.video as Json[])
      .filter((v) => url(v))
      .map((v) => ({
        label: `${v.height}p${v.codecs ? ` ${String(v.codecs).split('.')[0]}` : ''}`,
        url: url(v)!,
        audioUrl: audios[0] ? url(audios[0]) : undefined,
        height: num(v.height),
        width: num(v.width),
        bandwidth: num(v.bandwidth),
        mime: v.mimeType ?? v.mime_type,
      }));
    return variants.length ? [{ site: 'bilibili', key, title, duration: num(dash.duration), variants: dedupeHeights(variants) }] : [];
  }
  const durl: Json[] = data.durl ?? [];
  if (durl.length === 1 && isHttp(durl[0].url))
    return [{ site: 'bilibili', key, title, variants: [{ label: 'default', url: durl[0].url, size: num(durl[0].size) }] }];
  return [];
}

// ------------------------------------------------------------------ Vimeo

/** Vimeo video id from a vimeo.com / player.vimeo.com URL. */
export function vimeoId(url: string): string | undefined {
  return /vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/)?(\d{5,})/.exec(url)?.[1];
}

export function vimeo(config: Json | null | undefined, pageUrl?: string): SiteMedia[] {
  const files = config?.request?.files;
  if (!files) {
    const id = pageUrl && vimeoId(pageUrl);
    return id ? [{ site: 'vimeo', key: `vimeo:${id}:config`, configUrl: `https://player.vimeo.com/video/${id}/config` }] : [];
  }
  const video = config.video ?? {};
  const base = {
    site: 'vimeo',
    key: `vimeo:${video.id ?? ''}`,
    title: video.title,
    duration: num(video.duration),
    thumbnail: video.thumbs?.base ?? Object.values(video.thumbs ?? {}).find(isHttp),
  };
  const cdnUrl = (f: Json | undefined) => (f ? (f.cdns?.[f.default_cdn]?.url ?? Object.values(f.cdns ?? {}).map((c) => (c as Json).url).find(isHttp)) : undefined);
  const progressive: SiteVariant[] = (files.progressive ?? [])
    .filter((p: Json) => isHttp(p.url))
    .map((p: Json) => ({ label: p.quality ?? `${p.height}p`, url: p.url, height: num(p.height), width: num(p.width), mime: p.mime }));
  const hls = cdnUrl(files.hls);
  const out: SiteMedia[] = [];
  if (isHttp(hls)) out.push({ ...base, hls });
  if (progressive.length) out.push({ ...base, key: `${base.key}:p`, variants: dedupeHeights(progressive) });
  return out;
}

// ------------------------------------------------------------------ OK.ru

export function okru(dataOptions: string[]): SiteMedia[] {
  const out: SiteMedia[] = [];
  for (const raw of dataOptions) {
    let meta: Json;
    try {
      const opts = JSON.parse(raw);
      const m = opts?.flashvars?.metadata;
      meta = typeof m === 'string' ? JSON.parse(m) : m;
    } catch {
      continue;
    }
    if (!meta) continue;
    const movie = meta.movie ?? {};
    const base = { site: 'ok', key: `ok:${movie.id ?? out.length}`, title: movie.title, thumbnail: movie.poster, duration: num(movie.duration) };
    const heights: Record<string, number> = { mobile: 144, lowest: 240, low: 360, sd: 480, hd: 720, full: 1080, quad: 1440, ultra: 2160 };
    const variants: SiteVariant[] = (meta.videos ?? [])
      .filter((v: Json) => isHttp(v.url))
      .map((v: Json) => ({ label: heights[v.name] ? `${heights[v.name]}p` : v.name, url: v.url, height: heights[v.name] }));
    if (variants.length) out.push({ ...base, variants: dedupeHeights(variants) });
    else if (isHttp(meta.hlsManifestUrl ?? meta.ondemandHls)) out.push({ ...base, hls: meta.hlsManifestUrl ?? meta.ondemandHls });
    else if (isHttp(meta.hlsMasterPlaylistUrl)) out.push({ ...base, hls: meta.hlsMasterPlaylistUrl });
  }
  return out;
}

// ------------------------------------------------------------------ text scanners (VK, Facebook, Instagram)

/** Decode a JSON string literal body found in page source ("https:\/\/..." -> "https://..."). */
function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

export function vk(source: string, title?: string): SiteMedia[] {
  const variants: SiteVariant[] = [];
  for (const m of source.matchAll(/"(?:mp4|url)_?(\d{3,4})":"(https:[^"]+)"/g)) {
    const url = unescapeJson(m[2]);
    if (isHttp(url)) variants.push({ label: `${m[1]}p`, url, height: Number(m[1]) });
  }
  const hls = /"hls(?:_ondemand|_live)?":"(https:[^"]+)"/.exec(source);
  const dash = /"dash_(?:sep|webm|ondemand)":"(https:[^"]+)"/.exec(source);
  const base = { site: 'vk', key: 'vk', title };
  const out: SiteMedia[] = [];
  if (variants.length) out.push({ ...base, variants: dedupeHeights(variants) });
  if (hls) out.push({ ...base, key: 'vk:hls', hls: unescapeJson(hls[1]) });
  else if (dash) out.push({ ...base, key: 'vk:dash', dash: unescapeJson(dash[1]) });
  return out;
}

export function facebook(source: string, title?: string): SiteMedia[] {
  const out: SiteMedia[] = [];
  const seen = new Set<string>();
  // Progressive HD/SD pairs.
  const hdRe = /"(?:browser_native_hd_url|playable_url_quality_hd|hd_src(?:_no_ratelimit)?)":"(https:[^"]+)"/g;
  const sdRe = /"(?:browser_native_sd_url|playable_url|sd_src(?:_no_ratelimit)?)":"(https:[^"]+)"/g;
  const hd = [...source.matchAll(hdRe)].map((m) => unescapeJson(m[1]));
  const sd = [...source.matchAll(sdRe)].map((m) => unescapeJson(m[1]));
  for (let i = 0; i < Math.max(hd.length, sd.length) && out.length < 10; i++) {
    const variants: SiteVariant[] = [];
    if (isHttp(hd[i]) && !seen.has(hd[i])) variants.push({ label: 'HD', url: hd[i], height: 720 });
    if (isHttp(sd[i]) && !seen.has(sd[i])) variants.push({ label: 'SD', url: sd[i], height: 360 });
    variants.forEach((v) => seen.add(v.url));
    if (variants.length) out.push({ site: 'facebook', key: `fb:${variants[0].url.split('?')[0]}`, title, variants });
  }
  // Instagram video_versions.
  for (const m of source.matchAll(/"video_versions":(\[[^\]]+\])/g)) {
    try {
      const vs = (JSON.parse(m[1]) as Json[])
        .filter((v) => isHttp(v.url) && !seen.has(v.url))
        .map((v) => ({ label: v.height ? `${v.height}p` : 'video', url: v.url, height: num(v.height), width: num(v.width) }));
      vs.forEach((v) => seen.add(v.url));
      if (vs.length && out.length < 10) out.push({ site: 'instagram', key: `ig:${vs[0].url.split('?')[0]}`, title, variants: dedupeHeights(vs) });
    } catch {
      /* not JSON */
    }
  }
  // Embedded DASH manifests (separate audio/video, higher qualities).
  for (const m of source.matchAll(/"(?:dash_manifest|manifest_xml|video_dash_manifest)":"((?:[^"\\]|\\.)+)"/g)) {
    const xml = unescapeJson(m[1]);
    if (!/<MPD/.test(xml) || out.length >= 10) continue;
    const id = /<BaseURL>([^<]+)<\/BaseURL>/.exec(xml)?.[1]?.split('?')[0] ?? String(out.length);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ site: /instagram/.test(source.slice(0, 2000)) ? 'instagram' : 'facebook', key: `fbdash:${id}`, title, dashXml: xml });
  }
  return out;
}

// ------------------------------------------------------------------ Reddit

/**
 * Id shared by a Reddit post's player, manifest and stream URLs (v.redd.it/<id>/HLSPlaylist.m3u8,
 * v.redd.it/<id>/DASH_720.mp4, packaged-media.redd.it/<id>/..., i.redd.it/<id>.gif). Used to name each
 * download after its post instead of the feed page.
 */
export function redditKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!/(^|\.)redd\.it$/.test(u.hostname)) return;
    return u.pathname.split('/').find(Boolean)?.replace(/\.\w+$/, '') || undefined;
  } catch {
    return;
  }
}

// ------------------------------------------------------------------ generic page metadata (any site)

const MEDIA_URL = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|flv|f4v|ogv|3gp|avi|wmv|mpe?g|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|$)/i;

/** JSON-LD VideoObject and Open Graph video tags (only URLs that are actually media). */
export function genericMeta(jsonLd: string[], og: Record<string, string>, title?: string): SiteMedia[] {
  const urls = new Set<string>();
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const o = n as Json;
    const type = ([] as string[]).concat(o['@type'] ?? []);
    if (type.includes('VideoObject') && isHttp(o.contentUrl) && (MEDIA_URL.test(o.contentUrl) || /^video\//.test(o.encodingFormat ?? '')))
      urls.add(o.contentUrl);
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  for (const raw of jsonLd) {
    try {
      visit(JSON.parse(raw));
    } catch {
      /* invalid JSON-LD */
    }
  }
  // og:video is often an HTML player page (YouTube: /embed/...): only accept real media.
  const ogType = og['og:video:type'] ?? '';
  const typeOk = /^video\/|mpegurl|dash\+xml/i.test(ogType) && !/html|flash/i.test(ogType);
  for (const k of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream'])
    if (isHttp(og[k]) && (MEDIA_URL.test(og[k]) || typeOk)) urls.add(og[k]);
  return [...urls].slice(0, 5).map((url) =>
    /\.m3u8(\?|$)/i.test(url)
      ? { site: 'page', key: url, title, hls: url }
      : /\.mpd(\?|$)/i.test(url)
        ? { site: 'page', key: url, title, dash: url }
        : { site: 'page', key: url, title, variants: [{ label: 'default', url }] },
  );
}
