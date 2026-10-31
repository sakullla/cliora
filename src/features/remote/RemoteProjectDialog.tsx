import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { RemoteReadStatus, useRemoteReads } from '../../lib/remoteReads';
import type { AdapterDescriptor } from '../../types/native';
import type { RemoteDirectoryListing, RemoteProject, RemoteTarget } from '../../types/remote';
import { GuideDialog } from '../../components/GuideDialog';
import { toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { beginDirectoryReceipt, blocksDirectoryCreation, updateDirectoryReceipt, useDirectoryReceipts, type DirectoryReceipt } from './directoryReceipts';
import styles from './RemoteProjectDialog.module.css';

function errorText(error: unknown) {
  const value = error as { message?: string; action?: string };
  return [value?.message || String(error), value?.action].filter(Boolean).join(' · ');
}

export function RemoteProjectDialog({
  open,
  targets,
  projects,
  tools,
  initialTargetId,
  initialPath,
  onClose,
  onSaved,
}: {
  open: boolean;
  targets: RemoteTarget[];
  projects: RemoteProject[];
  tools: AdapterDescriptor[];
  initialTargetId?: string;
  initialPath?: string;
  onClose: () => void;
  onSaved: (project: RemoteProject) => void;
}) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState(initialTargetId ?? targets[0]?.id ?? '');
  const [name, setName] = useState('');
  const [path, setPath] = useState(initialPath ?? '');
  const [parent, setParent] = useState('/');
  const [listing, setListing] = useState<{ key: string; value: RemoteDirectoryListing } | null>(null);
  const [toolId, setToolId] = useState('');
  const [busy, setBusy] = useState<'list' | 'mkdir' | 'save' | ''>('');
  const [message, setMessage] = useState('');
  const receipts = useDirectoryReceipts();
  const inspections = useRef(new Set<AbortController>());
  useEffect(() => () => { for (const controller of inspections.current) controller.abort(); inspections.current.clear(); }, [open]);

  const reads = useRemoteReads(targetId, parent.trim(), open);
  const context = JSON.stringify([reads.identity, targets.find(item => item.id === targetId)?.updatedAt, parent.trim(), open]);
  const current = useRef(context);
  current.current = context;
  const operation = useRef<{ controller: AbortController; serial: number } | null>(null);
  const serial = useRef(0);
  const directories = listing?.key === context ? listing.value.items : [];
  const truncated = listing?.key === context && listing.value.truncated;

  const target = targets.find((item) => item.id === targetId) ?? null;
  const creationBlocked = receipts.some(item => blocksDirectoryCreation(item, target, path.trim()));
  const targetProjects = useMemo(() => projects.filter((item) => item.targetId === targetId), [projects, targetId]);
  const toolOptionsList = useMemo(() => toolOptions(tools), [tools]);
  // Host lists are rebuilt on every workbench render. Re-applying that array
  // used to put the default path back while the user was still typing.
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      openedFor.current = null;
      return;
    }
    const token = `${initialTargetId ?? ''}|${initialPath ?? ''}`;
    const nextTarget = targets.find((item) => item.id === (initialTargetId || targetId)) ?? targets[0];
    if (openedFor.current === token) {
      if (!targetId && nextTarget) {
        setTargetId(nextTarget.id);
        setPath(initialPath || nextTarget.defaultPath || '');
        setParent(nextTarget.defaultPath || '/');
      }
      return;
    }
    openedFor.current = token;
    setTargetId(nextTarget?.id ?? '');
    setName('');
    setPath(initialPath || nextTarget?.defaultPath || '');
    setParent(nextTarget?.defaultPath || '/');
    setToolId('');
    setMessage('');
  }, [open, initialPath, initialTargetId, targets, targetId]);

  useEffect(() => {
    setMessage('');
    setBusy('');
    if (open && targetId && parent.trim()) void loadDirectories();
    return () => { operation.current?.controller.abort(); operation.current = null; };
  }, [context]);

  function chooseTarget(value: string) {
    const next = targets.find((item) => item.id === value);
    operation.current?.controller.abort();
    setTargetId(value);
    setPath(next?.defaultPath ?? '');
    setParent(next?.defaultPath ?? '/');
    setName('');
    setMessage('');
  }

  function chooseExisting(value: string) {
    if (!value) return;
    setPath(value);
    setParent(value);
    if (!name.trim()) setName(value.split('/').filter(Boolean).pop() ?? '');
  }

  function begin() {
    operation.current?.controller.abort();
    const request = { controller: new AbortController(), serial: ++serial.current };
    operation.current = request;
    const key = context;
    return { ...request, isCurrent: () => current.current === key && operation.current?.serial === request.serial };
  }

  async function loadDirectories(fresh = false) {
    if (!targetId || !parent.trim()) return;
    const request = begin();
    setBusy('list'); setMessage('');
    try {
      const value = await reads.native.listRemoteDirectories(targetId, parent.trim(), { fresh, signal: request.controller.signal });
      if (request.isCurrent()) setListing({ key: context, value });
    } catch (error) { if (request.isCurrent()) setMessage(errorText(error)); }
    finally { if (request.isCurrent()) { setBusy(''); operation.current = null; } }
  }

  async function createDirectory() {
    const next = path.trim();
    if (!target || !next || creationBlocked) return;
    const receipt = beginDirectoryReceipt(target, next);
    if (!receipt) { setMessage(t('home.remote.receiptLimit')); return; }
    const request = begin();
    let created = false;
    setBusy('mkdir'); setMessage('');
    try {
      await native.createRemoteDirectory(targetId, next, { signal: request.controller.signal, targetRevision: receipt.target.updatedAt });
      created = true;
      updateDirectoryReceipt(receipt.id, { outcome: 'created' });
      if (!request.isCurrent()) return;
      if (request.controller.signal.aborted) return;
      const value = await reads.native.listRemoteDirectories(targetId, parent.trim(), { fresh: true, signal: request.controller.signal });
      if (request.isCurrent()) {
        setListing({ key: context, value });
      }
    } catch (error) {
      if (!created) {
        const outcome = (error as { remote?: { outcome?: string } })?.remote?.outcome === 'unknown' ? 'unknown' : 'failed';
        updateDirectoryReceipt(receipt.id, { outcome, detail: errorText(error) });
      } else if (request.isCurrent()) setMessage(errorText(error));
    }
    finally { if (request.isCurrent()) { setBusy(''); operation.current = null; } }
  }

  async function inspectReceipt(receipt: DirectoryReceipt) {
    if (receipt.outcome === 'pending' || receipt.inspection?.state === 'checking') return;
    const controller = new AbortController();
    inspections.current.add(controller);
    updateDirectoryReceipt(receipt.id, { inspection: { state: 'checking', detail: '' } });
    try {
      // The consumer's host props may lag a configuration event. Check local
      // persisted identity before using the original revision for a remote read.
      const original = (await native.listRemoteTargets()).find(item => item.id === receipt.target.id);
      controller.signal.throwIfAborted();
      if (!original || original.updatedAt !== receipt.target.updatedAt) {
        updateDirectoryReceipt(receipt.id, { inspection: { state: 'failed', detail: t('home.remote.receiptIdentityChanged') } });
        return;
      }
      await native.listRemoteDirectories(receipt.target.id, receipt.path, { fresh: true, targetRevision: receipt.target.updatedAt, signal: controller.signal });
      updateDirectoryReceipt(receipt.id, { inspection: { state: 'exists', detail: t('home.remote.receiptExists') } });
    } catch (error) {
      const missing = (error as { remote?: { reason?: string } })?.remote?.reason === 'directory_missing';
      updateDirectoryReceipt(receipt.id, { inspection: { state: missing ? 'missing' : 'failed', detail: missing ? t('home.remote.receiptMissing') : errorText(error) } });
    } finally { inspections.current.delete(controller); }
  }

  function close() {
    if (busy === 'save') return;
    operation.current?.controller.abort();
    operation.current = null;
    onClose();
  }

  async function save() {
    const nextPath = path.trim();
    if (!targetId || !nextPath) return;
    if (busy) return;
    const key = context;
    setBusy('save'); setMessage('');
    const existing = projects.find((item) => item.targetId === targetId && item.path === nextPath);
    try {
      const saved = await native.saveRemoteProject({
        id: existing?.id ?? '',
        targetId,
        name: name.trim() || nextPath.split('/').filter(Boolean).pop() || t('home.remote.defaultName'),
        path: nextPath,
        preferredTool: toolId || existing?.preferredTool || null,
        updatedAt: 0,
      });
      if (current.current !== key) return;
      onSaved(saved);
      onClose();
    } catch (error) { if (current.current === key) setMessage(errorText(error)); }
    finally { if (current.current === key) setBusy(''); }
  }

  return <GuideDialog open={open} title={t('home.remote.dialogTitle')} hint={t('home.remote.dialogHint')} wide closeDisabled={busy === 'save'} onClose={close}>
    <div className={styles.dialog}>
      <RemoteReadStatus state={reads} />
      {message && <p className={styles.message} role="status">{message}</p>}
      {receipts.length > 0 && <section className={styles.receipts} aria-label={t('home.remote.receiptTitle')}>
        <strong>{t('home.remote.receiptTitle')}</strong>
        {receipts.map(receipt => <article key={receipt.id} className={styles.receipt} data-outcome={receipt.outcome}>
          <strong>{receipt.target.name} · {receipt.target.user}@{receipt.target.host}:{receipt.target.port}</strong>
          <code>{receipt.path}</code>
          <p role="status">{t(`home.remote.receiptOutcome.${receipt.outcome}`)}{receipt.detail && ` · ${receipt.detail}`}</p>
          {receipt.inspection && <p role="status">{receipt.inspection.state === 'checking' ? t('home.remote.receiptChecking') : receipt.inspection.detail}</p>}
          <Button size="sm" disabled={receipt.outcome === 'pending' || receipt.inspection?.state === 'checking'} onClick={() => void inspectReceipt(receipt)}>{t('home.remote.receiptInspect')}</Button>
        </article>)}
      </section>}
      {!targets.length ? <div className={styles.empty}><Icon name="globe" size={20} /><span>{t('home.remote.noTargets')}</span></div> : <>
        <label className={styles.field}><span>{t('home.remote.target')}</span><select disabled={busy === 'save'} value={targetId} onChange={(event) => chooseTarget(event.target.value)}><option value="">{t('home.remote.pickTarget')}</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.user}@{item.host}</option>)}</select></label>
        {target && <div className={styles.targetMeta}><Icon name="globe" size={14} /><span>{target.user}@{target.host}:{target.port}</span><span>{target.defaultPath || '/'}</span></div>}
        <div className={styles.directoryCard}>
          <div className={styles.cardHeader}><div><strong>{t('home.remote.directoryTitle')}</strong><small>{t('home.remote.directoryHint')}</small></div><Button size="sm" variant="ghost" icon={<Icon name="refresh" size={14} />} disabled={!targetId || busy !== ''} onClick={() => void loadDirectories(true)}>{t('home.remote.refreshDirectories')}</Button></div>
          <label className={styles.field}><span>{t('home.remote.parentDirectory')}</span><input disabled={busy === 'save'} value={parent} spellCheck={false} onChange={(event) => { setParent(event.target.value); }} /></label>
          {busy && busy !== 'save' && <Button size="sm" onClick={() => operation.current?.controller.abort()}>{t('home.remote.cancelOperation')}</Button>}
          {truncated && <small className={styles.fieldHint}>{t('home.remote.directoryTruncated')}</small>}
          <div className={styles.directoryRow}>
            <label className={styles.field}><span>{t('home.remote.savedDirectory')}</span><select value="" onChange={(event) => chooseExisting(event.target.value)} disabled={!targetId || busy !== ''}><option value="">{directories.length || targetProjects.length ? t('home.remote.chooseDirectory') : listing?.key === context ? t('home.remote.noDirectories') : t('home.remote.directoryNotLoaded')}</option>{directories.map((item) => <option key={item} value={item}>{item}</option>)}{targetProjects.map((item) => <option key={`saved:${item.id}`} value={item.path}>{item.path} · {t('home.remote.saved')}</option>)}</select></label>
            <label className={styles.field}><span>{t('home.remote.path')}</span><input disabled={busy === 'save'} value={path} spellCheck={false} autoComplete="off" onChange={(event) => { setPath(event.target.value); setMessage(''); }} placeholder={t('home.remote.pathPlaceholder')} /></label>
          </div>
          <small className={styles.fieldHint}>{t('home.remote.manualPathHint')}</small>
          <Button size="sm" className={styles.createDirectory} disabled={!targetId || !path.trim() || busy !== '' || creationBlocked} onClick={() => void createDirectory()}>{busy === 'mkdir' ? t('home.remote.creatingDirectory') : t('home.remote.createDirectory')}</Button>
        </div>
        <div className={styles.grid}>
          <label className={styles.field}><span>{t('home.remote.name')}</span><input disabled={busy === 'save'} value={name} onChange={(event) => { setName(event.target.value); }} placeholder={t('home.remote.namePlaceholder')} /></label>
          <label className={styles.field}><span>{t('home.remote.tool')}</span><select disabled={busy === 'save'} value={toolId} onChange={(event) => setToolId(event.target.value)}><option value="">{t('home.remote.chooseLater')}</option>{toolOptionsList.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        </div>
        <div className={styles.actions}><Button disabled={busy === 'save'} onClick={close}>{t('common.dialog.cancel')}</Button><Button variant="primary" loading={busy === 'save'} disabled={!targetId || !path.trim() || busy !== ''} onClick={() => void save()}>{busy === 'save' ? t('home.remote.saving') : t('home.remote.save')}</Button></div>
      </>}
    </div>
  </GuideDialog>;
}
