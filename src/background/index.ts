/**
 * Background: detects media from network traffic and page content, keeps the per-tab media list,
 * runs the download queue, history, notifications, context menus and hotkeys.
 */
import { classify, extFor, mediaKey } from '../shared/detect';
import { t } from '../shared/i18n';
import type { ContentMessage, EngineEvent, UiRequest } from '../shared/messages';
import { buildBasename, cleanTitle } from '../shared/naming';
import { visibleMedia } from '../shared/quality';
import { loadSettings, type Settings } from '../shared/settings';
import type { HistoryEntry, Job, MediaItem, RequestHeaders, Variant } from '../shared/types';
import { formatDuration, hostMatches, hostOf, uid } from '../shared/util';
import { engine, hasOffscreen, onEngineEvent, usesOffscreen } from './engine-client';
import { clearHeaderRule, pruneHeaderRules, ruleId, setHeaderRule, setYoutubeUaRule } from './rules';
import { vimeo, youtube, youtubePlayerRequest, YT_IOS, type SiteMedia } from '../shared/sites';
import { applyUpdate, checkForUpdate, scheduleUpdates, updateState } from './update';

// ------------------------------------------------------------------ state

const media = new Map<number, MediaItem[]>();
const tabInfo = new Map<number, { thumbnail?: string; drm?: boolean }>();
let jobs: Job[] = [];
let settings: Settings;
const isFirefox = !chrome.offscreen;
/** Jobs handled by the stream engine (everything except plain file downloads and MSE captures). */
const variantOf = (j: Job) => j.media.variants?.find((v) => v.id === j.options.variantId) ?? j.media.variants?.[0];
/** Jobs handled by the stream engine: everything except plain single-file downloads and MSE captures. */
const isEngineJob = (j: Job) =>
  j.media.kind !== 'mse' && !(j.media.kind === 'direct' && !j.options.audioOnly && !variantOf(j)?.audioRef);
const isTurbo = (j: Job) => j.media.kind === 'mse' && (!!j.options.turbo || !!j.media.captureOnly);

const ready = (async () => {
  settings = await loadSettings();
  const s = await chrome.storage.session.get(['media', 'jobs', 'tabInfo']);
  for (const [k, v] of Object.entries((s.media ?? {}) as Record<string, MediaItem[]>)) media.set(Number(k), v);
  for (const [k, v] of Object.entries((s.tabInfo ?? {}) as Record<string, { thumbnail?: string }>)) tabInfo.set(Number(k), v);
  jobs = (s.jobs ?? []) as Job[];
  // Engine jobs can only survive a background restart if the offscreen document survived.
  const engineAlive = usesOffscreen() && (await hasOffscreen());
  for (const j of jobs)
    // MSE saves reply through a message channel that died with the old worker.
    // A turbo capture keeps running in the page and reports in again, so it survives a worker restart.
    if (j.status === 'running' && !j.downloadIds?.length && !(engineAlive && isEngineJob(j)) && !(isTurbo(j) && j.progress.phase === 'recording')) {
      j.status = 'error';
      j.error = t('err_interrupted');
    }
  // Rules of analyses/jobs that died with the previous worker would otherwise linger for the session.
  await pruneHeaderRules([...jobs.filter((j) => j.status === 'running').map((j) => `job-${j.id}`), 'youtube-ua']);
  await applyUiMode();
  pump();
})();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
const ports = new Set<chrome.runtime.Port>();

