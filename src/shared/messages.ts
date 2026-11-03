import type { EngineOutput, Job, MediaItem, Progress } from './types';
import type { EngineSettings } from '../engine/engine';

/** Background -> engine. */
export type EngineRequest =
  | { op: 'analyze'; media: MediaItem }
  | { op: 'start'; job: Job; settings: EngineSettings }
  | { op: 'cancel'; jobId: string }
  | { op: 'stop'; jobId: string }
  | { op: 'release'; jobId: string }
  | { op: 'preview'; media: MediaItem; settings: EngineSettings }
  | { op: 'copy'; text: string };

/** Engine -> background. */
export type EngineEvent =
  | { jobId: string; type: 'progress'; progress: Progress }
  | { jobId: string; type: 'done'; output: EngineOutput }
  | { jobId: string; type: 'error'; error: string; drm?: boolean }
  | { jobId: string; type: 'prepare'; hosts: string[] };

/** UI / content -> background. */
export type UiRequest =
  | { type: 'get-state'; tabId?: number }
  | { type: 'download'; mediaId: string; variantId?: string; audioOnly?: boolean; saveAs?: boolean }
  | { type: 'cancel'; jobId: string }
  | { type: 'stop'; jobId: string }
  | { type: 'retry'; jobId: string }
  | { type: 'clear-jobs' }
  | { type: 'remove-job'; jobId: string }
  | { type: 'clear-history' }
  | { type: 'remove-history'; id: string }
  | { type: 'reload-tab'; tabId: number; clearCookies?: boolean }
  | { type: 'preview'; mediaId: string }
  | { type: 'default-action'; mediaId: string; variantId?: string }
  | { type: 'turbo'; mediaId?: string; tabId: number }
  | { type: 'pick-name'; tabId: number }
  | { type: 'capture-site'; tabId: number; enable: boolean }
  | { type: 'settings-changed' }
  | { type: 'update-check' }
  | { type: 'update-apply' };

/** A post on a feed page: its media key (see redditKey), title and preview image. */
export type PostName = { key: string; title: string; thumbnail?: string };

/** Content script -> background. */
export type ContentMessage =
  | { type: 'page-media'; urls: string[]; title: string; thumbnail?: string; names?: PostName[] }
  | { type: 'mse-update'; msId: string; bytes: number; mimes: string[] }
  | { type: 'drm-detected' }
  | { type: 'site-media'; items: unknown[] }
  | { type: 'turbo'; event: 'progress' | 'done'; msId: string; time: number; duration: number }
  | { type: 'picker-result'; selector: string; text: string };
