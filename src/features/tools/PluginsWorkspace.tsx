import { uiAdapterFor } from '../../adapters';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { PluginAction, PluginEntry, PluginSnapshot, PluginTarget } from '../../types/resources';
import styles from './ManagementPanel.module.css';
import { useAccountLabels } from '../library/resourceContexts';
import { StatusBanner } from '../../components/StatusBanner';
import { SearchField } from '../../components/SearchField';
import i18n from '../../i18n';

function actionLabel(action: PluginAction) { return i18n.t(`tools.plugins.action.${action}`); }
function stateLabel(state: string) { return i18n.t(`tools.plugins.state.${state}`, { defaultValue: state }); }
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
function policyLabel(value: string) { return value.replaceAll('NOT_AVAILABLE', i18n.t('tools.plugins.policyNotAvailable')).replaceAll('AVAILABLE', i18n.t('tools.plugins.policyAvailable')).replaceAll('REQUIRED', i18n.t('tools.plugins.policyRequired')).replaceAll('FORBIDDEN', i18n.t('tools.plugins.policyForbidden')).replaceAll('ON_INSTALL', i18n.t('tools.plugins.policyOnInstall')).replaceAll('NONE', i18n.t('tools.plugins.policyNone')); }
function scopeLabel(scope: string) { return i18n.t(`tools.plugins.scope.${scope}`, { defaultValue: scope }); }
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const generation = useRef(0);
  const accountLabel = useAccountLabels();
  const entries = snapshot?.entries ?? [];
  const filtered = entries.filter(entry => `${entry.name} ${entry.source}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled === true : entry.enabled === false)));
  useEffect(() => { const id = ++generation.current; setSnapshot(null); setError(''); setNotice(''); setBusy(true);
    const cached = remembered.get(cacheKey);
    if (cached && Date.now() - cached.at < 30_000) { setSnapshot(cached.snapshot); setBusy(false); return () => { generation.current++; }; }
    let completed = false;
    void native.previewNativePlugins(target).then(value => { if (value && !completed && id === generation.current) setSnapshot(value); }).catch(() => { /* The authoritative scan reports errors; preview is optional. */ });
    void scanOnce(target).then(value => { if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); } }).catch(value => { if (id === generation.current) { remembered.delete(cacheKey); setError(message(value)); } }).finally(() => { completed = true; if (id === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [target]);
  async function refresh() { const id = ++generation.current; setBusy(true); setError('');
    try { const value = await native.scanNativePlugins(target); if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); } }
    catch (value) { if (id === generation.current) { remembered.delete(cacheKey); setError(message(value)); setSnapshot(null); } }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function operate(action: PluginAction, entry?: PluginEntry) {
    if (!snapshot?.baseline || busy) return;
    const id = generation.current;
    if (action === 'uninstall' && !await confirmAction(t('tools.plugins.confirmUninstall', { name: entry?.name }), () => id === generation.current, { title: t('tools.plugins.uninstallTitle'), confirmLabel: actionLabel('uninstall') })) return;
    if (id !== generation.current) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await native.operateNativePlugin({ target, action, source: entry?.id ?? source.trim(), baseline: snapshot.baseline, trusted });
      if (id !== generation.current) return;
      remembered.delete(cacheKey);
      if (result.snapshot) remember(cacheKey, result.snapshot);
      setSnapshot(result.snapshot); setNotice(result.detail);
      if (result.status === 'failed_possible_side_effects') setError(t('tools.plugins.sideEffects'));
      else if (action === 'install') { setSource(''); setTrusted(false); }
    } catch (value) { if (id === generation.current) setError(message(value)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  return <section className={styles.panel} aria-label={t('tools.plugins.label')}>
    <div className={styles.header}><div><h2>{t('tools.plugins.title')}</h2><p>{t('tools.plugins.description')}</p></div><div className={styles.actions}><button disabled={busy} onClick={() => void refresh()}>{t('tools.plugins.rescan')}</button></div></div>
    <div className={styles.context}><span>{scope === 'global' ? scopeLabel('user') : projectPath}</span><span>{accountLabel(contextId)}</span></div>
    {busy && <p role="status">{snapshot ? snapshot.baseline ? t('tools.plugins.operating') : t('tools.plugins.verifying') : t('tools.plugins.loading')}</p>}
    {error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}{notice && <StatusBanner tone="success" onDismiss={() => setNotice('')}>{notice}</StatusBanner>}
    {snapshot && <>
      {snapshot.capability.actions.some(action => action === 'install' || action === 'update') && <div className={styles.installBox}><div className={styles.create}><label>{t('tools.plugins.source')}<input aria-label={t('tools.plugins.source')} value={source} onChange={event => { setSource(event.target.value); setTrusted(false); }} placeholder={snapshot.capability.sources} disabled={busy} /></label>
        <button className={styles.primary} disabled={busy || !source.trim() || !trusted || !snapshot.capability.actions.includes('install')} onClick={() => void operate('install')}>{uiAdapterFor(toolId).plugins?.installLabel ?? t('tools.plugins.installDefault')}</button></div>
      <label className={styles.trust}><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} disabled={busy} /> {t('tools.plugins.trust')}{uiAdapterFor(toolId).plugins?.projectTrust && scope === 'project' ? t('tools.plugins.trustProject') : ''}</label>
      <p>{t('tools.plugins.sourceHint', { sources: snapshot.capability.sources })}</p></div>}
      <div className={styles.listToolbar}><SearchField type="search" label={t('tools.plugins.searchLabel')} placeholder={t('tools.plugins.searchPlaceholder')} value={search} onChange={setSearch} /><select aria-label={t('tools.plugins.filterLabel')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t('tools.plugins.filterAll')}</option><option value="enabled">{t('tools.plugins.enabled')}</option><option value="disabled">{t('tools.plugins.disabled')}</option><option value="readonly">{t('tools.plugins.filterReadonly')}</option></select><span>{snapshot.baseline ? '' : t('tools.plugins.discoveredPrefix')}{filtered.length === entries.length ? t('tools.plugins.count', { count: entries.length }) : t('tools.plugins.countFiltered', { filtered: filtered.length, total: entries.length })}</span></div>
      {!snapshot.entries.length && !!snapshot.baseline && <p className={styles.empty}>{snapshot.capability.actions.includes('install') ? t('tools.plugins.emptyInstallable') : t('tools.plugins.emptyNone')}{!snapshot.capability.actions.includes('install') && <span>{snapshot.capability.detail}</span>}</p>}
      {filtered.length > 0 && <ul className={styles.resourceList}>{filtered.map(entry => <li key={`${entry.scope}:${entry.id}`}>
        <div className={styles.resourceBody}><div className={styles.resourceTitle}><strong>{entry.name}</strong><span className={styles.badge} data-state={entry.enabled ? 'signed_in' : 'signed_out'}>{entry.enabled === null ? t('tools.plugins.stateUnknown') : entry.enabled ? t('tools.plugins.enabled') : t('tools.plugins.disabled')}</span>{entry.readOnly && <span className={styles.badge}>{snapshot.baseline ? t('tools.plugins.readonly') : t('tools.plugins.pendingReview')}</span>}<span className={styles.resourceMeta}>{entry.version ?? t('tools.plugins.versionMissing')}</span></div><p>{entry.source} · {scopeLabel(entry.scope)}</p><p>{stateLabel(entry.state)}</p></div>
        <div className={styles.actions}>{(['update', entry.enabled === false ? 'enable' : 'disable', 'uninstall'] as PluginAction[]).filter(action => snapshot.capability.actions.includes(action)).map(action => <button key={action} className={action === 'uninstall' ? styles.danger : undefined} title={entry.readOnly ? policyLabel(entry.policy) : action === 'update' && !trusted ? t('tools.plugins.updateTrustTitle') : undefined} disabled={busy || entry.readOnly || (action === 'update' && (!trusted || (uiAdapterFor(toolId).plugins?.projectUpdate === false && scope === 'project')))} onClick={() => void operate(action, entry)}>{actionLabel(action)}</button>)}</div>
        <details><summary>{t('tools.plugins.policySummary')}</summary><p>{policyLabel(entry.policy)}{entry.readOnly ? t('tools.plugins.readonlySuffix') : ''}</p></details>
        {entry.root && <details><summary>{t('tools.plugins.locationSummary')}</summary><p>{entry.root}</p></details>}
        {!!entry.resources.length && <details><summary>{t('tools.plugins.resourcesSummary')}</summary><ul>{entry.resources.map(resource => <li key={resource.path}>{resource.kind} · {resource.path}</li>)}</ul></details>}
      </li>)}</ul>}
      {entries.length > 0 && filtered.length === 0 && <p className={styles.empty}>{t('tools.plugins.noMatch')}<button onClick={() => { setSearch(''); setFilter('all'); }}>{t('tools.plugins.clearFilter')}</button></p>}
      <details className={styles.compatibility}><summary>{t('tools.plugins.compatSummary')}</summary><p>{t('tools.plugins.compatVersion', { version: snapshot.capability.version, detail: snapshot.capability.detail })}</p><p>{snapshot.detail}</p></details>
    </>}
  </section>;
}