function changed(tabId?: number) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void chrome.storage.session.set({
      media: Object.fromEntries(media),
      jobs,
      tabInfo: Object.fromEntries(tabInfo),
    });
  }, 300);
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => ports.forEach((p) => p.postMessage({ type: 'changed' })), 150);
  if (tabId != null) {
    updateBadge(tabId);
    scheduleMenu();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

const visible = (tabId: number) => visibleMedia(media.get(tabId) ?? [], settings?.mediaOrder ?? 'smart');

function updateBadge(tabId: number) {
  if (tabId < 0) return;
  const n = visible(tabId).length;
  void chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#e5484d' }).catch(() => {});
}

// ------------------------------------------------------------------ detection

const sentHeaders = new Map<string, RequestHeaders>();

function onSendHeaders(d: chrome.webRequest.OnSendHeadersDetails) {
  if (d.tabId < 0) return;
  const h: RequestHeaders = {};
  for (const x of d.requestHeaders ?? []) {
    const n = x.name.toLowerCase();
    if (n === 'referer') h.referer = x.value;
    else if (n === 'origin') h.origin = x.value;
  }
  if (sentHeaders.size > 3000) sentHeaders.clear();
  sentHeaders.set(d.requestId, h);
}

chrome.webRequest.onSendHeaders.addListener(
  onSendHeaders,
  { urls: ['<all_urls>'] },
  (isFirefox ? ['requestHeaders'] : ['requestHeaders', 'extraHeaders']) as chrome.webRequest.OnSendHeadersOptions[],
);

const IGNORED_TYPES = new Set(['image', 'stylesheet', 'script', 'font', 'ping', 'csp_report', 'websocket', 'beacon', 'imageset']);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const headers = sentHeaders.get(d.requestId) ?? {};
    sentHeaders.delete(d.requestId);
    if (d.tabId < 0 || IGNORED_TYPES.has(d.type) || (d.statusCode !== 200 && d.statusCode !== 206)) return;
    const get = (n: string) => d.responseHeaders?.find((h) => h.name.toLowerCase() === n)?.value;
    const len = get('content-length');
    const det = classify({
      url: d.url,
      contentType: get('content-type'),
      contentLength: len != null ? Number(len) : undefined,
      contentRange: get('content-range'),
      status: d.statusCode,
    });
    // YouTube serves raw stream chunks from googlevideo; the YouTube extractor handles that site.
    if (!det || /(^|\.)googlevideo\.com$/.test(new URL(d.url).hostname)) return;
    void ready.then(() => addMedia(d.tabId, d.frameId, d.url, det.kind, { mime: det.mime, size: det.size, headers }));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

async function addMedia(
  tabId: number,
  frameId: number,
  url: string,
  kind: MediaItem['kind'],
  extra: Partial<MediaItem>,
  /** False for URLs only reported by page content: never fetch those without a user click. */
  autoAnalyze = true,
): Promise<MediaItem | undefined> {
  const key = kind === 'mse' ? url : mediaKey(url);
  const find = () =>
    (media.get(tabId) ?? []).find((m) => (m.kind === 'mse' ? m.id === extra.id : mediaKey(m.url) === key));
  const merge = (existing: MediaItem) => {
    // Only take defined values, so a re-detection from <video> doesn't erase the size/mime seen on the network.
    const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    Object.assign(existing, { ...defined, id: existing.id, headers: { ...extra.headers, ...existing.headers } });
    // First seen in the DOM, now requested by the page itself: safe to analyze.
    if (autoAnalyze && existing.analyzed === undefined && (kind === 'hls' || kind === 'dash')) void analyzeItem(existing);
    changed(tabId);
    return existing;
  };
  const before = find();
  if (before) return merge(before);
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const raced = find(); // detected again while we awaited the tab
  if (raced) return merge(raced);
  const item: MediaItem = {
    id: extra.id ?? uid(),
    tabId,
    frameId,
    kind,
    url: key,
    pageUrl: tab.url ?? '',
    pageTitle: tab.title ?? '',
    headers: {},
    detectedAt: Date.now(),
    incognito: tab.incognito,
    thumbnail: tabInfo.get(tabId)?.thumbnail,
    ...extra,
  };
  item.headers.referer ??= tab.url;
  media.set(tabId, [...(media.get(tabId) ?? []), item]);
  changed(tabId);
  if (autoAnalyze && (kind === 'hls' || kind === 'dash')) void analyzeItem(item);
  return item;
}

async function analyzeItem(item: MediaItem) {
  const key = `analyze-${item.id}`;
  item.analyzed = false; // in progress
  try {
    await setHeaderRule(key, [new URL(item.url).hostname], item.headers);
    Object.assign(item, await engine<Partial<MediaItem>>({ op: 'analyze', media: item }), { analyzed: true });
  } catch (e) {
    item.analyzed = true;
    item.error = e instanceof Error ? e.message : String(e);
  } finally {
    void clearHeaderRule(key);
  }
  changed(item.tabId);
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  void ready.then(() => {
    // Keep a media file the tab itself navigated to (opening an .mp4 directly).
    const keep = (media.get(d.tabId) ?? []).filter((m) => m.url === d.url);
    media.set(d.tabId, keep);
    tabInfo.delete(d.tabId);
    changed(d.tabId);
  });
});

// SPA navigation (YouTube & co.): drop site-extracted items of the previous video.
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  void ready.then(() => {
    const list = media.get(d.tabId);
    if (!list?.some((m) => m.site)) return;
    media.set(d.tabId, list.filter((m) => !m.site));
    changed(d.tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => {
    // A capture lives in the page: it can never finish once the tab is gone.
    for (const j of jobs)
      if (j.status === 'running' && j.media.kind === 'mse' && j.media.tabId === tabId) void fail(j, t('err_tab_closed'));
    media.delete(tabId);
    tabInfo.delete(tabId);
    changed();
  });
});

chrome.tabs.onActivated.addListener(() => {
  scheduleMenu();
  changed();
});

// ------------------------------------------------------------------ queue

const findJob = (id: string) => jobs.find((j) => j.id === id);

async function smartName(item: MediaItem): Promise<string | undefined> {
  const host = hostOf(item.pageUrl);
  const rule = settings.smartNaming.find((r) => hostMatches(host, r.host));
  if (!rule) return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: item.tabId },
      func: (sel: string) => {
        const xpath = /^[/(]/.test(sel);
        const text = xpath
          ? document.evaluate(sel, document, null, XPathResult.STRING_TYPE, null).stringValue
          : document.querySelector(sel)?.textContent;
        return (text ?? '').replace(/\s+/g, ' ').trim();
      },
      args: [rule.selector],
    });
    return (res?.result as string) || undefined;
  } catch {
    return;
  }
}

