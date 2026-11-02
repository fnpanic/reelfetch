/** Talks to the download engine: an offscreen document on Chrome, the background page itself on Firefox. */
import { createEngineHost } from '../engine/host';
import type { EngineEvent, EngineRequest } from '../shared/messages';

let localHost: ((r: EngineRequest) => Promise<unknown>) | null = null;
let creating: Promise<void> | null = null;
let eventSink: (e: EngineEvent) => Promise<unknown> = async () => {};

export const usesOffscreen = () => !!chrome.offscreen;

export function onEngineEvent(fn: (e: EngineEvent) => Promise<unknown>) {
  eventSink = fn;
}

export async function hasOffscreen(): Promise<boolean> {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS', 'DOM_PARSER', 'CLIPBOARD'] as chrome.offscreen.Reason[],
      justification: 'Download, decrypt and remux media streams in the background.',
    })
    .finally(() => (creating = null));
  await creating;
}

export async function engine<T = unknown>(req: EngineRequest): Promise<T> {
  if (!usesOffscreen()) {
    localHost ??= createEngineHost((e) => eventSink(e));
    return (await localHost(req)) as T;
  }
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'engine', req });
  if (!r?.ok) throw new Error(r?.error ?? 'Engine unavailable');
  return r.result as T;
}
