import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBanner } from '../../components/StatusBanner';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import type { MemoryAggregate, MemoryManagement, MemoryOperation, MemoryStoreEntry, MemoryTarget } from '../../types/native';
import styles from './MemoryWorkspace.module.css';

type Failure = { message: string; retry: (() => Promise<void>) | null };
type OpenEntry = { target: MemoryTarget; id: string; text: string; fingerprint: string };

const writeOperations: MemoryOperation[] = ['create', 'edit', 'delete', 'master_switch', 'item_enable'];

function isExternalChange(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return message.includes('外部修改');
}

/** First non-empty line of the entry body, flattened and clipped for the list row. */
function summarize(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** One store behind the aggregate: the first entry of each store carries its switch state. */
function storeKey(target: MemoryTarget): string {
  return JSON.stringify([target.scope, target.projectPath ?? null, target.contextId ?? null, target.storeDirectory ?? null]);
}

export function MemoryWorkspace({ toolId, memory, active, suggestedProjectPath }: { toolId: string; memory: MemoryManagement; active: boolean; suggestedProjectPath: string | null }) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const [aggregate, setAggregate] = useState<MemoryAggregate | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [listFailure, setListFailure] = useState<Failure | null>(null);
  const [opened, setOpened] = useState<OpenEntry | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState('');
  const [newText, setNewText] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  const can = (operation: MemoryOperation) => memory.operations.includes(operation);
  const limitation = (memory.limitation || '').trim();
  const showWrites = writeOperations.some(operation => can(operation));

  const createTarget: MemoryTarget | null = memory.scope.global
    ? { toolId, scope: 'global', projectPath: null }
    : memory.scope.project && suggestedProjectPath
      ? { toolId, scope: 'project', projectPath: suggestedProjectPath }
      : null;
  const createLocation = createTarget
    ? createTarget.scope === 'global'
      ? t('common.memory.targetGlobal')
      : t('common.memory.targetProject', { name: createTarget.projectPath ?? '' })
    : '';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const previewEpoch = useRef(0);
  // Body summaries are read per entry over the existing read IPC. Failures are
  // silent: a store whose preview cannot be read still lists its entries.
  const loadPreviews = useCallback(async (value: MemoryAggregate) => {
    const epoch = ++previewEpoch.current;
    const results = await Promise.allSettled(value.entries.map(async entry => {
      const document = await native.readMemory(entry.target, entry.id);
      return [`${storeKey(entry.target)}:${entry.id}`, summarize(document.text)] as const;
    }));
    if (!mounted.current || epoch !== previewEpoch.current) return;
    setPreviews(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])));
  }, []);

  const reload = useCallback(async () => {
    try {
      const value = await native.listAllMemories(toolId);
      if (!mounted.current) return;
      setAggregate(value);
      setPreviews({});
      setListFailure(null);
      void loadPreviews(value);
    } catch (error) {
      if (!mounted.current) return;
      setAggregate(null);
      setPreviews({});
      setListFailure({ message: formatFailure(error, t('common.memory.listFailed'), t('common.memory.retryNext')), retry: () => reload() });
    }
  }, [toolId, t, loadPreviews]);

  useEffect(() => {
    setOpened(null);
    setPreviews({});
    setDraft('');
    setCreating(false);
    setNewId('');
    setNewText('');
    setFailure(null);
    setBusy(false);
  }, [toolId]);
  useEffect(() => { if (active) void reload(); }, [active, reload]);

  const report = useCallback((error: unknown, summary: string, retry: (() => Promise<void>) | null) => {
    setFailure({ message: formatFailure(error, summary, t('common.memory.retryNext')), retry });
  }, [t]);

  async function openEntry(entry: MemoryStoreEntry) {
    setBusy(true);
    try {
      const value = await native.readMemory(entry.target, entry.id);
      if (!mounted.current) return;
      setOpened({ target: entry.target, id: value.id, text: value.text, fingerprint: value.fingerprint });
      setDraft(value.text);
      setCreating(false);
      setFailure(null);
    } catch (error) {
      if (!mounted.current) return;
      report(error, t('common.memory.readFailed'), () => openEntry(entry));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function saveOpened(confirmExternal = false) {
    if (!opened) return;
    const current = opened;
    const text = draft;
    setBusy(true);
    try {
      let writeExternal = confirmExternal;
      if (!writeExternal) {
        const fresh = await native.readMemory(current.target, current.id);
        if (!mounted.current) return;
        if (fresh.fingerprint !== current.fingerprint) {
          setBusy(false);
          const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, {
            title: t('common.memory.externalTitle'),
            confirmLabel: t('common.memory.externalConfirm'),
          });
          if (!accepted) return;
          writeExternal = true;
          setBusy(true);
        }
      }
      const saved = await native.saveMemory({ target: current.target, id: current.id, text, baseline: current.text, confirmExternal: writeExternal });
      if (!mounted.current) return;
      setOpened({ target: current.target, id: saved.id, text: saved.text, fingerprint: saved.fingerprint });
      setDraft(value => value === text ? saved.text : value);
      setFailure(null);
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, {
          title: t('common.memory.externalTitle'),
          confirmLabel: t('common.memory.externalConfirm'),
        });
        if (!accepted) return;
        await saveOpened(true);
        return;
      }
      report(error, t('common.memory.saveFailed'), () => saveOpened(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function createMemory(confirmExternal = false) {
    if (!createTarget) return;
    const id = newId.trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || id === '_unbound') {
      setFailure({ message: t('common.memory.idInvalid'), retry: null });
      return;
    }
    const target = createTarget;
    const text = newText;
    setBusy(true);
    try {
      const saved = await native.saveMemory({ target, id, text, baseline: '', confirmExternal });
      if (!mounted.current) return;
      setOpened({ target, id: saved.id, text: saved.text, fingerprint: saved.fingerprint });
      setDraft(saved.text);
      setCreating(false);
      setNewId('');
      setNewText('');
      setFailure(null);
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, {
          title: t('common.memory.externalTitle'),
          confirmLabel: t('common.memory.externalConfirm'),
        });
        if (!accepted) return;
        await createMemory(true);
        return;
      }
      report(error, t('common.memory.saveFailed'), () => createMemory(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function remove(entry: MemoryStoreEntry, baseline: string) {
    setBusy(true);
    try {
      await native.deleteMemory({ target: entry.target, id: entry.id, baseline });
      if (!mounted.current) return;
      if (opened?.id === entry.id && storeKey(opened.target) === storeKey(entry.target)) { setOpened(null); setDraft(''); }
      setFailure(null);
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      report(error, t('common.memory.deleteFailed'), () => remove(entry, baseline));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function confirmRemove(entry: MemoryStoreEntry) {
    const accepted = await confirmAction(t('common.memory.deleteMessage', { id: entry.id }), () => mounted.current, {
      title: t('common.memory.deleteTitle'),
      confirmLabel: t('common.memory.deleteConfirm'),
      destructive: true,
    });
    if (!accepted || !mounted.current) return;
    let baseline = opened?.id === entry.id && storeKey(opened.target) === storeKey(entry.target) ? opened.text : '';
    if (!baseline) {
      setBusy(true);
      try {
        const fresh = await native.readMemory(entry.target, entry.id);
        if (!mounted.current) return;
        baseline = fresh.text;
      } catch (error) {
        if (!mounted.current) return;
        report(error, t('common.memory.readFailed'), () => confirmRemove(entry));
        return;
      } finally { if (mounted.current) setBusy(false); }
    }
    await remove(entry, baseline);
  }

  async function setEnabled(enabled: boolean, target: MemoryTarget, id?: string) {
    setBusy(true);
    try {
      await native.setMemoryEnabled({ target, id: id ?? null, enabled });
      if (!mounted.current) return;
      setFailure(null);
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      report(error, t('common.memory.saveFailed'), () => setEnabled(enabled, target, id));
    } finally { if (mounted.current) setBusy(false); }
  }

  // Distinct stores with at least one listed entry; each carries the exact
  // target the switch write must repeat, plus the store's switch state.
  const stores = new Map<string, { key: string; label: string; target: MemoryTarget; inUse: boolean; detail: string }>();
  for (const entry of aggregate?.entries ?? []) {
    const key = storeKey(entry.target);
    if (!stores.has(key)) stores.set(key, { key, label: entry.sourceLabel, target: entry.target, inUse: entry.inUse, detail: entry.detail });
  }
  const storeList = [...stores.values()];

  return <section className={styles.page} aria-label={t('tools.workspace.view.memory')}>
    {limitation && !showWrites && <p className={styles.limitation} role="status">{limitation}</p>}
    {listFailure && <StatusBanner tone="error" action={listFailure.retry ? <button type="button" className="button" onClick={() => { const retry = listFailure.retry; setListFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{listFailure.message}</StatusBanner>}
    {!aggregate && !listFailure && <p className={styles.prompt} role="status">{t('common.memory.loading')}</p>}
    {aggregate && storeList.map(store => <div key={store.key} className={styles.storeRow}>
      {can('master_switch') && <label className={styles.switch}><input type="checkbox" checked={store.inUse} disabled={busy} onChange={event => void setEnabled(event.target.checked, store.target)} />{storeList.length > 1 ? t('common.memory.masterFor', { source: store.label }) : t('common.memory.master')}</label>}
      {!store.inUse && <span className={styles.notInUse} role="status">{store.detail || t('common.memory.notInUse')}</span>}
    </div>)}
    {failure && <StatusBanner tone="error" action={failure.retry ? <button type="button" className="button" onClick={() => { const retry = failure.retry; setFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{failure.message}</StatusBanner>}
    {aggregate && aggregate.failedSources.map(source => <p key={source.label} className={styles.sourceFailure} role="status">{t('common.memory.sourceFailed', { label: source.label, reason: source.reason })}</p>)}
    {aggregate && <ul className={styles.list}>
      {aggregate.entries.length === 0 && aggregate.failedSources.length === 0 && <li className={styles.prompt}>{t('common.memory.emptyAll')}</li>}
      {aggregate.entries.map(entry => { const key = `${storeKey(entry.target)}:${entry.id}`; return <li key={key} className={styles.entry}>
        <strong>{entry.id}</strong>
        {previews[key] && <span className={styles.preview}>{previews[key]}</span>}
        <span className={styles.source}>{t('common.memory.sourceLabel', { source: entry.sourceLabel })}</span>
        <span className={styles.path} title={entry.path}>{entry.path}</span>
        <span className={styles.actions}>
          {can('item_enable') && <label className={styles.switch}><input type="checkbox" aria-label={t('common.memory.enable', { id: entry.id })} checked={entry.enabled} disabled={busy} onChange={event => void setEnabled(event.target.checked, entry.target, entry.id)} /></label>}
          {can('open') && <button type="button" className="button" disabled={busy} onClick={() => void openEntry(entry)}>{t('common.memory.open', { id: entry.id })}</button>}
          {can('delete') && <button type="button" className="button destructive" disabled={busy} onClick={() => void confirmRemove(entry)}>{t('common.memory.delete', { id: entry.id })}</button>}
        </span>
      </li>; })}
    </ul>}
    {can('create') && !creating && <div className={styles.row}>
      <button type="button" className="button primary" disabled={busy || !createTarget} onClick={() => { setCreating(true); setOpened(null); setDraft(''); }}>{t('common.memory.create')}</button>
      {createTarget
        ? <span className={styles.location}>{t('common.memory.writeLocation', { target: createLocation })}</span>
        : <span className={styles.location}>{t('common.memory.createUnavailable')}</span>}
    </div>}
    {creating && can('create') && createTarget && <form className={styles.create} onSubmit={event => { event.preventDefault(); void createMemory(false); }}>
      <p className={styles.location}>{t('common.memory.writeLocation', { target: createLocation })}</p>
      <label className={styles.field}>{t('common.memory.idLabel')}<input aria-label={t('common.memory.idLabel')} value={newId} onChange={event => setNewId(event.target.value)} /></label>
      <label className={styles.field}>{t('common.memory.textLabel')}<textarea aria-label={t('common.memory.textLabel')} rows={8} value={newText} onChange={event => setNewText(event.target.value)} /></label>
      <div className={styles.row}><button type="submit" className="button primary" disabled={busy}>{t('common.memory.save')}</button></div>
    </form>}
    {opened && <form className={styles.editor} onSubmit={event => { event.preventDefault(); if (can('edit')) void saveOpened(false); }}>
      <label className={styles.field}>{t('common.memory.textLabel')}<textarea aria-label={t('common.memory.textLabel')} rows={10} readOnly={!can('edit')} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      {can('edit') && <div className={styles.row}><button type="submit" className="button primary" disabled={busy}>{t('common.memory.save')}</button></div>}
    </form>}
  </section>;
}
