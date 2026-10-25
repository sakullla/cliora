import { uiAdapterFor } from '../../adapters';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { displayPath } from '../../lib/paths';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { PluginAction, PluginEntry, PluginSnapshot, PluginTarget } from '../../types/resources';
import styles from './ManagementPanel.module.css';
import { useAccountLabels } from '../library/resourceContexts';
import { useFeedback } from '../../lib/toast';
import { SearchField } from '../../components/SearchField';
import { SkeletonRows } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { DocumentHeader, DocumentWorkspace, documentStyles as doc } from './DocumentWorkspace';
import i18n from '../../i18n';

function actionLabel(action: PluginAction) { return i18n.t(`tools.plugins.action.${action}`); }
function stateLabel(state: string) { return i18n.t(`tools.plugins.state.${state}`, { defaultValue: state }); }
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
function policyLabel(value: string) { return value.replaceAll('NOT_AVAILABLE', i18n.t('tools.plugins.policyNotAvailable')).replaceAll('AVAILABLE', i18n.t('tools.plugins.policyAvailable')).replaceAll('REQUIRED', i18n.t('tools.plugins.policyRequired')).replaceAll('FORBIDDEN', i18n.t('tools.plugins.policyForbidden')).replaceAll('ON_INSTALL', i18n.t('tools.plugins.policyOnInstall')).replaceAll('NONE', i18n.t('tools.plugins.policyNone')); }
function scopeLabel(scope: string) { return i18n.t(`tools.plugins.scope.${scope}`, { defaultValue: scope }); }
function statusLabel(entry: PluginEntry) {
  if (entry.state === 'not_installed') return stateLabel(entry.state);
  if (entry.enabled === null) return i18n.t('tools.plugins.stateUnknown');
  return entry.enabled ? i18n.t('tools.plugins.enabled') : i18n.t('tools.plugins.disabled');
}
function sourceProblem(source: string) {
  if (!source) return 'sourceRequired';
  if (source.startsWith('-')) return 'sourceDash';
  if (/[\u0000-\u001f\u007f]/.test(source)) return 'sourceControl';
  if (source.length > 2048) return 'sourceTooLong';
  return null;
}

type Operation = {
  id: number;
  generation: number;
  entryId: string | null;
  name: string;
  action: PluginAction;
  source: string;
  trusted: boolean;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  detail?: string;
};

