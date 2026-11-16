import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { confirmAction } from '../../lib/confirm';
import { Button } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import type { AdapterDescriptor } from '../../types/native';
import type { BusinessWorkspace, WorkspaceCandidate, WorkspaceManifestPreview, WorkspaceRepository, WorkspaceSelection } from '../../types/workspaces';
import styles from './WorkspaceBrowser.module.css';

export const WORKSPACES_CHANGED = 'cliora:business-workspaces-changed';
export const WORKSPACE_MANIFEST_OPEN = 'cliora:workspace-manifest-open';
export function notifyWorkspacesChanged() { window.dispatchEvent(new Event(WORKSPACES_CHANGED)); }
const failure = (value: unknown) => formatFailure(value, '项目操作失败', '请重试');

export function WorkspaceBrowser({ tools = [], onSession, onPick, incomingManifest, compact = false }: { tools?: AdapterDescriptor[]; incomingManifest?: WorkspaceManifestPreview | null; onSession?: (id: string) => void; onPick?: (selection: WorkspaceSelection) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<BusinessWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
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
  useEffect(() => { if (incomingManifest) setPreview(incomingManifest); }, [incomingManifest]);
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
      if (refreshSource && selectedRef.current) await native.refreshWorkspaceManifest(selectedRef.current);
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
    }).catch(value => { if (live) setLoadError(failure(value)); });
    return () => { live = false; };
  }, [selectedId]);
  useEffect(() => {
    const receive = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path !== 'string' || compact) return;
      void native.previewWorkspaceManifest(path).then(value => { if (mounted.current) setPreview(value); }).catch(value => { if (mounted.current) setError(failure(value)); });
    };
    window.addEventListener(WORKSPACE_MANIFEST_OPEN, receive);
    return () => window.removeEventListener(WORKSPACE_MANIFEST_OPEN, receive);
  }, [compact]);

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
  async function remove(repository: WorkspaceRepository) {
    if (!current || !await confirmAction(t('workspaces.removeConfirm', { name: repository.name }), () => mounted.current, { title: t('workspaces.remove'), confirmLabel: t('workspaces.remove') })) return;
    await operate(() => native.removeWorkspaceRepository(current.id, repository.id, current.revision));
  }
  async function pick(repository: WorkspaceRepository) {
    if (!current) return;
    const available = repository.locations.find(location => location.available);
    const directory = paths[repository.id] || available?.path;
    if (!directory || !available) return;
    const selection = { workspaceId: current.id, repositoryId: repository.id, directory, projectId: available.projectId, label: `${current.name} / ${repository.name}` };
    if (onPick) { onPick(selection); return; }
    if (!launchTool) { setError(t('workspaces.chooseTool')); return; }
    await operate(async () => {
      const result = await native.launchCli({ ...selection, toolId: launchTool, projectId: available.projectId, sessionId: null, mode: 'normal', worktreeIntent: 'given' });
      if (result.sessionId) onSession?.(result.sessionId);
      else setNotice(t('workspaces.external'));
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
    });
  }
  const shown = (current?.repositories ?? []).filter(repo => (!favorites || repo.favorite) && `${repo.name} ${repo.locations.map(location => location.path).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleCandidates = (candidates ?? []).filter(item => `${item.name} ${item.path}`.toLowerCase().includes(scanQuery.toLowerCase()));
  return <section className={`${styles.browser} ${compact ? styles.compact : ''}`} aria-label={t('workspaces.title')} data-business-workspaces>
    <div className={styles.header}><div><h2>{t('workspaces.title')}</h2>{!compact && <p className={styles.hint}>{t('workspaces.hint')}</p>}</div><div className={styles.actions}>
      {!compact && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRenaming(false); setEditName(''); }}>{t('workspaces.create')}</Button>}
      {!compact && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void chooseManifest()}>{t('workspaces.openManifest')}</Button>}
      <Button size="sm" variant="ghost" disabled={busy || loading} aria-label={t('workspaces.refresh')} icon={<Icon name="refresh" size={14} />} onClick={() => void reload(true)} />
    </div></div>
    {(error || loadError) && <p className={styles.error} role="alert">{error || loadError} <Button size="sm" variant="ghost" onClick={() => void reload(true)}>{t('workspaces.retry')}</Button></p>}
    {notice && <p className={styles.hint} role="status">{notice}</p>}
    {workspaces.length > 0 ? <>
      <div className={styles.tools}><FilterSelect disabled={busy || scanBusy || candidates !== null} className={styles.select} label={t('workspaces.select')} value={selectedId} options={workspaces.map(item => ({ value: item.id, label: item.name, detail: t('workspaces.repositories', { count: item.repositories.length }) }))} onChange={id => { setSelectedId(id); setQuery(''); setPaths({}); }} />
        {!onPick && <FilterSelect label={t('workspaces.tool')} value={launchTool} options={enabledTools.map(tool => ({ value: tool.id, label: tool.name }))} onChange={setToolId} />}
        {!compact && <><Button size="sm" variant="ghost" disabled={!current || busy} onClick={() => { setRenaming(true); setEditName(current?.name ?? ''); }} icon={<Icon name="pencil" size={14} />}>{t('workspaces.rename')}</Button>
        <Button size="sm" disabled={!current || busy || scanBusy} onClick={() => void discover(false)}>{t('workspaces.add')}</Button>
        <Button size="sm" variant="ghost" disabled={!current || busy || scanBusy} onClick={() => void discover(true)}>{t('workspaces.discover')}</Button></>}
      </div>
      {current?.manifestPath ? <p className={styles.source} title={current.manifestPath}>{t('workspaces.linked')} · {current.manifestPath} · {t('workspaces.version', { revision: current.manifestRevision })}</p> : current && !compact && <div className={styles.actions}><span className={styles.source}>{t('workspaces.local')}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void publish()}>{t('workspaces.publish')}</Button></div>}
      {current?.error && <p className={styles.error} role="alert">{t('workspaces.sourceStale')} {current.error}</p>}
      <div className={styles.filters}><SearchField label={t('workspaces.search')} value={query} onChange={setQuery} placeholder={t('workspaces.search')} /><label><input type="checkbox" checked={favorites} onChange={event => setFavorites(event.target.checked)} /> {t('workspaces.onlyFavorites')}</label></div>
      <div className={styles.list} aria-label={t('workspaces.previewRepositories')}>
        {shown.map(repo => {
          const available = repo.locations.find(location => location.available);
          const options = new Map<string, string>();
          for (const location of repo.locations.filter(item => item.available && item.path)) {
            options.set(location.path!, location.path!);
            for (const tree of location.worktrees) options.set(tree.path, `${tree.branch || tree.name} · ${tree.path}`);
          }
          const selectedPath = paths[repo.id] || available?.path || '';
          return <article key={repo.id} className={styles.row} data-repository-id={repo.id}>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={t(repo.favorite ? 'workspaces.unfavorite' : 'workspaces.favorite')} aria-pressed={repo.favorite} icon={<Icon name="star" size={14} />} onClick={() => current && void operate(() => native.favoriteWorkspaceRepository(current.id, repo.id, !repo.favorite))} />
            <div className={styles.identity}><strong title={repo.name}>{repo.name}</strong>
              {available ? <div className={styles.location}><select aria-label={`${repo.name} ${t('workspaces.worktree')}`} value={selectedPath} onChange={event => setPaths(previous => ({ ...previous, [repo.id]: event.target.value }))}>{[...options].map(([path, label]) => <option key={path} value={path}>{label}</option>)}</select>{available.kind === 'legacy' && <small>{t('workspaces.legacy')}</small>}</div> : repo.locations.map(location => <small key={location.id} title={location.path ?? ''}>{location.path || t('workspaces.invalid')} · {location.reason}</small>)}
              {available?.reason && <small title={available.reason}>{available.reason}</small>}
            </div>
            <div className={styles.actions}><Button size="sm" disabled={busy || !available} onClick={() => void pick(repo)}>{t(onPick ? 'workspaces.use' : 'workspaces.launch')}</Button>{!compact && <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void relink(repo)}>{t('workspaces.relink')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(repo)} aria-label={`${t('workspaces.remove')} ${repo.name}`} icon={<Icon name="close" size={14} />} /></>}</div>
          </article>;
        })}
      </div>
      {!shown.length && <p className={styles.empty}>{t(current?.repositories.length ? 'workspaces.noMatches' : 'workspaces.emptyRepos')}</p>}
    </> : !loading && <p className={styles.empty}>{t('workspaces.empty')}</p>}
    <GuideDialog open={editName !== null} title={t(renaming ? 'workspaces.rename' : 'workspaces.create')} hint={t(renaming ? 'workspaces.renameHint' : 'workspaces.createHint')} closeDisabled={busy} onClose={() => setEditName(null)}>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void operate(async () => { const value = renaming && current ? await native.renameBusinessWorkspace(current.id, editName ?? '', current.revision) : await native.createBusinessWorkspace(editName ?? ''); setSelectedId(value.id); setEditName(null); }); }}><label>{t('workspaces.name')}<input autoFocus value={editName ?? ''} onChange={event => setEditName(event.target.value)} maxLength={160} /></label><Button type="submit" disabled={busy || !editName?.trim()}>{t('workspaces.save')}</Button>{error && <p role="alert">{error}</p>}</form>
    </GuideDialog>
    <GuideDialog open={candidates !== null} title={t('workspaces.scanTitle')} hint={t('workspaces.scanHint')} wide closeDisabled={busy} onClose={() => { if (scanId.current) void native.cancelWorkspaceScan(scanId.current); scanId.current = null; setCandidates(null); }}>
      <div className={styles.form}>
        {scanBusy && <p role="status">{t('workspaces.scanning')} <Button size="sm" onClick={() => scanId.current && void native.cancelWorkspaceScan(scanId.current)}>{t('workspaces.stop')}</Button></p>}
        {partial && <p role="status">{t('workspaces.partial')}</p>}
        <SearchField label={t('workspaces.search')} value={scanQuery} onChange={setScanQuery} />
        <label><input type="checkbox" checked={checked.size > 0 && checked.size === (candidates ?? []).filter(item => item.kind === 'repository').length} onChange={event => setChecked(event.target.checked ? new Set((candidates ?? []).filter(item => item.kind === 'repository').map(item => item.path)) : new Set())} />{t('workspaces.selectAll')}</label>
        <div className={styles.candidates}>{visibleCandidates.map((item, index) => <label key={`${item.path}:${index}`} className={styles.candidate}><input type="checkbox" disabled={item.kind !== 'repository' || busy} checked={checked.has(item.path)} onChange={event => setChecked(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.path); else next.delete(item.path); return next; })} /><span>{item.name}<small>{item.path}</small>{item.reason && <small>{item.reason}</small>}</span></label>)}</div>
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy || scanBusy || !checked.size || !current} onClick={() => current && void operate(async () => { const results = await native.addWorkspaceRepositories(current.id, [...checked], current.revision); const failed = results.filter(item => item.error); setNotice(t('workspaces.added', { count: results.length })); if (failed.length) { setChecked(new Set(failed.map(item => item.path))); throw new Error(failed.map(item => `${item.path}: ${item.error}`).join('\n')); } setCandidates(null); })}>{t('workspaces.selected', { count: checked.size })}</Button>
      </div>
    </GuideDialog>
    <GuideDialog open={preview !== null} title={t('workspaces.previewTitle')} hint={t('workspaces.previewHint')} wide closeDisabled={busy} onClose={() => setPreview(null)}>
      {preview && <div className={styles.form}><strong>{preview.manifest.name}</strong><span className={styles.path}>{preview.path}</span>{preview.conflict && <p role="alert">{t('workspaces.conflict')}</p>}<div className={styles.candidates}>{preview.manifest.repositories.map(repo => <div className={styles.row} key={repo.id}><div className={styles.identity}><strong>{repo.name}</strong>{repo.locations.map(location => <small key={`${location.hostId}:${location.path}`}>{location.path}</small>)}</div></div>)}</div>{error && <p role="alert">{error}</p>}<Button disabled={busy} onClick={() => void operate(async () => { const result = await native.attachWorkspaceManifest(preview.path, preview.digest, preview.conflict); setSelectedId(result.id); setPreview(null); })}>{t(preview.conflict ? 'workspaces.adopt' : 'workspaces.attach')}</Button></div>}
    </GuideDialog>
  </section>;
}