async function enqueue(item: MediaItem, options: Job['options']) {
  const host = hostOf(item.pageUrl || item.url);
  if (settings.audioOnlySites.some((s) => hostMatches(host, s))) options.audioOnly = true;
  const variant = item.variants?.find((v) => v.id === options.variantId);
  const job: Job = {
    id: uid(),
    media: item,
    options,
    basename: buildBasename(
      settings.filenameTemplate,
      {
        title: item.title || cleanTitle(item.pageTitle || hostOf(item.url), host) || 'video',
        host,
        quality: options.audioOnly ? 'audio' : variant?.label,
        smart: await smartName(item),
      },
      settings.subdirectory,
    ),
    status: 'queued',
    createdAt: Date.now(),
    progress: { bytes: 0 },
  };
  jobs.push(job);
  changed();
  pump();
}

// Firefox suspends idle event pages; engine progress stays in-process and doesn't count as activity.
let keepAlive: ReturnType<typeof setInterval> | undefined;
function updateKeepAlive() {
  const busy = isFirefox && jobs.some((j) => j.status === 'running' && isEngineJob(j));
  if (busy && !keepAlive) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  if (!busy && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }
}

function pump() {
  if (!settings) return;
  let running = jobs.filter((j) => j.status === 'running').length;
  for (const j of jobs) {
    if (running >= settings.maxParallel) break;
    if (j.status !== 'queued') continue;
    j.status = 'running';
    j.heartbeat = Date.now();
    running++;
    void startJob(j).catch((e) => fail(j, e instanceof Error ? e.message : String(e)));
  }
  updateKeepAlive();
  changed();
}

/**
 * Jobs that went silent (page navigated away during a turbo capture, engine lost with its offscreen
 * document) would otherwise hold a download slot forever and leave every new download "Waiting…".
 */
const STALL_MS = { turbo: 90_000, engine: 120_000 };
setInterval(() => {
  if (!settings) return;
  const now = Date.now();
  for (const j of jobs) {
    if (j.status !== 'running' || !j.heartbeat) continue;
    const silent = now - j.heartbeat;
    if (isTurbo(j) && j.progress.phase === 'recording' && silent > STALL_MS.turbo) void fail(j, t('err_stalled'));
    else if (isEngineJob(j) && !j.downloadIds && j.progress.phase !== 'convert' && silent > STALL_MS.engine) {
      void engine({ op: 'cancel', jobId: j.id }).catch(() => {});
      void fail(j, t('err_stalled'));
    }
  }
}, 15_000);

async function startJob(j: Job) {
  if (isTurbo(j)) return startTurbo(j);
  if (j.media.kind === 'mse') return startMse(j);
  const v = variantOf(j);
  const hosts = [j.media.url, v?.ref, v?.audioRef]
    .filter((u): u is string => !!u && /^https?:/.test(u))
    .map((u) => new URL(u).hostname);
  await setHeaderRule(`job-${j.id}`, hosts, j.media.headers);
  if (j.status !== 'running') return cleanup(j); // canceled while we were setting up
  if (!isEngineJob(j)) {
    const url = v?.ref ?? j.media.url;
    const ext = extFor(url, v?.mime ?? j.media.mime);
    const id = await chrome.downloads.download({
      url,
      filename: `${j.basename}.${ext}`,
      saveAs: !!(j.options.saveAs || settings.alwaysSaveAs),
      conflictAction: 'uniquify',
    });
    if (j.status !== 'running') return void chrome.downloads.cancel(id).catch(() => {});
    j.downloadIds = [id];
    j.filename = `${j.basename}.${ext}`;
    j.progress = { bytes: 0, total: v?.size ?? j.media.size, phase: 'download' };
    watchDirect();
    changed();
    return;
  }
  await engine({ op: 'start', job: j, settings: engineSettings() });
  if (j.status !== 'running') await engine({ op: 'cancel', jobId: j.id }).catch(() => {});
}

// ------------------------------------------------------------------ turbo capture

function waitForLoad(tabId: number, timeout = 45000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.webNavigation.onCompleted.removeListener(on);
      reject(new Error('Page did not load'));
    }, timeout);
    function on(d: { tabId: number; frameId: number }) {
      if (d.tabId !== tabId || d.frameId !== 0) return;
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(on);
      resolve();
    }
    chrome.webNavigation.onCompleted.addListener(on);
  });
}

const MAIN = 'MAIN' as chrome.scripting.ExecutionWorld;

/**
 * Turbo capture: enable capture for the tab's sites, reload, then let the page-world hook play the
 * video muted at high speed from the start; the capture is saved automatically when it ends.
 */
async function startTurbo(j: Job) {
  const tabId = j.media.tabId;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const hosts = [...new Set(frames.map((f) => hostOf(f.url)).filter(Boolean))];
  j.turboHosts = hosts.filter((h) => !settings.captureSites.some((s) => hostMatches(h, s)));
  if (j.turboHosts.length) await setCaptureScripts([...settings.captureSites, ...j.turboHosts]);
  await chrome.tabs.update(tabId, { muted: true });
  j.progress = { bytes: 0, phase: 'recording', recorded: 0, duration: j.media.duration };
  changed();
  const loaded = waitForLoad(tabId);
  await chrome.tabs.reload(tabId);
  await loaded;
  if (j.status !== 'running') return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: MAIN,
    func: (speed: number) => (window as unknown as { __reelfetchTurbo?: (s: number) => void }).__reelfetchTurbo?.(speed),
    args: [settings.turboSpeed],
  });
}

