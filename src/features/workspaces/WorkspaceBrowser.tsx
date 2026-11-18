import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { confirmAction } from '../../lib/confirm';
import { Badge, Button, Toolbar } from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { ToolIcon } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import type { AdapterDescriptor } from '../../types/native';
import type { BusinessWorkspace, WorkspaceCandidate, WorkspaceManifestPreview, WorkspaceRepository } from '../../types/workspaces';
import styles from './WorkspaceBrowser.module.css';

export const WORKSPACES_CHANGED = 'cliora:business-workspaces-changed';
export const WORKSPACE_MANIFEST_OPEN = 'cliora:workspace-manifest-open';
export function notifyWorkspacesChanged() { window.dispatchEvent(new Event(WORKSPACES_CHANGED)); }
const failure = (value: unknown) => formatFailure(value, '项目操作失败', '请重试');

/** Worktree choices of one repository: its main checkout first, then attached worktrees. */
export function repositoryPlaces(repository: WorkspaceRepository, mainLabel: string, worktreeLabel: string) {
  const places = new Map<string, { label: string; main: boolean }>();
  for (const location of repository.locations.filter(item => item.available && item.path)) {
    const main = location.worktrees.find(tree => tree.path === location.path);
    places.set(location.path!, { label: main?.branch || mainLabel, main: true });
    for (const tree of location.worktrees) if (tree.path !== location.path) places.set(tree.path, { label: `${tree.branch || tree.name} · ${worktreeLabel}`, main: false });
  }
  return places;
}

