import { t } from '../../shared/i18n';
import type { Settings } from '../../shared/settings';
import type { HistoryEntry } from '../../shared/types';
import { formatBytes } from '../../shared/util';
import { send } from '../hooks';
import { Icon } from '../Icon';

interface Props {
  history: HistoryEntry[];
  settings: Settings;
  update: (p: Partial<Settings>) => void;
}

export function HistoryView({ history, settings, update }: Props) {
  if (!settings.historyEnabled)
    return (
      <div className="empty">
        <Icon name="history" size={32} />
        <p>{t('history_warning')}</p>
        <p className="muted">{t('history_warning_2')}</p>
        <button className="primary" onClick={() => update({ historyEnabled: true, historyPromptAnswered: true })}>
          {t('enable_history')}
        </button>
      </div>
    );
  if (!history.length)
    return (
      <div className="empty">
        <Icon name="history" size={32} />
        <p>{t('no_downloads_yet')}</p>
      </div>
    );
  return (
    <div>
      <ul className="list">
        {history.map((h) => (
          <li key={h.id} className="row">
            <div className="body">
              <div className="name" title={h.filename}>
                {h.filename}
              </div>
              <div className="meta">
                {new Date(h.date).toLocaleString()} · {h.kind.toUpperCase()} {h.size ? `· ${formatBytes(h.size)}` : ''}
              </div>
            </div>
            <div className="actions row-actions">
              {h.pageUrl && (
                <button className="icon-btn" title={t('open_source_tab_button_tooltip')} onClick={() => chrome.tabs.create({ url: h.pageUrl })}>
                  <Icon name="external" />
                </button>
              )}
              {h.kind !== 'mse' && (
                <button className="icon-btn" title={t('copy_url')} onClick={() => navigator.clipboard.writeText(h.url)}>
                  <Icon name="copy" />
                </button>
              )}
              {h.downloadId != null && (
                <button className="icon-btn" title={t('download_directory_button_tooltip')} onClick={() => chrome.downloads.show(h.downloadId!)}>
                  <Icon name="folder" />
                </button>
              )}
              <button className="icon-btn" title={t('remove')} onClick={() => send({ type: 'remove-history', id: h.id })}>
                <Icon name="trash" />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="footer-actions">
        <button className="link" onClick={() => send({ type: 'clear-history' })}>
          {t('clear_history')}
        </button>
      </div>
    </div>
  );
}