async function stopTurboInPage(tabId: number) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: MAIN,
      func: () => (window as unknown as { __reelfetchTurboStop?: () => void }).__reelfetchTurboStop?.(),
    })
    .catch(() => {});
}

/** Undo turbo side effects: tab mute and temporary capture registration. */
async function endTurbo(j: Job) {
  if (!j.turboHosts) return;
  const hosts = j.turboHosts;
  j.turboHosts = undefined;
  await chrome.tabs.update(j.media.tabId, { muted: false }).catch(() => {});
  if (hosts.length) await setCaptureScripts(settings.captureSites).catch(() => {});
}

async function onTurboEvent(msg: Extract<ContentMessage, { type: 'turbo' }>, tabId: number, frameId: number) {
  const j = jobs.find((x) => x.status === 'running' && isTurbo(x) && x.media.tabId === tabId && x.progress.phase === 'recording');
  if (!j) return;
  j.heartbeat = Date.now(); // the page is alive, even while its player has no stream (e.g. an error screen)
  if (!msg.msId) return;
  const cap = media.get(tabId)?.find((m) => m.id === `mse:${tabId}:${frameId}:${msg.msId}`);
  if (msg.event === 'progress') {
    j.progress = { bytes: cap?.mse?.bytes ?? 0, phase: 'recording', recorded: msg.time, duration: msg.duration || j.progress.duration };
    changed();
    return;
  }
  await endTurbo(j);
  // The site stopped playback early (e.g. an error screen): save what was captured, but say so.
  const duration = msg.duration || j.progress.duration; // NaN while the player shows an error
  if (duration && msg.time < duration - 3) j.warning = `${t('turbo_partial')} ${formatDuration(msg.time)} / ${formatDuration(duration)}`;
  j.progress = { ...j.progress, phase: 'mux' };
  changed();
  await startMse(j, frameId, msg.msId).catch((e) => fail(j, e instanceof Error ? e.message : String(e)));
}

async function startMse(j: Job, frameOverride?: number, msOverride?: string) {
  const frameId = frameOverride ?? j.media.frameId ?? 0;
  await chrome.scripting.executeScript({ target: { tabId: j.media.tabId, frameIds: [frameId] }, files: ['content/mse-save.js'] });
  j.progress = { bytes: j.media.mse?.bytes ?? 0, phase: 'mux' };
  changed();
  const res = await chrome.tabs.sendMessage(
    j.media.tabId,
    {
      type: 'mse-save',
      msId: msOverride ?? j.media.id.split(':').pop(),
      filename: j.basename.split('/').pop(),
      audioOnly: !!j.options.audioOnly,
      preferMkv: settings.preferMkv,
    },
    { frameId },
  );
  if (j.status !== 'running') return;
  if (!res?.ok) throw new Error(res?.error ?? 'Capture failed');
  j.filename = res.filename;
  await finish(j, res.size);
}

let directTimer: ReturnType<typeof setInterval> | undefined;
function watchDirect() {
  if (directTimer) return;
  directTimer = setInterval(async () => {
    const active = jobs.filter((j) => j.status === 'running' && !isEngineJob(j) && j.downloadIds?.length);
    if (!active.length) {
      clearInterval(directTimer);
      directTimer = undefined;
      return;
    }
    for (const j of active) {
      const [d] = await chrome.downloads.search({ id: j.downloadIds![0] });
      if (d) j.progress = { bytes: d.bytesReceived, total: d.totalBytes > 0 ? d.totalBytes : j.media.size, phase: 'download' };
    }
    changed();
  }, 1000);
}

async function onEngine(e: EngineEvent): Promise<unknown> {
  await ready;
  const j = findJob(e.jobId);
  if (!j) {
    if (e.type === 'done') void engine({ op: 'release', jobId: e.jobId }).catch(() => {});
    return;
  }
  // Events from a run that was canceled before the engine knew about it: stop it for good.
  if (j.status !== 'running' && (e.type === 'progress' || e.type === 'prepare')) {
    void engine({ op: 'cancel', jobId: j.id }).catch(() => {});
    return;
  }
  switch (e.type) {
    case 'progress':
      j.progress = e.progress;
      j.heartbeat = Date.now();
      changed();
      return;
    case 'prepare':
      return setHeaderRule(`job-${j.id}`, e.hosts, j.media.headers);
    case 'error':
      return fail(j, e.drm ? t('err_drm') : e.error);
    case 'done': {
      if (j.status !== 'running') return engine({ op: 'release', jobId: j.id });
      j.progress = { ...j.progress, phase: 'save' };
      j.downloadIds = [];
      try {
        for (const [i, f] of e.output.files.entries()) {
          const filename = `${j.basename}${f.suffix ?? ''}.${f.ext}`;
          j.filename ??= filename;
          j.downloadIds.push(
            await chrome.downloads.download({
              url: f.url,
              filename,
              saveAs: i === 0 && !!(j.options.saveAs || settings.alwaysSaveAs),
              conflictAction: 'uniquify',
            }),
          );
        }
        j.progress.total = e.output.size;
        j.progress.bytes = e.output.size;
      } catch (err) {
        await fail(j, err instanceof Error ? err.message : String(err));
      }
      changed();
      return;
    }
  }
}
onEngineEvent(onEngine);

