import { useRemoteReads, RemoteReadStatus } from '../../lib/remoteReads';
import { uiAdapterFor } from '../../adapters';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { displayPath } from '../../lib/paths';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { PluginAction, PluginContents, PluginEntry, PluginFile, PluginItem, PluginSnapshot, PluginTarget } from '../../types/resources';
import panel from './ManagementPanel.module.css';
import styles from './PluginsWorkspace.module.css';
import { useAccountLabels } from '../library/resourceContexts';
import { useFeedback } from '../../lib/toast';
import { SearchField } from '../../components/SearchField';
import { SkeletonRows } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import { GuideDialog } from '../../components/GuideDialog';
import { CodeEditor, type CodeFormat } from '../../components/CodeEditor';
import { Icon, type IconName } from '../../components/Icon';
import { DocumentHeader, DocumentWorkspace, PathLine, documentStyles as doc } from './DocumentWorkspace';
import { DocumentReader } from './DocumentReader';
import i18n from '../../i18n';
import { Badge, Button, IconButton } from '../../components/ui';

function actionLabel(action: PluginAction) { return i18n.t(`tools.plugins.action.${action}`); }
function stateLabel(state: string) { return i18n.t(`tools.plugins.state.${state}`, { defaultValue: state }); }
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
function policyLabel(value: string) { return value.replaceAll('NOT_AVAILABLE', i18n.t('tools.plugins.policyNotAvailable')).replaceAll('AVAILABLE', i18n.t('tools.plugins.policyAvailable')).replaceAll('REQUIRED', i18n.t('tools.plugins.policyRequired')).replaceAll('FORBIDDEN', i18n.t('tools.plugins.policyForbidden')).replaceAll('ON_INSTALL', i18n.t('tools.plugins.policyOnInstall')).replaceAll('NONE', i18n.t('tools.plugins.policyNone')); }
function scopeLabel(scope: string) { return i18n.t(`tools.plugins.scope.${scope}`, { defaultValue: scope }); }
function statusLabel(entry: PluginEntry) {
  if (entry.state === 'not_installed' || entry.state === 'inventory_pending') return stateLabel(entry.state);
  if (entry.enabled === null) return i18n.t('tools.plugins.stateUnknown');
  return entry.enabled ? i18n.t('tools.plugins.enabled') : i18n.t('tools.plugins.disabled');
}
function statusTone(entry: PluginEntry) { return entry.state === 'not_installed' ? 'idle' : entry.enabled === true ? 'on' : entry.enabled === false ? 'off' : 'unknown'; }
function sourceProblem(source: string) {
  if (!source) return 'sourceRequired';
  if (source.startsWith('-')) return 'sourceDash';
  if (/[\u0000-\u001f\u007f]/.test(source)) return 'sourceControl';
  if (source.length > 2048) return 'sourceTooLong';
  return null;
}

/** Bundled item kinds in the order the detail lists them; unknown kinds follow, labelled raw. */
const kindOrder = ['agents', 'skills', 'commands', 'mcp', 'hooks', 'rules', 'prompts', 'extensions', 'themes'];
const kindIcons: Record<string, IconName> = { agents: 'user', skills: 'sparkle', commands: 'command', mcp: 'server', hooks: 'branch', rules: 'shield', prompts: 'clipboard', extensions: 'plug', themes: 'sliders' };
function kindLabel(kind: string) { return i18n.t(`tools.plugins.kind.${kind}`, { defaultValue: kind }); }
function kindIcon(kind: string): IconName { return kindIcons[kind] ?? 'package'; }
function kindRank(kind: string) { const index = kindOrder.indexOf(kind); return index < 0 ? kindOrder.length : index; }
function sortedKinds(kinds: Iterable<string>) { return [...new Set(kinds)].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b)); }
/** The tab a bundled item can be opened in, when this CLI has one. */
function tabFor(kind: string): 'agents' | 'skills' | null { return kind === 'agents' ? 'agents' : kind === 'skills' ? 'skills' : null; }
/** `name@marketplace` ids carry the marketplace; other sources are shown as their folder or package. */
function origin(entry: PluginEntry) {
  const at = entry.id.lastIndexOf('@');
  if (at > 0 && !/[\\/]/.test(entry.id)) return entry.id.slice(at + 1);
  return displayPath(entry.source);
}
function initials(name: string) { return (name.match(/[A-Za-z0-9\u4e00-\u9fff]/)?.[0] ?? '?').toUpperCase(); }
function codeFormat(format: string): CodeFormat { return (['json', 'toml', 'yaml', 'markdown', 'javascript'].includes(format) ? format : 'text') as CodeFormat; }

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
type ContentsState = { status: 'loading' } | { status: 'ready'; value: PluginContents } | { status: 'error'; error: string };
type Preview = { item: PluginItem; file: PluginFile | null; error: string };

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

