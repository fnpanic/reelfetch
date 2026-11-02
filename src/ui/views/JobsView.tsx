import { t } from '../../shared/i18n';
import type { Job } from '../../shared/types';
import { formatBytes, formatDuration } from '../../shared/util';
import { send } from '../hooks';
import { Icon } from '../Icon';

function percent(j: Job): number | undefined {
  const p = j.progress;
  if (j.status === 'done') return 100;
  if (p.phase === 'recording') return p.duration ? Math.min(100, ((p.recorded ?? 0) / p.duration) * 100) : undefined;
  if (p.total) return Math.min(100, (p.bytes / p.total) * 100);
  if (p.segmentsTotal) return Math.min(100, ((p.segments ?? 0) / p.segmentsTotal) * 100);
  return undefined;
}

function statusText(j: Job): string {
  const p = j.progress;
  if (j.status === 'queued') return t('status_queued');
  if (j.status === 'done') return [t('status_done'), formatBytes(p.total ?? p.bytes)].filter(Boolean).join(' · ');
  if (j.status === 'canceled') return t('status_canceled');
  if (j.status === 'error') return j.error ?? t('download_failed');
  if (p.phase === 'recording')
    return p.duration
      ? `${t('status_turbo')} ${formatDuration(p.recorded ?? 0)} / ${formatDuration(p.duration)} · ${formatBytes(p.bytes)}`
      : `${t('status_recording')} ${formatDuration(p.recorded ?? 0)} · ${formatBytes(p.bytes)}`;
  if (p.phase === 'mux') return t('status_muxing');
  if (p.phase === 'convert') return t('status_converting');
  if (p.phase === 'save') return t('status_saving');
  const seg = p.segmentsTotal ? `${p.segments ?? 0}/${p.segmentsTotal}` : '';
  return [t('status_downloading'), formatBytes(p.bytes), p.total ? `/ ${formatBytes(p.total)}` : '', seg].filter(Boolean).join(' ');
}

export function JobsView({ jobs }: { jobs: Job[] }) {
  const list = [...jobs].reverse();
  const finished = jobs.some((j) => j.status !== 'running' && j.status !== 'queued');
  if (!list.length)
    return (
      <div className="empty">
        <Icon name="download" size={32} />
        <p>{t('no_downloads_yet')}</p>
      </div>
    );
  return (
    <div>
      <ul className="list">
        {list.map((j) => {
          const pct = percent(j);
          const dl = j.downloadIds?.[0];
          return (
            <li key={j.id} className={`row job ${j.status}`}>
              <div className="body">
                <div className="name" title={j.filename ?? j.basename}>
                  {j.filename ?? j.basename.split('/').pop()}
                </div>
                <div className="progress" aria-hidden={pct == null}>
                  <div
                    className={pct == null && j.status === 'running' ? 'bar indeterminate' : 'bar'}
                    style={{ width: `${pct ?? (j.status === 'running' ? 100 : 0)}%` }}
                  />
                </div>
                <div className={j.status === 'error' ? 'meta error-text' : 'meta'}>{statusText(j)}</div>
                {j.warning && j.status === 'done' && <div className="meta warn-text">{j.warning}</div>}
              </div>
              <div className="actions row-actions">
                {j.status === 'running' && j.progress.phase === 'recording' && (
                  <button title={t('stop_and_save')} onClick={() => send({ type: 'stop', jobId: j.id })}>
                    <Icon name="stop" /> {t('stop')}
                  </button>
                )}
                {(j.status === 'running' || j.status === 'queued') && (
                  <button className="icon-btn" title={t('cancel')} onClick={() => send({ type: 'cancel', jobId: j.id })}>
                    <Icon name="x" />
                  </button>
                )}
                {(j.status === 'error' || j.status === 'canceled') && (
                  <button className="icon-btn" title={t('retry_download_button_tooltip')} onClick={() => send({ type: 'retry', jobId: j.id })}>
                    <Icon name="refresh" />
                  </button>
                )}
                {j.status === 'done' && dl != null && j.media.kind !== 'mse' && (
                  <>
                    <button
                      className="icon-btn"
                      title={t('play')}
                      onClick={async () => {
                        if (await chrome.permissions.request({ permissions: ['downloads.open'] })) await chrome.downloads.open(dl);
                      }}
                    >
                      <Icon name="play" />
                    </button>
                    <button className="icon-btn" title={t('download_directory_button_tooltip')} onClick={() => chrome.downloads.show(dl)}>
                      <Icon name="folder" />
                    </button>
                  </>
                )}
                {j.status !== 'running' && j.status !== 'queued' && (
                  <button className="icon-btn" title={t('remove')} onClick={() => send({ type: 'remove-job', jobId: j.id })}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {finished && (
        <div className="footer-actions">
          <button className="link" onClick={() => send({ type: 'clear-jobs' })}>
            {t('clear_downloaded_tooltip')}
          </button>
          <button className="link" onClick={() => chrome.downloads.showDefaultFolder()}>
            {t('download_directory_button_tooltip')}
          </button>
        </div>
      )}
    </div>
  );
}
