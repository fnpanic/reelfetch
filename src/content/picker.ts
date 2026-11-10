/**
 * Smart-naming element picker (injected on demand): hover to highlight, click to save a naming rule
 * for this site from the clicked element, Esc to cancel.
 */
import { t } from '../shared/i18n';

(() => {
  const w = window as unknown as { __reelfetchPicker?: boolean };
  if (w.__reelfetchPicker) return;
  w.__reelfetchPicker = true;

  const box = document.createElement('div');
  const tip = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', border: '2px solid #e5484d',
    background: 'rgba(229,72,77,.12)', borderRadius: '3px', transition: 'all .05s',
  });
  Object.assign(tip.style, {
    position: 'fixed', zIndex: '2147483647', left: '50%', top: '12px', transform: 'translateX(-50%)',
    background: '#1c1b1a', color: '#fff', font: '13px system-ui, sans-serif', padding: '8px 12px',
    borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,.3)', pointerEvents: 'none', maxWidth: '80vw',
  });
  tip.textContent = `ReelFetch: ${t('picker_hint')}`;
  document.documentElement.append(box, tip);

  const esc = (s: string) => CSS.escape(s);
  const unique = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  /** Shortest stable selector: id, then classes/attributes, then a short nth-of-type path. */
  function selectorFor(el: Element): string {
    if (el.id && !/\d{3,}/.test(el.id) && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur !== document.documentElement && parts.length < 5; cur = cur.parentElement) {
      let part = cur.tagName.toLowerCase();
      const stable = Array.from(cur.classList).filter((c) => !/\d{3,}|^(is-|has-|active|hover|focus)/.test(c)).slice(0, 2);
      if (stable.length) part += stable.map((c) => `.${esc(c)}`).join('');
      for (const attr of ['itemprop', 'data-testid', 'data-test', 'name', 'role'])
        if (cur.getAttribute(attr)) {
          part += `[${attr}="${cur.getAttribute(attr)!.replace(/"/g, '\\"')}"]`;
          break;
        }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) parts[0] += `:nth-of-type(${same.indexOf(cur) + 1})`;
        if (unique(parts.join(' > '))) return parts.join(' > ');
      }
      if (cur.id && !/\d{3,}/.test(cur.id)) {
        parts[0] = `#${esc(cur.id)}`;
        if (unique(parts.join(' > '))) return parts.join(' > ');
      }
    }
    return parts.join(' > ');
  }

  let target: Element | null = null;
  const onMove = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    target = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tip.textContent = `ReelFetch: "${(el.textContent ?? '').trim().slice(0, 80) || el.tagName.toLowerCase()}" - ${t('picker_use')}`;
  };
  const done = () => {
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('keydown', onKey, true);
    box.remove();
    setTimeout(() => tip.remove(), 1500);
    w.__reelfetchPicker = false;
  };
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!target) return;
    const selector = selectorFor(target);
    const text = (target.textContent ?? '').replace(/\s+/g, ' ').trim();
    void chrome.runtime.sendMessage({ type: 'picker-result', selector, text });
    tip.textContent = `ReelFetch: ${t('smart_naming_saved')} (${selector})`;
    done();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    tip.textContent = `ReelFetch: ${t('status_canceled')}`;
    done();
  };
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
})();