export function WorkspaceBrowser({ tools = [], onSession, incomingManifest, onManifestConsumed }: { tools?: AdapterDescriptor[]; incomingManifest?: WorkspaceManifestPreview | null; onManifestConsumed?: (preview: WorkspaceManifestPreview) => void; onSession?: (id: string) => void }) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<BusinessWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'favorites' | 'attention'>('all');
  const listRef = useRef<HTMLDivElement>(null);
  const [toolId, setToolId] = useState('');
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [editName, setEditName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [candidates, setCandidates] = useState<WorkspaceCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [partial, setPartial] = useState(false);
  const [scanQuery, setScanQuery] = useState('');
  const [preview, setPreview] = useState<WorkspaceManifestPreview | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  useEffect(() => {
    if (!incomingManifest) return;
    setPreview(incomingManifest);
    // Handoff is one-shot. Local cancellation/acceptance must not leave a parent intent
    // that reopens the same (possibly stale) preview when this page mounts again.
    onManifestConsumed?.(incomingManifest);
  }, [incomingManifest, onManifestConsumed]);
  const scanId = useRef<string | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const current = workspaces.find(item => item.id === selectedId) ?? null;
  const enabledTools = tools.filter(tool => tool.launch?.state !== 'unsupported' && tool.launch?.state !== 'planned');
  const launchTool = enabledTools.find(tool => tool.id === toolId)?.id ?? enabledTools[0]?.id ?? '';
  const reload = useCallback(async (refreshSource = false) => {
    if (!nativeAvailable) return;
    const seq = ++sequence.current;
    setLoading(true);
    try {
      // A background source refresh that cannot run now (for example another window holds the
      // manifest) keeps the last list; the project shows its own source status when it matters.
      if (refreshSource && selectedRef.current) await native.refreshWorkspaceManifest(selectedRef.current).catch(() => undefined);
      const result = await native.listBusinessWorkspaces();
      if (!mounted.current || seq !== sequence.current) return;
      const rows = Array.isArray(result) ? result : [];
      setWorkspaces(rows);
      setSelectedId(previous => rows.some(item => item.id === previous) ? previous : rows[0]?.id ?? '');
      setLoadError('');
    } catch (value) { if (mounted.current && seq === sequence.current) setLoadError(failure(value)); }
    finally { if (mounted.current && seq === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const changed = () => void reload();
    const focused = () => void reload(true);
    window.addEventListener(WORKSPACES_CHANGED, changed);
    window.addEventListener('focus', focused);
    return () => { mounted.current = false; sequence.current++; window.removeEventListener(WORKSPACES_CHANGED, changed); window.removeEventListener('focus', focused); if (scanId.current) void native.cancelWorkspaceScan(scanId.current); };
  }, [reload]);
  useEffect(() => {
    if (!selectedId || !nativeAvailable) return;
    let live = true;
    void native.refreshWorkspaceManifest(selectedId).then(value => {
      if (live && value) setWorkspaces(previous => previous.map(item => item.id === value.id ? value : item));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [selectedId]);
  useEffect(() => {
    const receive = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path !== 'string') return;
      void native.previewWorkspaceManifest(path).then(value => { if (mounted.current) setPreview(value); }).catch(value => { if (mounted.current) setError(failure(value)); });
    };
    window.addEventListener(WORKSPACE_MANIFEST_OPEN, receive);
    return () => window.removeEventListener(WORKSPACE_MANIFEST_OPEN, receive);
  }, []);

  async function operate(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (mounted.current) { await reload(); notifyWorkspacesChanged(); } }
    catch (value) { if (mounted.current) { await reload(); setError(failure(value)); notifyWorkspacesChanged(); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function chooseManifest() {
    try {
      const path = await open({ multiple: false, filters: [{ name: 'Project workspace', extensions: ['json'] }] });
      if (typeof path === 'string') setPreview(await native.previewWorkspaceManifest(path));
    } catch (value) { setError(failure(value)); }
  }
  async function publish() {
    if (!current) return;
    try {
      const path = await save({ defaultPath: `${current.name}.dev-workspace.json`, filters: [{ name: 'Project workspace', extensions: ['json'] }] });
      if (path) await operate(async () => { await native.exportWorkspaceManifest(current.id, path, current.revision); setNotice(t('workspaces.publishHint')); });
    } catch (value) { setError(failure(value)); }
  }
  async function discover(recursive: boolean) {
    if (!current || busy || scanBusy) return;
    try {
      const chosen = await open({ directory: true, multiple: !recursive, title: t(recursive ? 'workspaces.scanRoot' : 'workspaces.selectRepos') });
      if (!chosen) return;
      const roots = Array.isArray(chosen) ? chosen : [chosen];
      const operationId = crypto.randomUUID(); scanId.current = operationId;
      setCandidates([]); setChecked(new Set()); setPartial(false); setScanQuery(''); setScanBusy(true); setError('');
      const result = await native.scanWorkspaceRepositories(roots, operationId, recursive);
      if (!mounted.current || scanId.current !== operationId) return;
      setCandidates(result.candidates); setPartial(result.partial || result.cancelled);
      setChecked(new Set(result.candidates.filter(item => item.kind === 'repository').map(item => item.path)));
    } catch (value) { if (mounted.current) setError(failure(value)); }
    finally { scanId.current = null; if (mounted.current) setScanBusy(false); }
  }
  async function relink(repository: WorkspaceRepository) {
    if (!current) return;
    try {
      const path = await open({ directory: true, multiple: false, title: t('workspaces.relink') });
      if (typeof path === 'string') await operate(() => native.relinkWorkspaceRepository(current.id, repository.id, path, current.revision));
    } catch (value) { setError(failure(value)); }
  }
  async function deleteProject() {
    if (!current || !await confirmAction(t('workspaces.deleteConfirm', { name: current.name }), () => mounted.current, { title: t('workspaces.deleteProject'), confirmLabel: t('workspaces.deleteProject') })) return;
    const id = current.id;
    await operate(async () => { await native.deleteBusinessWorkspace(id); setSelectedId(previous => previous === id ? '' : previous); setQuery(''); setFilter('all'); setPaths({}); });
  }
  async function remove(repository: WorkspaceRepository) {
    if (!current || !await confirmAction(t('workspaces.removeConfirm', { name: repository.name }), () => mounted.current, { title: t('workspaces.remove'), confirmLabel: t('workspaces.remove') })) return;
    await operate(() => native.removeWorkspaceRepository(current.id, repository.id, current.revision));
  }
  async function pick(repository: WorkspaceRepository) {
    if (!current) return;
    const available = repository.locations.find(location => location.available);
    const directory = paths[repository.id] || available?.path;
    if (!directory || !available) return;
    if (!launchTool) { setError(t('workspaces.chooseTool')); return; }
    const selection = { workspaceId: current.id, repositoryId: repository.id, directory, projectId: available.projectId, label: `${current.name} / ${repository.name}` };
    await operate(async () => {
      const result = await native.launchCli({ ...selection, toolId: launchTool, projectId: available.projectId, sessionId: null, mode: 'normal', worktreeIntent: 'given' });
      if (result.sessionId) onSession?.(result.sessionId);
      else setNotice(t('workspaces.external'));
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
    });
  }
  const allRepositories = current?.repositories ?? [];
  const isBroken = (repo: WorkspaceRepository) => !repo.locations.some(location => location.available);
  const favoriteCount = allRepositories.filter(repo => repo.favorite).length;
  const brokenCount = allRepositories.filter(isBroken).length;
  const activeFilter = filter === 'favorites' && !favoriteCount ? 'all' : filter === 'attention' && !brokenCount ? 'all' : filter;
  const needle = query.trim().toLowerCase();
  // Favorites lead; everything else keeps the project's own order.
  const shown = allRepositories
    .filter(repo => (activeFilter !== 'favorites' || repo.favorite) && (activeFilter !== 'attention' || isBroken(repo)) && `${repo.name} ${repo.locations.map(location => location.path).join(' ')}`.toLowerCase().includes(needle))
    .map((repo, index) => ({ repo, index })).sort((a, b) => Number(b.repo.favorite) - Number(a.repo.favorite) || a.index - b.index).map(item => item.repo);
  const visibleCandidates = (candidates ?? []).filter(item => `${item.name} ${item.path}`.toLowerCase().includes(scanQuery.trim().toLowerCase()));
  const addable = (candidates ?? []).filter(item => item.kind === 'repository');
  const kindTone = { repository: 'success', directory: 'neutral', duplicate: 'neutral', unavailable: 'danger' } as const;
  const kindLabel = { repository: 'workspaces.kindRepository', directory: 'workspaces.kindDirectory', duplicate: 'workspaces.kindDuplicate', unavailable: 'workspaces.kindUnavailable' } as const;
  const startCreate = () => { setRenaming(false); setEditName(''); };
  function moveFocus(event: KeyboardEvent<HTMLElement>, fromSearch = false) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-row-primary]:not(:disabled)') ?? []);
    if (!buttons.length) return;
    if (fromSearch) { if (event.key === 'ArrowDown') { event.preventDefault(); buttons[0].focus(); } return; }
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  }
  const projectMenu = <RowMenu label={t('workspaces.projectActions')}>
    {current && <button type="button" role="menuitem" disabled={busy || scanBusy} onClick={() => void discover(true)}>{t('workspaces.discover')}</button>}
    <button type="button" role="menuitem" disabled={busy} onClick={startCreate}>{t('workspaces.create')}</button>
    {current && <button type="button" role="menuitem" disabled={busy} onClick={() => { setRenaming(true); setEditName(current.name); }}>{t('workspaces.rename')}</button>}
    <button type="button" role="menuitem" disabled={busy} onClick={() => void chooseManifest()}>{t('workspaces.openManifest')}</button>
    {current && !current.manifestPath && <button type="button" role="menuitem" disabled={busy} onClick={() => void publish()}>{t('workspaces.publish')}</button>}
    <button type="button" role="menuitem" disabled={busy || loading} onClick={() => void reload(true)}>{t('workspaces.refresh')}</button>
    {current && <button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void deleteProject()}>{t('workspaces.deleteProject')}</button>}
  </RowMenu>;
  return <section className={styles.block} aria-label={t('workspaces.title')} data-business-workspaces>
    <Toolbar className={styles.heading} title={t('workspaces.title')} count={workspaces.length ? <Badge>{workspaces.length}</Badge> : undefined} />
    <div className={styles.browser}>
    {workspaces.length > 0 && current ? <>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <FilterSelect variant="title" className={styles.select} disabled={busy || scanBusy || candidates !== null} label={t('workspaces.select')} triggerDetail={false} value={selectedId} options={workspaces.map(item => ({ value: item.id, label: item.name, detail: t('workspaces.repositories', { count: item.repositories.length }) }))} onChange={id => { setSelectedId(id); setQuery(''); setPaths({}); setFilter('all'); }} />
          <span className={styles.meta}>
            <span>{t('workspaces.repositories', { count: allRepositories.length })}</span>
            {current.manifestPath
              ? <span className={styles.linked} title={`${current.manifestPath} · ${t('workspaces.version', { revision: current.manifestRevision })}`}><Icon name="link" size={12} />{t('workspaces.linked')}</span>
              : <span>{t('workspaces.local')}</span>}
          </span>
        </div>
        <div className={styles.headerActions}>
          <Button size="sm" variant="primary" disabled={busy || scanBusy} icon={<Icon name="plus" size={14} />} onClick={() => void discover(false)}>{t('workspaces.add')}</Button>
          {projectMenu}
        </div>
      </div>
      {(error || loadError) && <div className={styles.error} role="alert"><Icon name="alert" size={14} /><span>{error || loadError}</span><Button size="sm" variant="ghost" onClick={() => void reload(true)}>{t('workspaces.retry')}</Button><button type="button" className={styles.dismiss} aria-label={t('workspaces.dismiss')} title={t('workspaces.dismiss')} onClick={() => { setError(''); setLoadError(''); }}><Icon name="close" size={13} /></button></div>}
      {current.error && <div className={styles.warning} role="alert"><Icon name="alert" size={14} /><span>{t('workspaces.sourceStale')} {current.error}</span></div>}
      {notice && <p className={styles.notice} role="status"><span>{notice}</span><button type="button" className={styles.dismiss} aria-label={t('workspaces.dismiss')} title={t('workspaces.dismiss')} onClick={() => setNotice('')}><Icon name="close" size={13} /></button></p>}
      {allRepositories.length > 0 ? <>
        <div className={styles.filters}>
          <div className={styles.search} onKeyDown={event => moveFocus(event, true)}><SearchField label={t('workspaces.search')} value={query} onChange={setQuery} placeholder={t('workspaces.search')} /></div>
          {favoriteCount > 0 && <button type="button" className={styles.chip} aria-pressed={activeFilter === 'favorites'} onClick={() => setFilter(activeFilter === 'favorites' ? 'all' : 'favorites')}><Icon name="star" size={12} />{t('workspaces.filterFavorites', { count: favoriteCount })}</button>}
          {brokenCount > 0 && <button type="button" className={styles.chip} data-tone="danger" aria-pressed={activeFilter === 'attention'} title={t('workspaces.attentionHint', { count: brokenCount })} onClick={() => setFilter(activeFilter === 'attention' ? 'all' : 'attention')}><span className={styles.dot} aria-hidden="true" />{t('workspaces.filterAttention', { count: brokenCount })}</button>}
          {enabledTools.length > 0 && <FilterSelect className={styles.toolPick} label={t('workspaces.tool')} value={launchTool} options={enabledTools.map(tool => ({ value: tool.id, label: tool.name, icon: <ToolIcon toolId={tool.id} size={14} /> }))} onChange={setToolId} />}
        </div>
        {shown.length > 0 ? <div className={styles.list} ref={listRef} aria-label={t('workspaces.previewRepositories')} onKeyDown={event => moveFocus(event)}>
          {shown.map(repo => {
            const available = repo.locations.find(location => location.available);
            const places = repositoryPlaces(repo, t('workspaces.mainCheckout'), t('workspaces.worktreeKind'));
            const selectedPath = paths[repo.id] || available?.path || '';
            const broken = !available;
            const missing = repo.locations[0];
            return <article key={repo.id} className={styles.row} data-repository-id={repo.id} data-state={broken ? 'unavailable' : undefined} data-favorite={repo.favorite || undefined}>
              <span className={styles.name}>{broken && <span className={styles.dot} aria-hidden="true" />}<strong title={repo.name}>{repo.name}</strong>{available?.kind === 'legacy' && <Badge>{t('workspaces.legacy')}</Badge>}</span>
              <span className={styles.path} title={broken ? missing?.path ?? '' : selectedPath}>{broken ? <><span>{missing?.path || t('workspaces.invalid')}</span><em>{t('workspaces.unavailable')}{missing?.reason ? ` · ${missing.reason}` : ''}</em></> : selectedPath}</span>
              {places.size > 1 ? <select className={styles.place} aria-label={`${repo.name} ${t('workspaces.worktree')}`} title={selectedPath} value={selectedPath} onChange={event => setPaths(previous => ({ ...previous, [repo.id]: event.target.value }))}>{[...places].map(([path, place]) => <option key={path} value={path}>{place.label}</option>)}</select> : <span />}
              <span className={styles.rowActions}>
                <Button size="sm" variant="ghost" className={styles.favorite} disabled={busy} aria-label={t(repo.favorite ? 'workspaces.unfavorite' : 'workspaces.favorite')} title={t(repo.favorite ? 'workspaces.unfavorite' : 'workspaces.favorite')} aria-pressed={repo.favorite} icon={<Icon name="star" size={14} />} onClick={() => void operate(() => native.favoriteWorkspaceRepository(current.id, repo.id, !repo.favorite))} />
                {broken
                  ? <Button size="sm" data-row-primary disabled={busy} icon={<Icon name="link" size={13} />} onClick={() => void relink(repo)}>{t('workspaces.relink')}</Button>
                  : <Button size="sm" className={styles.launch} data-row-primary disabled={busy || !launchTool} aria-label={t('workspaces.launch')} icon={<Icon name="play" size={12} />} onClick={() => void pick(repo)}>{t('workspaces.launchShort')}</Button>}
                <RowMenu className={styles.rowMenu} label={t('workspaces.repoActions', { name: repo.name })}>
                  {!broken && <button type="button" role="menuitem" disabled={busy} onClick={() => void relink(repo)}>{t('workspaces.relink')}</button>}
                  <button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void remove(repo)}>{t('workspaces.remove')}</button>
                </RowMenu>
              </span>
            </article>;
          })}
        </div> : <div className={styles.empty} role="status"><span>{t('workspaces.noMatches')}</span><Button size="sm" variant="ghost" onClick={() => { setQuery(''); setFilter('all'); }}>{t('workspaces.clearFilters')}</Button></div>}
      </> : <div className={styles.emptyState}><p>{t('workspaces.emptyReposAction')}</p><Button size="sm" variant="ghost" icon={<Icon name="search" size={13} />} disabled={busy || scanBusy} onClick={() => void discover(true)}>{t('workspaces.discover')}</Button></div>}
    </> : <div className={styles.intro}>
      <span className={styles.introIcon} aria-hidden="true"><Icon name="folder" size={18} /></span>
      <div className={styles.introCopy}><strong>{loading ? t('workspaces.loading') : t('workspaces.empty')}</strong><span>{loadError || t('workspaces.hint')}</span></div>
      {!loading && <div className={styles.headerActions}>
        {loadError ? <Button size="sm" onClick={() => void reload(true)}>{t('workspaces.retry')}</Button> : <Button size="sm" variant="primary" disabled={busy} icon={<Icon name="plus" size={14} />} onClick={startCreate}>{t('workspaces.create')}</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void chooseManifest()}>{t('workspaces.openManifest')}</Button>
      </div>}
    </div>}
    </div>
    <GuideDialog open={editName !== null} title={t(renaming ? 'workspaces.rename' : 'workspaces.create')} hint={t(renaming ? 'workspaces.renameHint' : 'workspaces.createHint')} closeDisabled={busy} onClose={() => setEditName(null)}>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); if (!editName?.trim()) return; void operate(async () => { const value = renaming && current ? await native.renameBusinessWorkspace(current.id, editName ?? '', current.revision) : await native.createBusinessWorkspace(editName ?? ''); setSelectedId(value.id); setEditName(null); }); }}>
        <label>{t('workspaces.name')}<input autoFocus value={editName ?? ''} onChange={event => setEditName(event.target.value)} maxLength={160} /></label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer"><Button variant="ghost" disabled={busy} onClick={() => setEditName(null)}>{t('workspaces.cancel')}</Button><Button type="submit" variant="primary" loading={busy} disabled={!editName?.trim()}>{t('workspaces.save')}</Button></div>
      </form>
    </GuideDialog>
    <GuideDialog open={candidates !== null} title={t('workspaces.scanTitle')} hint={t('workspaces.scanHint')} wide closeDisabled={busy} onClose={() => { if (scanId.current) void native.cancelWorkspaceScan(scanId.current); scanId.current = null; setCandidates(null); }}>
      <div className={styles.form}>
        {scanBusy && <div className={styles.scanning} role="status"><span className={styles.spinner} aria-hidden="true" /><span>{t('workspaces.scanning')}</span><Button size="sm" onClick={() => scanId.current && void native.cancelWorkspaceScan(scanId.current)}>{t('workspaces.stop')}</Button></div>}
        {partial && <p className={styles.warning} role="status">{t('workspaces.partial')}</p>}
        {!scanBusy && candidates && candidates.length > 0 && <div className={styles.scanBar}>
          <label className={styles.checkLabel}><input type="checkbox" disabled={!addable.length || busy} checked={checked.size > 0 && checked.size === addable.length} ref={node => { if (node) node.indeterminate = checked.size > 0 && checked.size < addable.length; }} onChange={event => setChecked(event.target.checked ? new Set(addable.map(item => item.path)) : new Set())} />{t('workspaces.selectAll')}</label>
          <span className={styles.muted}>{t('workspaces.scanSummary', { count: candidates.length, available: addable.length })}</span>
          {candidates.length > 6 && <div className={styles.scanSearch}><SearchField label={t('workspaces.search')} value={scanQuery} onChange={setScanQuery} placeholder={t('workspaces.search')} /></div>}
        </div>}
        {!scanBusy && candidates?.length === 0 && <p className={styles.empty}>{t('workspaces.scanEmpty')}</p>}
        {visibleCandidates.length > 0 && <div className={styles.candidates}>{visibleCandidates.map((item, index) => <label key={`${item.path}:${index}`} className={styles.candidate} data-kind={item.kind}>
          <input type="checkbox" disabled={item.kind !== 'repository' || busy} checked={checked.has(item.path)} onChange={event => setChecked(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.path); else next.delete(item.path); return next; })} />
          <span className={styles.candidateCopy}><span className={styles.candidateName}><strong>{item.name}</strong>{item.kind !== 'repository' && <Badge tone={kindTone[item.kind]}>{t(kindLabel[item.kind])}</Badge>}</span><span className={styles.mono}>{item.path}</span>{item.reason && <small>{item.reason}</small>}</span>
        </label>)}</div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer">
          <Button variant="primary" loading={busy} disabled={scanBusy || !checked.size || !current} onClick={() => current && void operate(async () => { const results = await native.addWorkspaceRepositories(current.id, [...checked], current.revision); const failed = results.filter(item => item.error); setNotice(t('workspaces.added', { count: results.length })); if (failed.length) { setChecked(new Set(failed.map(item => item.path))); throw new Error(failed.map(item => `${item.path}: ${item.error}`).join('\n')); } setCandidates(null); })}>{t('workspaces.selected', { count: checked.size })}</Button>
        </div>
      </div>
    </GuideDialog>
    <GuideDialog open={preview !== null} title={t('workspaces.previewTitle')} hint={t('workspaces.previewHint')} wide closeDisabled={busy} onClose={() => setPreview(null)}>
      {preview && <div className={styles.form}>
        <div className={styles.candidateName}><strong className={styles.manifestName}>{preview.manifest.name}</strong><Badge>{t('workspaces.manifestCount', { count: preview.manifest.repositories.length })}</Badge><Badge>{t('workspaces.version', { revision: preview.manifest.revision })}</Badge></div>
        <span className={styles.mono} title={preview.path}>{preview.path}</span>
        {preview.conflict && <p className={styles.warning} role="alert">{t('workspaces.conflict')}</p>}
        <div className={styles.candidates} aria-label={t('workspaces.previewRepositories')}>{preview.manifest.repositories.map(repo => <div className={styles.candidate} key={repo.id}><span className={styles.candidateCopy}><strong>{repo.name}</strong>{repo.locations.map(location => <span className={styles.mono} key={`${location.hostId}:${location.path}`}>{location.path}</span>)}</span></div>)}</div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer"><Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>{t('workspaces.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void operate(async () => { const result = await native.attachWorkspaceManifest(preview.path, preview.digest, preview.conflict); setSelectedId(result.id); setPreview(null); })}>{t(preview.conflict ? 'workspaces.adopt' : 'workspaces.attach')}</Button></div>
      </div>}
    </GuideDialog>
  </section>;
}
