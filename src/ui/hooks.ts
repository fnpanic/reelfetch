import { useCallback, useEffect, useState } from 'react';
import type { UiRequest } from '../shared/messages';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';
import type { HistoryEntry, Job, MediaItem } from '../shared/types';

export interface AppState {
  media: MediaItem[];
  jobs: Job[];
  history: HistoryEntry[];
  tab: { id: number; url?: string; title?: string; incognito?: boolean } | null;
  capture: boolean;
  drm: boolean;
  hostPermission: boolean;
}

export const send = <T = unknown>(msg: UiRequest): Promise<T> => chrome.runtime.sendMessage(msg);

/** Active tab of this window; the sidebar follows tab switches. */
function useActiveTabId(): number | undefined {
  // ?tabId= pins the view to a tab (used when the popup is opened as a page, e.g. in tests).
  const pinned = Number(new URLSearchParams(location.search).get('tabId')) || undefined;
  const [id, setId] = useState<number | undefined>(pinned);
  useEffect(() => {
    if (pinned) return;
    const refresh = () =>
      chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setId(t?.id));
    void refresh();
    const onActivated = () => void refresh();
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, [pinned]);
  return id;
}

export function useAppState(): AppState | null {
  const tabId = useActiveTabId();
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    if (tabId == null) return;
    let alive = true;
    const load = () => send<AppState>({ type: 'get-state', tabId }).then((s) => alive && s && setState(s));
    void load();
    const port = chrome.runtime.connect({ name: 'ui' });
    port.onMessage.addListener(load);
    return () => {
      alive = false;
      port.disconnect();
    };
  }, [tabId]);
  return state;
}

export function useSettings(): [Settings | null, (p: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    void loadSettings().then(setS);
  }, []);
  const update = useCallback((patch: Partial<Settings>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    void saveSettings(patch).then(() => send({ type: 'settings-changed' }));
  }, []);
  return [s, update];
}
