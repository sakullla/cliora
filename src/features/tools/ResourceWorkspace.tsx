import { useRemoteReads, RemoteReadStatus } from '../../lib/remoteReads';
import { CodeEditor } from '../../components/CodeEditor';
import { open } from '@tauri-apps/plugin-dialog';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Scope } from '../../types/native';
import type { NativeSkillEntry, SkillFileChange, SkillFileListing, SkillImportPreview, SkillInstallation, SkillManifest, SkillPackage, SkillRecoveryIssue, SkillTargetPreview, SkillTargetResult } from '../../types/resources';
import { SkillManifestView, isSkillManifest, skillBody } from './SkillManifestView';
import { fileFormat } from '../../lib/markdownLinks';
import { SKILL_FILE, SkillFileTrail, SkillFileView, SkillFilesPanel, useSkillReferences, type SkillFileState } from './SkillReader';
import { displayPath } from '../../lib/paths';
import { DocumentFoot, DocumentHeader, DocumentWorkspace, ModeSwitch, PathLine, Toggle, documentStyles as doc, type DocumentMode } from './DocumentWorkspace';
import { DocumentReader } from './DocumentReader';
import { EmptyState } from '../../components/EmptyState';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { confirmAction } from '../../lib/confirm';
import { saveShortcutHint, withMod } from '../../lib/shortcut';
import { Icon } from '../../components/Icon';
import { useFeedback } from '../../lib/toast';
import { SkeletonRows } from '../../components/Skeleton';
import i18n from '../../i18n';
import { samePath } from '../library/CliMarks';
import styles from './ResourceWorkspace.module.css';
import { Badge, Button, IconButton } from '../../components/ui';
import type { Tone } from '../../lib/statusTone';

const MarkdownView = lazy(() => import('../../components/MarkdownView'));

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}

function skillOrigin(entry: NativeSkillEntry): 'writable' | 'read_only' | 'plugin' {
  if (entry.source === 'plugin' || entry.source === 'read_only' || entry.source === 'writable') return entry.source;
  return entry.state === 'read_only' ? 'read_only' : 'writable';
}

function skillBadge(entry: NativeSkillEntry) {
  if (entry.state === 'unreadable') return i18n.t('tools.skills.stateUnreadable');
  const origin = skillOrigin(entry);
  if (origin === 'plugin') {
    if (entry.pluginEnabled === false) return i18n.t('tools.skills.pluginNotLoaded');
    if (entry.pluginEnabled === true) return i18n.t('tools.skills.pluginWillLoad');
    return i18n.t('tools.skills.stateReadOnly');
  }
  if (entry.state === 'managed') return i18n.t('tools.skills.stateInstalled');
  if (entry.state === 'external') return i18n.t('tools.skills.stateExternal');
  if (entry.state === 'read_only') return i18n.t('tools.skills.stateReadOnly');
  return i18n.t('tools.skills.stateUnreadable');
}

function pluginNote(entry: NativeSkillEntry) {
  const name = entry.pluginName ?? '';
  if (entry.pluginEnabled === false) return i18n.t('tools.skills.pluginNotLoadedNamed', { name });
  if (entry.pluginEnabled === true) return i18n.t('tools.skills.pluginWillLoadNamed', { name });
  return i18n.t('tools.skills.pluginReadOnlyNamed', { name });
}

type SourceFilter = 'all' | 'installed' | 'external' | 'read_only' | 'plugin';
type LoadFilter = 'all' | 'will_load' | 'not_loaded' | 'unreadable';

function sourceKind(entry: NativeSkillEntry): Exclude<SourceFilter, 'all'> | 'other' {
  if (skillOrigin(entry) === 'plugin') return 'plugin';
  if (entry.state === 'managed') return 'installed';
  if (entry.state === 'external') return 'external';
  if (entry.state === 'read_only' || skillOrigin(entry) === 'read_only') return 'read_only';
  return 'other';
}

/** `pluginEnabled === null` stays read-only and matches neither load bucket. */
function loadKind(entry: NativeSkillEntry, enabledByPackage: Record<string, boolean>): Exclude<LoadFilter, 'all'> | 'none' {
  if (entry.state === 'unreadable') return 'unreadable';
  const origin = skillOrigin(entry);
  if (origin === 'plugin') {
    if (entry.pluginEnabled === true) return 'will_load';
    if (entry.pluginEnabled === false) return 'not_loaded';
    return 'none';
  }
  if (origin !== 'writable') return 'none';
  if (!entry.packageId) return 'will_load';
  return enabledByPackage[entry.packageId] === false ? 'not_loaded' : 'will_load';
}