scheduleUpdates(
  () => !!settings?.autoUpdate && !jobs.some((j) => j.status === 'running' || j.status === 'queued'),
  () => changed(),
);

chrome.downloads.onChanged.addListener((delta) => {
  void ready.then(async () => {
    const j = jobs.find((x) => x.status === 'running' && x.downloadIds?.includes(delta.id));
    if (!j) return;
    if (delta.filename?.current) j.filename = delta.filename.current.split(/[\\/]/).pop();
    if (delta.state?.current === 'interrupted') {
      const [d] = await chrome.downloads.search({ id: delta.id });
      if (d?.error === 'USER_CANCELED') await cancel(j);
      else await fail(j, d?.error ?? 'Download interrupted');
      return;
    }
    if (delta.state?.current !== 'complete') return;
    const items = await Promise.all(j.downloadIds!.map((id) => chrome.downloads.search({ id }).then((r) => r[0])));
    if (items.every((d) => d?.state === 'complete')) await finish(j, items.reduce((n, d) => n + (d?.fileSize ?? 0), 0));
  });
});

async function cleanup(j: Job) {
  void clearHeaderRule(`job-${j.id}`);
  if (j.turboHosts) {
    await stopTurboInPage(j.media.tabId);
    await endTurbo(j);
  }
  if (isEngineJob(j)) await engine({ op: 'release', jobId: j.id }).catch(() => {});
}

async function finish(j: Job, size?: number) {
  if (j.status !== 'running') return;
  j.status = 'done';
  j.progress = { ...j.progress, bytes: size ?? j.progress.bytes, total: size ?? j.progress.total, phase: undefined };
  await cleanup(j);
  if (settings.historyEnabled && !j.media.incognito) {
    await addHistory({
      id: j.id,
      title: j.media.pageTitle || j.basename,
      url: j.media.url,
      pageUrl: j.media.pageUrl,
      filename: j.filename ?? j.basename,
      kind: j.media.kind,
      size,
      date: Date.now(),
      downloadId: j.downloadIds?.[0],
    });
  }
  if (settings.notifyOnComplete && (settings.privateNotifications || !j.media.incognito))
    notify(j.id, t('notif_done'), j.filename ?? j.basename);
  void countDownload();
  if (!settings.showCompleted) jobs = jobs.filter((x) => x !== j);
  changed();
  pump();
}

async function fail(j: Job, error: string) {
  if (j.status !== 'running' && j.status !== 'queued') return;
  j.status = 'error';
  j.error = error;
  await cleanup(j);
  if (settings.notifyOnComplete) notify(j.id, t('notif_failed'), `${j.basename}: ${error}`);
  changed();
  pump();
}

async function cancel(j: Job) {
  if (j.status !== 'running' && j.status !== 'queued') return;
  const wasRunning = j.status === 'running';
  j.status = 'canceled';
  if (wasRunning) {
    if (isEngineJob(j)) await engine({ op: 'cancel', jobId: j.id }).catch(() => {});
    for (const id of j.downloadIds ?? []) await chrome.downloads.cancel(id).catch(() => {});
  }
  await cleanup(j);
  changed();
  pump();
}

function notify(id: string, title: string, message: string) {
  void chrome.notifications
    .create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title, message })
    .catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  void ready.then(() => {
    const d = findJob(id)?.downloadIds?.[0];
    if (d != null) chrome.downloads.show(d);
  });
});

// ------------------------------------------------------------------ history

async function getHistory(): Promise<HistoryEntry[]> {
  const { history } = await chrome.storage.local.get('history');
  const cutoff = Date.now() - settings.historyDays * 86400_000;
  return ((history ?? []) as HistoryEntry[]).filter((h) => h.date >= cutoff);
}

let historyChain: Promise<void> = Promise.resolve();
/** Serialized read-modify-write so jobs finishing together don't drop entries. */
function addHistory(e: HistoryEntry): Promise<void> {
  historyChain = historyChain
    .then(async () => {
      const list = await getHistory();
      await chrome.storage.local.set({ history: [e, ...list].slice(0, 2000) });
    })
    .catch(() => {});
  return historyChain;
}

// ------------------------------------------------------------------ MSE capture

async function setCaptureScripts(sites: string[]) {
  await chrome.scripting.unregisterContentScripts({ ids: ['mse-hook'] }).catch(() => {});
  if (!sites.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: 'mse-hook',
      js: ['content/mse-hook.js'],
      matches: sites.flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]),
      runAt: 'document_start',
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);
}

async function toggleCapture(tabId: number, enable: boolean) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const hosts = [...new Set(frames.map((f) => hostOf(f.url)).filter(Boolean))];
  const sites = enable
    ? [...new Set([...settings.captureSites, ...hosts])]
    : settings.captureSites.filter((s) => !hosts.some((h) => hostMatches(h, s)));
  settings = { ...settings, captureSites: sites };
  await chrome.storage.local.set({ settings });
  await setCaptureScripts(sites);
  await chrome.tabs.reload(tabId);
}

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'engine-event') {
    onEngine(msg.event as EngineEvent).then(reply, () => reply(undefined));
    return true;
  }
  if (msg?.target === 'engine') return; // for the offscreen document
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage) {
    if (sender.tab?.id != null && ['page-media', 'mse-update', 'drm-detected', 'site-media', 'turbo', 'picker-result'].includes(msg?.type))
      void ready.then(() => onContent(msg as ContentMessage, sender.tab!.id!, sender.frameId ?? 0));
    return; // content scripts may only report, never command
  }
  ready
    .then(() => onUi(msg as UiRequest))
    .then(reply, (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});

