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

const ACTION_ICON: Record<Settings['defaultAction'], string> = {
  download: 'download',
  download_as: 'folder',
  audio: 'music',
  copy: 'copy',
};

export function MediaView({ state, settings, update, onQueued }: Props) {
  const [showHelp, setShowHelp] = useState(false);
  const host = hostOf(state.tab?.url ?? '');
  const audioSite = !!host && settings.audioOnlySites.some((s) => hostMatches(host, s));
  const media = state.media;
  const tabId = state.tab?.id;

  const reloadClearing = async () => {
    // Optional permission: asked for on first use only (needs this click as the user gesture).
    if (await chrome.permissions.request({ permissions: ['browsingData'] }))
      await send({ type: 'reload-tab', tabId: tabId!, clearCookies: true });
  };

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
            <MediaRow key={m.id} item={m} settings={settings} onQueued={onQueued} tabId={tabId} />
          ))}
        </ul>
      )}

      <div className="footer-actions">
        <button className="link" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>
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

      {showHelp && tabId != null && (
        <div className="help">
          <h3>{t('nomedia_title')}</h3>
          <p>{t('nomedia_description')}</p>
          <div className="buttons">
            <button onClick={() => send({ type: 'reload-tab', tabId })}>
              <Icon name="refresh" /> {t('nomedia_reload_button')}
            </button>
            <button onClick={reloadClearing}>
              <Icon name="refresh" /> {t('reload_clear_cookies')}
            </button>
          </div>
          <h3>{t('turbo_capture')}</h3>
          <p>{t('turbo_capture_hint')}</p>
          <button
            className="primary"
            onClick={async () => {
              await send({ type: 'turbo', tabId });
              onQueued();
            }}
          >
            <Icon name="record" /> {t('turbo_capture')}
          </button>
          <h3>{t('capture_title')}</h3>
          <p>{t('capture_description')}</p>
          <button onClick={() => send({ type: 'capture-site', tabId, enable: !state.capture })}>
            <Icon name="record" /> {state.capture ? t('capture_disable') : t('capture_enable')}
          </button>
          <h3>{t('smart_naming_title')}</h3>
          <button
            onClick={async () => {
              await send({ type: 'pick-name', tabId });
              window.close();
            }}
          >
            <Icon name="info" /> {t('pick_name')}
          </button>
        </div>
      )}
    </div>
  );
}

function Thumb({ item, settings, variantUrl }: { item: MediaItem; settings: Settings; variantUrl?: string }) {
  const [ok, setOk] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const canVideo =
    settings.previewMode === 'video' &&
    !item.drm &&
    (item.kind === 'hls' || item.kind === 'dash' || (item.kind === 'direct' && !item.variants?.[0]?.audioRef));
  const onEnter = () => {
    setHover(true);
    if (!canVideo || preview) return;
    if (item.kind === 'direct') setPreview(`${variantUrl ?? item.url}#t=5`);
    else void send<string | null>({ type: 'preview', mediaId: item.id }).then((u) => typeof u === 'string' && setPreview(u));
  };
  return (
    <div className="thumb" onMouseEnter={onEnter} onMouseLeave={() => setHover(false)}>
      {hover && preview ? (
        <video src={preview} muted autoPlay loop playsInline />
      ) : settings.previewMode !== 'none' && item.thumbnail && ok ? (
        <img src={item.thumbnail} alt="" onError={() => setOk(false)} />
      ) : (
        <Icon name="film" size={22} />
      )}
      {canVideo && !hover && <span className="thumb-play" aria-hidden="true">▶</span>}
    </div>
  );
}

