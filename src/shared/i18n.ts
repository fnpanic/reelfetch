/** chrome.i18n lookup; falls back to the key so missing strings are visible, not blank. */
export const t = (key: string, ...subs: (string | number)[]): string =>
  chrome.i18n.getMessage(key, subs.map(String)) || key;