async function addSiteMedia(tabId: number, frameId: number, items: unknown[]) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const http = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u) && u.length < 8192;
  const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  for (const raw of items.slice(0, 20)) {
    const it = raw as SiteMedia;
    if (!it || typeof it.site !== 'string' || typeof it.key !== 'string') continue;
    const meta: Partial<MediaItem> = {
      site: it.site.slice(0, 20),
      title: str(it.title),
      thumbnail: http(it.thumbnail) ? it.thumbnail : undefined,
      duration: num(it.duration),
      drm: it.drm === true || undefined,
    };
    if (it.site === 'vimeo' && http(it.configUrl) && new URL(it.configUrl).hostname === 'player.vimeo.com') {
      // Only this known endpoint: a page must not make the extension fetch arbitrary URLs.
      const res = await fetch(it.configUrl, { credentials: 'include' }).catch(() => null);
      const json = res?.ok ? await res.json().catch(() => null) : null;
      const found = vimeo(json);
      if (found.length) await addSiteMedia(tabId, frameId, found);
      continue;
    }
    if (http(it.hls)) await addMedia(tabId, frameId, it.hls, 'hls', meta);
    else if (http(it.dash)) await addMedia(tabId, frameId, it.dash, 'dash', meta);
    else if (typeof it.dashXml === 'string' && it.dashXml.length < 4e6)
      // Inline manifest: a synthetic URL keeps items distinct; BaseURLs resolve against the page.
      await addMedia(tabId, frameId, `about:reelfetch-${ruleId(it.key)}`, 'dash', { ...meta, manifest: it.dashXml });
    else if (Array.isArray(it.variants)) {
      const variants: Variant[] = it.variants
        .filter((v) => v && http(v.url))
        .slice(0, 40)
        .map((v) => ({
          id: v.url,
          ref: v.url,
          audioRef: http(v.audioUrl) ? v.audioUrl : undefined,
          label: str(v.label, 40) ?? 'video',
          height: num(v.height),
          width: num(v.width),
          bandwidth: num(v.bandwidth),
          mime: str(v.mime, 80),
          size: num(v.size),
        }));
      if (variants.length) await addMedia(tabId, frameId, variants[0].ref, 'direct', { ...meta, variants, size: variants[0].size, analyzed: true });
    } else if (it.captureOnly === true) {
      await addMedia(tabId, frameId, `turbo:${it.key}`, 'mse', {
        ...meta,
        id: `turbo:${tabId}:${it.key.slice(0, 80)}`,
        captureOnly: true,
        mse: { bytes: 0, mimes: [] },
      });
      if (it.site === 'youtube') await addYoutubeApiMedia(tabId, frameId, it.key, tab.url ?? '');
    }
  }
}

/**
 * YouTube via its player API (iOS client profile): when the page only offers SABR streams, ask the API
 * for direct stream URLs, like VDH does. Turbo capture stays available as the fallback.
 */
async function addYoutubeApiMedia(tabId: number, frameId: number, key: string, pageUrl: string) {
  const videoId = /^yt:([\w-]{6,20})$/.exec(key)?.[1];
  if (!settings.youtubeApi || !videoId) return;
  const host = new URL(pageUrl).hostname;
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
  // The API is always called on www.youtube.com (the e2e test maps that host to a local server).
  const origin = `https://www.youtube.com${new URL(pageUrl).port ? `:${new URL(pageUrl).port}` : ''}`;
  try {
    await setYoutubeUaRule(YT_IOS.userAgent);
    const req = youtubePlayerRequest(videoId, origin);
    const res = await fetch(req.url, { ...req.init, credentials: 'omit' });
    if (!res.ok) return;
    const found = youtube(await res.json()).filter((m) => m.variants?.length);
    for (const m of found) m.key = `${m.key}:api`;
    if (found.length) await addSiteMedia(tabId, frameId, found);
  } catch (e) {
    console.warn('[ReelFetch] YouTube API lookup failed', e);
  }
}

