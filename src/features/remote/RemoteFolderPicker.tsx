import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { RemoteReadStatus, useRemoteReads } from '../../lib/remoteReads';
import type { RemoteDirectoryListing, RemoteProject, RemoteTarget } from '../../types/remote';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { beginDirectoryInspection, beginDirectoryReceipt, blocksDirectoryCreation, loadDirectoryReceipts, updateDirectoryReceipt, useDirectoryReceipts, type DirectoryReceipt } from './directoryReceipts';
import { normalizeRemotePath, remoteBaseName, remoteJoin, remoteParent, remoteStartPath } from './remoteLaunch';
import styles from './RemoteFolderPicker.module.css';

const hiddenKey = 'cliora:remote-picker-hidden';

function errorText(error: unknown) {
  const value = error as { message?: string; action?: string };
  return [value?.message || String(error), value?.action].filter(Boolean).join(' · ');
}
const missing = (error: unknown) => (error as { remote?: { reason?: string } })?.remote?.reason === 'directory_missing';

/**
 * The remote counterpart of the system folder dialog. It only answers "which folder": the host is
 * the current run location, and the caller decides what to launch there.
 */
export function RemoteFolderPicker({ open, targetId, initialPath, title, onClose, onPick }: {
  open: boolean;
  targetId: string;
  initialPath?: string;
  title?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<RemoteTarget[] | null>(null);
  const [recent, setRecent] = useState<RemoteProject[]>([]);
  const target = targets?.find((item) => item.id === targetId) ?? null;
  const [cwd, setCwd] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(() => { try { return localStorage.getItem(hiddenKey) === 'true'; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [listing, setListing] = useState<{ key: string; value: RemoteDirectoryListing } | null>(null);
  const [failure, setFailure] = useState<{ key: string; text: string; missing: boolean } | null>(null);
  const [busy, setBusy] = useState<'list' | 'mkdir' | ''>('');
  const [message, setMessage] = useState('');
  const receipts = useDirectoryReceipts();
  const [receiptsReady, setReceiptsReady] = useState(false);
  const inspections = useRef(new Set<AbortController>());
  const inspectingIds = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);

  const reads = useRemoteReads(targetId, cwd, open && !!cwd);
  const context = JSON.stringify([reads.identity, target?.updatedAt, cwd, open]);
  const current = useRef(context);
  current.current = context;
  const operation = useRef<{ controller: AbortController; serial: number } | null>(null);
  const serial = useRef(0);

  // Each opening starts from the requested folder, after this host's record is known.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { openedFor.current = null; return; }
    let live = true;
    const loadTargets = () => { void native.listRemoteTargets().then((items) => { if (live) setTargets(Array.isArray(items) ? items : []); }).catch(() => { if (live) setTargets([]); }); };
    loadTargets();
    void native.listRemoteProjects(targetId).then((items) => { if (live && Array.isArray(items)) setRecent(items.filter((item) => item.targetId === targetId).sort((a, b) => b.updatedAt - a.updatedAt)); }).catch(() => {});
    // A host edited while browsing gets a new revision; its old listing must not stay on screen.
    window.addEventListener('cliora:remote-targets-changed', loadTargets);
    return () => { live = false; window.removeEventListener('cliora:remote-targets-changed', loadTargets); };
  }, [open, targetId]);
  useEffect(() => {
    if (!open || !target) return;
    const token = `${targetId}|${initialPath ?? ''}`;
    if (openedFor.current === token) return;
    openedFor.current = token;
    setCwd(normalizeRemotePath(initialPath ?? '') || remoteStartPath(target));
    setSelected(null); setFilter(''); setEditing(false); setCreating(false); setMessage('');
  }, [open, target, targetId, initialPath]);
  useEffect(() => () => { for (const controller of inspections.current) controller.abort(); inspections.current.clear(); }, [open]);

  useEffect(() => {
    setBusy(''); setMessage('');
    if (open && target && cwd) void loadDirectories();
    return () => { operation.current?.controller.abort(); operation.current = null; };
  }, [context]);
  // A new folder clears the selection and filter; a typed new-folder name stays as a draft.
  useEffect(() => { setSelected(null); setFilter(''); }, [cwd, targetId]);
  const folderNameRef = useRef(folderName);
  folderNameRef.current = folderName;

  // A failed refresh keeps the last good listing of this folder on screen; a new host identity clears it.
  const loaded = listing?.key === context ? listing.value : null;
  const failed = failure?.key === context ? failure : null;
  const shownListing = loaded;
  const folders = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (shownListing?.items ?? [])
      .map((path) => ({ path: normalizeRemotePath(path), name: remoteBaseName(path) }))
      .filter((item) => item.name && (showHidden || !item.name.startsWith('.')) && (!needle || item.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [shownListing, filter, showHidden]);
  const hiddenCount = useMemo(() => (shownListing?.items ?? []).filter((path) => remoteBaseName(path).startsWith('.')).length, [shownListing]);
  const chosen = selected ?? cwd;
  const newFolderPath = folderName.trim() ? remoteJoin(cwd, folderName.trim()) : '';
  const folderNameInvalid = !!folderName.trim() && (/[/\\]/.test(folderName) || ['.', '..'].includes(folderName.trim()));
  const creationBlocked = !!newFolderPath && receipts.some((item) => blocksDirectoryCreation(item, target, newFolderPath));
  const segments = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean);
    return [{ label: '/', path: '/' }, ...parts.map((part, index) => ({ label: part, path: '/' + parts.slice(0, index + 1).join('/') }))];
  }, [cwd]);

  function begin() {
    operation.current?.controller.abort();
    const request = { controller: new AbortController(), serial: ++serial.current };
    operation.current = request;
    const key = context;
    return { ...request, key, isCurrent: () => current.current === key && operation.current?.serial === request.serial };
  }

  async function loadDirectories(fresh = false) {
    if (!target || !cwd) return;
    const request = begin();
    setBusy('list'); setMessage('');
    try {
      await loadDirectoryReceipts(fresh).then(() => setReceiptsReady(true), (error) => { if (request.isCurrent()) setMessage(errorText(error)); });
      const value = await reads.native.listRemoteDirectories(targetId, cwd, { fresh, signal: request.controller.signal });
      if (!request.isCurrent()) return;
      setListing({ key: request.key, value });
      setFailure(null);
    } catch (error) {
      if (request.isCurrent()) setFailure({ key: request.key, text: errorText(error), missing: missing(error) });
    } finally { if (request.isCurrent()) { setBusy(''); operation.current = null; } }
  }

  function navigate(path: string) {
    const next = normalizeRemotePath(path);
    if (!next || next.startsWith('~')) return;
    setEditing(false);
    if (next === cwd) { void loadDirectories(true); return; }
    setCwd(next);
    // Keep keyboard browsing on the list, unless the user has already moved into a text field.
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
      listRef.current?.focus({ preventScroll: true });
    });
  }

  async function createFolder() {
    const next = newFolderPath;
    const submitted = folderName.trim();
    if (!target || !next || folderNameInvalid || creationBlocked || !receiptsReady || busy) return;
    const request = begin();
    let receipt: DirectoryReceipt | null = null;
    let dispatched = false;
    let created = false;
    setBusy('mkdir'); setMessage('');
    try {
      receipt = await beginDirectoryReceipt(target, next);
      if (!receipt) { if (request.isCurrent()) setMessage(t('home.remote.receiptLimit')); return; }
      request.controller.signal.throwIfAborted();
      dispatched = true;
      await native.createRemoteDirectory(receipt.target.id, next, { signal: request.controller.signal, targetRevision: receipt.target.updatedAt }, receipt.id);
      created = true;
      await updateDirectoryReceipt(receipt.id, { outcome: 'created' });
      if (!request.isCurrent() || request.controller.signal.aborted) return;
      // A name typed after submitting is a new draft; keep it.
      const untouched = folderNameRef.current.trim() === submitted;
      if (untouched) { setCreating(false); setFolderName(''); }
      const value = await reads.native.listRemoteDirectories(targetId, cwd, { fresh: true, signal: request.controller.signal });
      if (request.isCurrent()) { setListing({ key: request.key, value }); setFailure(null); if (untouched) setSelected(next); }
    } catch (error) {
      if (!created && receipt) {
        const remoteOutcome = (error as { remote?: { outcome?: string } })?.remote?.outcome;
        await updateDirectoryReceipt(receipt.id, { outcome: dispatched && remoteOutcome !== 'failed' ? 'unknown' : 'failed', detail: errorText(error) });
      } else if (request.isCurrent()) setMessage(errorText(error));
    } finally { if (request.isCurrent()) { setBusy(''); operation.current = null; } }
  }

  async function inspectReceipt(receipt: DirectoryReceipt) {
    if (receipt.outcome === 'pending' || receipt.inspection?.state === 'checking' || inspectingIds.current.has(receipt.id)) return;
    inspectingIds.current.add(receipt.id);
    const isCurrent = beginDirectoryInspection(receipt.id);
    const controller = new AbortController();
    inspections.current.add(controller);
    try {
      if (!await updateDirectoryReceipt(receipt.id, { inspection: { state: 'checking', detail: '' } }, isCurrent)) return;
      // Check the persisted host identity before using the original revision for a remote read.
      const original = (await native.listRemoteTargets()).find((item) => item.id === receipt.target.id);
      controller.signal.throwIfAborted();
      if (!original || original.updatedAt !== receipt.target.updatedAt || original.host !== receipt.target.host || original.port !== receipt.target.port || original.user !== receipt.target.user) {
        await updateDirectoryReceipt(receipt.id, { inspection: { state: 'failed', detail: t('home.remote.receiptIdentityChanged') } }, isCurrent);
        return;
      }
      await native.listRemoteDirectories(receipt.target.id, receipt.path, { fresh: true, targetRevision: receipt.target.updatedAt, signal: controller.signal });
      await updateDirectoryReceipt(receipt.id, { inspection: { state: 'exists', detail: t('home.remote.receiptExists') } }, isCurrent);
    } catch (error) {
      await updateDirectoryReceipt(receipt.id, { inspection: { state: missing(error) ? 'missing' : 'failed', detail: missing(error) ? t('home.remote.receiptMissing') : errorText(error) } }, isCurrent);
    } finally { inspections.current.delete(controller); inspectingIds.current.delete(receipt.id); }
  }

  function close() {
    operation.current?.controller.abort();
    operation.current = null;
    onClose();
  }

  function confirm() {
    if (!chosen || (selected === null && failed?.missing)) return;
    operation.current?.controller.abort();
    onPick(chosen);
  }

  function toggleHidden() {
    setShowHidden((value) => {
      try { localStorage.setItem(hiddenKey, String(!value)); } catch { /* optional preference */ }
      return !value;
    });
  }

  function startEdit() {
    setPathDraft(cwd);
    setEditing(true);
  }

  function onListKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLElement && event.target.matches('[role="option"]'))) return;
    const index = folders.findIndex((item) => item.path === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!folders.length) return;
      const next = event.key === 'ArrowDown' ? Math.min(folders.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
      setSelected(folders[next].path);
      listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      navigate(selected);
    } else if (event.key === 'Backspace' && cwd !== '/') {
      event.preventDefault();
      navigate(remoteParent(cwd));
    }
  }

  function onDialogKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); startEdit(); }
    else if (event.altKey && event.key === 'ArrowUp' && cwd !== '/') { event.preventDefault(); navigate(remoteParent(cwd)); }
  }

  const loading = busy === 'list' && !shownListing;
  const hostLine = target ? `${target.user}@${target.host}${target.port !== 22 ? `:${target.port}` : ''}` : '';
  const places = target ? [
    { path: remoteStartPath(target), label: t('home.remote.picker.home'), icon: 'home' as const },
    { path: '/', label: t('home.remote.picker.root'), icon: 'server' as const },
  ].filter((item, index, list) => list.findIndex((other) => other.path === item.path) === index) : [];

  return <GuideDialog open={open} title={title ?? t('home.remote.picker.title')} hint={target ? t('home.remote.picker.hint', { host: target.name }) : undefined} wide onClose={close}>
    <div className={styles.picker} onKeyDown={onDialogKey}>
      {targets && !target ? <div className={styles.unavailable}><Icon name="globe" size={20} /><span>{t('home.remote.noTargets')}</span></div> : <>
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolButton} aria-label={t('home.remote.picker.up')} title={`${t('home.remote.picker.up')} (Alt+↑)`} disabled={!cwd || cwd === '/'} onClick={() => navigate(remoteParent(cwd))}><Icon name="arrowUp" size={15} /></button>
          {editing
            ? <form className={styles.pathForm} onSubmit={(event) => { event.preventDefault(); navigate(pathDraft); }}>
              <input ref={pathInput} autoFocus onFocus={(event) => event.currentTarget.select()} className={styles.pathInput} aria-label={t('home.remote.path')} value={pathDraft} spellCheck={false} autoComplete="off" placeholder={t('home.remote.pathPlaceholder')} onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); } }} onBlur={() => setEditing(false)} />
              <kbd>Enter</kbd>
            </form>
            : <nav className={styles.crumbs} aria-label={t('home.remote.picker.location')} onClick={(event) => { if (event.target === event.currentTarget) startEdit(); }}>
              {segments.map((segment, index) => <span key={segment.path} className={styles.crumb}>
                {index > 1 && <Icon name="chevronRight" size={12} />}
                <button type="button" aria-current={index === segments.length - 1 ? 'location' : undefined} onClick={() => navigate(segment.path)}>{index === 0 ? <Icon name="server" size={13} /> : segment.label}</button>
              </span>)}
              <button type="button" className={styles.editPath} aria-label={t('home.remote.picker.editPath')} title={`${t('home.remote.picker.editPath')} (Ctrl+L)`} onClick={startEdit}><Icon name="pencil" size={13} /></button>
            </nav>}
          <button type="button" className={styles.toolButton} aria-label={t('home.remote.refreshDirectories')} title={t('home.remote.refreshDirectories')} disabled={!cwd || busy !== ''} onClick={() => void loadDirectories(true)}><Icon name="refresh" size={15} /></button>
          <Button size="sm" className={styles.newFolder} icon={<Icon name="plus" size={14} />} disabled={!cwd || busy !== '' || !receiptsReady} onClick={() => { setCreating(true); setFolderName(''); }}>{t('home.remote.picker.newFolder')}</Button>
        </div>

        <div className={styles.body}>
          <aside className={styles.places} aria-label={t('home.remote.picker.places')}>
            {target && <div className={styles.host}><span className={styles.hostGlyph}><Icon name="globe" size={15} /></span><span className={styles.hostCopy}><strong title={target.name}>{target.name}</strong><small title={hostLine}>{hostLine}</small></span></div>}
            <div className={styles.placeGroup}>
              {places.map((item) => <button key={item.path} type="button" className={styles.place} aria-current={cwd === item.path ? 'location' : undefined} title={item.path} onClick={() => navigate(item.path)}><Icon name={item.icon} size={14} /><span>{item.label}</span></button>)}
            </div>
            {recent.length > 0 && <div className={styles.placeGroup}>
              <span className={styles.groupLabel}>{t('home.remote.picker.recent')}</span>
              {recent.slice(0, 8).map((item) => <button key={item.id} type="button" className={styles.place} aria-current={cwd === normalizeRemotePath(item.path) ? 'location' : undefined} title={item.path} onClick={() => navigate(item.path)}><Icon name="clock" size={14} /><span className={styles.placeCopy}><span>{item.name}</span><small>{item.path}</small></span></button>)}
            </div>}
          </aside>

          <section className={styles.browser} aria-label={t('home.remote.picker.folders')}>
            <div className={styles.browserHead}>
              <label className={styles.filter}><Icon name="search" size={13} /><input aria-label={t('home.remote.picker.filter')} placeholder={t('home.remote.picker.filter')} value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); listRef.current?.focus(); if (folders[0]) setSelected(folders[0].path); } }} /></label>
              <button type="button" className={styles.hiddenToggle} aria-pressed={showHidden} title={t('home.remote.picker.showHidden')} onClick={toggleHidden}><Icon name={showHidden ? 'eye' : 'eyeOff'} size={13} /><span>{t('home.remote.picker.hiddenCount', { count: hiddenCount })}</span></button>
            </div>
            <RemoteReadStatus state={reads} />
            {message && <p className={styles.message} role="status">{message}</p>}
            {failed && <div className={styles.failure} role="status"><Icon name="alert" size={15} /><span>{failed.missing ? t('home.remote.picker.missing', { path: cwd }) : failed.text}</span><Button size="sm" variant="ghost" onClick={() => void loadDirectories(true)}>{t('home.remote.picker.retry')}</Button></div>}
            <div ref={listRef} className={styles.list} role="listbox" tabIndex={0} aria-label={t('home.remote.savedDirectory')} aria-busy={busy === 'list' || undefined} aria-activedescendant={undefined} onKeyDown={onListKey}>
              {creating && <form className={styles.createRow} onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
                <Icon name="folder" size={16} />
                <input autoFocus aria-label={t('home.remote.picker.folderName')} placeholder={t('home.remote.picker.folderName')} value={folderName} spellCheck={false} autoComplete="off" aria-invalid={folderNameInvalid || undefined} onChange={(event) => { setFolderName(event.target.value); setMessage(''); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCreating(false); } }} />
                <Button size="sm" variant="primary" type="submit" disabled={!newFolderPath || folderNameInvalid || creationBlocked || !receiptsReady || busy !== ''} loading={busy === 'mkdir'}>{busy === 'mkdir' ? t('home.remote.creatingDirectory') : t('home.remote.createDirectory')}</Button>
                <button type="button" className={styles.toolButton} aria-label={t('home.remote.picker.cancelCreate')} disabled={busy === 'mkdir'} onClick={() => setCreating(false)}><Icon name="close" size={14} /></button>
                {(folderNameInvalid || creationBlocked) && <small className={styles.createHint}>{folderNameInvalid ? t('home.remote.picker.invalidName') : t('home.remote.picker.blocked')}</small>}
              </form>}
              {loading && Array.from({ length: 6 }, (_, index) => <div key={index} className={styles.skeleton} aria-hidden="true"><span /><span style={{ width: `${38 + (index * 17) % 40}%` }} /></div>)}
              {folders.map((item, index) => <div key={item.path} id={undefined} role="option" data-index={index} aria-selected={item.path === selected} className={styles.row} title={item.path} onClick={() => setSelected(item.path === selected ? null : item.path)} onDoubleClick={() => navigate(item.path)}>
                <span className={styles.rowGlyph} data-hidden={item.name.startsWith('.') || undefined}><Icon name="folder" size={16} /></span>
                <span className={styles.rowName}>{item.name}</span>
                <button type="button" tabIndex={-1} className={styles.rowOpen} aria-label={t('home.remote.picker.open', { name: item.name })} onClick={(event) => { event.stopPropagation(); navigate(item.path); }}><Icon name="chevronRight" size={14} /></button>
              </div>)}
              {!loading && shownListing && !folders.length && !creating && <div className={styles.empty}><Icon name="folder" size={22} /><strong>{filter.trim() ? t('home.remote.picker.noMatch', { query: filter.trim() }) : t('home.remote.noDirectories')}</strong>{!filter.trim() && hiddenCount > 0 && !showHidden && <button type="button" onClick={toggleHidden}>{t('home.remote.picker.revealHidden', { count: hiddenCount })}</button>}</div>}
            </div>
            {busy !== '' && <div className={styles.progress} aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><span>{busy === 'mkdir' ? t('home.remote.creatingDirectory') : t('home.remote.picker.reading')}</span><Button size="sm" variant="ghost" onClick={() => operation.current?.controller.abort()}>{t('home.remote.cancelOperation')}</Button></div>}
            {loaded?.truncated && <small className={styles.note}>{t('home.remote.directoryTruncated')}</small>}
          </section>
        </div>

        {receipts.length > 0 && <section className={styles.receipts} aria-label={t('home.remote.receiptTitle')}>
          <span className={styles.groupLabel}>{t('home.remote.receiptTitle')}</span>
          {receipts.map((receipt) => <article key={receipt.id} className={styles.receipt} data-outcome={receipt.outcome}>
            <span className={styles.receiptDot} aria-hidden="true" />
            <div className={styles.receiptCopy}>
              <code>{receipt.path}</code>
              <small>{receipt.target.name} · {receipt.target.user}@{receipt.target.host}:{receipt.target.port}</small>
              <span>{t(`home.remote.receiptOutcome.${receipt.outcome}`)}{receipt.detail && ` · ${receipt.detail}`}</span>
              {receipt.inspection && <span data-inspection={receipt.inspection.state}>{receipt.inspection.state === 'checking' ? t('home.remote.receiptChecking') : receipt.inspection.detail}</span>}
            </div>
            <Button size="sm" variant="ghost" disabled={receipt.outcome === 'pending' || receipt.inspection?.state === 'checking'} onClick={() => void inspectReceipt(receipt)}>{t('home.remote.receiptInspect')}</Button>
          </article>)}
        </section>}

        <footer className={styles.footer}>
          <div className={styles.selection}>
            <span className={styles.selectionGlyph}><Icon name="folder" size={15} /></span>
            <span className={styles.selectionCopy}><small>{selected ? t('home.remote.picker.selectedFolder') : t('home.remote.picker.currentFolder')}</small><code title={chosen}>{chosen || '—'}</code></span>
          </div>
          <Button onClick={close}>{t('common.dialog.cancel')}</Button>
          <Button variant="primary" data-dialog-save icon={<Icon name="check" size={14} />} disabled={!chosen || (selected === null && !!failed?.missing)} onClick={confirm}>{t('home.remote.picker.choose')}</Button>
        </footer>
      </>}
    </div>
  </GuideDialog>;
}
