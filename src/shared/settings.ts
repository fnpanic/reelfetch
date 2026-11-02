export interface SmartNamingRule {
  host: string;
  /** CSS selector, or XPath when it starts with "/" or "(". */
  selector: string;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  fontSize: 'default' | 'large' | 'verylarge';
  popupSize: 'small' | 'medium' | 'big';
  uiMode: 'popup' | 'sidebar';
  preferredQuality: 'highest' | '1080' | '720' | '480';
  preferMkv: boolean;
  /** What the main button / Alt+Down does. */
  defaultAction: 'download' | 'download_as' | 'audio' | 'copy';
  previewMode: 'none' | 'image' | 'video';
  preferOriginalAudio: boolean;
  /** Turbo capture playback speed. */
  turboSpeed: number;
  /** Ask YouTube's player API (iOS client profile) for direct stream URLs. */
  youtubeApi: boolean;
  privateNotifications: boolean;
  /** Audio-only downloads: keep the original codec (remux) or transcode to MP3. */
  audioFormat: 'original' | 'mp3';
  alwaysSaveAs: boolean;
  notifyOnComplete: boolean;
  contextMenu: boolean;
  historyEnabled: boolean;
  historyDays: number;
  showCompleted: boolean;
  maxParallel: number;
  mediaOrder: 'smart' | 'newest' | 'oldest';
  subdirectory: string;
  filenameTemplate: string;
  audioOnlySites: string[];
  audioLangs: string[];
  subtitleLangs: string[];
  downloadSubtitles: boolean;
  smartNaming: SmartNamingRule[];
  captureSites: string[];
  tosAccepted: boolean;
  historyPromptAnswered: boolean;
  /** Install self-hosted updates automatically when no download is running (Windows setup only). */
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 'default',
  popupSize: 'medium',
  uiMode: 'popup',
  preferredQuality: '1080',
  preferMkv: false,
  defaultAction: 'download',
  previewMode: 'image',
  preferOriginalAudio: true,
  turboSpeed: 16,
  youtubeApi: true,
  privateNotifications: true,
  audioFormat: 'original',
  alwaysSaveAs: false,
  notifyOnComplete: true,
  contextMenu: true,
  historyEnabled: false,
  historyDays: 30,
  showCompleted: true,
  maxParallel: 2,
  mediaOrder: 'smart',
  subdirectory: '',
  filenameTemplate: '{title}',
  audioOnlySites: [],
  audioLangs: [],
  subtitleLangs: [],
  downloadSubtitles: false,
  smartNaming: [],
  captureSites: [],
  tosAccepted: false,
  historyPromptAnswered: false,
  autoUpdate: true,
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function resetSettings(): Promise<void> {
  return chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, tosAccepted: true } });
}
