import { useState } from 'react';
import { t } from '../../shared/i18n';
import { cleanTitle } from '../../shared/naming';
import { pickVariant } from '../../shared/quality';
import type { Settings } from '../../shared/settings';
import type { MediaItem } from '../../shared/types';
import { formatBytes, formatDuration, hostOf, hostMatches } from '../../shared/util';
import { send, type AppState } from '../hooks';
import { Icon } from '../Icon';

interface Props {
  state: AppState;
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  onQueued: () => void;
}

export function MediaView({ state, settings, update, onQueued }: Props) {
  const [showHelp, setShowHelp] = useState(false);
  const host = hostOf(state.tab?.url ?? '');
  const audioSite = !!host && settings.audioOnlySites.some((s) => hostMatches(host, s));
  const media = state.media;

  return (
    <div className="media-view">
      {state.drm && <div className="banner error">{t('drm_page_warning')}</div>}
      {media.length === 0 ? (
        <div className="empty">
          <Icon name="film" size={32} />
          <p className="title">{t('waiting_for_media')}</p>
          <p>{t('nomedia_description')}</p>
        </div>
      ) : (
        <ul className="list">
          {media.map((m) => (
            <MediaRow key={m.id} item={m} settings={settings} onQueued={onQueued} />
          ))}
        </ul>
      )}

      <div className="footer-actions">
        <button className="link" onClick={() => setShowHelp(!showHelp)}>
          {t('show_nomedia_button')}
        </button>
        {host && (
          <label className="check small">
            <input
              type="checkbox"
              checked={audioSite}
              onChange={(e) =>
                update({
                  audioOnlySites: e.target.checked
                    ? [...settings.audioOnlySites, host]
                    : settings.audioOnlySites.filter((s) => !hostMatches(host, s)),
                })
              }
            />
            {t('audio_only_for_this_website')}
          </label>
        )}
      </div>

      {showHelp && state.tab && (
        <div className="help">
          <h3>{t('nomedia_title')}</h3>
          <p>{t('nomedia_description')}</p>
          <button onClick={() => send({ type: 'reload-tab', tabId: state.tab!.id })}>
            <Icon name="refresh" /> {t('nomedia_reload_button')}
          </button>
          <h3>{t('capture_title')}</h3>
          <p>{t('capture_description')}</p>
          <button onClick={() => send({ type: 'capture-site', tabId: state.tab!.id, enable: !state.capture })}>
            <Icon name="record" /> {state.capture ? t('capture_disable') : t('capture_enable')}
          </button>
        </div>
      )}
    </div>
  );
}

function MediaRow({ item, settings, onQueued }: { item: MediaItem; settings: Settings; onQueued: () => void }) {
  const variants = item.variants ?? [];
  const [variantId, setVariantId] = useState(() => pickVariant(variants, settings.preferredQuality)?.id);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string>();
  const [thumbOk, setThumbOk] = useState(true);
  const selected = variants.find((v) => v.id === variantId) ?? pickVariant(variants, settings.preferredQuality);
  const title = cleanTitle(item.pageTitle, hostOf(item.pageUrl)) || hostOf(item.url) || item.url;
  const size = item.size ?? item.mse?.bytes;

  const download = async (opts: { audioOnly?: boolean; saveAs?: boolean } = {}) => {
    setMenu(false);
    const r = await send<{ error?: string }>({ type: 'download', mediaId: item.id, variantId: selected?.id, ...opts });
    if (r && typeof r === 'object' && r.error) setError(r.error);
    else onQueued();
  };

  const chips = [
    item.kind === 'mse' ? t('kind_capture') : item.kind.toUpperCase(),
    selected?.label,
    formatDuration(item.duration),
    formatBytes(size),
    item.audioLangs?.length ? `🔊 ${item.audioLangs.join(', ')}` : '',
    item.subtitleLangs?.length ? `CC ${item.subtitleLangs.join(', ')}` : '',
  ].filter(Boolean);

  return (
    <li className="row">
      <div className="thumb">
        {item.thumbnail && thumbOk ? (
          <img src={item.thumbnail} alt="" onError={() => setThumbOk(false)} />
        ) : (
          <Icon name="film" size={22} />
        )}
      </div>
      <div className="body">
        <div className="name" title={title}>
          {title}
        </div>
        <div className="chips">
          {chips.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
          {item.live && <span className="chip live">LIVE</span>}
          {item.drm && (
            <span className="chip drm" title={t('warn_drm_tooltip')}>
              <Icon name="lock" size={11} /> DRM
            </span>
          )}
          {item.analyzed === false && <span className="chip">…</span>}
        </div>
        {error && <div className="error-text">{error}</div>}
        {item.error && <div className="error-text" title={item.error}>{t('analyze_failed')}</div>}
        {details && <Details item={item} />}
      </div>
      <div className="actions">
        {variants.length > 1 && (
          <select
            aria-label={t('quality')}
            value={selected?.id}
            onChange={(e) => setVariantId(e.target.value)}
          >
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <div className="split">
          <button className="primary" disabled={item.drm} onClick={() => download()} title={t('download_button')}>
            <Icon name="download" /> {item.live ? t('record_button') : t('download_button')}
          </button>
          <button className="primary more" aria-label={t('more_actions')} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="more" />
          </button>
        </div>
        {menu && (
          <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
            <button role="menuitem" disabled={item.drm} onClick={() => download({ saveAs: true })}>
              <Icon name="folder" /> {t('download_as')}
            </button>
            <button role="menuitem" disabled={item.drm} onClick={() => download({ audioOnly: true })}>
              <Icon name="music" /> {t('download_audio_only')}
            </button>
            {item.kind !== 'mse' && (
              <button
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard.writeText(item.url);
                  setMenu(false);
                }}
              >
                <Icon name="copy" /> {t('copy_url')}
              </button>
            )}
            {item.kind === 'direct' && (
              <button role="menuitem" onClick={() => chrome.tabs.create({ url: item.url })}>
                <Icon name="play" /> {t('play')}
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                setDetails(!details);
                setMenu(false);
              }}
            >
              <Icon name="info" /> {t('details')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Details({ item }: { item: MediaItem }) {
  const info = {
    kind: item.kind,
    url: item.url,
    page: item.pageUrl,
    mime: item.mime,
    size: item.size,
    duration: item.duration,
    live: item.live,
    encrypted: item.encrypted,
    drm: item.drm,
    variants: item.variants?.map((v) => `${v.label} ${v.width ?? ''}x${v.height ?? ''} ${v.bandwidth ?? ''} ${v.codecs ?? ''}`),
    audio: item.audioLangs,
    subtitles: item.subtitleLangs,
    referer: item.headers.referer,
    error: item.error,
  };
  const text = JSON.stringify(info, null, 2);
  return (
    <div className="details">
      <pre>{text}</pre>
      <button onClick={() => navigator.clipboard.writeText(text)}>
        <Icon name="copy" /> {t('copy_to_clipboard')}
      </button>
    </div>
  );
}
