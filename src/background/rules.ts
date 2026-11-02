/** Session DNR rules that replay the page's Referer/Origin on requests made by the extension itself. */
import type { RequestHeaders } from '../shared/types';

export function ruleId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2_000_000_000) + 1;
}

/** Host of our own origin (chrome-extension://<id> or moz-extension://<uuid>). */
const selfHost = () => new URL(chrome.runtime.getURL('')).hostname;

/** Install or extend (hosts are merged) the rule for `key`. */
export async function setHeaderRule(key: string, hosts: string[], headers: RequestHeaders): Promise<void> {
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  const set = 'set' as chrome.declarativeNetRequest.HeaderOperation;
  if (headers.referer) requestHeaders.push({ header: 'referer', operation: set, value: headers.referer });
  if (headers.origin) requestHeaders.push({ header: 'origin', operation: set, value: headers.origin });
  if (!requestHeaders.length) return;
  const id = ruleId(key);
  const existing = (await chrome.declarativeNetRequest.getSessionRules()).find((r) => r.id === id);
  const domains = [...new Set([...(existing?.condition.requestDomains ?? []), ...hosts.filter(Boolean)])];
  if (!domains.length) return;
  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType, requestHeaders },
          // Only requests that belong to no tab AND come from this extension (not sites' service workers).
          condition: { requestDomains: domains, tabIds: [-1], initiatorDomains: [selfHost()] },
        },
      ],
    })
    .catch((e) => console.warn('[ReelFetch] header rule failed', e));
}

/**
 * The iOS stream profile needs the matching User-Agent, which fetch() cannot set. This rule applies it
 * only to the extension's own requests (initiator = this extension, no tab) to YouTube's API and CDN.
 */
export async function setYoutubeUaRule(userAgent: string | null, apiHost = 'www.youtube.com'): Promise<void> {
  const id = ruleId('youtube-ua');
  await chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [id],
      addRules: userAgent
        ? [
            {
              id,
              priority: 2,
              action: {
                type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
                requestHeaders: [{ header: 'user-agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: userAgent }],
              },
              condition: { requestDomains: [apiHost, 'googlevideo.com'], tabIds: [-1], initiatorDomains: [selfHost()] },
            },
          ]
        : [],
    })
    .catch((e) => console.warn('[ReelFetch] UA rule failed', e));
}

export function clearHeaderRule(key: string): Promise<void> {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(key)] }).catch(() => {});
}

/** Remove every rule not in `keep` (stale rules from jobs/analyses interrupted by a restart). */
export async function pruneHeaderRules(keep: string[]): Promise<void> {
  const ids = new Set(keep.map(ruleId));
  const stale = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id).filter((id) => !ids.has(id));
  if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale }).catch(() => {});
}
