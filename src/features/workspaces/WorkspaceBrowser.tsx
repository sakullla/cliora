import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { confirmAction } from '../../lib/confirm';
import { Badge, Button, Toolbar } from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { ToolIcon } from '../../components/ToolIcon';
import { displayPath } from '../../lib/paths';
import { Icon } from '../../components/Icon';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import type { AdapterDescriptor } from '../../types/native';
import { preferredLaunchMode, type LaunchSettings } from '../../types/launch';
import type { BusinessWorkspace, WorkspaceCandidate, WorkspaceManifestPreview, WorkspaceRepository } from '../../types/workspaces';
import i18n from '../../i18n';
import styles from './WorkspaceBrowser.module.css';
import { WORKSPACES_CHANGED, notifyWorkspacesChanged, changedWorkspace, FOCUS_REFRESH_INTERVAL } from '../../lib/workspaceEvents';

export { WORKSPACES_CHANGED, notifyWorkspacesChanged, changedWorkspace, type WorkspacesChangedDetail } from '../../lib/workspaceEvents';
export const WORKSPACE_MANIFEST_OPEN = 'cliora:workspace-manifest-open';
export function isBusinessWorkspace(value: unknown): value is BusinessWorkspace {
  return !!value && typeof value === 'object' && typeof (value as BusinessWorkspace).id === 'string' && Array.isArray((value as BusinessWorkspace).repositories);
}
// Per-viewer conveniences: the project, CLI, view mode and checkouts last used come back on the next visit.
const selectedKey = 'cliora:workspace-selected';
const toolKey = 'cliora:workspace-tool';
const pathsKey = 'cliora:workspace-paths';
const viewKey = 'cliora:workspace-view-mode';
type WorkspaceViewMode = 'grid' | 'list';
const GRID_AUTO_THRESHOLD = 8;
const GROUP_BAR_THRESHOLD = 12;

/** Derive smart prefix groups (e.g. `e6-common`, `e6-ms`, `dmh`) for large multi-repo projects. */
function repositoryPrefixGroups(repositories: WorkspaceRepository[]): { key: string; count: number; match: (name: string) => boolean }[] {
  if (repositories.length < GROUP_BAR_THRESHOLD) return [];
  const segmentsOf = (name: string) => name.toLowerCase().split(/[-_./]+/).filter(Boolean);
  const firstCounts = new Map<string, number>();
  for (const repo of repositories) {
    const first = segmentsOf(repo.name)[0];
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
  }
  const bucketCounts = new Map<string, { count: number; prefix: string }>();
  for (const repo of repositories) {
    const segs = segmentsOf(repo.name);
    if (!segs.length) continue;
    const first = segs[0];
    // If one top-level prefix dominates (e.g. `e6-*` > 45%), refine into 2-segment module prefixes.
    const dominant = (firstCounts.get(first) ?? 0) > repositories.length * 0.45 && segs.length >= 2;
    const key = dominant ? `${first}-${segs[1]}` : first;
    const entry = bucketCounts.get(key);
    if (entry) entry.count += 1;
    else bucketCounts.set(key, { count: 1, prefix: key });
  }
  const groups = [...bucketCounts.entries()]
    .filter(([, entry]) => entry.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([key, entry]) => ({
      key,
      count: entry.count,
      match: (name: string) => {
        const segs = segmentsOf(name);
        if (!segs.length) return false;
        const first = segs[0];
        const dominant = (firstCounts.get(first) ?? 0) > repositories.length * 0.45 && segs.length >= 2;
        return (dominant ? `${first}-${segs[1]}` : first) === key;
      },
    }));
  return groups.length >= 2 ? groups : [];
}
const stored = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const remember = (key: string, value: string) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* optional preference */ } };
/** Member checkouts read back raw: whether each one still exists is only known beside the project. */
const readPaths = (): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(stored(pathsKey) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value as Record<string, unknown>).filter(([key, path]) => key.includes('\u0000') && typeof path === 'string' && !!path);
    return Object.fromEntries(entries) as Record<string, string>;
  } catch { return {}; }
};
const writePaths = (value: Record<string, string>) => {
  remember(pathsKey, Object.keys(value).length ? JSON.stringify(value) : '');
};
const failure = (value: unknown) => formatFailure(value, i18n.t('workspaces.failed'), i18n.t('workspaces.retry'));
/** A worktree choice belongs to one project's member, so A → B → A returns to A's own checkout. */
const placeKey = (workspaceId: string, repositoryId: string) => `${workspaceId}\u0000${repositoryId}`;

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

/**
 * The folder every repository of a project shares, so rows can drop the long common head. Only a
 * real parent (two or more segments) of two or more repositories qualifies.
 */
export function commonRoot(paths: string[]): string | null {
  if (paths.length < 2) return null;
  const split = (path: string) => path.split(/[\\/]/);
  let shared = split(paths[0]).slice(0, -1);
  for (const path of paths.slice(1)) {
    const parts = split(path);
    let index = 0;
    while (index < shared.length && index < parts.length - 1 && shared[index] === parts[index]) index++;
    shared = shared.slice(0, index);
    if (!shared.length) return null;
  }
  if (shared.filter(Boolean).length < 2) return null;
  const separator = paths[0].includes('\\') && !paths[0].includes('/') ? '\\' : '/';
  return shared.join(separator);
}

