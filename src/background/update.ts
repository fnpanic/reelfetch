import { isNewer, parseRelease, UPDATE_BASE, UPDATER_HOST, type UpdateState } from '../shared/update';

const current = chrome.runtime.getManifest().version;
const CHECK_EVERY_MIN = 6 * 60;

async function load(): Promise<UpdateState> {
  const { update } = await chrome.storage.local.get('update');
  return { ...(update as UpdateState | undefined), current, native: (update as UpdateState | undefined)?.native ?? false };
}
const save = (s: UpdateState) => chrome.storage.local.set({ update: s });

async function native<T>(msg: object): Promise<T | null> {
  if (!chrome.runtime.sendNativeMessage) return null;
  try {
    return (await chrome.runtime.sendNativeMessage(UPDATER_HOST, msg)) as T;
  } catch {
    return null; // host not installed (manual install, Firefox, other OS)
  }
}

export async function updateState(): Promise<UpdateState> {
  const s = await load();
  // A newer version may have been installed since the last check.
  if (s.latest && !isNewer(s.latest.version, current)) s.latest = undefined;
  return s;
}

export async function checkForUpdate(): Promise<UpdateState> {
  const s = await load();
  if (!UPDATE_BASE) return s;
  try {
    const res = await fetch(`${UPDATE_BASE}/latest.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = parseRelease(await res.json());
    if (!rel) throw new Error('Invalid release data');
    s.latest = isNewer(rel.version, current) ? rel : undefined;
    s.error = undefined;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  }
  s.checkedAt = Date.now();
  const ping = await native<{ ok: boolean; ytdlp?: boolean }>({ op: 'ping' });
  s.native = !!ping?.ok;
  s.ytdlp = !!ping?.ytdlp;
  s.installing = false;
  await save(s);
  return s;
}

/** Lets the Windows updater replace the extension files, then reloads into the new version. */
export async function applyUpdate(): Promise<UpdateState> {
  const s = await load();
  if (!s.latest) return s;
  await save({ ...s, installing: true, error: undefined });
  const r = await native<{ ok: boolean; version?: string; error?: string }>({ op: 'update' });
  if (r?.ok) {
    chrome.runtime.reload();
    return s;
  }
  const failed = { ...s, installing: false, error: r?.error ?? 'Updater not installed' };
  await save(failed);
  return failed;
}

/** Periodic check; `auto` applies the update when nothing is downloading. */
export function scheduleUpdates(auto: () => boolean, onChange: () => void) {
  if (!UPDATE_BASE) return;
  void chrome.alarms.create('update-check', { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MIN });
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== 'update-check') return;
    const s = await checkForUpdate();
    onChange();
    if (s.latest && s.native && auto()) await applyUpdate();
  });
}
