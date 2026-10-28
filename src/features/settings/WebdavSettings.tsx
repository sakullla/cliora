import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon, type IconName } from '../../components/Icon';
import type { ConflictPreview, RestoreBlocker, SyncProgress, SyncStatus, SyncTransfer, WebdavSetup } from '../../types/portable';
import type { Project } from '../../types/launch';
import { Badge, Button, Card, StatusBadge, Switch } from '../../components/ui';
import styles from './Sync.module.css';
import { MIN_PASSPHRASE, Metric, Notice, PassphraseField, TextField, TransferList, endpointHost, relativeTime, useKindLabel } from './syncParts';

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
  const kindLabel = useKindLabel();
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

  function itemIcon(action: string, chosen: boolean): IconName {
    if (chosen || action === 'relink') return 'folder';
    if (action === 'install') return 'download';
    if (action === 'relogin') return 'user';
    return 'refresh';
  }

  function blockerTag(action: string, chosen: boolean) {
    if (chosen || action === 'relink') return t('settings.webdav.tagDirectory');
    if (action === 'install') return t('settings.webdav.tagInstall');
    if (action === 'relogin') return t('settings.webdav.tagLogin');
    return t('settings.webdav.tagWrite');
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
      const name = current.deleted || !current.detail ? t('settings.webdav.deletedItem', { kind: kindLabel(current.kind) }) : current.detail;
      return current.direction === 'download' ? t('settings.webdav.liveReceived', { name }) : t('settings.webdav.liveUploaded', { name });
    }
    return t('settings.webdav.progressWait');
  }

  function metrics(activity: Activity) {
    return <div className={styles.metrics}>
      <Metric icon="search" tone="muted" label={t('settings.webdav.metricCompared')} value={activity.compared} />
      <Metric icon="arrowDown" tone="info" label={t('settings.webdav.metricReceived')} value={activity.downloaded} />
      <Metric icon="upload" tone="accent" label={t('settings.webdav.metricUploaded')} value={activity.uploaded} />
    </div>;
  }

  function resultView(activity: Activity | null, headline: string, detail: string, conflictCount: number, moved: number, onClose: () => void) {
    const received = activity?.transfers.filter((item) => item.direction === 'download') ?? [];
    const sent = activity?.transfers.filter((item) => item.direction !== 'download') ?? [];
    return <div className={`sync-dialog sync-activity ${styles.dialogBody}`}>
      <div className={styles.result}>
        <span className={styles.resultMark} data-tone={conflictCount > 0 ? 'warn' : undefined} aria-hidden="true"><Icon name={conflictCount > 0 ? 'alert' : 'check'} size={24} /></span>
        <div className={styles.resultCopy}>
          <p className={styles.headline}>{headline}</p>
          <p className={styles.detail}>{detail}</p>
        </div>
      </div>
      {activity && metrics(activity)}
      {conflictCount > 0 && moved > 0 && <p className={styles.note}><Icon name="alert" size={14} />{t('settings.webdav.conflictsLeft', { count: conflictCount })}</p>}
      {!!received.length && <div className={styles.group}><h3><span>{t('settings.webdav.receivedTitle')}</span><Badge>{received.length}</Badge></h3><TransferList items={received} /></div>}
      {!!sent.length && <div className={styles.group}><h3><span>{t('settings.webdav.uploadedTitle')}</span><Badge>{sent.length}</Badge></h3><TransferList items={sent} /></div>}
      <div className={styles.dialogFoot}><Button variant="primary" data-dialog-save onClick={onClose}>{t('settings.webdav.progressClose')}</Button></div>
    </div>;
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
  const issueCount = missingProjects.length + blockers.length + conflicts.length;
  const itemIssues = issueCount > 0;
  const passwordShort = setup.authPassword.length < MIN_PASSPHRASE;
  const canSave = nativeAvailable && !busy && !!setup.endpoint && !!setup.username && !passwordShort;
  const last = status?.lastSuccess ? relativeTime(status.lastSuccess, i18n.language) : null;
  const host = endpointHost(status?.endpoint);
  const activity = activityOf(status);
  const activitySummary = activity ? summary(activity, conflicts.length) : null;
  const hiddenTransfers = Math.max(0, (activity?.transfers.length ?? 0) - PREVIEW_LIMIT);
  const receiptAt = status?.receipt?.at ? relativeTime(status.receipt.at, i18n.language) : null;
  const resultActivity = run?.result ? activityOf(run.result) : null;
  const resultSummary = resultActivity ? summary(resultActivity, run?.result?.conflicts.length ?? 0) : null;
  const phaseLabels = [t('settings.webdav.phaseConnect'), t('settings.webdav.phaseCompare'), t('settings.webdav.phaseTransfer'), t('settings.webdav.phaseApply')];
  const tone = !status?.configured ? 'idle' : status.lastError ? 'danger' : !status.enabled ? 'paused' : itemIssues ? 'warning' : 'ok';
  const syncing = !!run?.running;

  const readiness = <span className={styles.ready} data-partial={itemIssues ? '' : undefined}>
    <span className={styles.readyDot} aria-hidden="true" />
    <span>{itemIssues ? t('settings.webdav.partialReady') : t('settings.webdav.readyNow')}</span>
  </span>;

  return <section className={styles.column} aria-label={t('settings.webdav.title')}>
    {status?.configured ? <Card className={styles.hero} data-tone={tone}>
      <div className={styles.heroTop}>
        <span className={styles.glyph} data-tone={tone} aria-hidden="true"><Icon name="cloud" size={24} /><span className={styles.glyphDot} /></span>
        <div className={styles.heroCopy}>
          <div className={styles.heroTitle}><h2>{t('settings.webdav.title')}</h2><StatusBadge dot domain="sync" state={status.lastError ? 'error' : status.enabled ? 'on' : 'off'} /></div>
          <p className={styles.heroMeta}>
            <span className={styles.metaItem} title={last?.absolute}><Icon name="clock" size={14} />{last ? t('settings.webdav.lastSuccess', { time: last.text }) : t('settings.webdav.neverSynced')}</span>
            {host && <span className={styles.metaItem} title={t('settings.webdav.serverTitle')}><Icon name="globe" size={14} />{host}</span>}
          </p>
        </div>
        <Switch className={styles.autoSync} checked={status.enabled} disabled={busy} onChange={() => void toggleEnabled()} title={t('settings.webdav.autoSyncHint')}
          label={<span className={styles.switchText}><strong>{t('settings.webdav.autoSync')}</strong><small>{t('settings.webdav.autoSyncHint')}</small></span>} />
      </div>
      {status.lastError && <div className={styles.heroError}>
        <Icon name="alert" size={16} />
        <span className={styles.heroErrorText}>{t('settings.webdav.connectionFailed', { error: status.lastError })}</span>
        <span className={styles.actions}>
          <Button disabled={busy} icon={<Icon name="refresh" size={14} />} onClick={() => void syncNow()}>{t('settings.webdav.retry')}</Button>
          <Button disabled={busy} onClick={() => onEdit(true)}>{t('settings.webdav.editConnection')}</Button>
        </span>
      </div>}
      {!!status.pendingChanges && <p className={styles.heroNote}><Icon name="upload" size={14} />{t('settings.webdav.pendingUpload', { count: status.pendingChanges })}</p>}
      <div className={styles.heroFoot}>
        {readiness}
        {!status.lastError && <span className={styles.actions}>
          <Button disabled={busy} icon={<Icon name="pencil" size={14} />} onClick={() => onEdit(true)}>{t('settings.webdav.editConnection')}</Button>
          <Button variant="primary" disabled={busy} icon={<span className={styles.spin} data-active={syncing || undefined}><Icon name="refresh" size={14} /></span>} onClick={() => void syncNow()}>{syncing ? t('settings.webdav.syncing') : t('settings.webdav.syncNow')}</Button>
        </span>}
      </div>
    </Card> : <Card className={styles.hero} data-tone="idle" data-intro="">
      <div className={styles.heroTop}>
        <span className={styles.glyph} data-tone="idle" aria-hidden="true"><Icon name="cloud" size={24} /></span>
        <div className={styles.heroCopy}>
          <div className={styles.heroTitle}><h2>{t('settings.webdav.title')}</h2><StatusBadge dot domain="sync" state="not_connected" /></div>
          <p className={styles.heroLead}>{t('settings.webdav.description')}</p>
        </div>
      </div>
      <ul className={styles.features}>
        <li><span className={styles.featureIcon} aria-hidden="true"><Icon name="shield" size={16} /></span><span><strong>{t('settings.webdav.featureEncrypt')}</strong><small>{t('settings.webdav.featureEncryptDetail')}</small></span></li>
        <li><span className={styles.featureIcon} aria-hidden="true"><Icon name="refresh" size={16} /></span><span><strong>{t('settings.webdav.featureAuto')}</strong><small>{t('settings.webdav.featureAutoDetail')}</small></span></li>
        <li><span className={styles.featureIcon} aria-hidden="true"><Icon name="check" size={16} /></span><span><strong>{t('settings.webdav.featureConflict')}</strong><small>{t('settings.webdav.featureConflictDetail')}</small></span></li>
      </ul>
      <div className={styles.heroFoot}>
        {itemIssues ? readiness : <small className={styles.footHint}>{t('settings.webdav.notConnectedHint')}</small>}
        <span className={styles.actions}><Button variant="primary" icon={<Icon name="link" size={14} />} onClick={() => onEdit(true)}>{t('settings.webdav.configure')}</Button></span>
      </div>
    </Card>}

    {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
    {message && <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>}

    {itemIssues && <Card className={styles.card} data-tone="warning">
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} data-tone="warning" aria-hidden="true"><Icon name="alert" size={16} /></span>
        <div><h3><span>{t('settings.webdav.actionsTitle')}</span><Badge tone="warning">{issueCount}</Badge></h3><p>{t('settings.webdav.actionsHint')}</p></div>
      </header>
      <ul className={styles.issues}>
        {missingProjects.map((project) => <li className={styles.issue} key={project.id}>
          <span className={styles.issueIcon} aria-hidden="true"><Icon name="folder" size={16} /></span>
          <span className={styles.issueBody}><span className={styles.issueTitle}><strong>{project.name}</strong><Badge>{t('settings.webdav.tagDirectory')}</Badge></span><small>{project.path ? t('settings.webdav.missingDirectory', { path: project.path }) : t('settings.webdav.missingDirectoryUnknown')}</small></span>
          <Button disabled={busy} onClick={() => void chooseDirectory(project)}>{t('settings.webdav.chooseDirectory')}</Button>
        </li>)}
        {blockers.map((blocker) => {
          const chosen = !!selectedDirectory(blocker.detail);
          return <li className={styles.issue} key={blocker.key}>
            <span className={styles.issueIcon} aria-hidden="true"><Icon name={itemIcon(blocker.action, chosen)} size={16} /></span>
            <span className={styles.issueBody}><span className={styles.issueTitle}><strong>{blocker.label}</strong><Badge>{blockerTag(blocker.action, chosen)}</Badge></span><small>{blockerDetail(blocker.detail)}</small></span>
            <Button disabled={busy} onClick={() => void runBlocker(blocker)}>{chosen ? t('settings.webdav.writeChosenDirectory') : blocker.action === 'install' ? t('settings.webdav.installCli') : blocker.action === 'relogin' ? t('settings.webdav.relogin') : blocker.action === 'relink' ? t('settings.webdav.chooseDirectory') : t('settings.webdav.retry')}</Button>
          </li>;
        })}
        {conflicts.map((conflict) => {
          const preview = previews[conflict.key];
          return <li className={styles.issue} key={conflict.key} data-open={preview ? '' : undefined}>
            <span className={styles.issueIcon} data-tone="conflict" aria-hidden="true"><Icon name="copy" size={16} /></span>
            <span className={styles.issueBody}><span className={styles.issueTitle}><strong>{conflict.label}</strong><Badge tone="warning">{t('settings.webdav.tagConflict')}</Badge></span><small>{t('settings.webdav.conflictsHint')} {t('settings.webdav.remoteVersions', { count: conflict.remoteVersions })}</small></span>
            {!preview && <Button disabled={busy} onClick={() => void previewConflict(conflict.key)}>{t('settings.webdav.chooseConflict')}</Button>}
            {preview && <div className={styles.compare}>
              <div className={styles.version} data-side="local">
                <span className={styles.versionHead}><Icon name="monitor" size={14} />{t('settings.webdav.local')}</span>
                <pre>{preview.localSummary}</pre>
                <Button disabled={busy} onClick={() => void resolve(conflict.key, null, false)}>{t('settings.webdav.keepLocal')}</Button>
              </div>
              {preview.versions.map((version) => <div className={styles.version} data-side="remote" data-deleted={version.deleted || undefined} key={version.id}>
                <span className={styles.versionHead}><Icon name="cloud" size={14} />{t('settings.webdav.remoteVersion', { id: version.id.slice(0, 8) })}</span>
                <pre>{version.summary}</pre>
                <Button disabled={busy} onClick={() => void resolve(conflict.key, version.id, version.deleted)}>{version.deleted ? t('settings.webdav.acceptDelete') : t('settings.webdav.useRemote')}</Button>
              </div>)}
            </div>}
          </li>;
        })}
      </ul>
    </Card>}

    {status?.configured && <Card className={styles.card}>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden="true"><Icon name="records" size={16} /></span>
        <div><h3>{t('settings.webdav.activityTitle')}</h3>{receiptAt && <p title={receiptAt.absolute}>{receiptAt.text}</p>}</div>
        {activity && (hiddenTransfers > 0 || activity.transfers.length > 0) && <Button variant="ghost" size="sm" onClick={() => setReceiptOpen(true)}>{hiddenTransfers > 0 ? t('settings.webdav.moreTransfers', { count: hiddenTransfers }) : t('settings.webdav.viewReceipt')}<Icon name="chevronRight" size={14} /></Button>}
      </header>
      {activitySummary && activity ? <div className={styles.activity}>
        <div><p className={styles.headline}>{activitySummary.headline}</p><p className={styles.detail}>{activitySummary.detail}</p></div>
        {metrics(activity)}
        {conflicts.length > 0 && activitySummary.moved > 0 && <p className={styles.note}><Icon name="alert" size={14} />{t('settings.webdav.conflictsLeft', { count: conflicts.length })}</p>}
        {!!activity.transfers.length && <TransferList items={activity.transfers} limit={PREVIEW_LIMIT} />}
      </div> : <div className={styles.emptyActivity}>
        <p className={styles.headline}>{status.lastSuccess ? t('settings.webdav.noReceipt') : t('settings.webdav.noActivity')}</p>
        <p className={styles.detail}>{status.lastSuccess ? t('settings.webdav.noReceiptDetail') : t('settings.webdav.noActivityDetail')}</p>
      </div>}
    </Card>}

    <GuideDialog open={!!run?.open} title={run?.running ? t('settings.webdav.progressTitle') : t('settings.webdav.progressDoneTitle')} onClose={closeRun}>
      {run && run.running && <div className={`sync-dialog sync-activity ${styles.dialogBody}`}>
        <div className={styles.runHead}>
          <span className={styles.runGlyph} aria-hidden="true"><Icon name="cloud" size={26} /></span>
          <div className={styles.runCopy}><strong>{progressText(run)}</strong>{run.total > 0 && <small>{t('settings.webdav.progressCount', { done: Math.min(run.done, run.total), total: run.total })}</small>}</div>
        </div>
        <ol className={styles.steps} aria-label={t('settings.webdav.progressTitle')}>{PHASES.map((id, index) => {
          const current = stepIndex(run.phase);
          const state = index < current ? 'done' : index === current ? 'current' : 'wait';
          return <li key={id} data-state={state}><span className={styles.stepMark}>{state === 'done' ? <Icon name="check" size={12} /> : index + 1}</span><span>{phaseLabels[index]}</span></li>;
        })}</ol>
        <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={run.total > 0 ? run.total : undefined} aria-valuenow={run.total > 0 ? Math.min(run.done, run.total) : undefined} aria-valuetext={progressText(run)} data-indeterminate={run.total > 0 ? undefined : ''}>
          <span style={run.total > 0 ? { width: `${Math.min(100, Math.round((run.done / run.total) * 100))}%` } : undefined} />
        </div>
        {!!run.lines.length && <TransferList items={run.lines.map((line) => ({ ...line, key: line.id }))} live />}
        <p className={styles.runHint}>{t('settings.webdav.progressBackground')}</p>
      </div>}
      {run && !run.running && resultView(resultActivity, resultSummary?.headline ?? t('settings.webdav.emptyTransfer'), resultSummary?.detail ?? t('settings.webdav.emptyTransfer'), run.result?.conflicts.length ?? 0, resultSummary?.moved ?? 0, closeRun)}
    </GuideDialog>
    <GuideDialog open={receiptOpen && !run?.open} title={t('settings.webdav.progressDoneTitle')} hint={receiptAt ? receiptAt.absolute : undefined} onClose={() => setReceiptOpen(false)}>
      {activitySummary && activity && resultView(activity, activitySummary.headline, activitySummary.detail, conflicts.length, activitySummary.moved, () => setReceiptOpen(false))}
    </GuideDialog>
    <GuideDialog open={editing} title={status?.configured ? t('settings.webdav.editTitle') : t('settings.webdav.configure')} hint={t('settings.webdav.dialogHint')} onClose={() => onEdit(false)}>
      <form className={`sync-dialog ${styles.dialogBody}`} onSubmit={(event) => { event.preventDefault(); if (canSave) void configure(); }}>
        <TextField label={t('settings.webdav.endpoint')} icon="globe" type="url" value={setup.endpoint} placeholder="https://dav.example.com/cliora/" autoComplete="url" hint={t('settings.webdav.endpointHint')} autoFocus={!setup.endpoint} onChange={(event) => setSetup({ ...setup, endpoint: event.target.value })} />
        <TextField label={t('settings.webdav.username')} icon="user" value={setup.username} autoComplete="username" autoFocus={!!setup.endpoint} onChange={(event) => setSetup({ ...setup, username: event.target.value })} />
        <PassphraseField label={t('settings.webdav.password')} value={setup.authPassword} autoComplete="new-password" placeholder={t('settings.webdav.passwordPlaceholder')} meter
          hint={passwordShort ? t('settings.webdav.passwordMore', { count: Math.max(0, MIN_PASSPHRASE - setup.authPassword.length) }) : t('settings.webdav.passwordOk')}
          onChange={(value) => setSetup({ ...setup, authPassword: value, encryptionPassword: '', previousEncryptionPassword: '' })} />
        <div className={styles.callout}><Icon name="shield" size={16} /><span>{t('settings.webdav.securityNote')}</span></div>
        <div className={styles.dialogFoot}>
          <Button disabled={busy} onClick={() => onEdit(false)}>{t('common.dialog.cancel')}</Button>
          <Button type="submit" variant="primary" data-dialog-save disabled={!canSave}>{busy ? t('settings.webdav.verifying') : t('settings.webdav.save')}</Button>
        </div>
      </form>
    </GuideDialog>
  </section>;
}
