export type MediaKind = 'direct' | 'hls' | 'dash' | 'mse';

export interface RequestHeaders {
  referer?: string;
  origin?: string;
}

export interface Variant {
  id: string;
  label: string;
  height?: number;
  width?: number;
  bandwidth?: number;
  codecs?: string;
  /** HLS: media playlist URL. DASH: representation id. */
  ref: string;
}

export interface MediaItem {
  id: string;
  tabId: number;
  frameId?: number;
  kind: MediaKind;
  url: string;
  pageUrl: string;
  pageTitle: string;
  mime?: string;
  size?: number;
  headers: RequestHeaders;
  detectedAt: number;
  thumbnail?: string;
  incognito?: boolean;
  // filled by analysis
  analyzed?: boolean;
  variants?: Variant[];
  duration?: number;
  live?: boolean;
  drm?: boolean;
  encrypted?: boolean;
  audioLangs?: string[];
  subtitleLangs?: string[];
  /** URLs of child playlists (HLS master) so duplicates can be hidden. */
  children?: string[];
  error?: string;
  /** MSE capture: buffered bytes and track mimes. */
  mse?: { bytes: number; mimes: string[] };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface JobOptions {
  variantId?: string;
  audioOnly?: boolean;
  saveAs?: boolean;
}

export interface Job {
  id: string;
  media: MediaItem;
  options: JobOptions;
  /** Filename without extension, already sanitized, may include sub-directory. */
  basename: string;
  status: JobStatus;
  createdAt: number;
  progress: Progress;
  error?: string;
  downloadIds?: number[];
  blobUrls?: string[];
  filename?: string;
}

export interface Progress {
  bytes: number;
  total?: number;
  segments?: number;
  segmentsTotal?: number;
  /** Seconds recorded (live). */
  recorded?: number;
  phase?: 'download' | 'mux' | 'save' | 'recording';
}

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  pageUrl: string;
  filename: string;
  kind: MediaKind;
  size?: number;
  date: number;
  downloadId?: number;
}

export interface EngineOutput {
  files: { url: string; ext: string; suffix?: string }[];
  size: number;
}
