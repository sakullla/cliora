import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { GuideDialog } from '../../components/GuideDialog';
import type { ConflictPreview, RestoreBlocker, SyncProgress, SyncStatus, SyncTransfer, WebdavSetup } from '../../types/portable';
import type { Project } from '../../types/launch';
import styles from './MigrationSettings.module.css';

const PREVIEW_LIMIT = 4;
const PHASES = ['connect', 'compare', 'transfer', 'apply'] as const;

type Activity = { compared: number; uploaded: number; downloaded: number; transfers: SyncTransfer[] };
type SyncLine = { id: string; direction: string; label: string; kind: string; deleted: boolean };
type SyncRun = {
  open: boolean;
  running: boolean;
  dismissed: boolean;
  phase: string;
  detail: string;
  direction: string;
  kind: string;
  deleted: boolean;
  done: number;
  total: number;
  lines: SyncLine[];
  result: SyncStatus | null;
};

function activityOf(status: SyncStatus | null): Activity | null {
  if (!status) return null;
  if (status.receipt) {
    return {
      compared: status.receipt.compared,
      uploaded: status.receipt.uploaded,
      downloaded: status.receipt.downloaded,
      transfers: status.receipt.transfers ?? [],
    };
  }
  const transfers = status.transfers ?? [];
  if (transfers.length || status.compared || status.uploaded || status.downloaded) {
    return { compared: status.compared ?? 0, uploaded: status.uploaded, downloaded: status.downloaded, transfers };
  }
  return null;
}

function stepIndex(phase: string) {
  if (phase === 'compare') return 1;
  if (phase === 'transfer' || phase === 'save') return 2;
  if (phase === 'apply' || phase === 'done') return 3;
  return 0;
}

const emptySetup = (endpoint = '', enabled = true): WebdavSetup => ({
  endpoint, username: '', authPassword: '', encryptionPassword: '', previousEncryptionPassword: '', enabled,
});

function missingDirectoryPath(detail: string) {
  const mark = '目录不存在：';
  const index = detail.indexOf(mark);
  return index < 0 ? '' : detail.slice(index + mark.length).trim();
}

const selectedDirectoryMark = '写入已选目录：';

function selectedDirectory(detail: string) {
  const index = detail.indexOf(selectedDirectoryMark);
  return index < 0 ? '' : detail.slice(index + selectedDirectoryMark.length).trim();
}

function blockerDetail(detail: string) {
  const index = detail.indexOf(`\n${selectedDirectoryMark}`);
  return index < 0 ? detail : detail.slice(0, index);
}

function sameDirectory(left: string, right: string) {
  const normalize = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalize(left) === normalize(right);
}