export function PluginsWorkspace({ toolId, scope, projectPath, contextId, remoteTargetId = null, focusPlugin = null, onOpenItem, openTabs = [] }: {
  toolId: string; scope: Scope; projectPath: string; contextId: string | null; remoteTargetId?: string | null;
  /** Selects this plugin once it is listed (a jump from an item it owns). */
  focusPlugin?: { id: string; token: number } | null;
  /** Opens a bundled agent or skill in its own tab. Absent when that tab is unavailable. */
  onOpenItem?: (tab: 'agents' | 'skills', path: string) => void;
  /** Tabs this CLI shows, so a jump is offered only where it can land. */
  openTabs?: Array<'agents' | 'skills'>;
}) {
  const { t } = useTranslation();
  const remoteReads = useRemoteReads(remoteTargetId, JSON.stringify([toolId, scope, projectPath]), true);
  const native = remoteReads.native;
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const cacheKey = JSON.stringify([remoteReads.identity, target]);
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null);
  const [source, setSource] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const { setError, setNotice } = useFeedback();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [contents, setContents] = useState<Record<string, ContentsState>>({});
  const [kindFilter, setKindFilter] = useState('all');
  const [preview, setPreview] = useState<Preview | null>(null);
  const generation = useRef(0);
  const operationId = useRef(0);
  const refreshing = useRef(false);
  const previewRequest = useRef(0);
  const sourceInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const accountLabel = useAccountLabels(!!remoteTargetId);
  const entries = snapshot?.entries ?? [];
  const needle = search.trim().toLocaleLowerCase();
  const filtered = entries.filter(entry => `${entry.name} ${entry.source} ${entry.id}`.toLocaleLowerCase().includes(needle) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled === true : entry.enabled === false)));
  const installedCount = entries.filter(entry => entry.state !== 'not_installed').length;
  const filteredInstalledCount = filtered.filter(entry => entry.state !== 'not_installed').length;
  const sourceIssue = sourceProblem(source.trim());
  const canInstall = !!snapshot?.baseline && snapshot.capability.actions.includes('install');
  const offersInstall = !!snapshot?.capability.actions.includes('install') && !remoteTargetId;
  const blockProjectUpdate = uiAdapterFor(toolId).plugins?.projectUpdate === false && scope === 'project';
  const installLabel = uiAdapterFor(toolId).plugins?.installLabel ?? t('tools.plugins.installDefault');
  const working = operations.some(item => item.status === 'queued' || item.status === 'running');
  const jumpTab = (kind: string) => { const tab = tabFor(kind); return tab && onOpenItem && openTabs.includes(tab) ? tab : null; };

  useEffect(() => {
    const id = ++generation.current;
    setSnapshot(null); setError(''); setNotice(''); setBusy(true); setStale(false); setSelectedKey(null); setOperations([]); setTrusted(false); setContents({}); setPreview(null); setInstallOpen(false);
    const cached = !remoteTargetId ? remembered.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.at < 30_000) { setSnapshot(cached.snapshot); setBusy(false); return () => { generation.current++; }; }
    // Retain a previous inventory while revalidating; operations still scan
    // again before applying a mutation.
    if (cached) setSnapshot(cached.snapshot);
    let completed = false;
    const readRemote = () => native.getRemoteResourceStore(remoteTargetId!, toolId, 'plugins').then(value => (value as { snapshot?: PluginSnapshot }).snapshot ?? { target, capability: { version: 'remote', sources: '', actions: [], project: false, detail: '远程主机资源' }, entries: [], baseline: 'remote', detail: '' });
    if (!remoteTargetId && !cached) void native.previewNativePlugins(target).then(value => { if (value && !completed && id === generation.current) setSnapshot(value); }).catch(() => { /* The authoritative scan reports errors; preview is optional. */ });
    void (remoteTargetId ? readRemote() : scanOnce(target)).then(value => { if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); setStale(false); } }).catch(value => { if (id === generation.current) { remembered.delete(cacheKey); setStale(true); setError(message(value)); } }).finally(() => { completed = true; if (id === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [target, remoteTargetId]);

  useEffect(() => {
    // Remote plugin inventory is currently read-only. Never fall through to
    // the native plugin scanner or installer when a remote host is selected.
    if (remoteTargetId) return;
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
        // Installed, updated or removed packages change what they bundle.
        setContents({});
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

  const wasVisible = useRef(remoteReads.active);
  useEffect(() => {
    const reopened = remoteReads.active && !wasVisible.current; wasVisible.current = remoteReads.active;
    if (reopened && remoteTargetId) void refresh(false);
  }, [remoteReads.active]);

  async function refresh(fresh = true) {
    if (refreshing.current || busy || working) return;
    const id = generation.current;
    refreshing.current = true;
    setBusy(true); setError('');
    try {
      const value = remoteTargetId
        ? ((await native.getRemoteResourceStore(remoteTargetId, toolId, 'plugins', { fresh }) as { snapshot?: PluginSnapshot }).snapshot ?? snapshot ?? { target, capability: { version: 'remote', sources: '', actions: [], project: false, detail: '远程主机资源' }, entries: [], baseline: 'remote', detail: '' })
        : await native.scanNativePlugins(target);
      if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); setStale(false); setContents({}); }
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
    if (action === 'install') setInstallOpen(false);
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
  function openInstall() { setInstallOpen(true); requestAnimationFrame(() => sourceInput.current?.focus()); }
  const pluginKey = (entry: PluginEntry) => `${entry.scope}:${entry.id}`;
  const opened = filtered.find(entry => pluginKey(entry) === selectedKey) ?? null;
  const contentsKey = opened && snapshot ? `${pluginKey(opened)}|${snapshot.baseline}` : '';
  const openedContents = contentsKey ? contents[contentsKey] : undefined;
  const inspectable = !!opened && !remoteTargetId && opened.state !== 'not_installed' && (!!opened.root || opened.resources.length > 0);
  useEffect(() => {
    if (selectedKey || !restoreFocus.current) return;
    const key = restoreFocus.current;
    restoreFocus.current = null;
    document.querySelector<HTMLButtonElement>(`[data-plugin-key="${CSS.escape(key)}"]`)?.focus();
  }, [selectedKey]);
  // Each plugin opens on its full contents, never on another plugin's file preview.
  useEffect(() => { setKindFilter('all'); setPreview(null); previewRequest.current++; }, [selectedKey]);
  // The bundled items are read once per plugin and scan baseline, after the plugin is opened.
  useEffect(() => {
    if (!opened || !inspectable || !contentsKey || contents[contentsKey]) return;
    const id = generation.current;
    const key = contentsKey;
    setContents(current => ({ ...current, [key]: { status: 'loading' } }));
    void native.inspectNativePlugin(target, opened.id)
      .then(value => { if (id === generation.current) setContents(current => ({ ...current, [key]: { status: 'ready', value } })); })
      .catch(value => { if (id === generation.current) setContents(current => ({ ...current, [key]: { status: 'error', error: message(value) } })); });
  }, [contentsKey, inspectable, !!openedContents]);
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focusPlugin || appliedFocus.current === focusPlugin.token || !snapshot) return;
    const entry = entries.find(item => item.id === focusPlugin.id);
    if (!entry) return;
    appliedFocus.current = focusPlugin.token;
    setSearch(''); setFilter('all'); setSelectedKey(pluginKey(entry));
  }, [focusPlugin, snapshot]);

  async function openPreview(item: PluginItem) {
    if (!opened) return;
    const request = ++previewRequest.current;
    setPreview({ item, file: null, error: '' });
    try {
      const file = await native.readNativePluginFile(target, opened.id, item.path);
      if (request === previewRequest.current) setPreview({ item, file, error: '' });
    } catch (value) {
      if (request === previewRequest.current) setPreview({ item, file: null, error: message(value) });
    }
  }
  function reveal(entry: PluginEntry, path: string | null) {
    void native.revealNativePluginPath(target, entry.id, path).catch(value => setError(message(value)));
  }

  const showFailed = !busy && (!snapshot || (stale && !snapshot.baseline));
  const showEmpty = !!snapshot?.baseline && entries.length === 0 && !busy && !stale;
  const countText = snapshot ? `${snapshot.baseline ? '' : t('tools.plugins.discoveredPrefix')}${filteredInstalledCount === installedCount ? t('tools.plugins.count', { count: installedCount }) : t('tools.plugins.countFiltered', { filtered: filteredInstalledCount, total: installedCount })}` : undefined;
  const operation = opened ? operationFor(opened) : undefined;

  const installDialog = offersInstall && snapshot ? <GuideDialog open={installOpen} title={t('tools.plugins.installTitle')} hint={t('tools.plugins.installHint')} onClose={() => setInstallOpen(false)}>
    <form className={styles.install} onSubmit={event => { event.preventDefault(); void operate('install'); }}>
      <label className={styles.installField}>{t('tools.plugins.source')}
        <input ref={sourceInput} aria-label={t('tools.plugins.source')} value={source} spellCheck={false} onChange={event => { setSource(event.target.value); setTrusted(false); }} placeholder={snapshot.capability.sources} aria-invalid={!!source && !!sourceIssue} aria-describedby="plugin-source-hint plugin-source-error" />
      </label>
      <p id="plugin-source-hint" className={styles.installHint}><Icon name="info" size={13} />{t('tools.plugins.sourceHint', { sources: snapshot.capability.sources })}</p>
      {source && sourceIssue && <p id="plugin-source-error" className={styles.fieldError} role="alert">{t(`tools.plugins.${sourceIssue}`)}</p>}
      <label className={styles.trust} data-checked={trusted || undefined}>
        <input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} />
        <span><strong>{t('tools.plugins.trustTitle')}</strong><small>{t('tools.plugins.trust')}{uiAdapterFor(toolId).plugins?.projectTrust && scope === 'project' ? t('tools.plugins.trustProject') : ''}</small></span>
      </label>
      <div className={styles.installActions}>
        <Button type="button" onClick={() => setInstallOpen(false)}>{t('common.dialog.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!source.trim() || !trusted || !!sourceIssue || !canInstall}>{installLabel}</Button>
      </div>
    </form>
  </GuideDialog> : null;

  const contentsSection = opened ? (() => {
    if (!inspectable) return opened.resources.length ? <section className={styles.section} aria-label={t('tools.plugins.contentsTitle')}>
      <h4>{t('tools.plugins.contentsTitle')}</h4>
      <ul className={styles.folders}>{opened.resources.map(resource => <li key={resource.path}><span className={styles.kindGlyph} aria-hidden="true"><Icon name={kindIcon(resource.kind)} size={14} /></span><strong>{kindLabel(resource.kind)}</strong><code>{displayPath(resource.path)}</code></li>)}</ul>
    </section> : null;
    if (!openedContents || openedContents.status === 'loading') return <section className={styles.section} aria-label={t('tools.plugins.contentsTitle')} aria-busy="true"><h4>{t('tools.plugins.contentsTitle')}</h4><div role="status" aria-label={t('tools.plugins.contentsLoading')}><SkeletonRows count={3} /></div></section>;
    if (openedContents.status === 'error') return <section className={styles.section} aria-label={t('tools.plugins.contentsTitle')}><h4>{t('tools.plugins.contentsTitle')}</h4><div className={styles.contentsError} role="alert"><Icon name="alert" size={15} /><span>{t('tools.plugins.contentsFailed')} {openedContents.error}</span><Button size="sm" onClick={() => setContents(current => { const next = { ...current }; delete next[contentsKey]; return next; })}>{t('tools.plugins.retry')}</Button></div></section>;
    const items = openedContents.value.items;
    const kinds = sortedKinds(items.map(item => item.kind));
    const shown = kindFilter === 'all' ? items : items.filter(item => item.kind === kindFilter);
    return <section className={styles.section} aria-label={t('tools.plugins.contentsTitle')}>
      <div className={styles.sectionHead}><h4>{t('tools.plugins.contentsTitle')}</h4>{items.length > 0 && <span className={styles.sectionCount}>{t('tools.plugins.itemCount', { count: items.length })}</span>}</div>
      {items.length === 0 ? <p className={styles.muted}>{t('tools.plugins.noResources')}</p> : <>
        {kinds.length > 1 && <div className={styles.kindTabs} role="group" aria-label={t('tools.plugins.kindFilter')}>
          <button type="button" aria-pressed={kindFilter === 'all'} onClick={() => setKindFilter('all')}>{t('tools.plugins.kindAll')}<span>{items.length}</span></button>
          {kinds.map(kind => <button type="button" key={kind} aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}><Icon name={kindIcon(kind)} size={13} />{kindLabel(kind)}<span>{items.filter(item => item.kind === kind).length}</span></button>)}
        </div>}
        <ul className={styles.items} aria-label={t('tools.plugins.itemsLabel')}>{shown.map(item => {
          const tab = jumpTab(item.kind);
          return <li key={`${item.kind}:${item.path}:${item.name}`} className={styles.item}>
            <button type="button" className={styles.itemMain} title={displayPath(item.path)} onClick={() => void openPreview(item)}>
              <span className={styles.kindGlyph} data-kind={item.kind} aria-hidden="true"><Icon name={kindIcon(item.kind)} size={15} /></span>
              <span className={styles.itemCopy}>
                <strong>{item.name}</strong>
                <small>{item.kind === 'hooks' && item.description ? t('tools.plugins.hookHandlers', { count: Number(item.description) }) : item.description || kindLabel(item.kind)}</small>
              </span>
            </button>
            {tab && <Button size="sm" variant="ghost" className={styles.itemJump} title={t(`tools.plugins.openIn.${tab}`)} onClick={() => onOpenItem!(tab, item.location)}>{t(`tools.plugins.openIn.${tab}`)}<Icon name="arrowUpRight" size={13} /></Button>}
          </li>;
        })}</ul>
        {openedContents.value.truncated && <p className={styles.muted}>{t('tools.plugins.itemsTruncated')}</p>}
      </>}
    </section>;
  })() : null;

  const manifest = openedContents?.status === 'ready' ? openedContents.value.manifest : null;
  const previewView = opened && preview ? <div className={styles.preview}>
    <div className={styles.previewBar}>
      <Button size="sm" variant="ghost" icon={<Icon name="arrowLeft" size={14} />} onClick={() => { previewRequest.current++; setPreview(null); }}>{t('tools.plugins.backToPlugin')}</Button>
      <span className={styles.previewTitle}><span className={styles.kindGlyph} data-kind={preview.item.kind} aria-hidden="true"><Icon name={kindIcon(preview.item.kind)} size={14} /></span><strong>{preview.item.name}</strong><Badge>{kindLabel(preview.item.kind)}</Badge></span>
      <span className={styles.previewTools}>
        {jumpTab(preview.item.kind) && <Button size="sm" onClick={() => onOpenItem!(jumpTab(preview.item.kind)!, preview.item.location)}>{t(`tools.plugins.openIn.${jumpTab(preview.item.kind)}`)}</Button>}
        <IconButton size="sm" className={doc.iconButton} aria-label={t('tools.plugins.revealFile')} title={t('tools.plugins.revealFile')} onClick={() => reveal(opened, preview.item.path)} icon={<Icon name="folder" size={15} />} />
      </span>
    </div>
    <div className={styles.previewPath}><PathLine path={preview.item.path} /></div>
    {preview.error ? <p className={styles.contentsError} role="alert"><Icon name="alert" size={15} /><span>{preview.error}</span></p>
      : !preview.file ? <div className={styles.previewLoading} role="status" aria-label={t('tools.plugins.previewLoading')}><SkeletonRows count={4} /></div>
      : <>
        {preview.file.truncated && <p className={doc.strip} data-tone="warn"><Icon name="alert" size={14} /><span>{t('tools.plugins.previewTruncated')}</span></p>}
        {preview.file.format === 'markdown'
          ? <DocumentReader text={preview.file.content} format="markdown" label={t('tools.plugins.previewLabel', { name: preview.item.name })} />
          : <div className={doc.editor} data-readonly><CodeEditor label={t('tools.plugins.previewLabel', { name: preview.item.name })} format={codeFormat(preview.file.format)} value={preview.file.content} readOnly documentId={preview.file.path} /></div>}
      </>}
  </div> : null;

  return <>{installDialog}<DocumentWorkspace documentKey={preview ? `${selectedKey}|${preview.item.path}|${preview.item.name}` : selectedKey} label={t('tools.plugins.label')} toolbarLabel={t('tools.plugins.toolbar')} backLabel={t('common.dialog.back')} onBack={closeDetails}
    heading={t('tools.plugins.title')}
    count={countText}
    actions={<>
      <IconButton size="sm" className={doc.iconButton} aria-label={t('tools.plugins.rescan')} title={t('tools.plugins.rescan')} disabled={busy || working} data-spinning={(busy && !!snapshot) || undefined} onClick={() => void refresh()} icon={<Icon name="refresh" size={15} />} />
      {offersInstall && <IconButton size="sm" variant="primary" aria-label={t('tools.plugins.installTitle')} title={t('tools.plugins.installTitle')} disabled={!canInstall} onClick={openInstall} icon={<Icon name="plus" size={16} />} />}
    </>}
    search={snapshot ? <SearchField type="search" label={t('tools.plugins.searchLabel')} placeholder={t('tools.plugins.searchPlaceholder')} value={search} onChange={setSearch} /> : undefined}
    filters={snapshot ? <select className={panel.filter} aria-label={t('tools.plugins.filterLabel')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t('tools.plugins.filterAll')}</option><option value="enabled">{t('tools.plugins.enabled')}</option><option value="disabled">{t('tools.plugins.disabled')}</option><option value="readonly">{t('tools.plugins.filterReadonly')}</option></select> : undefined}
    notices={<><RemoteReadStatus state={remoteReads} />
      {busy && snapshot && <p className={panel.progress} role="status">{snapshot.baseline ? t('tools.plugins.refreshing') : t('tools.plugins.verifying')}</p>}
      {stale && snapshot?.baseline && <div className={panel.staleNotice} role="status"><strong>{t('tools.plugins.staleTitle')}</strong><span>{t('tools.plugins.staleDetail')}</span><Button size="sm" disabled={busy || working} onClick={() => void refresh()}>{t('tools.plugins.rescan')}</Button></div>}
      {operations.length > 0 && <div className={panel.queue} aria-label={t('tools.plugins.queueLabel')}><div className={panel.queueTitle}><strong>{t('tools.plugins.queueTitle')}</strong><span>{t('tools.plugins.queueSerial')}</span></div>{operations.map(item => <div className={panel.queueRow} key={item.id} data-state={item.status}><span><strong>{actionLabel(item.action)} · {item.name}</strong>{item.detail && <small>{item.detail}</small>}</span><span className={panel.queueState}>{t(`tools.plugins.operationState.${item.status}`)}</span>{item.status === 'queued' && <button type="button" onClick={() => setOperations(current => current.filter(entry => entry.id !== item.id))}>{t('tools.plugins.cancelQueued')}</button>}{item.status === 'failed' && <button type="button" disabled={item.action === 'install' && (!source.trim() || !trusted || !!sourceIssue || !canInstall)} onClick={() => { if (item.action === 'install') { void operate('install'); return; } setError(''); setOperations(current => current.map(entry => entry.id === item.id ? { ...entry, status: 'queued', detail: undefined } : entry)); }}>{t('tools.plugins.retry')}</button>}{item.status === 'succeeded' && item.entryId === null && <button type="button" onClick={() => setOperations(current => current.filter(entry => entry.id !== item.id))}>{t('tools.plugins.dismiss')}</button>}</div>)}</div>}
    </>}
    listFooterLabel={t('tools.plugins.compatSummary')}
    listFooter={snapshot ? <>
      <span className={panel.context}><Badge>{scope === 'global' ? scopeLabel('user') : projectPath}</Badge><Badge>{accountLabel(contextId)}</Badge></span>
      <details className={panel.compatibility}><summary>{t('tools.plugins.compatSummary')}</summary><p>{t('tools.plugins.compatVersion', { version: snapshot.capability.version, detail: snapshot.capability.detail })}</p><p>{snapshot.detail}</p></details>
    </> : undefined}
    list={<div className={panel.listWrap}>
      {busy && !snapshot && <div role="status" aria-label={t('tools.plugins.loading')}><SkeletonRows count={3} /></div>}
      {showFailed && <EmptyState title={t('tools.plugins.loadFailedTitle')} detail={t('tools.plugins.loadFailedDetail')} action={<Button variant="primary" onClick={() => void refresh()}>{t('tools.plugins.rescan')}</Button>} />}
      {showEmpty && <EmptyState title={t('tools.plugins.emptyTitle')} detail={[canInstall ? t('tools.plugins.emptyInstallable') : t('tools.plugins.emptyNone'), snapshot?.detail, canInstall ? '' : snapshot?.capability.detail].filter(Boolean).join(' ')} action={canInstall
        ? <Button variant="primary" onClick={openInstall}>{installLabel}</Button>
        : <Button variant="primary" disabled={busy} onClick={() => void refresh()}>{t('tools.plugins.rescan')}</Button>} />}
      {!showFailed && !showEmpty && filtered.length === 0 && entries.length > 0 && <div className={panel.noMatch}><strong>{t('tools.plugins.noMatch')}</strong><p>{t('tools.plugins.noMatchDetail')}</p><button type="button" onClick={clearFilters}>{t('tools.plugins.clearFilter')}</button></div>}
      {filtered.length > 0 && <ul className={doc.rows} aria-label={t('tools.plugins.title')}>{filtered.map(entry => {
        const key = pluginKey(entry);
        const pendingOperation = operationFor(entry);
        const kinds = sortedKinds(entry.resources.map(resource => resource.kind));
        return <li key={key}><button type="button" className={`${doc.row} ${styles.row}`} data-plugin-key={key} data-status={statusTone(entry)} aria-current={opened && pluginKey(opened) === key ? 'true' : undefined} onClick={() => setSelectedKey(key)}>
          <span className={styles.monogram} aria-hidden="true">{initials(entry.name)}</span>
          <span className={styles.rowCopy}>
            <span className={styles.rowTitle}><strong>{entry.name}</strong>{entry.version && <small>{entry.version}</small>}</span>
            <span className={doc.rowSummary}>{displayPath(entry.source)} · {scopeLabel(entry.scope)}</span>
            <span className={styles.rowMeta}>
              <span className={styles.status} data-status={statusTone(entry)}>{statusLabel(entry)}</span>
              {kinds.length > 0 && <span className={styles.kindMarks} title={kinds.map(kindLabel).join(' · ')}>{kinds.slice(0, 5).map(kind => <Icon key={kind} name={kindIcon(kind)} size={13} />)}<span className="sr-only">{kinds.map(kindLabel).join(' · ')}</span></span>}
              {entry.readOnly && <span className={styles.lock} title={snapshot?.baseline ? t('tools.plugins.readonly') : t('tools.plugins.pendingReview')}><Icon name="lock" size={12} />{snapshot?.baseline ? t('tools.plugins.readonly') : t('tools.plugins.pendingReview')}</span>}
              {pendingOperation && <Badge tone="warning">{t(`tools.plugins.operationState.${pendingOperation.status}`)}</Badge>}
            </span>
          </span>
        </button></li>;
      })}</ul>}
    </div>}
    placeholder={snapshot && entries.length > 0 && !opened ? <div className={styles.placeholder}>
      <span className={doc.placeholderIcon} aria-hidden="true"><Icon name="package" size={22} /></span>
      <strong>{t('tools.plugins.selectHint')}</strong>
      <p>{t('tools.plugins.selectDetail')}</p>
      <dl className={styles.overview}>
        <div><dt>{t('tools.plugins.overviewInstalled')}</dt><dd>{installedCount}</dd></div>
        <div><dt>{t('tools.plugins.enabled')}</dt><dd>{entries.filter(entry => entry.enabled === true).length}</dd></div>
        <div><dt>{t('tools.plugins.disabled')}</dt><dd>{entries.filter(entry => entry.enabled === false).length}</dd></div>
      </dl>
      {offersInstall && <Button variant="primary" icon={<Icon name="plus" size={14} />} disabled={!canInstall} onClick={openInstall}>{installLabel}</Button>}
    </div> : null}
    document={opened ? <article className={doc.doc} aria-label={t('tools.plugins.detailsLabel')}>
      <DocumentHeader
        title={opened.name}
        badges={<>
          <span className={styles.status} data-status={statusTone(opened)}>{statusLabel(opened)}</span>
          {opened.version && <Badge className={styles.version}>{opened.version}</Badge>}
          {opened.readOnly && <Badge><Icon name="lock" size={11} />{t('tools.plugins.readonly')}</Badge>}
          {operation && <Badge tone="warning">{t(`tools.plugins.operationState.${operation.status}`)}</Badge>}
        </>}
        tools={<>
          {entryActions(opened).map(action => <Button size="sm" key={action} variant={action === 'uninstall' ? 'ghost' : action === 'update' ? 'secondary' : action === 'enable' ? 'primary' : 'secondary'} className={action === 'uninstall' ? styles.danger : undefined} title={opened.readOnly ? policyLabel(opened.policy) : action === 'update' && blockProjectUpdate ? t('tools.plugins.updateProjectTitle') : operation ? t('tools.plugins.sameItemPending') : undefined} disabled={!snapshot?.baseline || !!operation || opened.readOnly || (action === 'update' && blockProjectUpdate)} onClick={() => void operate(action, opened)}>{actionLabel(action)}</Button>)}
          <IconButton size="sm" className={doc.iconButton} aria-label={t('tools.plugins.closeDetails')} title={t('tools.plugins.closeDetails')} onClick={closeDetails} icon={<Icon name="close" size={15} />} />
        </>}
        meta={<span className={styles.meta}>
          <span><Icon name="package" size={12} />{origin(opened)}</span>
          <span>{scopeLabel(opened.scope)}</span>
          {manifest?.author && <span><Icon name="user" size={12} />{manifest.author}</span>}
          {manifest?.license && <span>{manifest.license}</span>}
        </span>}
        metaActions={manifest?.homepage ? <Button size="sm" variant="ghost" className={doc.ghostButton} onClick={() => void native.openExternalUrl(manifest.homepage!).catch(value => setError(message(value)))}><Icon name="globe" size={13} />{t('tools.plugins.homepage')}</Button> : undefined}
      />
      {previewView ?? <div className={doc.body}><div className={styles.detail}>
        <section className={styles.hero} aria-label={t('tools.plugins.aboutLabel')}>
          <p className={manifest?.description ? styles.description : styles.muted}>{manifest?.description ?? (inspectable && openedContents?.status !== 'ready' ? '\u00a0' : t('tools.plugins.noDescription'))}</p>
          {manifest && manifest.keywords.length > 0 && <span className={styles.keywords}>{manifest.keywords.map(word => <span key={word}>{word}</span>)}</span>}
          <dl className={styles.facts}>
            <div><dt>{t('tools.plugins.version')}</dt><dd>{opened.version ?? t('tools.plugins.versionMissing')}</dd></div>
            <div><dt>{t('tools.plugins.source')}</dt><dd title={displayPath(opened.source)}>{displayPath(opened.source)}</dd></div>
            <div><dt>{t('tools.plugins.scopeLabel')}</dt><dd>{scopeLabel(opened.scope)}</dd></div>
            <div><dt>{t('tools.plugins.loadState')}</dt><dd>{stateLabel(opened.state)}</dd></div>
          </dl>
        </section>
        {contentsSection}
        <section className={styles.section} aria-label={t('tools.plugins.locationSummary')}>
          <div className={styles.sectionHead}><h4>{t('tools.plugins.locationSummary')}</h4>{opened.root && !remoteTargetId && <Button size="sm" variant="ghost" className={doc.ghostButton} onClick={() => reveal(opened, null)}><Icon name="folder" size={13} />{t('tools.plugins.revealFolder')}</Button>}</div>
          {opened.root ? <PathLine path={opened.root} /> : <p className={styles.muted}>{t('tools.plugins.notProvided')}</p>}
        </section>
        <details className={styles.policy}>
          <summary>{t('tools.plugins.policySummary')}</summary>
          <p>{policyLabel(opened.policy)}{opened.readOnly ? t('tools.plugins.readonlySuffix') : ''}</p>
        </details>
        {opened.readOnly && <p className={panel.readonlyNote}>{t('tools.plugins.readonlyDetail')}</p>}
        {blockProjectUpdate && entryActions(opened).includes('update') && <p className={panel.readonlyNote}>{t('tools.plugins.updateProjectTitle')}</p>}
      </div></div>}
    </article> : null}
  /></>;
}
