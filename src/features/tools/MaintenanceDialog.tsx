import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { writeClipboard } from '../../lib/clipboard';
import styles from './MaintenanceDialog.module.css';

export type MaintenanceAction = 'install' | 'upgrade' | 'install_native' | 'uninstall_npm' | 'upgrade_major';

export type MaintenanceState = {
  tool: string;
  name: string;
  running: boolean;
  action: MaintenanceAction;
  source?: string;
  lineVersion?: string;
  /** Release the action is expected to reach, when the install panel knows it. */
  target?: string;
  /** Version installed when the action started. */
  from?: string | null;
  cancelling?: boolean;
  output: string;
  error: string;
  version?: string | null;
  startedAt: number;
  finishedAt?: number;
  /** Hidden into the floating activity pill while the action keeps running. */
  minimized?: boolean;
};

// Installer output often carries terminal colour codes; the log shows plain text.
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function plain(output: string) { return output.replace(ansi, '').replace(/\r(?!\n)/g, '\n'); }

function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useElapsed(state: MaintenanceState | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state?.running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.running, state?.startedAt]);
  if (!state) return '';
  return clock((state.finishedAt ?? now) - state.startedAt);
}

type Phase = 'running' | 'done' | 'error';

export function MaintenanceDialog({ state, busy, canRetry, onCancel, onRetry, onClose, onMinimize, onRestore }: {
  state: MaintenanceState | null;
  busy: boolean;
  canRetry: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const elapsed = useElapsed(state);
  const [logOpen, setLogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const phase: Phase = !state || state.running ? 'running' : state.error ? 'error' : 'done';
  const text = plain(state?.output ?? '');
  const lines = text.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const lastLine = lines.at(-1) ?? '';

  // A failure opens the log: the installer output is usually the only explanation.
  useEffect(() => { if (state && !state.running && state.error && state.output) setLogOpen(true); }, [state?.running, state?.error]);
  useEffect(() => { setLogOpen(false); setCopied(false); }, [state?.startedAt]);
  useLayoutEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text, logOpen]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!state) return null;
  const headline = phase === 'running'
    ? t(`tools.workspace.maintenanceHeadline.running.${state.action}`, { name: state.name })
    : phase === 'done'
      ? t(`tools.workspace.maintenanceHeadline.done.${state.action}`, { name: state.name })
      : t('tools.workspace.maintenanceHeadline.failed', { name: state.name });
  const status = phase === 'running'
    ? (state.cancelling ? t('tools.workspace.maintenanceCancelling') : t('tools.workspace.maintenanceRunning'))
    : phase === 'error'
      ? state.error
      : state.version ? t('tools.workspace.maintenanceDone', { version: state.version }) : t('tools.workspace.maintenanceDoneNoVersion');
  const to = phase === 'done' ? state.version ?? state.target : state.target;
  const showFlow = state.action !== 'uninstall_npm' && (state.from || to);
  const badge = phase === 'running' ? <span className={styles.spinner} /> : <Icon name={phase === 'error' ? 'alert' : 'check'} size={phase === 'error' ? 13 : 14} strokeWidth={2.6} />;

  async function copy() {
    if (await writeClipboard(text)) setCopied(true);
  }

  return <>
    <GuideDialog open={!state.minimized} title={t('tools.workspace.maintenanceTitle', { name: state.name })} onClose={() => { if (state.running) onMinimize(); else onClose(); }}>
      <div className={styles.panel} data-phase={phase}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}>
            <ToolIcon toolId={state.tool} size={48} />
            <span className={styles.heroBadge} aria-hidden="true">{badge}</span>
          </span>
          <div className={styles.heroText}>
            <h3>{headline}</h3>
            <p role="status" className={styles.status}>{status}</p>
          </div>
        </div>

        <div className={styles.facts}>
          {showFlow && <span className={styles.flow} aria-label={t('tools.workspace.maintenanceFlowAria', { from: state.from || '—', to: to || t('tools.workspace.maintenanceLatest') })}>
            {state.from && <span className={styles.version} data-role="from">{state.from}</span>}
            {state.from && <span className={styles.arrow}><Icon name="arrowRight" size={13} /></span>}
            <span className={styles.version} data-role="to">{to || t('tools.workspace.maintenanceLatest')}</span>
          </span>}
          <span className={styles.elapsed}><Icon name="clock" size={13} />{t('tools.workspace.maintenanceElapsed', { time: elapsed })}</span>
          {phase === 'running' && <span className={styles.track} aria-hidden="true"><span /></span>}
        </div>
        {state.running && state.error && <p role="alert" className={styles.inlineError}>{state.error}</p>}

        <section className={styles.terminal} data-open={logOpen || undefined}>
          <div className={styles.terminalHead}>
            <button type="button" className={styles.terminalToggle} aria-expanded={logOpen} onClick={() => setLogOpen((value) => !value)}>
              <Icon name="chevronRight" size={14} />
              <span className={styles.terminalTitle}>{t('tools.workspace.maintenanceLog')}</span>
              {lines.length > 0 && <span className={styles.terminalCount}>{t('tools.workspace.maintenanceLogLines', { count: lines.length })}</span>}
            </button>
            {!logOpen && lastLine && <code className={styles.ticker} title={lastLine}>{lastLine}</code>}
            <button type="button" className={styles.copy} data-copied={copied || undefined} disabled={!text.trim()} onClick={() => void copy()} aria-label={t('tools.workspace.maintenanceCopyLog')} title={t('tools.workspace.maintenanceCopyLog')}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
          </div>
          <pre ref={logRef} className={styles.log} hidden={!logOpen} aria-label={t('tools.workspace.maintenanceLog')}>{text || t('tools.workspace.maintenanceWaiting')}</pre>
        </section>

        <div className="dialog-footer">
          {state.running
            ? <>
              <button type="button" className={styles.quietDanger} disabled={state.cancelling} onClick={onCancel}>{t(state.cancelling ? 'tools.workspace.maintenanceCancelling' : 'tools.workspace.maintenanceCancel')}</button>
              <span className="dialog-footer-gap" />
              <button type="button" onClick={onMinimize} title={t('tools.workspace.maintenanceBackgroundHint')}><Icon name="minimize" size={14} />{t('tools.workspace.maintenanceBackground')}</button>
            </>
            : <>
              <span className="dialog-footer-gap" />
              {state.error && canRetry && <button type="button" onClick={onClose}>{t('tools.workspace.maintenanceClose')}</button>}
              {state.error && canRetry
                ? <button type="button" className={styles.primary} disabled={busy} onClick={onRetry}><Icon name="refresh" size={14} />{t('tools.workspace.maintenanceRetry')}</button>
                : <button type="button" className={styles.primary} onClick={onClose}>{state.error ? t('tools.workspace.maintenanceClose') : t('tools.workspace.maintenanceFinish')}</button>}
            </>}
        </div>
      </div>
    </GuideDialog>

    {state.minimized && <div className={styles.pill} data-phase={phase} role="status" aria-label={headline}>
      <span className={styles.pillIcon}>
        <ToolIcon toolId={state.tool} size={24} />
        <span className={styles.heroBadge} aria-hidden="true">{badge}</span>
      </span>
      <span className={styles.pillText}>
        <strong>{headline}</strong>
        <small>{phase === 'running' ? (lastLine || status) : status}</small>
      </span>
      <span className={styles.pillTime}>{elapsed}</span>
      <button type="button" className={styles.pillOpen} onClick={onRestore}>{t('tools.workspace.maintenanceShow')}</button>
      {!state.running && <button type="button" className={styles.pillClose} aria-label={t('tools.workspace.maintenanceClose')} title={t('tools.workspace.maintenanceClose')} onClick={onClose}><Icon name="close" size={14} /></button>}
      {state.running && <span className={styles.pillTrack} aria-hidden="true" />}
    </div>}
  </>;
}
