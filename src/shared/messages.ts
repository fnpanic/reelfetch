import type { EngineOutput, Job, MediaItem, Progress } from './types';
import type { EngineSettings } from '../engine/engine';

/** Background -> engine. */
export type EngineRequest =
  | { op: 'analyze'; media: MediaItem }
  | { op: 'start'; job: Job; settings: EngineSettings }
  | { op: 'cancel'; jobId: string }
  | { op: 'stop'; jobId: string }
  | { op: 'release'; jobId: string };

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
  | { type: 'reload-tab'; tabId: number }
  | { type: 'capture-site'; tabId: number; enable: boolean }
  | { type: 'settings-changed' };

/** Content script -> background. */
export type ContentMessage =
  | { type: 'page-media'; urls: string[]; title: string; thumbnail?: string }
  | { type: 'mse-update'; msId: string; bytes: number; mimes: string[] }
  | { type: 'drm-detected' };