function MediaRow({
  item,
  settings,
  onQueued,
  tabId,
}: {
  item: MediaItem;
  settings: Settings;
  onQueued: () => void;
  tabId?: number;
}) {
  const variants = item.variants ?? [];
  const [variantId, setVariantId] = useState(() => pickVariant(variants, settings.preferredQuality)?.id);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const selected = variants.find((v) => v.id === variantId) ?? pickVariant(variants, settings.preferredQuality);
  const title = item.title || cleanTitle(item.pageTitle, hostOf(item.pageUrl)) || hostOf(item.url) || item.url;
  const size = selected?.size ?? item.size ?? item.mse?.bytes;
  const capture = item.kind === 'mse';
  const action = capture ? 'download' : settings.defaultAction;

  const run = async (msg: Parameters<typeof send>[0]) => {
    setMenu(false);
    const r = await send<{ error?: string } | string>(msg);
    if (r && typeof r === 'object' && r.error) setError(r.error);
    else if (r === 'copy') setNote(t('copied'));
    else onQueued();
  };
  const download = (opts: { audioOnly?: boolean; saveAs?: boolean } = {}) =>
    run({ type: 'download', mediaId: item.id, variantId: selected?.id, ...opts });

  const chips = [
    item.site ? item.site.toUpperCase() : null,
    item.captureOnly ? t('kind_turbo') : capture ? t('kind_capture') : item.kind.toUpperCase(),
    selected?.label,
    formatDuration(item.duration),
    formatBytes(size),
    item.audioLangs?.length ? `🔊 ${item.audioLangs.join(', ')}` : '',
    item.subtitleLangs?.length ? `CC ${item.subtitleLangs.join(', ')}` : '',
  ].filter(Boolean) as string[];

  const mainLabel = item.captureOnly
    ? t('turbo_capture')
    : item.live
      ? t('record_button')
      : t(`action_${action}`);

  return (
    <li className="row">
      <Thumb item={item} settings={settings} variantUrl={selected?.ref} />
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
        {note && <div className="meta">{note}</div>}
        {error && <div className="error-text">{error}</div>}
        {item.error && (
          <div className="error-text" title={item.error}>
            {t('analyze_failed')}
          </div>
        )}
        {item.captureOnly && <div className="meta">{t('turbo_capture_hint')}</div>}
        {details && <Details item={item} />}
      </div>
      <div className="actions">
        {variants.length > 1 && (
          <select aria-label={t('quality')} value={selected?.id} onChange={(e) => setVariantId(e.target.value)}>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.size ? ` · ${formatBytes(v.size)}` : ''}
              </option>
            ))}
          </select>
        )}
        <div className="split">
          <button
            className="primary"
            disabled={item.drm}
            onClick={() =>
              capture || item.live ? download() : run({ type: 'default-action', mediaId: item.id, variantId: selected?.id })
            }
          >
            <Icon name={item.captureOnly ? 'record' : ACTION_ICON[action]} /> {mainLabel}
          </button>
          <button className="primary more" aria-label={t('more_actions')} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="more" />
          </button>
        </div>
        {menu && (
          <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
            <button role="menuitem" disabled={item.drm} onClick={() => download()}>
              <Icon name="download" /> {t('download_button')}
            </button>
            <button role="menuitem" disabled={item.drm} onClick={() => download({ saveAs: true })}>
              <Icon name="folder" /> {t('download_as')}
            </button>
            <button role="menuitem" disabled={item.drm} onClick={() => download({ audioOnly: true })}>
              <Icon name="music" /> {t('download_audio_only')}
            </button>
            {!capture && (
              <button
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard.writeText(selected?.ref && item.kind === 'direct' ? selected.ref : item.url);
                  setMenu(false);
                  setNote(t('copied'));
                }}
              >
                <Icon name="copy" /> {t('copy_url')}
              </button>
            )}
            {item.kind === 'direct' && !selected?.audioRef && (
              <button role="menuitem" onClick={() => chrome.tabs.create({ url: selected?.ref ?? item.url })}>
                <Icon name="play" /> {t('play')}
              </button>
            )}
            {tabId != null && !item.captureOnly && (
              <button role="menuitem" disabled={item.drm} onClick={() => run({ type: 'turbo', tabId, mediaId: capture ? item.id : undefined })}>
                <Icon name="record" /> {t('turbo_capture')}
              </button>
            )}
            {tabId != null && (
              <button
                role="menuitem"
                onClick={async () => {
                  await send({ type: 'pick-name', tabId });
                  window.close();
                }}
              >
                <Icon name="info" /> {t('pick_name')}
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
    site: item.site,
    title: item.title,
    url: item.url,
    page: item.pageUrl,
    mime: item.mime,
    size: item.size,
    duration: item.duration,
    live: item.live,
    encrypted: item.encrypted,
    drm: item.drm,
    variants: item.variants?.map(
      (v) => `${v.label} ${v.width ?? ''}x${v.height ?? ''} ${v.bandwidth ?? ''} ${v.codecs ?? v.mime ?? ''}${v.audioRef ? ' +audio' : ''}`,
    ),
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