export function SkillsWorkspace({ toolId, scope, projectPath, contextId, remoteTargetId = null, onDirtyChange, focusPath = null }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; remoteTargetId?: string | null; onDirtyChange?: (dirty: boolean) => void; focusPath?: { path: string; token: number } | null }) {
  const { t } = useTranslation();
  const remoteReads = useRemoteReads(remoteTargetId, JSON.stringify([toolId, scope, projectPath]), true);
  const native = remoteReads.native;
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [nativeEntries, setNativeEntries] = useState<NativeSkillEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [recoveryIssues, setRecoveryIssues] = useState<SkillRecoveryIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [url, setUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null; installAfter: boolean } | null>(null);
  const [dependencyChecked, setDependencyChecked] = useState(false);
  const [skillEnabled, setSkillEnabled] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<SkillTargetPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [external, setExternal] = useState<NativeSkillEntry | null>(null);
  const [skillDoc, setSkillDoc] = useState<{ path: string; baseline: string; draft: string } | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [mode, setMode] = useState<DocumentMode>('read');
  const [infoOpen, setInfoOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [load, setLoad] = useState<LoadFilter>('all');
  const [enabledByPackage, setEnabledByPackage] = useState<Record<string, boolean>>({});
  const [retained, setRetained] = useState<NativeSkillEntry[]>([]);
  // Backend reading of the text on screen; `manifest` is null when the reader is unavailable.
  const [manifestState, setManifestState] = useState<{ text: string; name: string; manifest: SkillManifest | null } | null>(null);
  const [attachments, setAttachments] = useState<{ path: string; listing: SkillFileListing | null; error: string } | null>(null);
  // Referenced files opened from SKILL.md, oldest first; empty shows SKILL.md itself.
  const [trail, setTrail] = useState<Array<{ path: string; anchor: string | null }>>([]);
  const [fileStates, setFileStates] = useState<Record<string, SkillFileState>>({});
  const readerRef = useRef<HTMLDivElement | null>(null);
  const scrollMemory = useRef(new Map<string, number>());
  const skillRequest = useRef(0);
  remoteReads.bindWriteDraft(skillDoc?.path ?? (adding ? 'new' : null));
  const skillDirty = !!skillDoc && skillDoc.draft !== skillDoc.baseline;
  const formDirty = !!url.trim() || !!archiveSelection || !!pendingImport || adding || skillDirty;
  const formDirtyRef = useRef(false);
  formDirtyRef.current = formDirty;
  useLayoutEffect(() => { onDirtyChange?.(formDirty); }, [formDirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillTargetResult | null>(null);
  useEffect(() => {
    if (!result || result.status === 'failed') return;
    const timer = window.setTimeout(() => setResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [result]);
  const selected = packages.find((item) => item.id === selectedId);
  const project = scope === 'project' ? projectPath || null : null;
  const visibleIssues = recoveryIssues.filter((issue) => issue.toolId === toolId && (issue.scope === 'project' || (issue.contextId ?? null) === (contextId ?? null)));
  useEffect(() => { setPendingTarget(null); }, [toolId, scope, project, selectedId]);
  useEffect(() => {
    skillRequest.current += 1;
    setAdding(false);
    setExternal(null);
    setSkillDoc(null);
    setSkillLoading(false);
    setArchiveSelection(null);
    setPendingImport(null);
    setSelectedId(null);
    setPendingTarget(null);
    setRetained([]);
    setEnabledByPackage({});
    setQuery('');
    setSource('all');
    setLoad('all');
    setUrl('');
  }, [toolId, scope, project]);
  useEffect(() => {
    let live = true;
    void native.listSkillRecoveryIssues().then((issues) => { if (live) setRecoveryIssues(issues); })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
  const [scanError, setScanError] = useState('');
  const nativeReadSequence = useRef(0);
  useEffect(() => () => { nativeReadSequence.current++; skillRequest.current++; }, [remoteTargetId, toolId, scope, project]);
  async function loadNativeSkills() {
    remoteReads.rebaseWriteAction();
    const sequence = ++nativeReadSequence.current;
    try {
      const entries = remoteTargetId
        ? ((await native.getRemoteResourceStore(remoteTargetId, toolId, 'skills', { fresh: true }) as { entries?: NativeSkillEntry[] }).entries ?? []).map(entry => entry.packageId ? entry : { ...entry, packageId: `remote:${entry.path}` })
        : await native.scanNativeSkills(toolId, scope, project);
      if (sequence !== nativeReadSequence.current) return entries;
      setNativeEntries(entries);
      setScanError('');
      return entries;
    } catch (value) {
      if (sequence === nativeReadSequence.current) setScanError(errorText(value));
      throw value;
    }
  }
  useEffect(() => {
    if (!remoteReads.active) return;
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); setRetained([]); setScanError(''); setListLoading(false); return; }
    let live = true;
    setListLoading(true);
    setScanError('');
    void (remoteTargetId
      ? native.getRemoteResourceStore(remoteTargetId, toolId, 'skills').then(value => (value as { entries?: NativeSkillEntry[] }).entries ?? []).then(entries => entries.map(entry => entry.packageId ? entry : { ...entry, packageId: `remote:${entry.path}` }))
      : native.scanNativeSkills(toolId, scope, project)).then((entries) => { if (live) setNativeEntries(entries); })
      .catch((value) => { if (live) { setScanError(errorText(value)); } })
      .finally(() => { if (live) setListLoading(false); });
    return () => { live = false; };
  }, [toolId, scope, project, remoteTargetId, remoteReads.active]);
  const installed = installations.find((item) => item.toolId === toolId && item.scope === scope && item.projectPath === project && (item.contextId ?? null) === (scope === 'global' ? contextId ?? null : null));
  useEffect(() => {
    if (remoteTargetId) {
      let live = true;
      void native.getRemoteResourceStore(remoteTargetId, toolId, 'skills').then(value => {
        if (!live) return;
        const entries = (value as { entries?: NativeSkillEntry[] }).entries ?? [];
        setPackages(entries.map(entry => ({ id: entry.packageId ?? `remote:${entry.path}`, name: entry.name, description: entry.detail, compatibility: null, source: entry.path, digest: entry.digest ?? '', fileCount: 1, updatedAt: 0, inLibrary: true })));
      }).catch(value => { if (live) setError(errorText(value)); });
      return () => { live = false; };
    }
    void native.listSkillPackages().then(setPackages).catch((value) => setError(errorText(value)));
  }, [remoteTargetId, toolId]);
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    if (remoteTargetId) { setInstallations([]); setSkillEnabled(true); return () => { live = false; }; }
    void Promise.all([native.listSkillInstallations(selectedId),native.getSkillEnabled(selectedId,toolId,scope,project)]).then(([items,enabled]) => { if (live) { setInstallations(items); setSkillEnabled(enabled); setEnabledByPackage(current => current[selectedId] === enabled ? current : { ...current, [selectedId]: enabled }); } })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [selectedId, toolId, scope, project, remoteTargetId]);

  async function installPackage(packageId: string) {
    if (scope === 'project' && !project) { setError(t('tools.skills.pickProjectFirst')); return; }
    const item = (await native.listSkillPackages()).find((entry) => entry.id === packageId);
    if (!item) return;
    if (item.compatibility && !dependencyChecked) { setError(t('tools.skills.dependencyFirst')); setSelectedId(packageId); return; }
    const targetPreview = await native.previewSkillTarget(packageId, toolId, scope, project);
    if (targetPreview.status === 'conflict') { setPendingTarget(targetPreview); setSelectedId(packageId); return; }
    const outcome = await native.installSkill(packageId, toolId, scope, project, targetPreview.previewToken, false);
    setResult(outcome);
    setInstallations(await native.listSkillInstallations(packageId));
    await loadNativeSkills();
    setSkillEnabled(await native.getSkillEnabled(packageId, toolId, scope, project));
    setRecoveryIssues(await native.listSkillRecoveryIssues());
    if (outcome.status !== 'failed') setAdding(false);
  }

  async function place(item: SkillPackage, existed: boolean) {
    if (syncLibrary) await native.setSkillInLibrary(item.id, true);
    else if (!existed) await native.setSkillInLibrary(item.id, false);
    await finishImported(item, true);
  }

  async function finishImported(item: SkillPackage, installAfter: boolean) {
    setPackages(await native.listSkillPackages());
    setSelectedId(item.id);
    setResult(null);
    setAdding(false);
    setExternal(null);
    if (installAfter) await installPackage(item.id);
  }

  async function local() {
    remoteReads.beginWriteAction();
    try {
      const source = await open({ directory: true, multiple: false, title: t('tools.skills.pickDirTitle') });
      if (typeof source !== 'string') return;
      setBusy(true); setError('');
      if (remoteTargetId) {
        await native.importRemoteSkillDirectory(remoteTargetId, toolId, source);
        await loadNativeSkills();
        setResult({ toolId, scope, projectPath: project, path: source, status: 'installed', detail: t('tools.skills.saved') });
        return;
      }
      const preview = await native.previewSkillLocal(source);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source, subdirectory: null, installAfter: true }); return;
      }
      const item = await native.importSkillLocal(source, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function archive(source: string, localZip: boolean, chosen?: string) {
    setBusy(true); setError('');
    try {
      let child = chosen ?? null;
      if (chosen === undefined) {
        const entries = await native.listSkillZipEntries(source, localZip);
        if (entries.length > 1) { setArchiveSelection({ source, local: localZip, entries, chosen: null }); return; }
        child = entries[0] || null;
      }
      const preview = localZip ? await native.previewSkillLocalZip(source, child) : await native.previewSkillHttpsZip(source, child);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: localZip ? 'local_zip' : 'zip', source, subdirectory: child, installAfter: true }); setArchiveSelection(null); return;
      }
      const item = localZip ? await native.importSkillLocalZip(source, child, preview.digest, preview.existingDigest) : await native.importSkillHttpsZip(source, child, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest);
      if (!localZip) setUrl('');
      setArchiveSelection(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function localZip() {
    try {
      const source = await open({ directory: false, multiple: false, title: t('tools.skills.pickZipTitle'), filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof source === 'string') await archive(source, true);
    } catch (value) { setError(errorText(value)); }
  }
  async function confirmImport() {
    if (!pendingImport) return;
    setBusy(true); setError('');
    try {
      const { preview, kind, source, subdirectory, installAfter } = pendingImport;
      const item = kind === 'local'
        ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      setPendingImport(null);
      if (kind === 'zip') setUrl('');
      if (installAfter) await place(item, !!preview.existingDigest);
      else { await native.setSkillInLibrary(item.id, true); setExternal(null); setSelectedId(null); setSkillDoc(null); setResult({ toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: t('tools.skills.addedToLibrary') }); }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  function resetDocument() {
    skillRequest.current += 1;
    setMode('read');
    setAdding(false);
    setSyncLibrary(false);
    setExternal(null);
    setArchiveSelection(null);
    setPendingImport(null);
    setSkillDoc(null);
    setSkillLoading(false);
    setSelectedId(null);
    setPendingTarget(null);
    setUrl('');
    setAttachments(null);
    resetFiles();
  }
  function resetFiles() {
    setTrail([]);
    setFileStates({});
    scrollMemory.current.clear();
  }
  async function confirmLeave() {
    if (!formDirtyRef.current) return true;
    const request = skillRequest.current;
    return confirmAction(t('common.app.leaveDirtyMessage'), () => skillRequest.current === request, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  async function openNative(entry: NativeSkillEntry) {
    const sameEntry = external?.path === entry.path || (!external && !!entry.packageId && entry.packageId === selectedId);
    if (sameEntry && !adding && !archiveSelection && !pendingImport) return;
    if (!(await confirmLeave())) return;
    const request = ++skillRequest.current;
    setAdding(false);
    setError('');
    setExternal(entry.packageId ? null : entry);
    setSelectedId(entry.packageId);
    setSkillDoc(null);
    setSkillLoading(true);
    setMode('read');
    setInfoOpen(false);
    setArchiveSelection(null);
    setPendingImport(null);
    setPendingTarget(null);
    setUrl('');
    setAttachments(null);
    resetFiles();
    try {
      const document = remoteTargetId
        ? { content: ((await native.getRemoteResourceStore(remoteTargetId, toolId, 'skills', { fresh: true }) as { documents?: Record<string, string> }).documents ?? {})[entry.path] ?? '' }
        : await native.readNativeSkill(toolId, scope, project, entry.path);
      if (skillRequest.current !== request) return;
      setSkillDoc({ path: entry.path, baseline: document.content, draft: document.content });
      // Remote hosts only carry SKILL.md documents; attachments are local only.
      if (!remoteTargetId) void loadAttachments(entry.path, request);
    } catch (value) {
      if (skillRequest.current === request) setError(errorText(value));
    } finally {
      if (skillRequest.current === request) setSkillLoading(false);
    }
  }
  async function loadAttachments(path: string, request: number) {
    try {
      const listing = await native.listNativeSkillFiles(toolId, scope, project, path);
      if (skillRequest.current !== request) return;
      setAttachments({ path, listing: listing && Array.isArray(listing.files) ? listing : null, error: '' });
    } catch (value) {
      if (skillRequest.current === request) setAttachments({ path, listing: null, error: errorText(value) });
    }
  }
  async function loadFile(directory: string, file: string) {
    const request = skillRequest.current;
    setFileStates(current => ({ ...current, [file]: { preview: null, error: '' } }));
    try {
      const preview = await native.readNativeSkillReference(toolId, scope, project, directory, file);
      if (skillRequest.current === request) setFileStates(current => ({ ...current, [file]: { preview, error: '' } }));
    } catch (value) {
      if (skillRequest.current === request) setFileStates(current => ({ ...current, [file]: { preview: null, error: errorText(value) } }));
    }
  }
  /** Opens a file the skill references in the reader; SKILL.md itself returns to the top. */
  function openFile(path: string, anchor: string | null) {
    if (!skillDoc || remoteTargetId) return;
    const leaving = trail.at(-1)?.path ?? SKILL_FILE;
    if (readerRef.current) scrollMemory.current.set(leaving, readerRef.current.scrollTop);
    if (path === SKILL_FILE) { setTrail([]); return; }
    scrollMemory.current.delete(path);
    setTrail(current => current.at(-1)?.path === path ? current : [...current, { path, anchor }]);
    if (!fileStates[path]?.preview) void loadFile(skillDoc.path, path);
  }
  function returnTo(index: number) {
    const leaving = trail.at(-1)?.path ?? SKILL_FILE;
    if (readerRef.current) scrollMemory.current.set(leaving, readerRef.current.scrollTop);
    setTrail(current => current.slice(0, index + 1));
  }
  const openedFile = trail.at(-1) ?? null;
  const readerPath = openedFile?.path ?? SKILL_FILE;
  // Back and breadcrumb return to where the reader was; a newly opened file starts at the top or its anchor.
  useLayoutEffect(() => {
    const node = readerRef.current;
    const remembered = scrollMemory.current.get(readerPath);
    if (node && remembered !== undefined) node.scrollTop = remembered;
  }, [readerPath, fileStates[readerPath]?.preview]);
  // A jump from a plugin's contents opens that skill once the native list has it.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focusPath || appliedFocus.current === focusPath.token) return;
    const entry = nativeEntries.find(item => samePath(item.path, focusPath.path));
    if (!entry) return;
    appliedFocus.current = focusPath.token;
    void openNative(entry);
  }, [focusPath, nativeEntries]);
  async function saveSkill() {
    if (!skillDoc || skillDoc.draft === skillDoc.baseline) return;
    const request = skillRequest.current;
    const saved = skillDoc;
    setBusy(true); setError('');
    try {
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'skills', { fresh: true }) as { entries?: NativeSkillEntry[]; documents?: Record<string, string> };
        // The cached store keeps each entry's issues; recompute them for the saved text.
        const savedEntry = (current.entries ?? []).find(item => item.path === saved.path);
        const manifest = savedEntry ? await native.analyzeSkillDocument(savedEntry.name, saved.draft).catch(() => null) : null;
        const entries = (current.entries ?? []).map(item => item === savedEntry && isSkillManifest(manifest) ? { ...item, issues: manifest.issues.map(issue => issue.code) } : item);
        await native.saveRemoteResourceStore(remoteTargetId, toolId, 'skills', { entries, documents: { ...(current.documents ?? {}), [saved.path]: saved.draft } });
      } else {
        await native.saveNativeSkill(toolId, scope, project, saved.path, saved.baseline, saved.draft);
      }
      if (skillRequest.current !== request) return;
      setSkillDoc({ ...saved, baseline: saved.draft });
      setMode('read');
      await loadNativeSkills();
      setResult({ toolId, scope, projectPath: project, path: saved.path, status: 'installed', detail: t('tools.skills.saved') });
    } catch (value) {
      if (skillRequest.current === request) setError(errorText(value));
    } finally {
      if (skillRequest.current === request) setBusy(false);
    }
  }
  async function syncExternal() {
    if (!external) return;
    setBusy(true); setError('');
    try {
      const preview = await native.previewSkillLocal(external.path);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source: external.path, subdirectory: null, installAfter: false }); return;
      }
      const item = await native.importSkillLocal(external.path, preview.digest, preview.existingDigest);
      await native.setSkillInLibrary(item.id, true);
      setResult({ toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: t('tools.skills.addedToLibrary') });
      setExternal(null); setSelectedId(null); setSkillDoc(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function change(remove: boolean) {
    remoteReads.beginWriteAction();
    if (!selected) return;
    if (scope === 'project' && !project) { setError(t('tools.skills.pickProjectFirst')); return; }
    if (!remove && selected.compatibility && !dependencyChecked) { setError(t('tools.skills.dependencyFirst')); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'skills', { fresh: true }) as { entries?: NativeSkillEntry[]; documents?: Record<string, string> };
        const entry = (current.entries ?? []).find(item => item.packageId === selected.id || `remote:${item.path}` === selected.id);
        if (remove && entry) {
          await native.saveRemoteResourceStore(remoteTargetId, toolId, 'skills', { ...current, entries: (current.entries ?? []).filter(item => item !== entry), documents: Object.fromEntries(Object.entries(current.documents ?? {}).filter(([path]) => path !== entry.path)) });
        }
        setPendingTarget(null); await loadNativeSkills(); setResult({ toolId, scope, projectPath: project, path: entry?.path ?? selected.source, status: remove ? 'removed' : 'already_current', detail: remove ? t('tools.skills.removed', { path: entry?.path ?? selected.source }) : t('tools.skills.saved') });
        if (remove) resetDocument();
        return;
      }
      const targetPreview = !remove ? pendingTarget ?? await native.previewSkillTarget(selected.id, toolId, scope, project) : null;
      if (!remove && !pendingTarget && targetPreview?.status === 'conflict') { setPendingTarget(targetPreview); return; }
      const outcome = remove ? await native.removeSkill(selected.id, toolId, scope, project, contextId)
        : await native.installSkill(selected.id, toolId, scope, project, targetPreview?.previewToken ?? null, targetPreview?.status === 'conflict');
      setResult(outcome);
      setPendingTarget(null);
      setInstallations(await native.listSkillInstallations(selected.id));
      await loadNativeSkills();
      setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));
      setRecoveryIssues(await native.listSkillRecoveryIssues());
      if (outcome.status !== 'failed' && remove) resetDocument();
      else if (outcome.status !== 'failed') setAdding(false);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function toggleSkill(next: boolean) {
    remoteReads.beginWriteAction();
    if (!selected) return;
    const remembered = nativeEntries.find(item => item.packageId === selected.id) ?? retained.find(item => item.packageId === selected.id) ?? null;
    setBusy(true); setError('');
    try {
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'skills', { fresh: true }) as { entries?: NativeSkillEntry[]; documents?: Record<string, string> };
        const entries = (current.entries ?? []).map(item => item.packageId === selected.id || `remote:${item.path}` === selected.id ? { ...item, state: next ? 'external' as const : 'read_only' as const } : item);
        await native.saveRemoteResourceStore(remoteTargetId, toolId, 'skills', { ...current, entries });
        setSkillEnabled(next); await loadNativeSkills(); return;
      }
      await native.setSkillEnabled(selected.id, toolId, scope, project, next, contextId);
      const enabled = await native.getSkillEnabled(selected.id, toolId, scope, project);
      setSkillEnabled(enabled);
      setEnabledByPackage(current => ({ ...current, [selected.id]: enabled }));
      setInstallations(await native.listSkillInstallations(selected.id));
      const found = await loadNativeSkills();
      setRetained(current => {
        const visible = current.filter(item => item.packageId !== selected.id && !found.some(entry => entry.path === item.path));
        if (!remembered || enabled || found.some(item => item.path === remembered.path)) return visible;
        return [...visible, remembered];
      });
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function checkRecovery() {
    try { setRecoveryIssues(await native.listSkillRecoveryIssues()); setError(''); }
    catch (value) { setError(errorText(value)); }
  }

  const recovery = !!visibleIssues.length && <div className={styles.error} role="alert"><strong>{t('tools.skills.recoveryTitle')}</strong><p>{t('tools.skills.recoveryDetail')}</p>{visibleIssues.map((issue) => <div key={issue.operationId} className={styles.fileChange}><strong>{issue.scope === 'global' ? t('tools.apply.global') : t('tools.skills.recoveryProject', { path: issue.projectPath ?? '' })}</strong><p>{issue.detail}</p><p>{t('tools.skills.recoveryTarget', { path: issue.targetPath })}</p><p>{t('tools.skills.recoveryBackup', { path: issue.backupPath })}</p><button type="button" onClick={() => void navigator.clipboard.writeText(issue.backupPath).catch((value) => setError(errorText(value)))}>{t('tools.skills.recoveryCopy')}</button></div>)}<button type="button" onClick={() => void checkRecovery()}>{t('tools.skills.recoveryRecheck')}</button></div>;
  const outcome = result && (result.status === 'failed' || result.detail === t('tools.skills.saved') ? result.detail : result.detail === t('tools.skills.addedToLibrary') ? t('tools.skills.addedToLibraryNote') : result.status === 'removed' ? t('tools.skills.removed', { path: result.path ?? '' }) : t('tools.skills.installed', { path: result.path ?? '' }));
  // Outside the document, results float as page toasts instead of pushing the list down.
  const feedback = useFeedback();
  // Disabling a writable skill archives its directory out of the scan. Keep that row until a later scan returns it; a failed scan clears the cache.
  const extras = retained.filter(item => !nativeEntries.some(entry => entry.path === item.path));
  const entries = extras.length ? [...nativeEntries, ...extras] : nativeEntries;
  const openedEntry = external ?? entries.find(item => !!item.packageId && item.packageId === selectedId) ?? null;
  const subject = external ?? openedEntry;
  const origin = subject ? skillOrigin(subject) : selected ? 'writable' as const : null;
  const needsProject = scope === 'project' && !project;
  const canEditSkill = origin === 'writable' && subject?.state !== 'unreadable';
  const documentOpen = adding || !!subject || !!selected || !!skillDoc || skillLoading || !!archiveSelection || !!pendingImport || !!pendingTarget;
  useEffect(() => {
    if (documentOpen) return;
    if (error) { feedback.setError(error); setError(''); }
    else if (outcome) { if (result?.status === 'failed') feedback.setWarning(outcome); else feedback.setNotice(outcome); setResult(null); }
  }, [documentOpen, error, outcome, result, feedback]);
  const installState: { label: string; tone: Tone } = installed?.state === 'current' ? { label: t('tools.skills.stateInstalled'), tone: 'success' }
    : installed?.state === 'update_available' ? { label: t('tools.skills.stateUpdate'), tone: 'info' }
    : installed?.state === 'conflict' ? { label: t('tools.skills.stateConflict'), tone: 'warning' }
    : installed?.state === 'disabled' ? { label: t('tools.skills.stateDisabled'), tone: 'neutral' }
    : installed?.state === 'missing' ? { label: t('tools.skills.stateMissing'), tone: 'danger' }
    : { label: t('tools.skills.stateNotInstalled'), tone: 'neutral' };

  const needle = query.trim().toLowerCase();
  const visible = entries.filter(item => {
    if (needle && !item.name.toLowerCase().includes(needle) && !(skillOrigin(item) === 'plugin' && item.pluginName?.toLowerCase().includes(needle))) return false;
    if (source !== 'all' && sourceKind(item) !== source) return false;
    if (load !== 'all' && loadKind(item, enabledByPackage) !== load) return false;
    return true;
  });
  const filtering = needle.length > 0 || source !== 'all' || load !== 'all';
  const docTitle = openedEntry?.name ?? selected?.name ?? t('tools.skills.currentTitle');
  const skillName = subject?.name ?? selected?.name ?? '';
  const readingDraft = skillDoc && mode === 'read' ? skillDoc.draft : null;
  useEffect(() => {
    if (readingDraft === null) return;
    if (manifestState && manifestState.text === readingDraft && manifestState.name === skillName) return;
    let live = true;
    void native.analyzeSkillDocument(skillName, readingDraft)
      .then(value => { if (live) setManifestState({ text: readingDraft, name: skillName, manifest: isSkillManifest(value) ? value : null }); })
      .catch(() => { if (live) setManifestState({ text: readingDraft, name: skillName, manifest: null }); });
    return () => { live = false; };
  }, [readingDraft, skillName]);
  const skillPath = subject?.path || skillDoc?.path || '';
  const showLibrary = !!external && origin !== 'plugin';
  const showRemove = !!selected && !!installed && origin !== 'plugin';
  const showUpdate = !!selected && installed?.state === 'update_available' && origin !== 'plugin';
  const documentNote = subject?.state === 'unreadable' ? subject.detail
    : origin === 'plugin' && subject ? pluginNote(subject)
    : skillDoc && canEditSkill ? t('tools.skills.editorNote')
    : '';

  async function openAdding() {
    if (adding) return;
    if (!(await confirmLeave())) return;
    skillRequest.current += 1;
    setAdding(true);
    setSyncLibrary(false);
    setExternal(null);
    setSelectedId(null);
    setSkillDoc(null);
    setSkillLoading(false);
    setArchiveSelection(null);
    setPendingImport(null);
    setPendingTarget(null);
    setError('');
    setUrl('');
  }
  async function closeDocument() {
    if (!(await confirmLeave())) return;
    resetDocument();
  }
  function onEditorKey(event: KeyboardEvent<HTMLElement>) {
    if (!withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (event.repeat || busy || !canEditSkill || !skillDoc || skillDoc.draft === skillDoc.baseline) return;
    void saveSkill();
  }
  function clearFilters() { setQuery(''); setSource('all'); setLoad('all'); }
  async function discardSkill() {
    if (!skillDoc || skillDoc.draft === skillDoc.baseline) { setMode('read'); return; }
    const request = skillRequest.current;
    if (!await confirmAction(t('common.app.leaveDirtyMessage'), () => skillRequest.current === request, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') })) return;
    setSkillDoc(current => current ? { ...current, draft: current.baseline } : current);
    setMode('read');
  }
  function filePair(file: SkillFileChange, afterLabel: string) {
    return <details key={file.path} className={styles.fileChange}><summary>{file.path}</summary><div className={styles.fileDiff}><div><strong>{t('tools.skills.currentLabel')}</strong>{file.before !== null ? <pre>{file.before}</pre> : <small>{file.beforeSize === null ? t('tools.skills.notExists') : t('tools.skills.fileMeta', { size: file.beforeSize, digest: file.beforeDigest })}</small>}</div><div><strong>{afterLabel}</strong>{file.after !== null ? <pre>{file.after}</pre> : <small>{file.afterSize === null ? t('tools.agents.delete') : t('tools.skills.fileMeta', { size: file.afterSize, digest: file.afterDigest })}</small>}</div></div></details>;
  }
  function entryButton(item: NativeSkillEntry) {
    const entryOrigin = skillOrigin(item);
    const loadedWithPlugin = entryOrigin === 'plugin' && item.pluginEnabled === true && item.state !== 'unreadable';
    const current = external?.path === item.path || (!external && !!item.packageId && item.packageId === selectedId);
    // Scans and fixtures can omit detail. A missing or blank value is not a summary.
    // Read-only bundles prefix a short note onto the description; the list shows the description, same as every other skill.
    const rawSummary = typeof item.detail === 'string' ? item.detail.trim() : '';
    const noteSplit = entryOrigin === 'read_only' ? rawSummary.indexOf(' · ') : -1;
    const summary = noteSplit >= 0 ? rawSummary.slice(noteSplit + 3).trim() : rawSummary;
    const tone: Tone = item.state === 'managed' || loadedWithPlugin ? 'success' : item.state === 'unreadable' || item.state === 'read_only' || (entryOrigin === 'plugin' && !loadedWithPlugin) ? 'warning' : 'neutral';
    return <button type="button" key={item.path} className={doc.row} aria-current={current || undefined} title={displayPath(item.path)} onClick={() => void openNative(item)}>
      <span className={doc.rowTitle}><strong>{item.name}</strong></span>
      {summary && <span className={doc.rowSummary}>{summary}</span>}
      <span className={doc.rowMeta}>
        <Badge tone={tone}>{skillBadge(item)}</Badge>
        {entryOrigin === 'plugin' && <Badge>{t('tools.skills.sourcePlugin')}</Badge>}
        {entryOrigin === 'plugin' && item.pluginName && <span className={doc.rowNote}>{item.pluginName}</span>}
        {(item.issues?.length ?? 0) > 0 && <Badge tone="warning">{t('tools.skills.specIssues')}</Badge>}
      </span>
    </button>;
  }
  const archivePanel = archiveSelection && <div className={styles.distribution}><label>{t('tools.skills.archiveLabel')}<select aria-label={t('tools.skills.archiveAria')} value={archiveSelection.chosen ?? '__choose__'} onChange={event => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">{t('tools.skills.archivePlaceholder')}</option>{archiveSelection.entries.map(entry => <option key={entry} value={entry}>{entry || t('tools.skills.archiveRoot')}</option>)}</select></label><div className={styles.actions}><button type="button" onClick={() => setArchiveSelection(null)}>{t('common.dialog.cancel')}</button><button type="button" disabled={busy || archiveSelection.chosen === null} onClick={() => void archive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>{t('tools.skills.archiveImport')}</button></div></div>;
  const importPanel = pendingImport && <div className={styles.resultList} role="group" aria-label={t('tools.skills.importLabel')}>
    <strong>{t('tools.skills.importTitle', { name: pendingImport.preview.name })}</strong>
    <p>{pendingImport.installAfter ? t('tools.skills.importInstallNote') : t('tools.skills.importLibraryNote')}</p>
    <p>{t('tools.skills.importSource', { source: pendingImport.preview.source, count: pendingImport.preview.fileCount })}</p>
    {isSkillManifest(pendingImport.preview.manifest)
      ? <SkillManifestView manifest={pendingImport.preview.manifest} directory={pendingImport.preview.name} />
      : pendingImport.preview.compatibility && <p>{t('tools.skills.importCompat', { requirement: pendingImport.preview.compatibility })}</p>}
    <p>{t('tools.skills.importChangesNote')}</p>
    {pendingImport.preview.changes.map(file => filePair(file, t('tools.skills.importAfterLabel')))}
    <div className={styles.actions}><button type="button" onClick={() => setPendingImport(null)}>{t('tools.skills.importCancel')}</button><Button variant="primary" disabled={busy} onClick={() => void confirmImport()}>{pendingImport.installAfter ? t('tools.skills.importConfirmInstall') : t('tools.skills.importConfirmLibrary')}</Button></div>
  </div>;
  const targetPanel = pendingTarget && <div className={styles.resultList} role="group" aria-label={t('tools.skills.previewLabel')}><strong>{pendingTarget.status === 'conflict' ? t('tools.skills.conflictTitle') : t('tools.skills.confirmTitle')}</strong><p>{pendingTarget.detail} · {pendingTarget.path}</p>
    {pendingTarget.changes.map(file => filePair(file, t('tools.skills.afterLabel')))}
    <div className={styles.actions}><button type="button" onClick={() => setPendingTarget(null)}>{t('common.dialog.cancel')}</button><Button variant="primary" disabled={busy} onClick={() => void change(false)}>{pendingTarget.status === 'conflict' ? t('tools.skills.confirmTakeover') : t('tools.skills.confirmInstall')}</Button></div>
  </div>;
  const status = <>
    {outcome && <p role="status" className={result?.status === 'failed' ? styles.error : styles.notice}>{outcome}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </>;
  const reading = !adding && !archiveSelection && (!!subject || !!selected || skillLoading || !!skillDoc || !!pendingImport || !!pendingTarget);
  const addForm = <form className={doc.doc} aria-label={t('tools.skills.add')} onSubmit={event => event.preventDefault()}>
    <DocumentHeader title={t('tools.skills.add')} meta={t('tools.skills.addHint')} />
    <div className={doc.scroll}>
      <div className={styles.sources}>
        <button type="button" aria-label={t('tools.skills.pickFolder')} disabled={busy} onClick={() => void local()}><span className={styles.sourceIcon} aria-hidden="true"><Icon name="folder" size={18} /></span><strong>{t('tools.skills.pickFolder')}</strong><span>{t('tools.skills.pickFolderHint')}</span></button>
        <button type="button" aria-label={t('tools.skills.importZip')} disabled={busy} onClick={() => void localZip()}><span className={styles.sourceIcon} aria-hidden="true"><Icon name="archive" size={18} /></span><strong>{t('tools.skills.importZip')}</strong><span>{t('tools.skills.importZipHint')}</span></button>
      </div>
      <label className={styles.urlField}>{t('tools.skills.zipUrl')}<span className={styles.urlRow}><input aria-label={t('tools.skills.zipUrlAria')} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><button type="button" disabled={busy || !url.trim()} onClick={() => void archive(url.trim(), false)}>{t('tools.skills.importUrl')}</button></span></label>
      <label className={styles.syncOption}><input type="checkbox" checked={syncLibrary} onChange={event => setSyncLibrary(event.target.checked)} /><span><strong>{t('tools.mcp.quickSync')}</strong><small>{t('tools.mcp.quickSyncHint')}</small></span></label>
      {archivePanel}
      {importPanel}
      {status}
    </div>
  </form>;

  const docDirty = !!skillDoc && skillDoc.draft !== skillDoc.baseline;
  const metaNote = subject?.state === 'unreadable' ? '' : documentNote && documentNote !== t('tools.skills.editorNote') ? documentNote : '';
  const packageMeta = selected && canEditSkill ? [t('tools.skills.fileCount', { count: selected.fileCount }), skillEnabled ? '' : t('tools.skills.disabledHint')].filter(Boolean).join(' · ') : '';
  const transient = targetPanel || importPanel;
  const listing = attachments && attachments.path === skillDoc?.path ? attachments : null;
  const readManifest = skillDoc && manifestState && manifestState.text === skillDoc.draft && manifestState.name === skillName ? manifestState : null;
  const readBody = skillDoc && readManifest?.manifest ? skillBody(skillDoc.draft, readManifest.manifest) : '';
  // Links and path-like code resolve against local files; remote hosts carry SKILL.md only.
  const skillDirectory = skillDoc?.path ?? '';
  const resolver = skillDoc && !remoteTargetId
    ? (from: string, targets: string[]) => native.resolveNativeSkillReferences(toolId, scope, project, skillDirectory, from, targets)
    : null;
  const rootText = skillDoc && mode === 'read' && !openedFile && readManifest ? readManifest.manifest ? readBody : skillDoc.draft : null;
  const rootRefs = useSkillReferences(resolver, skillDirectory, SKILL_FILE, rootText);
  const openedText = openedFile && mode === 'read' && fileFormat(openedFile.path) === 'markdown' ? fileStates[openedFile.path]?.preview?.text ?? null : null;
  const fileRefs = useSkillReferences(resolver, skillDirectory, openedFile?.path ?? '', openedText);
  const rootLinks = resolver ? { resolve: rootRefs.resolve, open: openFile } : undefined;
  const fileLinks = resolver ? { resolve: fileRefs.resolve, open: openFile } : undefined;
  const referenced = [...new Set([...(rootRefs.paths?.values() ?? [])].filter((path): path is string => !!path && path.startsWith('../')))];
  const filesPanel = skillDoc && !remoteTargetId ? <SkillFilesPanel listing={listing?.listing ?? null} error={listing?.error ?? ''} referenced={referenced} onOpen={path => openFile(path, null)} /> : null;
  const readView = !skillDoc ? null
    : !readManifest
      ? <div className={doc.body} role="status" aria-label={t('tools.skills.loading')}><div className={doc.pending}><span /><span /><span /></div></div>
      : !readManifest.manifest
        ? <DocumentReader text={skillDoc.draft} format="markdown" label={t('tools.skills.previewRegion')} files={rootLinks} />
        : <div ref={readerRef} className={doc.body} role="region" aria-label={t('tools.skills.previewRegion')} tabIndex={0}>
          <div className={doc.readColumn}>
            <SkillManifestView manifest={readManifest.manifest} directory={skillName} />
            {readBody.trim()
              ? <Suspense fallback={<pre className={doc.lead}>{readBody}</pre>}><MarkdownView text={readBody} files={rootLinks} /></Suspense>
              : !readManifest.manifest.description && !readManifest.manifest.issues.length && <p className={doc.empty}>{t('common.document.empty')}</p>}
            {filesPanel}
          </div>
        </div>;
  const fileView = skillDoc && openedFile ? <>
    <SkillFileTrail trail={trail.map(item => item.path)} size={fileStates[openedFile.path]?.preview?.size ?? null} onBack={() => returnTo(trail.length - 2)} onCrumb={returnTo} />
    <SkillFileView key={`${trail.length}:${openedFile.path}`} path={openedFile.path} anchor={openedFile.anchor} state={fileStates[openedFile.path]} mode={mode} label={t('tools.skills.fileRegion', { path: openedFile.path })} links={fileLinks} regionRef={readerRef} onRetry={() => void loadFile(skillDoc.path, openedFile.path)} />
  </> : null;
  const article = <article className={doc.doc} aria-label={docTitle}>
    <DocumentHeader
      title={docTitle}
      badges={<>
        {origin === 'plugin' && <Badge><Icon name="package" size={11} />{t('tools.skills.sourcePlugin')}</Badge>}
        {origin === 'read_only' && <Badge><Icon name="lock" size={11} />{t('tools.skills.stateReadOnly')}</Badge>}
        {external && origin === 'writable' && <Badge>{t('tools.skills.stateExternal')}</Badge>}
        {selected && canEditSkill && <Badge tone={installState.tone}>{installState.label}</Badge>}
      </>}
      tools={<>
        {skillDoc && <ModeSwitch mode={mode} editable={canEditSkill && !openedFile} onChange={setMode} />}
        {selected && canEditSkill && <Toggle checked={skillEnabled} label={t('tools.skills.enableAria')} text={skillEnabled ? t('tools.skills.enabledNote') : t('tools.skills.disabledNote')} disabled={busy || (!installed && !entries.some(item => item.name === selected?.name) && !skillEnabled)} onChange={value => void toggleSkill(value)} />}
        {(skillPath || selected) && <IconButton size="sm" className={doc.iconButton} aria-expanded={infoOpen} aria-label={t('tools.skills.pathToggle')} title={t('tools.skills.pathToggle')} onClick={() => setInfoOpen(value => !value)} icon={<Icon name="info" size={15} />} />}
      </>}
      meta={metaNote || packageMeta ? <>{metaNote && <span>{metaNote}</span>}{packageMeta && <span>{packageMeta}</span>}</> : undefined}
      metaActions={showLibrary || showRemove || showUpdate ? <>
        {showUpdate && <Button variant="ghost" size="sm" className={doc.ghostButton} data-tone="accent" disabled={busy || needsProject} onClick={() => void change(false)}><Icon name="refresh" size={13} />{t('tools.skills.updateToScope')}</Button>}
        {showLibrary && <Button variant="ghost" size="sm" className={doc.ghostButton} data-tone="accent" disabled={busy} onClick={() => void syncExternal()}><Icon name="library" size={13} />{t('tools.skills.addToLibrary')}</Button>}
        {showRemove && <Button variant="ghost" size="sm" className={doc.ghostButton} data-tone="danger" disabled={busy} onClick={() => void change(true)}><Icon name="trash" size={13} />{t('tools.mcp.removeFromTool')}</Button>}
      </> : undefined}
    />
    {infoOpen && <div className={doc.info}>
      {skillPath && <PathLine path={skillPath} label={t('common.document.path')} />}
      {selected && <PathLine path={selected.source} label={t('common.document.source_')} />}
      {selected?.description && <p>{selected.description}</p>}
    </div>}
    {selected && canEditSkill && selected.compatibility && <label className={doc.strip} data-tone="warn"><input type="checkbox" checked={dependencyChecked} onChange={event => setDependencyChecked(event.target.checked)} /><span>{t('tools.skills.compatibilityChecked', { requirement: selected.compatibility })}</span></label>}
    {subject?.state === 'unreadable' && subject.detail && subject.detail !== error && <p className={doc.strip} data-tone="warn"><Icon name="alert" size={14} /><span>{subject.detail}</span></p>}
    {(outcome || error) && <div className={styles.docStatus}>{status}</div>}
    {transient
      ? <div className={doc.scroll}>{targetPanel}{importPanel}</div>
      : skillLoading
        ? <div className={doc.body} role="status" aria-label={t('tools.skills.loading')}><div className={doc.pending}><span /><span /><span /></div></div>
        : skillDoc
          ? fileView ?? (mode === 'read'
            ? readView
            : <div className={doc.editor} data-readonly={!canEditSkill || undefined}><CodeEditor format="markdown" label={t('tools.skills.editorLabel')} documentId={skillDoc.path} value={skillDoc.draft} onChange={value => setSkillDoc(current => current ? { ...current, draft: value } : current)} readOnly={busy || !canEditSkill} /></div>)
          : <div className={doc.body} />}
    {canEditSkill && skillDoc && !transient && !openedFile && (mode === 'edit' || docDirty) && <DocumentFoot dirty={docDirty} note={t('tools.skills.editorNote')}>
      {docDirty
        ? <button type="button" disabled={busy} onClick={() => void discardSkill()}>{t('common.document.discard')}</button>
        : <button type="button" onClick={() => setMode('read')}>{t('common.document.done')}</button>}
      <Button variant="primary" data-dialog-save title={saveShortcutHint()} disabled={busy || !docDirty} onClick={() => void saveSkill()}>{t('tools.skills.save')}</Button>
    </DocumentFoot>}
  </article>;

  return <DocumentWorkspace documentKey={adding ? 'new' : selectedId} label={t('tools.workspace.view.skills')} toolbarLabel={needsProject ? undefined : t('tools.skills.toolbar')} backLabel={t('tools.skills.back')} onBack={() => { void closeDocument(); }} onKeyDown={onEditorKey}
    heading={needsProject ? undefined : t('tools.workspace.view.skills')}
    count={needsProject || !entries.length ? undefined : t('tools.skills.count', { filtered: visible.length, total: entries.length })}
    actions={needsProject ? undefined : <IconButton variant="primary" size="sm" aria-label={t('tools.skills.add')} title={t('tools.skills.add')} disabled={busy} onClick={() => void openAdding()} icon={<Icon name="plus" size={16} />} />}
    search={needsProject || !entries.length ? undefined : <SearchField type="search" label={t('tools.skills.searchLabel')} placeholder={t('tools.skills.searchPlaceholder')} value={query} onChange={setQuery} />}
    filters={needsProject || !entries.length ? undefined : <>
      <FilterSelect className={styles.filterSelect} label={t('tools.skills.sourceFilter')} value={source} triggerDetail={false} options={[
        { value: 'all', label: t('tools.skills.sourceAll') },
        { value: 'installed', label: t('tools.skills.stateInstalled') },
        { value: 'external', label: t('tools.skills.stateExternal') },
        { value: 'read_only', label: t('tools.skills.stateReadOnly') },
        { value: 'plugin', label: t('tools.skills.sourcePlugin') },
      ]} onChange={value => setSource(value as SourceFilter)} />
      <FilterSelect className={styles.filterSelect} label={t('tools.skills.loadFilter')} value={load} triggerDetail={false} options={[
        { value: 'all', label: t('tools.skills.loadAll') },
        { value: 'will_load', label: t('tools.skills.loadWill') },
        { value: 'not_loaded', label: t('tools.skills.pluginNotLoaded') },
        { value: 'unreadable', label: t('tools.skills.stateUnreadable') },
      ]} onChange={value => setLoad(value as LoadFilter)} />
      {filtering && <Button variant="ghost" size="sm" className={doc.ghostButton} onClick={clearFilters}><Icon name="close" size={12} />{t('tools.skills.clearFilters')}</Button>}
    </>}
    notices={<><RemoteReadStatus state={remoteReads} />{recovery || scanError ? <>
      {recovery}
      {scanError && <p className={styles.error} role="status">{t('tools.skills.scanFailed', { detail: scanError })}</p>}
    </> : null}</>}
    list={needsProject
      ? <div className={doc.noMatch}><Icon name="folder" size={20} /><p>{t('tools.mcp.pickProjectFirst')}</p></div>
      : listLoading && !entries.length
        ? <div className={styles.skeleton} role="status" aria-label={t('tools.skills.listLoading')}><SkeletonRows count={3} /></div>
        : scanError && !entries.length
          ? null
          : !entries.length
            ? <EmptyState icon="sparkle" title={t('tools.skills.emptyTitle')} detail={t('tools.skills.emptyDetail')} action={!adding ? <Button variant="primary" disabled={busy} onClick={() => void openAdding()}><Icon name="plus" size={14} />{t('tools.skills.add')}</Button> : undefined} />
            : filtering && !visible.length
              ? <div className={doc.noMatch}><Icon name="search" size={18} /><p>{needle ? t('tools.skills.noMatchQuery', { query: query.trim() }) : t('tools.skills.noMatch')}</p><button type="button" onClick={clearFilters}>{t('tools.skills.clearFilters')}</button></div>
              : <nav className={doc.rows} aria-label={t('tools.skills.listLabel')}>{visible.map(entryButton)}</nav>}
    placeholder={entries.length > 0 && !documentOpen ? <div className={doc.placeholder}><span className={doc.placeholderIcon} aria-hidden="true"><Icon name="sparkle" size={22} /></span><strong>{t('tools.skills.selectHint')}</strong><p>{t('tools.skills.selectDetail')}</p></div> : null}
    document={adding || archiveSelection ? addForm : reading ? article : null}
  />;
}