export function WebdavSettings({ active, editing, onEdit, revision = 0 }: { active: boolean; editing: boolean; onEdit: (editing: boolean) => void; revision?: number }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [setup, setSetup] = useState<WebdavSetup>(emptySetup());
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, ConflictPreview>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [run, setRun] = useState<SyncRun | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const latest = useRef(''); latest.current = JSON.stringify([status, previews, active]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.getWebdavStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      if (next.endpoint) setSetup((old) => ({ ...old, endpoint: next.endpoint ?? '', enabled: next.enabled, encryptionPassword: '', previousEncryptionPassword: '' }));
    }).catch((reason: { message?: string }) => { if (alive) setError(reason.message ?? t('settings.webdav.statusFailed')); });
    void native.listProjects().then((next) => {
      if (!alive) return;
      setProjects(next);
      setProjectsLoaded(true);
    }).catch(() => { if (alive) setProjectsLoaded(true); });
    return () => { alive = false; };
  }, [active, revision]);

  async function configure() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      // An empty encryption password tells the engine to use the connection password.
      const next = await native.configureWebdav({ ...setup, encryptionPassword: '', previousEncryptionPassword: '' });
      setStatus(next); onEdit(false);
      setSetup(emptySetup(next.endpoint ?? '', next.enabled));
      setMessage(t('settings.webdav.configured'));
      if (next.enabled) await executeSync();
    } catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.configureFailed')); }
    finally { setBusy(false); }
  }

  async function toggleEnabled() {
    if (busy || !status) return;
    setBusy(true); setError('');
    try { setStatus(await native.setWebdavEnabled(!status.enabled)); }
    catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.toggleFailed')); }
    finally { setBusy(false); }
  }

  async function executeSync() {
    setReceiptOpen(false);
    setRun({ open: true, running: true, dismissed: false, phase: 'connect', detail: '', direction: '', kind: '', deleted: false, done: 0, total: 0, lines: [], result: null });
    let stop: (() => void) | undefined;
    try {
      stop = await listen<SyncProgress>('cliora:sync-progress', (event) => {
        const payload = event.payload;
        if (!payload) return;
        setRun((current) => {
          if (!current?.running) return current;
          const lines = payload.direction
            ? [...current.lines, { id: `${payload.direction}:${payload.key}:${current.lines.length}`, direction: payload.direction, label: payload.detail, kind: payload.kind, deleted: payload.deleted }].slice(-8)
            : current.lines;
          return { ...current, phase: payload.phase || current.phase, detail: payload.detail, direction: payload.direction, kind: payload.kind, deleted: payload.deleted, done: payload.done, total: payload.total, lines };
        });
      }).catch(() => undefined);
      const next = await native.syncWebdavNow();
      if (!mounted.current) return next;
      setStatus(next);
      setPreviews({});
      setRun((current) => {
        if (!current || current.dismissed) return null;
        return { ...current, running: false, result: next, phase: 'done' };
      });
      return next;
    } catch (reason) {
      if (mounted.current) {
        setError((reason as { message?: string }).message ?? t('settings.webdav.syncFailed'));
        setRun(null);
        void native.getWebdavStatus().then((next) => { if (mounted.current) setStatus(next); }).catch(() => {});
      }
      return null;
    } finally { stop?.(); }
  }

  async function syncNow() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await executeSync(); }
    finally { if (mounted.current) setBusy(false); }
  }

  function closeRun() {
    setRun((current) => {
      if (!current) return current;
      if (current.running) return { ...current, open: false, dismissed: true };
      return null;
    });
  }

  async function resolve(key: string, versionId: string | null, deleted: boolean) {
    if (busy) return;
    const started = latest.current;
    if (versionId && !await confirmAction(deleted ? t('settings.webdav.confirmDelete') : t('settings.webdav.confirmReplace'), () => mounted.current && latest.current === started, { title: deleted ? t('settings.webdav.confirmDeleteTitle') : t('settings.webdav.confirmReplaceTitle'), confirmLabel: deleted ? t('settings.webdav.deleteLocal') : t('settings.webdav.replaceLocal'), destructive: deleted })) return;
    setBusy(true); setError(''); setMessage('');
    try { setStatus(await native.resolveWebdavConflict(key, versionId));
      setPreviews((old) => { const next = { ...old }; delete next[key]; return next; });
      setMessage(t('settings.webdav.resolved')); }
    catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.resolveFailed')); }
    finally { setBusy(false); }
  }

  async function previewConflict(key: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { const next = await native.previewWebdavConflict(key); setPreviews((old) => ({ ...old, [key]: next })); }
    catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.previewFailed')); }
    finally { setBusy(false); }
  }

  async function chooseDirectory(project: Project) {
    if (busy) return;
    const picked = await open({ title: t('settings.webdav.chooseDirectoryTitle'), directory: true, multiple: false });
    if (typeof picked !== 'string') return;
    setBusy(true); setError('');
    try {
      const updated = await native.relinkProject(project.id, picked);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setStatus(await native.getWebdavStatus());
      setMessage(t('settings.webdav.directoryLinked', { name: updated.name }));
    } catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.relinkFailed')); }
    finally { setBusy(false); }
  }

  function blockerCleared(next: SyncStatus | null | undefined, key: string) {
    return !!next && Array.isArray(next.blockers) && !next.blockers.some((item) => item.key === key);
  }

  async function refreshStatus() {
    try {
      const next = await native.getWebdavStatus();
      if (mounted.current) setStatus(next);
    } catch { /* The action error stays visible when status cannot be refreshed. */ }
  }

  async function retryNative(blocker: RestoreBlocker) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.retryRestoreBlocker(blocker.key);
      if (blockerCleared(next, blocker.key)) {
        setStatus(next);
        setMessage(t('settings.webdav.nativeReady', { label: blocker.label }));
        return;
      }
      if (next) setStatus(next);
      const detail = blockerDetail(next?.blockers?.find((item) => item.key === blocker.key)?.detail || blocker.detail);
      if (blocker.action === 'install') setMessage(t('settings.webdav.installHint', { label: blocker.label, detail }));
      else setError(detail || t('settings.webdav.writeFailed'));
    } catch (reason) {
      const detail = blockerDetail((reason as { message?: string }).message || blocker.detail);
      await refreshStatus();
      if (blocker.action === 'install') setMessage(t('settings.webdav.installHint', { label: blocker.label, detail }));
      else setError(detail || t('settings.webdav.writeFailed'));
    } finally { setBusy(false); }
  }

  async function acceptLogin(blocker: RestoreBlocker) {
    const next = await native.retryRestoreBlocker(blocker.key);
    if (blockerCleared(next, blocker.key)) {
      setStatus(next);
      setMessage(t('settings.webdav.nativeReady', { label: blocker.label }));
      return true;
    }
    if (next) setStatus(next);
    return false;
  }

  async function relogin(blocker: RestoreBlocker) {
    if (busy) return;
    const id = blocker.key.startsWith('account:') ? blocker.key.slice('account:'.length) : '';
    setBusy(true); setError(''); setMessage('');
    try {
      const accounts = await native.listAccounts();
      const account = accounts.find((item) => item.id === id);
      const capabilities = await native.accountCapabilities();
      const method = capabilities.find((item) => item.toolId === account?.toolId)?.methods[0];
      if (account?.state === 'signed_in' && !account.pendingLogin) {
        try {
          if (await acceptLogin(blocker)) return;
        } catch { /* The saved sign-in was not accepted. Start the login again. */ }
      }
      if (!account || !method) {
        setError(blocker.detail || t('settings.webdav.reloginFailed'));
        return;
      }
      const started = await native.startAccountLogin(account.id, account.version, method);
      if (started.state === 'signed_in' && !started.pendingLogin) {
        if (await acceptLogin(blocker)) return;
      }
      setMessage(t('settings.webdav.reloginStarted'));
    } catch (reason) {
      setError((reason as { message?: string }).message ?? t('settings.webdav.reloginFailed'));
      await refreshStatus();
    } finally { setBusy(false); }
  }

  async function writeChosenDirectory(blocker: RestoreBlocker) {
    if (busy) return;
    const path = selectedDirectory(blocker.detail);
    const project = projects.find((item) => item.path && sameDirectory(item.path, path));
    if (!project?.path) {
      setError(t('settings.webdav.writeFailed'));
      return;
    }
    setBusy(true); setError(''); setMessage('');
    try {
      const updated = await native.relinkProject(project.id, project.path);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setStatus(await native.getWebdavStatus());
      setMessage(t('settings.webdav.directoryWritten', { label: blocker.label }));
    } catch (reason) {
      setError((reason as { message?: string }).message ?? t('settings.webdav.writeFailed'));
      void native.getWebdavStatus().then((next) => { if (mounted.current) setStatus(next); }).catch(() => {});
    } finally { setBusy(false); }
  }

  async function runBlocker(blocker: RestoreBlocker) {
    if (selectedDirectory(blocker.detail)) {
      await writeChosenDirectory(blocker);
      return;
    }
    if (blocker.action === 'relink') {
      const path = missingDirectoryPath(blocker.detail);
      const project = projects.find((item) => item.path === path);
      if (project) { await chooseDirectory(project); return; }
      setError(blocker.detail);
      return;
    }
    if (blocker.action === 'install' || blocker.action === 'retry') {
      await retryNative(blocker);
      return;
    }
    if (blocker.action === 'relogin') {
      await relogin(blocker);
      return;
    }
    await syncNow();
  }

  function kindLabel(kind: string) {
    const known = ['preferences', 'profile', 'common', 'project', 'library', 'mcp', 'skill', 'account', 'binding'];
    return known.includes(kind) ? t(`settings.webdav.kind.${kind}`) : kind;
  }

  function itemName(item: { label: string; kind: string; deleted: boolean }) {
    if (item.deleted || !item.label) return t('settings.webdav.deletedItem', { kind: kindLabel(item.kind) });
    return item.label;
  }

  function summary(activity: Activity, conflictCount: number) {
    const moved = Math.max(activity.uploaded + activity.downloaded, activity.transfers.length);
    const headline = conflictCount > 0 && moved === 0
      ? t('settings.webdav.conflictsLeft', { count: conflictCount })
      : moved === 0
        ? t('settings.webdav.alreadyAligned')
        : t('settings.webdav.syncedSome', { count: moved });
    const detail = moved === 0
      ? (activity.compared > 0 ? t('settings.webdav.alreadyAlignedDetail', { count: activity.compared }) : t('settings.webdav.emptyTransfer'))
      : t('settings.webdav.syncedSomeDetail', { downloaded: activity.downloaded, uploaded: activity.uploaded });
    return { moved, headline, detail };
  }

  function progressText(current: SyncRun) {
    if (current.phase === 'connect') return t('settings.webdav.progressConnect');
    if (current.phase === 'read') return t('settings.webdav.progressRead');
    if (current.phase === 'compare') return current.detail ? t('settings.webdav.progressCompareItem', { name: current.detail }) : t('settings.webdav.progressCompare');
    if (current.phase === 'save') return t('settings.webdav.progressSave');
    if (current.phase === 'apply' || current.phase === 'done') return t('settings.webdav.progressApply');
    if (current.phase === 'transfer') {
      const name = itemName({ label: current.detail, kind: current.kind, deleted: current.deleted });
      return current.direction === 'download' ? t('settings.webdav.liveReceived', { name }) : t('settings.webdav.liveUploaded', { name });
    }
    return t('settings.webdav.progressWait');
  }

  function transferGroups(transfers: SyncTransfer[]) {
    const sections = [
      ['download', t('settings.webdav.receivedTitle'), transfers.filter((item) => item.direction === 'download')],
      ['upload', t('settings.webdav.uploadedTitle'), transfers.filter((item) => item.direction !== 'download')],
    ] as const;
    if (!transfers.length) return null;
    return <div className={styles.groups}>{sections.map(([key, title, items]) => items.length ? <div key={key}><h3>{title}</h3><ul className={styles.transferList}>{items.map((item) => <li key={`${item.direction}:${item.key}`}><span className={styles.direction}>{item.direction === 'download' ? t('settings.webdav.directionDownload') : t('settings.webdav.directionUpload')}</span><span className={styles.transferName}>{itemName(item)}</span><span className={styles.kindChip}>{kindLabel(item.kind)}</span></li>)}</ul></div> : null)}</div>;
  }

  const missingProjects = projects.filter((project) => !project.available);
  const blockers = (status?.blockers ?? []).filter((blocker) => {
    if (blocker.action !== 'relink') return true;
    const path = missingDirectoryPath(blocker.detail);
    if (!projectsLoaded || !path) return true;
    if (missingProjects.some((project) => project.path === path)) return false;
    if (projects.some((project) => project.path === path && project.available)) return false;
    return true;
  });
  const conflicts = status?.conflicts ?? [];
  const itemIssues = missingProjects.length > 0 || blockers.length > 0 || conflicts.length > 0;
  const passwordShort = setup.authPassword.length < 12;
  const when = status?.lastSuccess ? new Date(status.lastSuccess * 1000).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN') : '';
  const activity = activityOf(status);
  const activitySummary = activity ? summary(activity, conflicts.length) : null;
  const preview = activity?.transfers.slice(0, PREVIEW_LIMIT) ?? [];
  const hiddenTransfers = Math.max(0, (activity?.transfers.length ?? 0) - preview.length);
  const resultActivity = run?.result ? activityOf(run.result) : null;
  const resultSummary = resultActivity ? summary(resultActivity, run?.result?.conflicts.length ?? 0) : null;
  const phaseLabels = [t('settings.webdav.phaseConnect'), t('settings.webdav.phaseCompare'), t('settings.webdav.phaseTransfer'), t('settings.webdav.phaseApply')];

  return <section className="settings-group" aria-label={t('settings.webdav.title')}>
    <div className="setting-intro"><h2>{t('settings.webdav.title')}</h2><p>{t('settings.webdav.description')}</p></div>
    {error && <div className={styles.inlineError} role="alert">{error}</div>}
    {message && <div className={styles.inlineMessage} role="status">{message}</div>}
    {status?.configured ? <>
      <div className="setting-row"><span><strong>{status.enabled ? t('settings.webdav.syncOn') : t('settings.webdav.syncOff')}</strong><small>{status.lastSuccess ? t('settings.webdav.lastSuccess', { time: when }) : t('settings.webdav.neverSynced')}</small></span>
        <button className="button" type="button" disabled={busy} onClick={() => void toggleEnabled()}>{status.enabled ? t('settings.webdav.pause') : t('settings.webdav.enable')}</button></div>
      <div className={styles.syncBoard}>
        <div className={styles.syncReady}><span className={styles.syncDot} data-partial={itemIssues ? '' : undefined} /><strong>{itemIssues ? t('settings.webdav.partialReady') : t('settings.webdav.readyNow')}</strong></div>
        {activitySummary ? <>
          <p className={styles.syncHeadline}>{activitySummary.headline}</p>
          <p className={styles.syncDetail}>{activitySummary.detail}</p>
          {conflicts.length > 0 && activitySummary.moved > 0 && <p className={styles.syncNote}>{t('settings.webdav.conflictsLeft', { count: conflicts.length })}</p>}
          {!!preview.length && <ul className={styles.transferPreview}>{preview.map((item) => <li key={`${item.direction}:${item.key}`}><span className={styles.direction}>{item.direction === 'download' ? t('settings.webdav.directionDownload') : t('settings.webdav.directionUpload')}</span><span className={styles.transferName}>{itemName(item)}</span><span className={styles.kindChip}>{kindLabel(item.kind)}</span></li>)}</ul>}
          {(hiddenTransfers > 0 || preview.length > 0) && <div className={styles.boardActions}>
            <button className="button" type="button" onClick={() => setReceiptOpen(true)}>{hiddenTransfers > 0 ? t('settings.webdav.moreTransfers', { count: hiddenTransfers }) : t('settings.webdav.viewReceipt')}</button>
          </div>}
        </> : status.lastSuccess ? <>
          <p className={styles.syncHeadline}>{t('settings.webdav.noReceipt')}</p>
          <p className={styles.syncDetail}>{t('settings.webdav.noReceiptDetail')}</p>
        </> : null}
      </div>
      {!!status.pendingChanges && <div className="setting-row"><span><small>{t('settings.webdav.pendingUpload', { count: status.pendingChanges })}</small></span></div>}
      {status.lastError ? <div className={styles.action}><span className={styles.hint}>{t('settings.webdav.connectionFailed', { error: status.lastError })}</span>
        <button className="button" type="button" disabled={busy} onClick={() => void syncNow()}>{t('settings.webdav.retry')}</button>
        <button className="button" type="button" disabled={busy} onClick={() => onEdit(true)}>{t('settings.webdav.editConnection')}</button></div>
        : <div className={styles.action}><button className="button primary" type="button" disabled={busy} onClick={() => void syncNow()}>{busy ? t('settings.webdav.syncing') : t('settings.webdav.syncNow')}</button>
          <button className="button" type="button" disabled={busy} onClick={() => onEdit(true)}>{t('settings.webdav.editConnection')}</button></div>}
    </> : <>
      <div className="setting-row"><span><strong>{t('settings.webdav.notConnected')}</strong><small>{t('settings.webdav.notConnectedHint')}</small></span><button className="button" type="button" onClick={() => onEdit(true)}>{t('settings.webdav.configure')}</button></div>
      {itemIssues && <div className="setting-row"><span><strong>{t('settings.webdav.partialReady')}</strong></span></div>}
    </>}
    <GuideDialog open={!!run?.open} title={run?.running ? t('settings.webdav.progressTitle') : t('settings.webdav.progressDoneTitle')} onClose={closeRun}>
      <div className="sync-activity">
      {run && run.running && <>
        <ol className={styles.steps} aria-label={t('settings.webdav.progressTitle')}>{PHASES.map((id, index) => {
          const current = stepIndex(run.phase);
          const state = index < current ? 'done' : index === current ? 'current' : 'wait';
          return <li key={id} data-state={state}><span>{state === 'done' ? '✓' : index + 1}</span>{phaseLabels[index]}</li>;
        })}</ol>
        <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={run.total > 0 ? run.total : undefined} aria-valuenow={run.total > 0 ? Math.min(run.done, run.total) : undefined} aria-valuetext={progressText(run)} data-indeterminate={run.total > 0 ? undefined : ''}>
          <span style={run.total > 0 ? { width: `${Math.min(100, Math.round((run.done / run.total) * 100))}%` } : undefined} />
        </div>
        <div className={styles.progressMeta}><p>{progressText(run)}</p>{run.total > 0 && <strong>{t('settings.webdav.progressCount', { done: Math.min(run.done, run.total), total: run.total })}</strong>}</div>
        {!!run.lines.length && <ul className={styles.liveLog} aria-live="polite">{run.lines.map((line) => <li key={line.id}><span className={styles.direction}>{line.direction === 'download' ? t('settings.webdav.directionDownload') : t('settings.webdav.directionUpload')}</span><span className={styles.transferName}>{itemName(line)}</span><span className={styles.kindChip}>{kindLabel(line.kind)}</span></li>)}</ul>}
      </>}
      {run && !run.running && <>
        <div className={styles.resultHero}>
          <span className={styles.resultMark} data-tone={(run.result?.conflicts.length ?? 0) > 0 ? 'warn' : undefined} aria-hidden="true" />
          <div className={styles.resultCopy}>
            <p className={styles.syncHeadline}>{resultSummary?.headline ?? t('settings.webdav.emptyTransfer')}</p>
            <p className={styles.syncDetail}>{resultSummary?.detail ?? t('settings.webdav.emptyTransfer')}</p>
          </div>
        </div>
        {(run.result?.conflicts.length ?? 0) > 0 && (resultSummary?.moved ?? 0) > 0 && <p className={styles.syncNote}>{t('settings.webdav.conflictsLeft', { count: run.result?.conflicts.length ?? 0 })}</p>}
        {resultActivity && transferGroups(resultActivity.transfers)}
        <div className={styles.resultActions}><button type="button" className="button primary" data-dialog-save onClick={closeRun}>{t('settings.webdav.progressClose')}</button></div>
      </>}
      </div>
    </GuideDialog>
    <GuideDialog open={receiptOpen && !run?.open} title={t('settings.webdav.progressDoneTitle')} onClose={() => setReceiptOpen(false)}>
      {activitySummary && activity && <div className="sync-activity">
        <div className={styles.resultHero}>
          <span className={styles.resultMark} data-tone={conflicts.length > 0 ? 'warn' : undefined} aria-hidden="true" />
          <div className={styles.resultCopy}>
            <p className={styles.syncHeadline}>{activitySummary.headline}</p>
            <p className={styles.syncDetail}>{activitySummary.detail}</p>
          </div>
        </div>
        {conflicts.length > 0 && activitySummary.moved > 0 && <p className={styles.syncNote}>{t('settings.webdav.conflictsLeft', { count: conflicts.length })}</p>}
        {transferGroups(activity.transfers)}
        <div className={styles.resultActions}><button type="button" className="button primary" data-dialog-save onClick={() => setReceiptOpen(false)}>{t('settings.webdav.progressClose')}</button></div>
      </div>}
    </GuideDialog>
    <GuideDialog open={editing} title={status?.configured ? t('settings.webdav.editTitle') : t('settings.webdav.configure')} hint={t('settings.webdav.dialogHint')} onClose={() => onEdit(false)}>
    <div className={styles.webdavForm}>
      <label>{t('settings.webdav.endpoint')}<input type="url" value={setup.endpoint} placeholder="https://dav.example.com/cliora/" onChange={(event) => setSetup({ ...setup, endpoint: event.target.value })} /></label>
      <label>{t('settings.webdav.username')}<input value={setup.username} autoComplete="username" onChange={(event) => setSetup({ ...setup, username: event.target.value })} /></label>
      <label>{t('settings.webdav.password')}<input type="password" value={setup.authPassword} autoComplete="new-password" placeholder={t('settings.webdav.passwordPlaceholder')} onChange={(event) => setSetup({ ...setup, authPassword: event.target.value, encryptionPassword: '', previousEncryptionPassword: '' })} /></label>
      <small>{passwordShort ? t('settings.webdav.passwordMore', { count: Math.max(0, 12 - setup.authPassword.length) }) : t('settings.webdav.passwordOk')}</small>
      <small>{t('settings.webdav.securityNote')}</small>
      <div className={styles.action}><button type="button" className="button primary" disabled={!nativeAvailable || busy || !setup.endpoint || !setup.username || passwordShort} onClick={() => void configure()}>{t('settings.webdav.save')}</button>
        <button type="button" className="button" disabled={busy} onClick={() => onEdit(false)}>{t('common.dialog.cancel')}</button></div>
    </div>
    </GuideDialog>
    {itemIssues && <div className={styles.conflicts}><h3>{t('settings.webdav.actionsTitle')}</h3><p>{t('settings.webdav.actionsHint')}</p>
      {missingProjects.map((project) => <div className={styles.conflict} key={project.id}><strong>{project.name}</strong><small>{project.path ? t('settings.webdav.missingDirectory', { path: project.path }) : t('settings.webdav.missingDirectoryUnknown')}</small>
        <button className="button" type="button" disabled={busy} onClick={() => void chooseDirectory(project)}>{t('settings.webdav.chooseDirectory')}</button></div>)}
      {blockers.map((blocker) => <div className={styles.conflict} key={blocker.key}><strong>{blocker.label}</strong><small>{blockerDetail(blocker.detail)}</small>
        <button className="button" type="button" disabled={busy} onClick={() => void runBlocker(blocker)}>{selectedDirectory(blocker.detail) ? t('settings.webdav.writeChosenDirectory') : blocker.action === 'install' ? t('settings.webdav.installCli') : blocker.action === 'relogin' ? t('settings.webdav.relogin') : blocker.action === 'relink' ? t('settings.webdav.chooseDirectory') : t('settings.webdav.retry')}</button></div>)}
      {!!conflicts.length && <h3>{t('settings.webdav.conflictsTitle')}</h3>}
      {conflicts.map((conflict) => <div className={styles.conflict} key={conflict.key}><strong>{conflict.label}</strong><small>{t('settings.webdav.conflictsHint')} {t('settings.webdav.remoteVersions', { count: conflict.remoteVersions })}</small>
        {!previews[conflict.key] ? <button className="button" type="button" disabled={busy} onClick={() => void previewConflict(conflict.key)}>{t('settings.webdav.chooseConflict')}</button> : <>
          <div className={styles.version}><strong>{t('settings.webdav.local')}</strong><p>{previews[conflict.key].localSummary}</p><button className="button" type="button" disabled={busy} onClick={() => void resolve(conflict.key, null, false)}>{t('settings.webdav.keepLocal')}</button></div>
          {previews[conflict.key].versions.map((version) => <div className={styles.version} key={version.id}><strong>{t('settings.webdav.remoteVersion', { id: version.id.slice(0, 8) })}</strong><p>{version.summary}</p>
            <button className="button" type="button" disabled={busy} onClick={() => void resolve(conflict.key, version.id, version.deleted)}>{version.deleted ? t('settings.webdav.acceptDelete') : t('settings.webdav.useRemote')}</button></div>)}
        </>}</div>)}
    </div>}
  </section>;
}