async function onContent(msg: ContentMessage, tabId: number, frameId: number) {
  const info = tabInfo.get(tabId) ?? {};
  tabInfo.set(tabId, info);
  if (msg.type === 'page-media') {
    if (msg.thumbnail && frameId === 0) {
      info.thumbnail = msg.thumbnail;
      for (const m of media.get(tabId) ?? []) m.thumbnail ??= msg.thumbnail;
    }
    for (const url of msg.urls) {
      const det = classify({ url }) ?? (/^https?:/.test(url) ? { kind: 'direct' as const } : null);
      if (det) await addMedia(tabId, frameId, url, det.kind, { mime: det.mime }, false);
    }
    changed(tabId);
  } else if (msg.type === 'mse-update') {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    await addMedia(tabId, frameId, `mse:${tabId}:${frameId}:${msg.msId}`, 'mse', {
      id: `mse:${tabId}:${frameId}:${msg.msId}`,
      mse: { bytes: msg.bytes, mimes: msg.mimes },
      drm: info.drm,
      pageUrl: tab?.url ?? '',
      pageTitle: tab?.title ?? '',
    });
  } else if (msg.type === 'site-media') {
    if (Array.isArray(msg.items)) await addSiteMedia(tabId, frameId, msg.items);
  } else if (msg.type === 'turbo') {
    await onTurboEvent(msg, tabId, frameId);
  } else if (msg.type === 'picker-result') {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const host = hostOf(tab?.url ?? '');
    if (!host || typeof msg.selector !== 'string' || !msg.selector) return;
    settings = {
      ...settings,
      smartNaming: [...settings.smartNaming.filter((r) => r.host !== host), { host, selector: msg.selector.slice(0, 500) }],
    };
    await chrome.storage.local.set({ settings });
    notify(`picker-${Date.now()}`, t('smart_naming_saved'), `${host}: ${String(msg.text).slice(0, 120)}`);
  } else if (msg.type === 'drm-detected') {
    info.drm = true;
    for (const m of media.get(tabId) ?? []) if (m.kind === 'mse') m.drm = true;
    changed(tabId);
  }
}

async function onUi(msg: UiRequest): Promise<unknown> {
  switch (msg.type) {
    case 'get-state': {
      const tabId = msg.tabId ?? -1;
      const tab = tabId >= 0 ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const host = hostOf(tab?.url ?? '');
      return {
        media: tabId >= 0 ? visible(tabId) : [],
        jobs,
        history: await getHistory(),
        tab: tab && { id: tab.id, url: tab.url, title: tab.title, incognito: tab.incognito },
        capture: !!host && settings.captureSites.some((s) => hostMatches(host, s)),
        drm: !!tabInfo.get(tabId)?.drm,
        hostPermission: await chrome.permissions.contains({ origins: ['<all_urls>'] }),
        update: await updateState(),
      };
    }
    case 'download': {
      const item = [...media.values()].flat().find((m) => m.id === msg.mediaId);
      if (!item) throw new Error('Media no longer available');
      await enqueue(item, { variantId: msg.variantId, audioOnly: msg.audioOnly, saveAs: msg.saveAs });
      return true;
    }
    case 'cancel':
    case 'stop': {
      const j = findJob(msg.jobId);
      if (!j) return;
      if (msg.type === 'stop' && j.progress.phase === 'recording' && isTurbo(j)) await stopTurboInPage(j.media.tabId);
      else if (msg.type === 'stop' && j.progress.phase === 'recording') await engine({ op: 'stop', jobId: j.id });
      else await cancel(j);
      return true;
    }
    case 'retry': {
      const j = findJob(msg.jobId);
      if (j && (j.status === 'error' || j.status === 'canceled')) {
        Object.assign(j, { status: 'queued', error: undefined, warning: undefined, progress: { bytes: 0 }, downloadIds: undefined, filename: undefined });
        pump();
      }
      return true;
    }
    case 'remove-job':
      jobs = jobs.filter((j) => j.id !== msg.jobId || j.status === 'running');
      changed();
      return true;
    case 'clear-jobs':
      jobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
      changed();
      return true;
    case 'clear-history':
      await chrome.storage.local.set({ history: [] });
      changed();
      return true;
    case 'remove-history':
      await chrome.storage.local.set({ history: (await getHistory()).filter((h) => h.id !== msg.id) });
      changed();
      return true;
    case 'reload-tab': {
      if (msg.clearCookies) {
        const tab = await chrome.tabs.get(msg.tabId);
        const url = new URL(tab.url ?? '');
        const bd = chrome.browsingData as unknown as {
          removeCookies?: (o: { hostnames: string[] }) => Promise<void>;
        };
        if (isFirefox && bd.removeCookies) await bd.removeCookies({ hostnames: [url.hostname] });
        else await chrome.browsingData.remove({ origins: [url.origin] }, { cookies: true });
      }
      await chrome.tabs.reload(msg.tabId, { bypassCache: true });
      return true;
    }
    case 'preview': {
      const item = [...media.values()].flat().find((m) => m.id === msg.mediaId);
      if (!item || (item.kind !== 'hls' && item.kind !== 'dash')) return null;
      const key = `preview-${item.id}`;
      if (!item.manifest) await setHeaderRule(key, [new URL(item.url).hostname], item.headers);
      try {
        return await engine<string>({ op: 'preview', media: item, settings: engineSettings() });
      } finally {
        void clearHeaderRule(key);
      }
    }
    case 'default-action': {
      const item = [...media.values()].flat().find((m) => m.id === msg.mediaId);
      if (!item) throw new Error('Media no longer available');
      await runDefault(item, msg.variantId);
      return settings.defaultAction;
    }
    case 'turbo': {
      const item =
        [...media.values()].flat().find((m) => m.id === msg.mediaId) ??
        (await addMedia(msg.tabId, 0, `turbo:page:${msg.tabId}`, 'mse', {
          id: `turbo:${msg.tabId}:page`,
          captureOnly: true,
          mse: { bytes: 0, mimes: [] },
        }));
      if (!item) throw new Error('Tab not available');
      await enqueue(item, { turbo: true });
      return true;
    }
    case 'pick-name':
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['content/picker.js'] });
      return true;
    case 'capture-site':
      await toggleCapture(msg.tabId, msg.enable);
      return true;
    case 'update-check': {
      const s = await checkForUpdate();
      changed();
      return s;
    }
    case 'update-apply':
      if (jobs.some((j) => j.status === 'running' || j.status === 'queued')) throw new Error(t('update_busy'));
      return applyUpdate().finally(() => changed());
    case 'settings-changed':
      settings = await loadSettings();
      await applyUiMode();
      await setCaptureScripts(settings.captureSites);
      scheduleMenu();
      for (const tabId of media.keys()) updateBadge(tabId);
      changed();
      pump();
      return true;
  }
}