export function WorkspaceBrowser({ tools = [], launchSettings = null, enablePageSearch = false, spotlightProject = null, onSession, incomingManifest, onManifestConsumed }: { tools?: AdapterDescriptor[]; launchSettings?: LaunchSettings | null; enablePageSearch?: boolean; spotlightProject?: { id: string; token: number } | null; incomingManifest?: WorkspaceManifestPreview | null; onManifestConsumed?: (preview: WorkspaceManifestPreview) => void; onSession?: (id: string) => void }) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<BusinessWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState(() => stored(selectedKey));
  const [query, setQuery] = useState('');
  // Typing stays responsive while hundreds of rows are filtered behind it.
  const deferredQuery = useDeferredValue(query);
  const instance = useId();
  const loadedAt = useRef(0);
  const [filter, setFilter] = useState<'all' | 'favorites' | 'attention'>('all');
  const [prefixGroup, setPrefixGroup] = useState('');
  const [viewPref, setViewPref] = useState<WorkspaceViewMode | ''>(() => {
    const saved = stored(viewKey);
    return saved === 'grid' || saved === 'list' ? saved : '';
  });
  const listRef = useRef<HTMLDivElement>(null);
  const [toolId, setToolId] = useState(() => stored(toolKey));
  const [launching, setLaunching] = useState('');
  // Keyed per project and repository: switching projects leaves every member's own choice alone,
  // and the remembered map survives this page (validity is re-checked beside each project below).
  const [paths, setPaths] = useState<Record<string, string>>(readPaths);
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
  /** The member a v2 handoff came from; cleared as soon as this page has continued (or dropped) it. */
  const [sourceIntent, setSourceIntent] = useState<{ workspaceId: string; repositoryId: string } | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  useEffect(() => {
    if (!incomingManifest) return;
    // Handoff is one-shot: the parent intent is consumed before anything can be replayed, so a
    // cancelled preview or a later visit never reopens the same (possibly stale) file.
    onManifestConsumed?.(incomingManifest);
    const source = incomingManifest.sourceRepositoryId;
    if (source && incomingManifest.attached && !incomingManifest.conflict) {
      // This project is already linked with exactly this content: continue the source member
      // instead of asking the user to confirm the same file again.
      setSelectedId(incomingManifest.manifest.workspaceId);
      setQuery(''); setFilter('all'); setPrefixGroup('');
      setSourceIntent({ workspaceId: incomingManifest.manifest.workspaceId, repositoryId: source });
      return;
    }
    setPreview(incomingManifest);
  }, [incomingManifest, onManifestConsumed]);
  const scanId = useRef<string | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const current = workspaces.find(item => item.id === selectedId) ?? null;
  const currentId = current?.id;
  const manifestPath = current?.manifestPath;
  const linkedId = useRef<string | undefined>(undefined);
  linkedId.current = manifestPath ? currentId : undefined;
  const enabledTools = tools.filter(tool => tool.launch?.state !== 'unsupported' && tool.launch?.state !== 'planned');
  const launchTool = enabledTools.find(tool => tool.id === toolId)?.id ?? enabledTools[0]?.id ?? '';
  const reload = useCallback(async (refreshSource = false) => {
    if (!nativeAvailable) return;
    const seq = ++sequence.current;
    setLoading(true);
    try {
      // A background source refresh that cannot run now (for example another window holds the
      // manifest) keeps the last list; the project shows its own source status when it matters.
      if (refreshSource && linkedId.current) await native.refreshWorkspaceManifest(linkedId.current).catch(() => undefined);
      const result = await native.listBusinessWorkspaces();
      if (!mounted.current || seq !== sequence.current) return;
      const rows = Array.isArray(result) ? result : [];
      setWorkspaces(rows);
      const savedId = stored(selectedKey);
      setSelectedId(previous => rows.some(item => item.id === previous) ? previous : rows.find(item => item.id === savedId)?.id ?? rows[0]?.id ?? '');
      setLoadError('');
      loadedAt.current = Date.now();
    } catch (value) { if (mounted.current && seq === sequence.current) setLoadError(failure(value)); }
    finally { if (mounted.current && seq === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const changed = (event: Event) => {
      const detail = changedWorkspace(event);
      if (detail.source === instance) return;
      const workspace = detail.workspace;
      if (workspace) setWorkspaces(previous => previous.some(item => item.id === workspace.id) ? previous.map(item => item.id === workspace.id ? workspace : item) : previous);
      else void reload();
    };
    const focused = () => { if (Date.now() - loadedAt.current >= FOCUS_REFRESH_INTERVAL) void reload(true); };
    window.addEventListener(WORKSPACES_CHANGED, changed);
    window.addEventListener('focus', focused);
    return () => { mounted.current = false; sequence.current++; window.removeEventListener(WORKSPACES_CHANGED, changed); window.removeEventListener('focus', focused); if (scanId.current) void native.cancelWorkspaceScan(scanId.current); };
  }, [reload, instance]);
  useEffect(() => { if (workspaces.length) remember(selectedKey, selectedId); }, [selectedId, workspaces.length]);
  // The stored map follows every choice and every successful deletion, so a removed project never
  // leaves its keys behind; a checkout that vanished meanwhile is ignored by its own row instead.
  useEffect(() => { writePaths(paths); }, [paths]);
  const hasViewedProject = useRef(false);
  useEffect(() => {
    if (!currentId || !nativeAvailable) return;
    // The initial listing just probed every checkout. Only a linked project also needs its
    // source file read. Later project switches still recheck directories that may have moved.
    const initialLocal = !hasViewedProject.current && !manifestPath;
    hasViewedProject.current = true;
    if (initialLocal) return;
    let live = true;
    void native.refreshWorkspaceManifest(currentId).then(value => {
      if (live && value) setWorkspaces(previous => previous.map(item => item.id === value.id ? value : item));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [currentId, manifestPath]);
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
    try {
      const value = await action();
      if (!mounted.current) return;
      // An operation that returns its project updates only that project; listing would
      // re-probe every repository of every project.
      if (isBusinessWorkspace(value)) {
        setWorkspaces(previous => previous.map(item => item.id === value.id ? value : item));
        notifyWorkspacesChanged({ source: instance, workspace: value });
      } else { await reload(); notifyWorkspacesChanged({ source: instance }); }
    }
    catch (value) { if (mounted.current) { await reload(); setError(failure(value)); notifyWorkspacesChanged({ source: instance }); } }
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
  async function openInTwiglane(repository: WorkspaceRepository) {
    if (!current?.manifestPath || busy) return;
    setError(''); setNotice('');
    // v2 names the member this row stands for: Twiglane continues that repository, not a guess
    // made from the project name.
    const url = `twiglane://workspace?v=2&file=${encodeURIComponent(current.manifestPath)}&repository=${encodeURIComponent(repository.id)}`;
    try { await native.openExternalUrl(url); }
    catch (value) { if (mounted.current) setError(failure(value)); }
  }
  async function discover(recursive: boolean) {
    if (!current || busy || scanBusy) return;
    let operationId: string | null = null;
    try {
      const chosen = await open({ directory: true, multiple: !recursive, title: t(recursive ? 'workspaces.scanRoot' : 'workspaces.selectRepos') });
      if (!chosen || !mounted.current) return;
      const roots = Array.isArray(chosen) ? chosen : [chosen];
      operationId = crypto.randomUUID();
      scanId.current = operationId;
      setCandidates([]); setChecked(new Set()); setPartial(false); setScanQuery(''); setScanBusy(true); setError('');
      const result = await native.scanWorkspaceRepositories(roots, operationId, recursive);
      if (!mounted.current || scanId.current !== operationId) return;
      setCandidates(result.candidates); setPartial(result.partial || result.cancelled);
      setChecked(new Set(result.candidates.filter(item => item.kind === 'repository').map(item => item.path)));
    } catch (value) { if (mounted.current && (!operationId || scanId.current === operationId)) setError(failure(value)); }
    finally {
      if (operationId && scanId.current === operationId) {
        scanId.current = null;
        if (mounted.current) setScanBusy(false);
      }
    }
  }
  function closeScan() {
    if (scanId.current) void native.cancelWorkspaceScan(scanId.current);
    scanId.current = null;
    setCandidates(null);
    setChecked(new Set());
    setScanQuery('');
    setScanBusy(false);
  }
  async function relink(repository: WorkspaceRepository) {
    if (!current) return;
    try {
      const path = await open({ directory: true, multiple: false, title: t('workspaces.relink') });
      if (typeof path === 'string') {
        await operate(() => native.relinkWorkspaceRepository(current.id, repository.id, path, current.revision));
        if (mounted.current) returnFocus(repository.id);
      }
    } catch (value) { setError(failure(value)); }
  }
  /** Creating or renaming updates the project list in the same render that selects it, so the header
   *  (and the trigger the dialog returns focus to) is never rebuilt with a missing current project. */
  async function saveProject() {
    const name = (editName ?? '').trim();
    if (!name) return;
    const target = renaming ? current : null;
    let saved = false;
    await operate(async () => {
      const value = target ? await native.renameBusinessWorkspace(target.id, name, target.revision) : await native.createBusinessWorkspace(name);
      setWorkspaces(previous => previous.some(item => item.id === value.id) ? previous.map(item => item.id === value.id ? value : item) : [...previous, value]);
      setSelectedId(value.id);
      setEditName(null);
      saved = true;
      return value;
    });
    // A first project replaces the intro that held the dialog's trigger: the dialog has nothing to
    // return focus to. Only a focus really left on the page moves on, so the usual return stays.
    if (saved && mounted.current) requestAnimationFrame(() => { if (document.activeElement === document.body) returnFocus(''); });
  }
  async function deleteProject() {
    if (!current || !await confirmAction(t('workspaces.deleteConfirm', { name: current.name }), () => mounted.current, { title: t('workspaces.deleteProject'), confirmLabel: t('workspaces.deleteProject') })) return;
    const id = current.id;
    let deleted = false;
    await operate(async () => { await native.deleteBusinessWorkspace(id); setSelectedId(previous => previous === id ? '' : previous); setQuery(''); setFilter('all'); deleted = true; });
    // A failed deletion leaves the project, and the choices its members still resolve, in place.
    if (!deleted || !mounted.current) return;
    // The project's own choices leave with it; other projects keep theirs.
    setPaths(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}\u0000`))));
    returnFocus('');
  }
  async function remove(repository: WorkspaceRepository) {
    if (!current || !await confirmAction(t('workspaces.removeConfirm', { name: repository.name }), () => mounted.current, { title: t('workspaces.remove'), confirmLabel: t('workspaces.remove') })) return;
    const neighbour = Math.max(0, shown.findIndex(repo => repo.id === repository.id));
    await operate(() => native.removeWorkspaceRepository(current.id, repository.id, current.revision));
    if (mounted.current) returnFocus(repository.id, neighbour);
  }
  /** A star flips at once; the whole list never waits on (or is disabled by) a favorite. */
  async function toggleFavorite(repository: WorkspaceRepository) {
    if (!current) return;
    const workspaceId = current.id;
    const favorite = !repository.favorite;
    const flip = (value: boolean) => setWorkspaces(previous => previous.map(item => item.id !== workspaceId ? item : { ...item, repositories: item.repositories.map(repo => repo.id === repository.id ? { ...repo, favorite: value } : repo) }));
    flip(favorite);
    try {
      const value = await native.favoriteWorkspaceRepository(workspaceId, repository.id, favorite);
      if (!mounted.current) return;
      if (isBusinessWorkspace(value)) {
        setWorkspaces(previous => previous.map(item => item.id === value.id ? value : item));
        notifyWorkspacesChanged({ source: instance, workspace: value });
      } else { await reload(); notifyWorkspacesChanged({ source: instance }); }
    } catch (value) { if (mounted.current) { flip(!favorite); setError(failure(value)); } }
  }
  async function pick(repository: WorkspaceRepository) {
    if (!current) return;
    const { available, path } = placeOf(current.id, repository);
    if (!available || !path) return;
    if (!launchTool) { setError(t('workspaces.chooseTool')); return; }
    const selection = { workspaceId: current.id, repositoryId: repository.id, directory: path, projectId: available.projectId, label: `${current.name} / ${repository.name}` };
    setLaunching(repository.id);
    await operate(async () => {
      const result = await native.launchCli({ ...selection, toolId: launchTool, projectId: available.projectId, sessionId: null, mode: preferredLaunchMode(launchSettings, 'project', !!enabledTools.find(tool => tool.id === launchTool)?.yoloAvailable), worktreeIntent: 'given' });
      if (result.sessionId) onSession?.(result.sessionId);
      else setNotice(t('workspaces.external'));
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
    });
    if (mounted.current) setLaunching('');
  }
  const mainCheckoutLabel = t('workspaces.mainCheckout');
  const worktreeKindLabel = t('workspaces.worktreeKind');
  /** The checkout a row works in: the remembered choice only while it still exists locally. */
  function placeOf(workspaceId: string, repository: WorkspaceRepository) {
    const places = repositoryPlaces(repository, mainCheckoutLabel, worktreeKindLabel);
    const available = repository.locations.find(location => location.available);
    const remembered = paths[placeKey(workspaceId, repository.id)];
    const chosen = remembered && places.has(remembered) ? remembered : '';
    return { places, available, remembered, chosen, path: chosen || available?.path || '', fallback: !!remembered && !chosen };
  }
  /** A removed or repaired row must not drop the keyboard onto the page: keep it in the project. */
  function returnFocus(repositoryId: string, neighbour = 0) {
    requestAnimationFrame(() => {
      // Removing a project never pulls focus away from what the project still shows.
      if (!repositoryId && blockRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-repository-id]') ?? []);
      const at = rows.findIndex(row => row.dataset.repositoryId === repositoryId);
      const row = at >= 0 ? rows[at] : rows[Math.min(neighbour, rows.length - 1)];
      const target = row?.querySelector<HTMLElement>('[data-row-primary]:not(:disabled)') ?? blockRef.current?.querySelector<HTMLElement>('[data-project-add]:not(:disabled)') ?? null;
      row?.scrollIntoView({ block: 'nearest' });
      target?.focus({ preventScroll: true });
    });
  }
  const allRepositories = current?.repositories ?? [];
  const root = useMemo(() => commonRoot(allRepositories.flatMap(repo => repo.locations.filter(location => location.path && !location.targetId).map(location => location.path!))), [allRepositories]);
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const repo of allRepositories) counts.set(repo.name, (counts.get(repo.name) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  }, [allRepositories]);
  /** A row's path below the shared folder; nothing when that is just a unique repository's own name. */
  const relativePath = (path: string, name: string) => {
    if (!root || !path.startsWith(root) || !/[\\/]/.test(path.charAt(root.length))) return displayPath(path);
    const rest = path.slice(root.length + 1);
    if (rest !== name) return rest;
    if (!duplicateNames.has(name)) return '';
    const parent = displayPath(root).split(/[\\/]/).filter(Boolean).at(-1);
    return parent ? `${parent}/${rest}` : displayPath(path);
  };
  const isBroken = (repo: WorkspaceRepository) => !repo.locations.some(location => location.available);
  const favoriteCount = allRepositories.filter(repo => repo.favorite).length;
  const brokenCount = allRepositories.filter(isBroken).length;
  const activeFilter = filter === 'favorites' && !favoriteCount ? 'all' : filter === 'attention' && !brokenCount ? 'all' : filter;
  const prefixGroups = useMemo(() => repositoryPrefixGroups(allRepositories), [allRepositories]);
  const activePrefixGroup = prefixGroups.find(group => group.key === prefixGroup) ?? null;
  const viewMode: WorkspaceViewMode = viewPref || (allRepositories.length >= GRID_AUTO_THRESHOLD ? 'grid' : 'list');
  const needle = deferredQuery.trim().toLowerCase();
  // Favorites lead; everything else keeps the project's own order. Every word must match the
  // name or a path, so `team api` narrows hundreds of repositories in one step.
  const shown = useMemo(() => {
    const tokens = needle.split(/\s+/).filter(Boolean);
    const matching = allRepositories.filter(repo => {
      if ((activeFilter === 'favorites' && !repo.favorite) || (activeFilter === 'attention' && repo.locations.some(location => location.available))) return false;
      if (activePrefixGroup && !activePrefixGroup.match(repo.name)) return false;
      if (!tokens.length) return true;
      const text = `${repo.name} ${repo.locations.map(location => location.path).join(' ')}`.toLowerCase();
      return tokens.every(token => text.includes(token));
    });
    return matching.sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }, [allRepositories, activeFilter, activePrefixGroup, needle]);
  const filtered = shown.length !== allRepositories.length;
  const visibleCandidates = (candidates ?? []).filter(item => `${item.name} ${item.path}`.toLowerCase().includes(scanQuery.trim().toLowerCase()));
  const addable = (candidates ?? []).filter(item => item.kind === 'repository');
  const kindTone = { repository: 'success', directory: 'neutral', duplicate: 'neutral', unavailable: 'danger' } as const;
  const kindLabel = { repository: 'workspaces.kindRepository', directory: 'workspaces.kindDirectory', duplicate: 'workspaces.kindDuplicate', unavailable: 'workspaces.kindUnavailable' } as const;
  const startCreate = () => { setRenaming(false); setEditName(''); };
  function moveFocus(event: KeyboardEvent<HTMLElement>, fromSearch = false) {
    // Search narrowed to one ready repository: Enter starts it, so "type, Enter" is the whole trip.
    if (fromSearch && event.key === 'Enter' && !event.nativeEvent.isComposing && needle && needle === query.trim().toLowerCase() && shown.length === 1 && !isBroken(shown[0]) && launchTool && !busy) {
      event.preventDefault();
      void pick(shown[0]);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-row-primary]:not(:disabled)') ?? []);
    if (!buttons.length) return;
    if (fromSearch) { if (event.key === 'ArrowDown') { event.preventDefault(); buttons[0].focus(); } return; }
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  }
  const revealedSpotlight = useRef<number | null>(null);
  const blockRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!spotlightProject || revealedSpotlight.current === spotlightProject.token || loading) return;
    const matchedWorkspace = workspaces.find(ws => ws.repositories.some(repo => repo.locations.some(loc => loc.projectId === spotlightProject.id)));
    if (matchedWorkspace) {
      if (selectedId !== matchedWorkspace.id || query || filter !== 'all' || prefixGroup) {
        setSelectedId(matchedWorkspace.id);
        setQuery('');
        setFilter('all');
        setPrefixGroup('');
        return;
      }
      const matchedRepo = matchedWorkspace.repositories.find(repo => repo.locations.some(loc => loc.projectId === spotlightProject.id));
      const row = matchedRepo ? blockRef.current?.querySelector<HTMLElement>(`[data-repository-id="${CSS.escape(matchedRepo.id)}"]`) : null;
      if (row) {
        revealedSpotlight.current = spotlightProject.token;
        row.scrollIntoView({ block: 'center', behavior: 'auto' });
        const frame = requestAnimationFrame(() => {
          row.scrollIntoView({ block: 'center', behavior: 'auto' });
          (row.querySelector<HTMLElement>('[data-row-primary]:not(:disabled)') ?? row).focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
      }
    }
    if (workspaces.length > 0 || !nativeAvailable) {
      revealedSpotlight.current = spotlightProject.token;
      blockRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [spotlightProject?.id, spotlightProject?.token, workspaces, selectedId, query, filter, prefixGroup, loading]);

  // A v2 handoff continues the sender's own member: this page selects that project, clears any
  // narrowing the viewer left behind and lands on the member row. It never picks another
  // repository and never launches or writes anything on its own.
  useEffect(() => {
    // Wait for the list, its selection, and the end of any in-flight write: the row's primary
    // action is disabled while an operation runs, so focusing earlier would land nowhere.
    if (!sourceIntent || busy || loading || workspaces.length === 0) return;
    setQuery(''); setFilter('all'); setPrefixGroup('');
    const workspace = workspaces.find(item => item.id === sourceIntent.workspaceId) ?? null;
    // A first-time acceptance reaches this effect before the refreshed list carries the project;
    // the intent waits for that read instead of being dropped.
    if (!workspace) return;
    if (selectedId !== sourceIntent.workspaceId) {
      setSelectedId(sourceIntent.workspaceId);
      return;
    }
    const repository = workspace.repositories.find(item => item.id === sourceIntent.repositoryId) ?? null;
    setSourceIntent(null);
    if (!repository) {
      // The local copy no longer carries that member; nothing else is opened in its place.
      setError(t('workspaces.sourceStale'));
      return;
    }
    // A member without a usable directory stays here as the repair context: its row explains why
    // and its primary action is the relink entry the user needs.
    if (!repository.locations.some(location => location.available)) setNotice(`${repository.name} · ${t('workspaces.unavailable')} · ${t('workspaces.relink')}`);
    returnFocus(repository.id);
  }, [sourceIntent, workspaces, selectedId, loading, busy, t]);

  const launchLabel = t('workspaces.launch');
  const launchShort = t('workspaces.launchShort');
  const favoriteLabel = t('workspaces.favorite');
  const unfavoriteLabel = t('workspaces.unfavorite');
  const worktreeLabel = t('workspaces.worktree');
  const projectMenu = <RowMenu label={t('workspaces.projectActions')}>
    {current && <button type="button" role="menuitem" disabled={busy || scanBusy} onClick={() => void discover(true)}>{t('workspaces.discover')}</button>}
    <button type="button" role="menuitem" disabled={busy} onClick={startCreate}>{t('workspaces.create')}</button>
    {current && <button type="button" role="menuitem" disabled={busy} onClick={() => { setRenaming(true); setEditName(current.name); }}>{t('workspaces.rename')}</button>}
    <button type="button" role="menuitem" disabled={busy} onClick={() => void chooseManifest()}>{t('workspaces.openManifest')}</button>
    {current && !current.manifestPath && <button type="button" role="menuitem" disabled={busy} onClick={() => void publish()}>{t('workspaces.publish')}</button>}
    <button type="button" role="menuitem" disabled={busy || loading} onClick={() => void reload(true)}>{t('workspaces.refresh')}</button>
    {current && <button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void deleteProject()}>{t('workspaces.deleteProject')}</button>}
  </RowMenu>;
  return <section ref={blockRef} className={styles.block} aria-label={t('workspaces.title')} data-business-workspaces>
    <Toolbar className={styles.heading} title={t('workspaces.title')} count={workspaces.length ? <Badge>{workspaces.length}</Badge> : undefined} />
    <div className={styles.browser}>
    {workspaces.length > 0 && current ? <>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <FilterSelect variant="title" className={styles.select} disabled={busy || scanBusy || candidates !== null} label={t('workspaces.select')} triggerDetail={false} value={selectedId} options={workspaces.map(item => ({ value: item.id, label: item.name, detail: t('workspaces.repositories', { count: item.repositories.length }) }))} onChange={id => { setSelectedId(id); setQuery(''); setFilter('all'); setPrefixGroup(''); }} />
          <span className={styles.meta}>
            <span>{t('workspaces.repositories', { count: allRepositories.length })}</span>
            {root && <span className={styles.root} title={t('workspaces.rootHint', { path: displayPath(root) })}><Icon name="folder" size={12} /><span>{displayPath(root)}</span></span>}
            {current.manifestPath
              ? <span className={styles.linked} title={`${current.manifestPath} · ${t('workspaces.version', { revision: current.manifestRevision })}`}><Icon name="link" size={12} />{t('workspaces.linked')}</span>
              : <span>{t('workspaces.local')}</span>}
          </span>
        </div>
        <div className={styles.headerActions}>
          <Button size="sm" variant="primary" data-project-add disabled={busy || scanBusy} icon={<Icon name="plus" size={14} />} onClick={() => void discover(false)}>{t('workspaces.add')}</Button>
          {projectMenu}
        </div>
      </div>
      {(error || loadError) && <div className={styles.error} role="alert"><Icon name="alert" size={14} /><span>{error || loadError}</span><Button size="sm" variant="ghost" onClick={() => void reload(true)}>{t('workspaces.retry')}</Button><button type="button" className={styles.dismiss} aria-label={t('workspaces.dismiss')} title={t('workspaces.dismiss')} onClick={() => { setError(''); setLoadError(''); }}><Icon name="close" size={13} /></button></div>}
      {current.error && <div className={styles.warning} role="alert"><Icon name="alert" size={14} /><span>{t('workspaces.sourceStale')} {current.error}</span></div>}
      {notice && <p className={styles.notice} role="status"><span>{notice}</span><button type="button" className={styles.dismiss} aria-label={t('workspaces.dismiss')} title={t('workspaces.dismiss')} onClick={() => setNotice('')}><Icon name="close" size={13} /></button></p>}
      {allRepositories.length > 0 ? <>
        <div className={styles.filters}>
          <div className={styles.search} onKeyDown={event => moveFocus(event, true)}><SearchField label={t('workspaces.search')} pageSearch={enablePageSearch} value={query} onChange={setQuery} placeholder={t('workspaces.search')} /></div>
          {favoriteCount > 0 && <button type="button" className={styles.chip} aria-pressed={activeFilter === 'favorites'} onClick={() => setFilter(activeFilter === 'favorites' ? 'all' : 'favorites')}><Icon name="star" size={12} />{t('workspaces.filterFavorites', { count: favoriteCount })}</button>}
          {brokenCount > 0 && <button type="button" className={styles.chip} data-tone="danger" aria-pressed={activeFilter === 'attention'} title={t('workspaces.attentionHint', { count: brokenCount })} onClick={() => setFilter(activeFilter === 'attention' ? 'all' : 'attention')}><span className={styles.dot} aria-hidden="true" />{t('workspaces.filterAttention', { count: brokenCount })}</button>}
          {filtered && <span className={styles.matchCount} role="status">{t('workspaces.matchCount', { shown: shown.length, total: allRepositories.length })}</span>}
          {allRepositories.length >= 4 && <div className={styles.viewSwitch} role="group" aria-label={t('workspaces.viewMode')}>
            <button type="button" aria-pressed={viewMode === 'grid'} aria-label={t('workspaces.viewGrid')} title={t('workspaces.viewGrid')} onClick={() => { setViewPref('grid'); remember(viewKey, 'grid'); }}><Icon name="grid" size={14} /></button>
            <button type="button" aria-pressed={viewMode === 'list'} aria-label={t('workspaces.viewList')} title={t('workspaces.viewList')} onClick={() => { setViewPref('list'); remember(viewKey, 'list'); }}><Icon name="list" size={14} /></button>
          </div>}
          {enabledTools.length > 0 && <FilterSelect className={styles.toolPick} label={t('workspaces.tool')} title={t('workspaces.tool')} value={launchTool} options={enabledTools.map(tool => ({ value: tool.id, label: tool.name, icon: <ToolIcon toolId={tool.id} size={14} /> }))} onChange={id => { setToolId(id); remember(toolKey, id); }} />}
        </div>
        {prefixGroups.length > 0 && <div className={styles.groupBar} role="group" aria-label={t('workspaces.groupFilter')}>
          <button type="button" className={styles.groupChip} aria-pressed={!activePrefixGroup} onClick={() => setPrefixGroup('')}><span>{t('workspaces.groupAll')}</span><em>{allRepositories.length}</em></button>
          {prefixGroups.map(group => <button key={group.key} type="button" className={styles.groupChip} aria-pressed={activePrefixGroup?.key === group.key} onClick={() => setPrefixGroup(activePrefixGroup?.key === group.key ? '' : group.key)}><span>{group.key}</span><em>{group.count}</em></button>)}
        </div>}
        {shown.length > 0 ? <div className={styles.list} data-view={viewMode} ref={listRef} aria-label={t('workspaces.previewRepositories')} onKeyDown={event => moveFocus(event)}>
          {shown.map(repo => {
            const { places, available, remembered, path: selectedPath, fallback } = placeOf(current.id, repo);
            const broken = !available;
            const missing = repo.locations[0];
            const shownPath = broken ? (missing?.path ? relativePath(missing.path, repo.name) : '') : relativePath(selectedPath, repo.name);
            const currentBranch = !broken ? available?.worktrees.find(tree => tree.path === selectedPath)?.branch : null;
            // Identity reads as one block: the name, and below it only what tells this row apart
            // (a distinguishing path, a missing directory or a fallback). Unique rows stay one line.
            const hasDetail = broken || fallback || !!shownPath;
            return <article key={repo.id} className={styles.row} data-repository-id={repo.id} data-state={broken ? 'unavailable' : undefined} data-detail={hasDetail || undefined} data-favorite={repo.favorite || undefined}>
              <span className={styles.name}>{broken && <span className={styles.dot} aria-hidden="true" />}<strong title={repo.name}>{repo.name}</strong>{available?.kind === 'legacy' && <Badge>{t('workspaces.legacy')}</Badge>}</span>
              {hasDetail && <span className={styles.path} title={broken ? [missing?.path && displayPath(missing.path), t('workspaces.unavailable'), missing?.reason].filter(Boolean).join(' · ') : displayPath(selectedPath)}>{broken ? <>{missing?.path ? shownPath && <span>{shownPath}</span> : <span>{t('workspaces.invalid')}</span>}<em>{t('workspaces.unavailable')}{missing?.reason ? ` · ${missing.reason}` : ''}</em></> : <>{shownPath && <span>{shownPath}</span>}{fallback && (places.size > 1
                // Only a row that shows the picker may promise that choosing replaces the fallback.
                ? <em className={styles.fallback} title={t('workspaces.worktreeFallbackHint', { path: displayPath(remembered ?? '') })}>{t('workspaces.worktreeFallback')}</em>
                : <em className={styles.fallback} title={t('workspaces.worktreeFallbackHintSingle', { path: displayPath(remembered ?? '') })}>{t('workspaces.worktreeFallbackSingle', { path: displayPath(selectedPath) })}</em>)}</>}</span>}
              {places.size > 1
                ? <select className={styles.place} aria-label={`${repo.name} ${worktreeLabel}`} title={selectedPath} value={selectedPath} onChange={event => setPaths(previous => ({ ...previous, [placeKey(current.id, repo.id)]: event.target.value }))}>{[...places].map(([path, place]) => <option key={path} value={path}>{place.label}</option>)}</select>
                : currentBranch
                  ? <span className={styles.branchTag} title={currentBranch}><Icon name="branch" size={11} /><span>{currentBranch}</span></span>
                  : <span className={styles.placeholder} />}
              <span className={styles.rowActions}>
                <Button size="sm" variant="ghost" className={styles.favorite} aria-label={repo.favorite ? unfavoriteLabel : favoriteLabel} title={repo.favorite ? unfavoriteLabel : favoriteLabel} aria-pressed={repo.favorite} icon={<Icon name="star" size={14} />} onClick={() => void toggleFavorite(repo)} />
                {broken
                  ? <Button size="sm" data-row-primary disabled={busy} icon={<Icon name="link" size={13} />} onClick={() => void relink(repo)}>{t('workspaces.relink')}</Button>
                  : <Button size="sm" className={styles.launch} data-row-primary loading={launching === repo.id} disabled={busy || !launchTool} aria-label={launchLabel} title={launchTool ? undefined : t('workspaces.chooseTool')} icon={<Icon name="play" size={12} />} onClick={() => void pick(repo)}>{launchShort}</Button>}
                <RowMenu className={styles.rowMenu} label={t('workspaces.repoActions', { name: repo.name })}>{() => <>
                  {!broken && <button type="button" role="menuitem" disabled={busy} onClick={() => void relink(repo)}>{t('workspaces.relink')}</button>}
                  {current.manifestPath && !broken && <button type="button" role="menuitem" disabled={busy} onClick={() => void openInTwiglane(repo)}>{t('workspaces.openInTwiglane')}</button>}
                  <button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void remove(repo)}>{t('workspaces.remove')}</button>
                </>}</RowMenu>
              </span>
            </article>;
          })}
        </div> : <div className={styles.empty} role="status"><span>{t('workspaces.noMatches')}</span><Button size="sm" variant="ghost" onClick={() => { setQuery(''); setFilter('all'); setPrefixGroup(''); }}>{t('workspaces.clearFilters')}</Button></div>}
      </> : <div className={styles.emptyState}><p>{t('workspaces.emptyReposAction')}</p><Button size="sm" variant="ghost" icon={<Icon name="search" size={13} />} disabled={busy || scanBusy} onClick={() => void discover(true)}>{t('workspaces.discover')}</Button></div>}
    </> : <div className={styles.intro}>
      <span className={styles.introIcon} aria-hidden="true"><Icon name="folder" size={18} /></span>
      <div className={styles.introCopy}><strong>{loading ? t('workspaces.loading') : t('workspaces.empty')}</strong><span>{loadError || t('workspaces.hint')}</span></div>
      {!loading && <div className={styles.headerActions}>
        {loadError ? <Button size="sm" onClick={() => void reload(true)}>{t('workspaces.retry')}</Button> : <Button size="sm" variant="primary" data-project-add disabled={busy} icon={<Icon name="plus" size={14} />} onClick={startCreate}>{t('workspaces.create')}</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void chooseManifest()}>{t('workspaces.openManifest')}</Button>
      </div>}
    </div>}
    </div>
    <GuideDialog open={editName !== null} title={t(renaming ? 'workspaces.rename' : 'workspaces.create')} hint={t(renaming ? 'workspaces.renameHint' : 'workspaces.createHint')} closeDisabled={busy} onClose={() => setEditName(null)}>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void saveProject(); }}>
        <label>{t('workspaces.name')}<input autoFocus value={editName ?? ''} onChange={event => setEditName(event.target.value)} maxLength={160} /></label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer"><Button variant="ghost" disabled={busy} onClick={() => setEditName(null)}>{t('workspaces.cancel')}</Button><Button type="submit" variant="primary" loading={busy} disabled={!editName?.trim()}>{t('workspaces.save')}</Button></div>
      </form>
    </GuideDialog>
    <GuideDialog open={candidates !== null} title={t('workspaces.scanTitle')} hint={t('workspaces.scanHint')} wide closeDisabled={busy} onClose={closeScan}>
      <div className={styles.form}>
        {scanBusy && <div className={styles.scanning} role="status"><span className={styles.spinner} aria-hidden="true" /><span>{t('workspaces.scanning')}</span><Button size="sm" onClick={() => scanId.current && void native.cancelWorkspaceScan(scanId.current)}>{t('workspaces.stop')}</Button></div>}
        {partial && <p className={styles.warning} role="status">{t('workspaces.partial')}</p>}
        {!scanBusy && candidates && candidates.length > 0 && <div className={styles.scanBar}>
          <label className={styles.checkLabel}><input type="checkbox" disabled={!addable.length || busy} checked={checked.size > 0 && checked.size === addable.length} ref={node => { if (node) node.indeterminate = checked.size > 0 && checked.size < addable.length; }} onChange={event => setChecked(event.target.checked ? new Set(addable.map(item => item.path)) : new Set())} />{t('workspaces.selectAll')}</label>
          <span className={styles.muted}>{t('workspaces.scanSummary', { count: candidates.length, available: addable.length })}</span>
          {candidates.length > 6 && <div className={styles.scanSearch}><SearchField label={t('workspaces.search')} value={scanQuery} onChange={setScanQuery} placeholder={t('workspaces.search')} /></div>}
        </div>}
        {!scanBusy && candidates?.length === 0 && <p className={styles.empty}>{t('workspaces.scanEmpty')}</p>}
        {/* A search that hides every candidate keeps the selection; say so and offer the way back. */}
        {!scanBusy && !!candidates?.length && !visibleCandidates.length && <div className={styles.empty} role="status"><span>{t('workspaces.noMatches')}</span><Button size="sm" variant="ghost" onClick={() => setScanQuery('')}>{t('workspaces.clearFilters')}</Button></div>}
        {visibleCandidates.length > 0 && <div className={styles.candidates}>{visibleCandidates.map((item, index) => <label key={`${item.path}:${index}`} className={styles.candidate} data-kind={item.kind}>
          <input type="checkbox" disabled={item.kind !== 'repository' || busy} checked={checked.has(item.path)} onChange={event => setChecked(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.path); else next.delete(item.path); return next; })} />
          <span className={styles.candidateCopy}><span className={styles.candidateName}><strong>{item.name}</strong>{item.kind !== 'repository' && <Badge tone={kindTone[item.kind]}>{t(kindLabel[item.kind])}</Badge>}</span><span className={styles.mono}>{item.path}</span>{item.reason && <small>{item.reason}</small>}</span>
        </label>)}</div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer">
          <Button variant="ghost" disabled={busy} onClick={closeScan}>{t('workspaces.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={scanBusy || !checked.size || !current} onClick={() => current && void operate(async () => { const results = await native.addWorkspaceRepositories(current.id, [...checked], current.revision); const failed = results.filter(item => item.error); if (results.length > failed.length) setNotice(t('workspaces.added', { count: results.length - failed.length })); if (failed.length) { setChecked(new Set(failed.map(item => item.path))); throw new Error(failed.map(item => `${item.path}: ${item.error}`).join('\n')); } closeScan(); })}>{t('workspaces.selected', { count: checked.size })}</Button>
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
        <div className="dialog-footer"><Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>{t('workspaces.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void operate(async () => {
          // Accepting the file also continues the sender's member: the intent belongs to this
          // acceptance, so cancelling the preview leaves nothing to replay later.
          const source = preview.sourceRepositoryId;
          const result = await native.attachWorkspaceManifest(preview.path, preview.digest, preview.conflict);
          setSelectedId(result.id);
          setPreview(null);
          if (source) { setQuery(''); setFilter('all'); setSourceIntent({ workspaceId: result.id, repositoryId: source }); }
        })}>{t(preview.conflict ? 'workspaces.adopt' : 'workspaces.attach')}</Button></div>
      </div>}
    </GuideDialog>
  </section>;
}