const remembered = new Map<string, { snapshot: PluginSnapshot; at: number }>();
const pending = new Map<string, Promise<PluginSnapshot>>();
function scanOnce(target: PluginTarget) {
  const key = JSON.stringify(target);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = native.scanNativePlugins(target).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
function remember(key: string, snapshot: PluginSnapshot) {
  remembered.delete(key);
  remembered.set(key, { snapshot, at: Date.now() });
  if (remembered.size > 24) remembered.delete(remembered.keys().next().value!);
}

export function PluginsWorkspace({ toolId, scope, projectPath, contextId }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null }) {
  const { t } = useTranslation();
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const cacheKey = JSON.stringify(target);
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null);
  const [source, setSource] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const { setError, setNotice } = useFeedback();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const generation = useRef(0);
  const operationId = useRef(0);
  const refreshing = useRef(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const accountLabel = useAccountLabels();
  const entries = snapshot?.entries ?? [];
  const filtered = entries.filter(entry => `${entry.name} ${entry.source}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled === true : entry.enabled === false)));
  const installedCount = entries.filter(entry => entry.state !== 'not_installed').length;
  const filteredInstalledCount = filtered.filter(entry => entry.state !== 'not_installed').length;
  const sourceIssue = sourceProblem(source.trim());
  const canInstall = !!snapshot?.baseline && snapshot.capability.actions.includes('install');
  const blockProjectUpdate = uiAdapterFor(toolId).plugins?.projectUpdate === false && scope === 'project';

  useEffect(() => {
    const id = ++generation.current;
    setSnapshot(null); setError(''); setNotice(''); setBusy(true); setStale(false); setSelectedKey(null); setOperations([]); setTrusted(false);
    const cached = remembered.get(cacheKey);
    if (cached && Date.now() - cached.at < 30_000) { setSnapshot(cached.snapshot); setBusy(false); return () => { generation.current++; }; }
    let completed = false;
    void native.previewNativePlugins(target).then(value => { if (value && !completed && id === generation.current) setSnapshot(value); }).catch(() => { /* The authoritative scan reports errors; preview is optional. */ });
    void scanOnce(target).then(value => { if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); setStale(false); } }).catch(value => { if (id === generation.current) { remembered.delete(cacheKey); setStale(true); setError(message(value)); } }).finally(() => { completed = true; if (id === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [target]);

  useEffect(() => {
    if (operations.some(operation => operation.status === 'running')) return;
    const operation = operations.find(item => item.status === 'queued');
    if (!operation || operation.generation !== generation.current) return;
    const id = generation.current;
    setOperations(current => current.map(item => item.id === operation.id ? { ...item, status: 'running' } : item));
    void (async () => {
      try {
        const latest = await native.scanNativePlugins(target);
        if (id !== generation.current) return;
        remember(cacheKey, latest);
        setSnapshot(latest); setStale(false);
        if (!latest.baseline || !latest.capability.actions.includes(operation.action)) throw new Error(t('tools.plugins.operationUnavailable'));
        const entry = operation.entryId ? latest.entries.find(item => item.id === operation.entryId) : null;
        if (operation.action !== 'install' && (!entry || entry.state === 'not_installed')) throw new Error(t('tools.plugins.operationEntryChanged'));
        if (entry?.readOnly || (operation.action === 'update' && blockProjectUpdate)) throw new Error(t('tools.plugins.operationUnavailable'));
        const result = await native.operateNativePlugin({ target, action: operation.action, source: operation.source, baseline: latest.baseline, trusted: operation.trusted });
        if (id !== generation.current) return;
        remembered.delete(cacheKey);
        const nextSnapshot = result.snapshot ?? latest;
        if (result.snapshot) remember(cacheKey, result.snapshot);
        setSnapshot(nextSnapshot);
        setStale(!result.snapshot);
        const failed = result.status === 'failed_possible_side_effects';
        setOperations(current => current.map(item => item.id === operation.id ? { ...item, status: failed ? 'failed' : 'succeeded', detail: result.detail } : item));
        if (failed) setError(`${result.detail} ${t('tools.plugins.sideEffects')}`);
        else {
          setNotice(result.detail);
          if (operation.action === 'install') {
            setSource(''); setTrusted(false);
            const previousKeys = new Set(latest.entries.map(item => `${item.scope}:${item.id}`));
            const added = nextSnapshot.entries.filter(item => !previousKeys.has(`${item.scope}:${item.id}`));
            const installed = nextSnapshot.entries.find(item => item.id === operation.source || item.source === operation.source) ?? (added.length === 1 ? added[0] : undefined);
            if (installed) setSelectedKey(`${installed.scope}:${installed.id}`);
            else setError(`${result.detail} ${t('tools.plugins.installedNotFound')}`);
          }
          if (operation.action === 'uninstall') setSelectedKey(null);
        }
      } catch (value) {
        if (id !== generation.current) return;
        const detail = message(value);
        setOperations(current => current.map(item => item.id === operation.id ? { ...item, status: 'failed', detail } : item));
        setStale(true); setError(detail);
      }
    })();
  }, [operations, target]);

  async function refresh() {
    if (refreshing.current || busy || operations.some(operation => operation.status === 'queued' || operation.status === 'running')) return;
    const id = generation.current;
    refreshing.current = true;
    setBusy(true); setError('');
    try {
      const value = await native.scanNativePlugins(target);
      if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); setStale(false); }
    } catch (value) {
      if (id === generation.current) { remembered.delete(cacheKey); setStale(true); setError(message(value)); }
    } finally {
      refreshing.current = false;
      if (id === generation.current) setBusy(false);
    }
  }

  async function operate(action: PluginAction, entry?: PluginEntry) {
    if (!snapshot?.baseline) return;
    const operationSource = entry?.id ?? source.trim();
    if (action === 'install' && (!trusted || sourceIssue || !canInstall)) return;
    if (operations.some(operation => ['queued', 'running'].includes(operation.status) && (operation.entryId === entry?.id || (action === 'install' && operation.action === 'install' && operation.source === operationSource)))) return;
    const id = generation.current;
    if (action === 'uninstall' && !await confirmAction(t('tools.plugins.confirmUninstall', { name: entry?.name }), () => id === generation.current, { title: t('tools.plugins.uninstallTitle'), confirmLabel: actionLabel('uninstall') })) return;
    if (action === 'update' && !await confirmAction(t('tools.plugins.confirmUpdate', { name: entry?.name }), () => id === generation.current, { title: t('tools.plugins.updateTitle'), confirmLabel: actionLabel('update') })) return;
    if (id !== generation.current) return;
    setError(''); setNotice('');
    const operation: Operation = { id: ++operationId.current, generation: id, entryId: entry?.id ?? null, name: entry?.name ?? operationSource, action, source: operationSource, trusted: action === 'update' || trusted, status: 'queued' };
    setOperations(current => [...current.filter(item => item.status === 'queued' || item.status === 'running' || item.entryId !== operation.entryId), operation]);
  }

  function operationFor(entry: PluginEntry) { return operations.find(operation => operation.entryId === entry.id && (operation.status === 'queued' || operation.status === 'running')); }
  function entryActions(entry: PluginEntry) {
    if (entry.state === 'not_installed') return [];
    return (['update', entry.enabled === false ? 'enable' : 'disable', 'uninstall'] as PluginAction[]).filter(action => snapshot?.capability.actions.includes(action));
  }
  function clearFilters() { setSearch(''); setFilter('all'); }
  function closeDetails() { restoreFocus.current = selectedKey; setSelectedKey(null); }
  const pluginKey = (entry: PluginEntry) => `${entry.scope}:${entry.id}`;
  const opened = filtered.find(entry => pluginKey(entry) === selectedKey) ?? null;
  useEffect(() => {
    if (selectedKey || !restoreFocus.current) return;
    const key = restoreFocus.current;
    restoreFocus.current = null;
    document.querySelector<HTMLButtonElement>(`[data-plugin-key="${CSS.escape(key)}"]`)?.focus();
  }, [selectedKey]);

  const showFailed = !busy && (!snapshot || (stale && !snapshot.baseline));
  const showEmpty = !!snapshot?.baseline && entries.length === 0 && !busy && !stale;
  const countText = snapshot ? `${snapshot.baseline ? '' : t('tools.plugins.discoveredPrefix')}${filteredInstalledCount === installedCount ? t('tools.plugins.count', { count: installedCount }) : t('tools.plugins.countFiltered', { filtered: filteredInstalledCount, total: installedCount })}` : undefined;
  const install = snapshot?.capability.actions.includes('install') ? <div className={styles.installBox}>
    <div className={styles.installHeading}><span className={styles.installGlyph} aria-hidden="true"><Icon name="package" size={17} /></span><div><h3>{t('tools.plugins.installTitle')}</h3><p>{t('tools.plugins.sourceHint', { sources: snapshot.capability.sources })}</p></div></div>
    <div className={styles.installControls}>
      <div className={styles.create}><label>{t('tools.plugins.source')}<input ref={sourceInput} aria-label={t('tools.plugins.source')} value={source} onChange={event => { setSource(event.target.value); setTrusted(false); }} placeholder={snapshot.capability.sources} aria-invalid={!!source && !!sourceIssue} aria-describedby="plugin-source-error" /></label>
        <button type="button" className={styles.primary} disabled={!source.trim() || !trusted || !!sourceIssue || !canInstall} onClick={() => void operate('install')}>{uiAdapterFor(toolId).plugins?.installLabel ?? t('tools.plugins.installDefault')}</button></div>
      <label className={styles.trust}><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} /> {t('tools.plugins.trust')}{uiAdapterFor(toolId).plugins?.projectTrust && scope === 'project' ? t('tools.plugins.trustProject') : ''}</label>
      {source && sourceIssue && <p id="plugin-source-error" className={styles.fieldError}>{t(`tools.plugins.${sourceIssue}`)}</p>}
    </div>
  </div> : null;
  const operation = opened ? operationFor(opened) : undefined;

  return <DocumentWorkspace label={t('tools.plugins.label')} toolbarLabel={t('tools.plugins.toolbar')} backLabel={t('common.dialog.back')} onBack={closeDetails}
    heading={t('tools.plugins.title')}
    count={countText}
    actions={<button type="button" className={doc.iconButton} aria-label={t('tools.plugins.rescan')} title={t('tools.plugins.rescan')} disabled={busy || operations.some(item => item.status === 'queued' || item.status === 'running')} data-spinning={(busy && !!snapshot) || undefined} onClick={() => void refresh()}><Icon name="refresh" size={15} /></button>}
    search={snapshot ? <SearchField type="search" label={t('tools.plugins.searchLabel')} placeholder={t('tools.plugins.searchPlaceholder')} value={search} onChange={setSearch} /> : undefined}
    filters={snapshot ? <select className={styles.filter} aria-label={t('tools.plugins.filterLabel')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t('tools.plugins.filterAll')}</option><option value="enabled">{t('tools.plugins.enabled')}</option><option value="disabled">{t('tools.plugins.disabled')}</option><option value="readonly">{t('tools.plugins.filterReadonly')}</option></select> : undefined}
    notices={<>
      {busy && snapshot && <p className={styles.progress} role="status">{snapshot.baseline ? t('tools.plugins.refreshing') : t('tools.plugins.verifying')}</p>}
      {stale && snapshot?.baseline && <div className={styles.stale} role="status"><strong>{t('tools.plugins.staleTitle')}</strong><span>{t('tools.plugins.staleDetail')}</span><button type="button" disabled={busy || operations.some(item => item.status === 'queued' || item.status === 'running')} onClick={() => void refresh()}>{t('tools.plugins.rescan')}</button></div>}
      {operations.length > 0 && <div className={styles.queue} aria-label={t('tools.plugins.queueLabel')}><div className={styles.queueTitle}><strong>{t('tools.plugins.queueTitle')}</strong><span>{t('tools.plugins.queueSerial')}</span></div>{operations.map(item => <div className={styles.queueRow} key={item.id} data-state={item.status}><span><strong>{actionLabel(item.action)} · {item.name}</strong>{item.detail && <small>{item.detail}</small>}</span><span className={styles.queueState}>{t(`tools.plugins.operationState.${item.status}`)}</span>{item.status === 'queued' && <button type="button" onClick={() => setOperations(current => current.filter(entry => entry.id !== item.id))}>{t('tools.plugins.cancelQueued')}</button>}{item.status === 'failed' && <button type="button" disabled={item.action === 'install' && (!source.trim() || !trusted || !!sourceIssue || !canInstall)} onClick={() => { if (item.action === 'install') { void operate('install'); return; } setError(''); setOperations(current => current.map(entry => entry.id === item.id ? { ...entry, status: 'queued', detail: undefined } : entry)); }}>{t('tools.plugins.retry')}</button>}</div>)}</div>}
    </>}
    listFooterLabel={t('tools.plugins.compatSummary')}
    listFooter={snapshot ? <>
      <span className={styles.context}><span>{scope === 'global' ? scopeLabel('user') : projectPath}</span><span>{accountLabel(contextId)}</span></span>
      <details className={styles.compatibility}><summary>{t('tools.plugins.compatSummary')}</summary><p>{t('tools.plugins.compatVersion', { version: snapshot.capability.version, detail: snapshot.capability.detail })}</p><p>{snapshot.detail}</p></details>
    </> : undefined}
    list={<div className={styles.listWrap}>
      {install}
      {busy && !snapshot && <div role="status" aria-label={t('tools.plugins.loading')}><SkeletonRows count={3} /></div>}
      {showFailed && <EmptyState title={t('tools.plugins.loadFailedTitle')} detail={t('tools.plugins.loadFailedDetail')} action={<button type="button" className="button primary" onClick={() => void refresh()}>{t('tools.plugins.rescan')}</button>} />}
      {showEmpty && <EmptyState title={t('tools.plugins.emptyTitle')} detail={canInstall ? t('tools.plugins.emptyInstallable') : `${t('tools.plugins.emptyNone')}${snapshot?.capability.detail ? ` ${snapshot.capability.detail}` : ''}`} action={canInstall
        ? <button type="button" className="button primary" onClick={() => sourceInput.current?.focus()}>{t('tools.plugins.installDefault')}</button>
        : <button type="button" className="button primary" disabled={busy} onClick={() => void refresh()}>{t('tools.plugins.rescan')}</button>} />}
      {!showFailed && !showEmpty && filtered.length === 0 && entries.length > 0 && <div className={styles.noMatch}><strong>{t('tools.plugins.noMatch')}</strong><p>{t('tools.plugins.noMatchDetail')}</p><button type="button" onClick={clearFilters}>{t('tools.plugins.clearFilter')}</button></div>}
      {filtered.length > 0 && <ul className={doc.rows} aria-label={t('tools.plugins.title')}>{filtered.map(entry => {
        const key = pluginKey(entry);
        const pending = operationFor(entry);
        return <li key={key}><button type="button" className={doc.row} data-plugin-key={key} aria-current={opened && pluginKey(opened) === key ? 'true' : undefined} onClick={() => setSelectedKey(key)}>
          <span className={doc.rowTitle}><strong>{entry.name}</strong></span>
          <span className={doc.rowSummary}>{displayPath(entry.source)} · {scopeLabel(entry.scope)}</span>
          <span className={doc.rowMeta}>
            <span className={doc.chip} data-tone={entry.enabled ? 'on' : 'muted'}>{statusLabel(entry)}</span>
            <span className={doc.chip}>{stateLabel(entry.state)}</span>
            {entry.readOnly && <span className={doc.chip}>{snapshot?.baseline ? t('tools.plugins.readonly') : t('tools.plugins.pendingReview')}</span>}
            {pending && <span className={doc.chip} data-tone="warn">{t(`tools.plugins.operationState.${pending.status}`)}</span>}
          </span>
        </button></li>;
      })}</ul>}
    </div>}
    placeholder={snapshot && entries.length > 0 && !opened ? <div className={doc.placeholder}><span className={doc.placeholderIcon} aria-hidden="true"><Icon name="package" size={22} /></span><strong>{t('tools.plugins.selectHint')}</strong><p>{t('tools.plugins.selectDetail')}</p></div> : null}
    document={opened ? <article className={doc.doc} aria-label={t('tools.plugins.detailsLabel')}>
      <DocumentHeader
        title={opened.name}
        badges={<>
          <span className={doc.chip} data-tone={opened.enabled ? 'on' : 'muted'}>{stateLabel(opened.state)}</span>
          {opened.readOnly && <span className={doc.chip}>{t('tools.plugins.readonly')}</span>}
          {operation && <span className={doc.chip} data-tone="warn">{t(`tools.plugins.operationState.${operation.status}`)}</span>}
        </>}
        tools={<>
          {entryActions(opened).map(action => <button type="button" key={action} className={action === 'uninstall' ? styles.danger : action === 'update' ? styles.primary : undefined} title={opened.readOnly ? policyLabel(opened.policy) : action === 'update' && blockProjectUpdate ? t('tools.plugins.updateProjectTitle') : operation ? t('tools.plugins.sameItemPending') : undefined} disabled={!snapshot?.baseline || !!operation || opened.readOnly || (action === 'update' && blockProjectUpdate)} onClick={() => void operate(action, opened)}>{actionLabel(action)}</button>)}
          <button type="button" className={doc.iconButton} aria-label={t('tools.plugins.closeDetails')} title={t('tools.plugins.closeDetails')} onClick={closeDetails}><Icon name="close" size={15} /></button>
        </>}
      />
      <div className={doc.body}><div className={styles.pluginDetails}>
        <dl className={styles.detailGrid}><div><dt>{t('tools.plugins.version')}</dt><dd>{opened.version ?? t('tools.plugins.versionMissing')}</dd></div><div><dt>{t('tools.plugins.source')}</dt><dd>{displayPath(opened.source)}</dd></div><div><dt>{t('tools.plugins.scopeLabel')}</dt><dd>{scopeLabel(opened.scope)}</dd></div><div><dt>{t('tools.plugins.locationSummary')}</dt><dd>{opened.root ? displayPath(opened.root) : t('tools.plugins.notProvided')}</dd></div></dl>
        <section className={styles.detailSection}><h4>{t('tools.plugins.policySummary')}</h4><p>{policyLabel(opened.policy)}{opened.readOnly ? t('tools.plugins.readonlySuffix') : ''}</p></section>
        <section className={styles.detailSection}><h4>{t('tools.plugins.resourcesSummary')}</h4>{opened.resources.length ? <ul>{opened.resources.map(resource => <li key={resource.path}><span>{resource.kind}</span><code>{displayPath(resource.path)}</code></li>)}</ul> : <p>{t('tools.plugins.noResources')}</p>}</section>
        {opened.readOnly && <p className={styles.readonlyNote}>{t('tools.plugins.readonlyDetail')}</p>}
        {blockProjectUpdate && entryActions(opened).includes('update') && <p className={styles.readonlyNote}>{t('tools.plugins.updateProjectTitle')}</p>}
      </div></div>
    </article> : null}
  />;
}
