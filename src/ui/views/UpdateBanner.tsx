import { useState } from 'react';
import { t } from '../../shared/i18n';
import { UPDATE_BASE, type UpdateState } from '../../shared/update';
import { send } from '../hooks';
import { Icon } from '../Icon';

export const setupUrl = (u: UpdateState) => (u.latest?.setup ? `${UPDATE_BASE}/${u.latest.setup}` : UPDATE_BASE);

/** Applies an update in place (Windows updater) or offers the new setup for download. */
export function useUpdateAction(u: UpdateState) {
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    if (!u.native) return void chrome.tabs.create({ url: setupUrl(u) });
    const r = await send<UpdateState | { error: string }>({ type: 'update-apply' });
    if (r && 'error' in r && r.error) setError(r.error);
  };
  return { run, error: error ?? u.error, label: u.native ? t('update_now') : t('download_button') };
}

export function UpdateBanner({ update: u }: { update: UpdateState }) {
  const { run, error, label } = useUpdateAction(u);
  return (
    <div className="banner update" role="status">
      <span className="banner-text">
        <strong>
          {t('update_available')} {u.latest!.version}
        </strong>
        {error && <span className="error-text">{error}</span>}
      </span>
      <button className="primary" disabled={u.installing} onClick={run}>
        <Icon name={u.native ? 'refresh' : 'download'} /> {u.installing ? t('update_installing') : label}
      </button>
    </div>
  );
}