// ------------------------------------------------------------------ UI mode, menus, hotkeys

type SidebarApi = { sidebarAction?: { open(): Promise<void> } };
const ff = (globalThis as { browser?: SidebarApi }).browser;

async function applyUiMode() {
  const sidebar = settings.uiMode === 'sidebar';
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebar }).catch(() => {});
    await chrome.action.setPopup({ popup: sidebar ? '' : 'ui/popup.html' });
  } else {
    await chrome.action.setPopup({ popup: sidebar && ff?.sidebarAction ? '' : 'ui/popup.html' });
  }
}

chrome.action.onClicked.addListener(() => {
  void ff?.sidebarAction?.open();
});

let menuTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMenu() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => void buildMenu(), 300);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function buildMenu() {
  await chrome.contextMenus.removeAll();
  if (!settings?.contextMenu) return;
  type Ctx = [chrome.contextMenus.ContextType, ...chrome.contextMenus.ContextType[]];
  const ctx = (...c: string[]) => c as unknown as Ctx;
  const contexts = ctx('page', 'frame', 'video', 'audio', 'link', 'selection');
  chrome.contextMenus.create({ id: 'rf', title: 'ReelFetch', contexts });
  chrome.contextMenus.create({ id: 'rf-src', parentId: 'rf', title: t('menu_download_this'), contexts: ctx('video', 'audio') });
  const tab = await activeTab();
  const items = tab?.id != null ? visible(tab.id).slice(0, 12) : [];
  if (!items.length) {
    chrome.contextMenus.create({ id: 'rf-none', parentId: 'rf', title: t('no_media'), enabled: false, contexts });
    return;
  }
  chrome.contextMenus.create({ id: 'rf-best', parentId: 'rf', title: t('menu_download_best'), contexts });
  chrome.contextMenus.create({ id: 'rf-sep', parentId: 'rf', type: 'separator', contexts });
  for (const m of items) {
    const label = [m.kind.toUpperCase(), m.variants?.[0]?.label, cleanTitle(m.pageTitle, hostOf(m.pageUrl))]
      .filter(Boolean)
      .join(' · ');
    chrome.contextMenus.create({ id: `rf-m:${m.id}`, parentId: 'rf', title: label.slice(0, 80), contexts });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void ready.then(async () => {
    const tabId = tab?.id ?? -1;
    const id = String(info.menuItemId);
    if (id === 'rf-best') return downloadBest(tabId);
    if (id.startsWith('rf-m:')) {
      const item = visible(tabId).find((m) => m.id === id.slice(5));
      if (item) await runDefault(item);
    }
    if (id === 'rf-src' && info.srcUrl && /^https?:/.test(info.srcUrl)) {
      const det = classify({ url: info.srcUrl }) ?? { kind: 'direct' as const };
      const item = await addMedia(tabId, info.frameId ?? 0, info.srcUrl, det.kind, {});
      if (item) await enqueue(item, {});
    }
  });
});

function engineSettings() {
  return {
    preferredQuality: settings.preferredQuality,
    audioLangs: settings.audioLangs,
    subtitleLangs: settings.subtitleLangs,
    downloadSubtitles: settings.downloadSubtitles,
    preferMkv: settings.preferMkv,
    audioFormat: settings.audioFormat,
    preferOriginalAudio: settings.preferOriginalAudio,
  };
}

/** The user's default action (Alt+Down, right-click entries, main button). */
async function runDefault(item: MediaItem, variantId?: string) {
  if (settings.defaultAction === 'copy' && item.kind !== 'mse') {
    await engine({ op: 'copy', text: item.variants?.find((v) => v.id === variantId)?.ref ?? item.url });
    return;
  }
  await enqueue(item, {
    variantId,
    saveAs: settings.defaultAction === 'download_as' || undefined,
    audioOnly: settings.defaultAction === 'audio' || undefined,
  });
}

async function downloadBest(tabId: number) {
  const best = visible(tabId).find((m) => !m.drm);
  if (best) await runDefault(best);
}

/** VDH-style milestone: a one-time thank-you at 100 downloads. */
async function countDownload() {
  const stats = ((await chrome.storage.local.get('stats')).stats ?? {}) as { downloads?: number };
  const n = (stats.downloads ?? 0) + 1;
  await chrome.storage.local.set({ stats: { ...stats, downloads: n } });
  if (n === 100) notify('milestone-100', t('one_hundred_downloads_title'), t('one_hundred_downloads_body'));
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'default-action') return;
  void ready.then(async () => {
    const tab = await activeTab();
    if (tab?.id != null) await downloadBest(tab.id);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void ready.then(() => {
    scheduleMenu();
    return setCaptureScripts(settings.captureSites);
  });
});
