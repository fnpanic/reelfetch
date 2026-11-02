import { useEffect, useState } from 'react';
import { t } from '../shared/i18n';
import { useAppState, useSettings } from './hooks';
import { MediaView } from './views/MediaView';
import { JobsView } from './views/JobsView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { Icon } from './Icon';
import { UpdateBanner } from './views/UpdateBanner';

type View = 'media' | 'downloads' | 'history' | 'settings';

/** Firefox exposes its sidebar API only on the `browser` namespace. */
const ffSidebar = (globalThis as { browser?: { sidebarAction?: { open(): Promise<void> } } }).browser?.sidebarAction;

export function App({ sidebar }: { sidebar: boolean }) {
  const state = useAppState();
  const [settings, update] = useSettings();
  const [view, setView] = useState<View>('media');

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    root.dataset.theme = settings.theme === 'system' ? '' : settings.theme;
    root.dataset.font = settings.fontSize;
    root.dataset.size = sidebar ? 'sidebar' : settings.popupSize;
  }, [settings, sidebar]);

  if (!settings) return null;

  if (!settings.tosAccepted)
    return (
      <div className="tos">
        <h1>{t('tos_title')}</h1>
        <p>{t('tos_description')}</p>
        <button className="primary" onClick={() => update({ tosAccepted: true })}>
          {t('tos_accept')}
        </button>
      </div>
    );

  const active = state?.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length ?? 0;
  const tabs: [View, string, string, number?][] = [
    ['media', t('tab_media'), 'film', state?.media.length],
    ['downloads', t('tab_downloads'), 'download', active || undefined],
    ['history', t('tab_history'), 'history'],
    ['settings', t('tab_settings'), 'gear'],
  ];

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img src="../icons/32.png" alt="" width={20} height={20} />
          <span>ReelFetch</span>
        </div>
        <nav role="tablist">
          {tabs.map(([id, label, icon, badge]) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              title={label}
              className={view === id ? 'tab active' : 'tab'}
              onClick={() => setView(id)}
            >
              <Icon name={icon} />
              <span className="tab-label">{label}</span>
              {badge ? <span className="badge">{badge}</span> : null}
            </button>
          ))}
        </nav>
        {!sidebar && (chrome.sidePanel?.open || ffSidebar) && (
          <button
            className="icon-btn"
            title={t('show_in_sidebar')}
            onClick={async () => {
              if (ffSidebar) await ffSidebar.open(); // must run directly in the click handler
              else await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id! });
              window.close();
            }}
          >
            <Icon name="sidebar" />
          </button>
        )}
      </header>
      {state && !state.hostPermission && (
        <div className="banner warn">
          <span>{t('need_permission')}</span>
          <button onClick={() => chrome.permissions.request({ origins: ['<all_urls>'] })}>{t('grant')}</button>
        </div>
      )}
      {state?.update.latest && <UpdateBanner update={state.update} />}
      <main>
        {!state ? (
          <div className="empty">{t('loading')}</div>
        ) : view === 'media' ? (
          <MediaView state={state} settings={settings} update={update} onQueued={() => setView('downloads')} />
        ) : view === 'downloads' ? (
          <JobsView jobs={state.jobs} />
        ) : view === 'history' ? (
          <HistoryView history={state.history} settings={settings} update={update} />
        ) : (
          <SettingsView settings={settings} update={update} updateState={state.update} />
        )}
      </main>
    </div>
  );
}
