import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../../shared/i18n';
import { resetSettings, type Settings } from '../../shared/settings';
import { send } from '../hooks';
import { Icon } from '../Icon';

interface Props {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
}

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Select<K extends keyof Settings>({
  label,
  k,
  options,
  s,
  update,
}: {
  label: string;
  k: K;
  options: [Settings[K], string][];
  s: Settings;
  update: Props['update'];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={String(s[k])}
        onChange={(e) => {
          const opt = options.find(([v]) => String(v) === e.target.value);
          if (opt) update({ [k]: opt[0] } as Partial<Settings>);
        }}
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Check({ label, k, s, update }: { label: string; k: keyof Settings; s: Settings; update: Props['update'] }) {
  return (
    <label className="check">
      <input type="checkbox" checked={!!s[k]} onChange={(e) => update({ [k]: e.target.checked } as Partial<Settings>)} />
      {label}
    </label>
  );
}

/** Text input that commits on blur, so typing doesn't spam storage. */
function Text({
  label,
  value,
  onCommit,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [v, setV] = useState(value);
  const props = {
    value: v,
    placeholder,
    onChange: (e: { target: { value: string } }) => setV(e.target.value),
    onBlur: () => v !== value && onCommit(v),
  };
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}
    </label>
  );
}

/** Ordered language preference list (VDH-style add / move up / move down / remove). */
function LangList({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const move = (i: number, d: number) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const add = () => {
    const code = draft.trim().toLowerCase();
    if (code && !value.includes(code)) onChange([...value, code]);
    setDraft('');
  };
  return (
    <div className="field lang-field">
      <span>{label}</span>
      <div>
        <ol className="langs">
          {value.map((l, i) => (
            <li key={l}>
              <code>{l}</code>
              <button className="icon-btn" title={t('move_lang_up')} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="icon-btn" title={t('move_lang_down')} disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button className="icon-btn" title={t('remove_lang')} onClick={() => onChange(value.filter((x) => x !== l))}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ol>
        <div className="rule">
          <input
            aria-label={t('add_lang')}
            placeholder="en, de, fr…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button disabled={!draft.trim()} onClick={add}>
            {t('add_lang')}
          </button>
        </div>
      </div>
    </div>
  );
}

const isFirefox = !chrome.offscreen;

export function SettingsView({ settings: s, update }: Props) {
  const [rule, setRule] = useState({ host: '', selector: '' });
  const [incognito, setIncognito] = useState(true);
  useEffect(() => {
    void chrome.extension.isAllowedIncognitoAccess().then(setIncognito);
  }, []);
  return (
    <div className="settings">
      <Section title={t('appearance_title')}>
        <Select label={t('theme_title')} k="theme" s={s} update={update} options={[['system', t('theme_system')], ['light', t('theme_light')], ['dark', t('theme_dark')]]} />
        <Select label={t('font_size_title')} k="fontSize" s={s} update={update} options={[['default', t('font_size_default')], ['large', t('font_size_large')], ['verylarge', t('font_size_verylarge')]]} />
        <Select label={t('popup_size_title')} k="popupSize" s={s} update={update} options={[['small', t('popup_size_small')], ['medium', t('popup_size_medium')], ['big', t('popup_size_big')]]} />
        <Select label={t('panel_position_title')} k="uiMode" s={s} update={update} options={[['popup', t('use_popup')], ['sidebar', t('use_sidebar')]]} />
      </Section>

      <Section title={t('download_title')}>
        <Select
          label={t('preferred_quality')}
          k="preferredQuality"
          s={s}
          update={update}
          options={[['highest', t('preferred_quality_highest')], ['1080', t('preferred_quality_1080p')], ['720', t('preferred_quality_720p')], ['480', t('preferred_quality_480p')]]}
        />
        <Select
          label={t('default_action')}
          k="defaultAction"
          s={s}
          update={update}
          options={[['download', t('action_download')], ['download_as', t('action_download_as')], ['audio', t('action_audio')], ['copy', t('action_copy')]]}
        />
        <Select label={t('max_parallel_downloads')} k="maxParallel" s={s} update={update} options={[1, 2, 3, 4, 6, 8].map((n) => [n, String(n)])} />
        <Text label={t('download_subdirectory')} value={s.subdirectory} placeholder="Videos/ReelFetch" onCommit={(v) => update({ subdirectory: v })} />
        <Text label={t('filename_template')} value={s.filenameTemplate} placeholder="{title}" onCommit={(v) => update({ filenameTemplate: v || '{title}' })} />
        <p className="hint">{t('filename_template_hint')}</p>
        <Check label={t('prefer_mkv')} k="preferMkv" s={s} update={update} />
        <Select label={t('audio_format')} k="audioFormat" s={s} update={update} options={[['original', t('audio_format_original')], ['mp3', 'MP3']]} />
        <Check label={t('always_download_as_menu')} k="alwaysSaveAs" s={s} update={update} />
        <Check label={t('show_notification')} k="notifyOnComplete" s={s} update={update} />
        <Check label={t('transient_history_description')} k="showCompleted" s={s} update={update} />
        <div className="buttons">
          <button className="link" onClick={() => chrome.downloads.showDefaultFolder()}>
            {t('download_directory_button_tooltip')}
          </button>
          <button
            className="link"
            onClick={() => chrome.tabs.create({ url: isFirefox ? 'about:preferences#general' : 'chrome://settings/downloads' })}
          >
            {t('change_browser_download_directory')}
          </button>
        </div>
      </Section>

      <Section title={t('preview_mode_title')}>
        <Select label={t('preview_mode_title')} k="previewMode" s={s} update={update} options={[['none', t('preview_mode_none')], ['image', t('preview_mode_image')], ['video', t('preview_mode_video')]]} />
        <Check label={t('youtube_api')} k="youtubeApi" s={s} update={update} />
        <Select label={t('turbo_speed')} k="turboSpeed" s={s} update={update} options={[2, 4, 8, 16].map((n) => [n, `${n}×`])} />
        <p className="hint">{t('turbo_capture_hint')}</p>
      </Section>

      <Section title={t('languages_title')}>
        <LangList label={t('settings_audio_tracks_title')} value={s.audioLangs} onChange={(v) => update({ audioLangs: v })} />
        <Check label={t('prefer_original_audio')} k="preferOriginalAudio" s={s} update={update} />
        <LangList label={t('settings_subtitles_title')} value={s.subtitleLangs} onChange={(v) => update({ subtitleLangs: v })} />
        <Check label={t('download_subtitles')} k="downloadSubtitles" s={s} update={update} />
      </Section>

      <Section title={t('behavior_title')}>
        <Check label={t('show_in_context_menu')} k="contextMenu" s={s} update={update} />
        <Select label={t('media_discovered_ordering_title')} k="mediaOrder" s={s} update={update} options={[['smart', t('order_media_smart')], ['newest', t('order_media_by_newest')], ['oldest', t('order_media_by_oldest')]]} />
        <Text label={t('audio_only_sites')} value={s.audioOnlySites.join('\n')} multiline placeholder="music.example.com" onCommit={(v) => update({ audioOnlySites: list(v) })} />
        <Text label={t('capture_sites')} value={s.captureSites.join('\n')} multiline placeholder="video.example.com" onCommit={(v) => update({ captureSites: list(v) })} />
      </Section>

      <Section title={t('smart_naming_title')}>
        <p className="hint">{t('smart_naming_hint')}</p>
        {s.smartNaming.map((r, i) => (
          <div key={i} className="rule">
            <code>{r.host}</code>
            <code className="grow">{r.selector}</code>
            <button className="icon-btn" title={t('remove')} onClick={() => update({ smartNaming: s.smartNaming.filter((_, j) => j !== i) })}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
        <div className="rule">
          <input aria-label={t('host')} placeholder="example.com" value={rule.host} onChange={(e) => setRule({ ...rule, host: e.target.value })} />
          <input aria-label={t('selector')} className="grow" placeholder="h1.title  |  //h1/text()" value={rule.selector} onChange={(e) => setRule({ ...rule, selector: e.target.value })} />
          <button
            disabled={!rule.host.trim() || !rule.selector.trim()}
            onClick={() => {
              update({ smartNaming: [...s.smartNaming, { host: rule.host.trim(), selector: rule.selector.trim() }] });
              setRule({ host: '', selector: '' });
            }}
          >
            {t('add')}
          </button>
        </div>
      </Section>

      <Section title={t('private_browsing_title')}>
        {!incognito && (
          <div className="banner warn">
            <span>{t('private_browsing_warning')}</span>
            <button onClick={() => chrome.tabs.create({ url: isFirefox ? 'about:addons' : `chrome://extensions/?id=${chrome.runtime.id}` })}>
              {t('private_browsing_button')}
            </button>
          </div>
        )}
        <Check label={t('private_browsing_notifications')} k="privateNotifications" s={s} update={update} />
      </Section>

      <Section title={t('settings_history_title')}>
        <Check label={t('enable_history')} k="historyEnabled" s={s} update={update} />
        <Select label={t('history_limit')} k="historyDays" s={s} update={update} options={[1, 7, 30, 90, 365].map((n) => [n, String(n)])} />
        <button onClick={() => send({ type: 'clear-history' })}>{t('clear_history')}</button>
      </Section>

      <Section title={t('controls_title')}>
        <p className="hint">{t('hotkeys_hint')}</p>
        <div className="buttons">
          <button
            onClick={async () => {
              await resetSettings();
              await send({ type: 'settings-changed' });
              location.reload();
            }}
          >
            {t('reset_settings')}
          </button>
          <button onClick={() => chrome.runtime.reload()}>{t('restart_addon')}</button>
        </div>
        <p className="muted">
          {t('version_title')}: {chrome.runtime.getManifest().version}
        </p>
      </Section>
    </div>
  );
}
