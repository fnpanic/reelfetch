import { createEngineHost } from '../engine/host';
import type { EngineRequest } from '../shared/messages';

const handle = createEngineHost((event) => chrome.runtime.sendMessage({ type: 'engine-event', event }));

chrome.runtime.onMessage.addListener((msg: { target?: string; req: EngineRequest }, sender, reply) => {
  // Only the background commands the engine: runtime messages from content scripts (sender.tab) reach this page too.
  if (msg?.target !== 'engine' || sender.id !== chrome.runtime.id || sender.tab) return;
  handle(msg.req).then(
    (result) => reply({ ok: true, result }),
    (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
