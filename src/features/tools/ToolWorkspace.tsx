import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction, type ConfirmationOptions } from '../../lib/confirm';
import { sameDraftRequest } from '../../lib/draftGuard';
import { importedConnection } from '../../lib/nativeDraft';
import type { ModelRoleValue } from './adapters/contract';
import type { DraftRequest } from '../../lib/draftGuard';
import type { ApiError } from '../../types/domain';
import type { Project, TrayRepairTarget } from '../../types/launch';
import type { AdapterDescriptor, ApplyComparison, Connection, ConnectionCheck, ModelDirectory, NativeInspection, NativePreview, RegisteredCommon, RegisteredProfile, RegisteredToolWorkspace, Scope } from '../../types/native';
import { authEnvName, uiAdapterFor } from './adapters';
import { McpWorkspace, SkillsWorkspace } from './ResourceWorkspace';
import { ToolIcon } from '../../components/ToolIcon';
import { FileConflict } from '../../components/FileConflict';
import { displayPath } from '../../lib/paths';
import { CodeEditor } from '../../components/CodeEditor';
import styles from './ToolWorkspace.module.css';

type View = 'form' | 'native' | 'merged';
type Editor = 'profile' | 'common' | 'native';

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) return String((value as ApiError).message);
  return '操作失败，请重试。';
}

function defaultConnection(formats: string[]): Connection {
  return { providerId: '', interfaceFormat: formats[0] ?? 'openai_responses', baseUrl: '', model: '', secretRef: null, authEnvVar: null };
}

function formatLabel(value: string): string {
  return ({ openai_completions: 'Chat Completions', openai_responses: 'Responses', anthropic_messages: 'Anthropic Messages' } as Record<string, string>)[value] ?? value;
}

function connectionShape(value: Connection | null): string {
  return value ? JSON.stringify([value.providerId, value.interfaceFormat, value.baseUrl, value.model, value.authEnvVar]) : '';
}

function emptyProfile(tool: string): RegisteredProfile {
  return { id: '', tool, name: '', version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} };
}

export function ToolWorkspacePage({ managedTools, initialTool, openSequence = 0, active = true, repair, onDirtyChange }: { active?: boolean; managedTools: AdapterDescriptor[]; initialTool?: string; openSequence?: number; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [tool, setTool] = useState<string>(repair?.toolId ?? initialTool ?? managedTools[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>(repair?.scope ?? 'global');
  const [projectPath, setProjectPath] = useState(repair?.projectPath ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [choosingProject, setChoosingProject] = useState(false);
  const [preferredProfileId, setPreferredProfileId] = useState<string | null>(repair?.profileId ?? null);
  const appliedRepair = useRef(repair?.sequence ?? 0);
  const appliedOpenSequence = useRef(0);
  const [workspace, setWorkspace] = useState<RegisteredToolWorkspace | null>(null);
  const [editor, setEditor] = useState<Editor>('profile');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const draftRevision = useRef(0);
  const [draft, setDraftState] = useState<RegisteredProfile | null>(null);
  const setDraft = (value: SetStateAction<RegisteredProfile | null>) => {
    draftRevision.current++;
    setDraftState(value);
  };
  const [commonDraft, setCommonDraft] = useState<RegisteredCommon | null>(null);
  const [view, setView] = useState<View>('form');
  const [resourceView, setResourceView] = useState<'config' | 'mcp' | 'skills'>(repair?.resourceView ?? 'config');
  const [mcpDirty, setMcpDirty] = useState(false);
  const [skillsDirty, setSkillsDirty] = useState(false);
  const [resourceEpoch, setResourceEpoch] = useState(0);
  const [role, setRole] = useState('settings');
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const [modelDirectory, setModelDirectory] = useState<ModelDirectory | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [manualRoles, setManualRoles] = useState<string[]>([]);
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck | null>(null);
  const [inspection, setInspection] = useState<NativeInspection | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [newSecret, setNewSecret] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [rawDisk, setRawDisk] = useState<{ context: string; role: string; original: string; text: string } | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fileConflict, setFileConflict] = useState<{ context: string; current: string } | null>(null);
  const [backups, setBackups] = useState<{ transactionId: string; path: string }[]>([]);
  const [backupPreview, setBackupPreview] = useState<{ transactionId: string; current: string; original: string } | null>(null);
  const [applyComparison, setApplyComparison] = useState<ApplyComparison | null>(null);
  const loadSequence = useRef(0);
  const modelSequence = useRef(0);
  const modelSource = useRef('');
  const inspectionSequence = useRef(0);
  const importSequence = useRef(0);
  const rawSequence = useRef(0);
  const reasoningSequence = useRef(0);
  const previewSequence = useRef(0);
  const savedDraft = useRef('');
  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    void native.listProjects().then(result => { if (active) setProjects(result); }).catch(value => { if (active) setError(errorText(value)); });
    return () => { active = false; };
  }, []);

  const visibleTools = managedTools;
  const currentTool = visibleTools.some((item) => item.id === tool) ? tool : visibleTools[0]?.id;
  useEffect(()=>setApplyComparison(null),[currentTool,scope,projectPath]);
  const currentDescriptor = visibleTools.find((item) => item.id === currentTool);
  const toolName = currentDescriptor?.name ?? currentTool ?? '';
  const uiAdapter = uiAdapterFor(currentTool ?? '');
  const draftContext = JSON.stringify([currentTool, scope, projectPath, selectedId, editor]);
  const latestDraft = useRef<DraftRequest<RegisteredProfile>>({ context: draftContext, revision: draftRevision.current, draft });
  latestDraft.current = { context: draftContext, revision: draftRevision.current, draft };
  const captureDraft = (): DraftRequest<RegisteredProfile> => ({ ...latestDraft.current });
  const stillCurrent = (started: DraftRequest<RegisteredProfile>) => sameDraftRequest(started, { ...latestDraft.current, revision: draftRevision.current });
  const invalidateDraftRequest = () => { draftRevision.current++; };
  const connection = draft?.connection ?? (draft && editor === 'profile' ? { ...defaultConnection(workspace?.probe.interfaceFormats ?? []), providerId:'my-provider' } : null);
  useEffect(() => { setRevealedSecret(null); }, [draftContext, connection?.secretRef, newSecret]);
  const fileSignature = JSON.stringify(draft?.files ?? {});
  const effectiveEnvName = authEnvName(uiAdapter, connection, currentTool ?? '');
  const pendingRaw = rawDisk?.context === draftContext ? rawDisk : null;
  const activeRaw = pendingRaw?.role === role ? pendingRaw : null;
  const dirty = (editor === 'profile' ? !!draft && JSON.stringify(draft) !== savedDraft.current : editor === 'common' && !!commonDraft && JSON.stringify(commonDraft) !== savedDraft.current) || !!pendingRaw && pendingRaw.text !== pendingRaw.original || !!newSecret;
  const refreshState = useRef({ currentTool, scope, projectPath, selectedId, editor, dirty, busy, mcpDirty, skillsDirty });
  refreshState.current = { currentTool, scope, projectPath, selectedId, editor, dirty, busy, mcpDirty, skillsDirty };
  const confirmationContext = JSON.stringify([draftContext, draft, commonDraft, rawDisk, newSecret, mcpDirty, skillsDirty]);
  const latestConfirmation = useRef(confirmationContext); latestConfirmation.current = confirmationContext;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function confirmChange(message: string, options: ConfirmationOptions = { title: '放弃未保存修改？', confirmLabel: '放弃修改' }) {
    const started = captureDraft();
    const context = latestConfirmation.current;
    return confirmAction(message, () => mounted.current && stillCurrent(started) && context === latestConfirmation.current, options);
  }
  useLayoutEffect(() => { onDirtyChange?.(dirty || mcpDirty || skillsDirty); }, [dirty, mcpDirty, skillsDirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  const reload = useCallback(async (nextTool: string, nextScope: Scope, nextProject: string, preferredId?: string | null) => {
    if (!nativeAvailable || (nextScope === 'project' && !nextProject.trim())) { loadSequence.current++; setWorkspace(null); return; }
    const sequence = ++loadSequence.current;
    setLoading(true); setError('');
    try {
      const result = await native.getRegisteredToolWorkspace(nextTool, nextScope, nextProject);
      if (sequence !== loadSequence.current) return;
      setWorkspace(result);
      setRawDisk(null);
      setEditor('profile');
      setCustomPath(result.customPath ?? '');
      const next = result.profiles.find((item) => item.id === preferredId) ?? result.profiles.find((item) => item.id === result.binding?.profileId) ?? result.profiles[0] ?? null;
      setSelectedId(next?.id ?? null);
      setDraft(next ? structuredClone(next) : null);
      savedDraft.current = next ? JSON.stringify(next) : '';
      setCommonDraft(result.common ? structuredClone(result.common) : { tool: nextTool, version: 0, files: {} });
      setRole(result.probe.nativeFiles.find(item => !item.sensitive && item.role === uiAdapterFor(nextTool).primaryRole)?.role ?? result.probe.nativeFiles.find((item) => !item.sensitive)?.role ?? 'settings');
    } catch (value) {
      if (sequence === loadSequence.current) { setWorkspace(null); setError(errorText(value)); }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);

  useLayoutEffect(() => {
    loadSequence.current++; invalidateDraftRequest(); inspectionSequence.current++;
    setFileConflict(null); setBackups([]); setBackupPreview(null); setWorkspace(null); setDraft(null); setCommonDraft(null); setSelectedId(null); setRawDisk(null);
    setNotice(''); setError(''); setInspection(null); setNewSecret(''); savedDraft.current = '';
  }, [currentTool, scope, projectPath]);
  useEffect(() => { if (active && currentTool) void reload(currentTool, scope, projectPath, preferredProfileId); }, [currentTool, scope, projectPath, preferredProfileId, reload]);

  async function discardUnsavedDrafts() {
    invalidateDraftRequest();
    setRawDisk(null);
    setNewSecret('');
    setRevealedSecret(null);
    setNotice('');
    setMcpDirty(false);
    setSkillsDirty(false);
    setResourceEpoch((value) => value + 1);
    if (currentTool) {
      await reload(currentTool, scope, projectPath, selectedId);
      return;
    }
    setDraft(null);
    setCommonDraft(null);
    setSelectedId(null);
    setEditor('profile');
    savedDraft.current = '';
  }

  useEffect(() => {
    if (!openSequence || appliedOpenSequence.current === openSequence) return;
    appliedOpenSequence.current = openSequence;
    let live = true;
    void (async () => {
      const hadUnsaved = dirty || mcpDirty || skillsDirty;
      if (hadUnsaved && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
      if (!live) return;
      if (hadUnsaved) await discardUnsavedDrafts();
      else invalidateDraftRequest();
      if (!live) return;
      if (initialTool) setTool(initialTool);
      setResourceView('config');
      setNotice('');
    })();
    return () => { live = false; };
  }, [openSequence]);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listen('cliora:portable-changed', () => {
      const started = refreshState.current;
      if (!started.currentTool || started.scope === 'project' && !started.projectPath.trim()) return;
      const sequence = ++loadSequence.current;
      void native.getRegisteredToolWorkspace(started.currentTool, started.scope, started.projectPath).then((result) => {
        if (!active || sequence !== loadSequence.current) return;
        const current = refreshState.current;
        if (current.currentTool !== started.currentTool || current.scope !== started.scope || current.projectPath !== started.projectPath) return;
        setWorkspace(result);
        setLoading(false);
        if (current.dirty || current.busy || current.mcpDirty || current.skillsDirty) {
          setNotice('已收到资料更新；当前未保存草稿已保留，保存时会检查资料是否变化。');
          return;
        }
        const common = result.common ? structuredClone(result.common) : { tool: started.currentTool!, version: 0, files: {} };
        setCommonDraft(common);
        if (current.editor === 'common') { savedDraft.current = JSON.stringify(common); return; }
        if (current.editor === 'native') return;
        const next = result.profiles.find((item) => item.id === current.selectedId) ?? result.profiles.find((item) => item.id === result.binding?.profileId) ?? result.profiles[0] ?? null;
        setSelectedId(next?.id ?? null);
        setDraft(next ? structuredClone(next) : null);
        savedDraft.current = next ? JSON.stringify(next) : '';
      }).catch((value) => { if (active && sequence === loadSequence.current) { setLoading(false); setError(errorText(value)); } });
    }).then((unlisten) => { if (active) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { active = false; stop?.(); };
  }, []);

  useEffect(() => {
    if (!repair || repair.page !== 'connections' || appliedRepair.current === repair.sequence || !repair.toolId) return;
    appliedRepair.current = repair.sequence;
    let live = true;
    void (async () => {
      if ((dirty || mcpDirty || skillsDirty) && !await confirmChange('当前草稿尚未保存，打开托盘指向的配置会丢失这些修改。继续吗？')) {
        if (live) setNotice('当前草稿已保留；可保存后再从托盘打开修复位置。');
        return;
      }
      if (!live) return;
      invalidateDraftRequest();
      setTool(repair.toolId!);
      setScope(repair.scope ?? 'global');
      setProjectPath(repair.projectPath ?? '');
      setPreferredProfileId(repair.profileId);
      setResourceView(repair.resourceView ?? 'config');
      setNotice('已打开托盘操作对应的配置位置。');
      if (repair.toolId === currentTool && repair.scope === scope && (repair.projectPath ?? '') === projectPath && repair.profileId === preferredProfileId) {
        void reload(repair.toolId!, repair.scope, repair.projectPath ?? '', repair.profileId);
      }
    })();
    return () => { live = false; };
  }, [repair?.sequence]);

  useEffect(() => {
    if (!nativeAvailable || view !== 'merged' || !draft || editor !== 'profile') return;
    const sequence = ++previewSequence.current;
    const timer = window.setTimeout(() => {
      void native.previewRegisteredNativeProfile(draft, scope).then((result) => { if (sequence === previewSequence.current) { setPreview(result); setError(''); } }).catch((value) => { if (sequence === previewSequence.current) { setPreview(null); setError(errorText(value)); } });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft, editor, scope, view]);

  const refreshModels = useCallback(async (source: Connection, force: boolean) => {
    if (!nativeAvailable || !source.baseUrl.trim()) return;
    const sequence = ++modelSequence.current;
    setModelLoading(true);
    try {
      const result = await native.listProviderModels(source, force);
      if (sequence === modelSequence.current) setModelDirectory(result);
    } catch (value) {
      if (sequence === modelSequence.current) setModelDirectory({ models: [], status: 'error', fetchedAt: null, source: 'provider_directory', error: errorText(value) });
    } finally { if (sequence === modelSequence.current) setModelLoading(false); }
  }, []);

  useEffect(() => {
    const source = connection ? JSON.stringify([connection.providerId, connection.interfaceFormat, connection.baseUrl, connection.secretRef]) : '';
    if (source === modelSource.current) return;
    modelSource.current = source;
    modelSequence.current++;
    setConnectionCheck(null);
    setModelLoading(false);
    if (!connection) { setModelDirectory(null); return; }
    setModelDirectory(null);
  }, [connection?.providerId, connection?.interfaceFormat, connection?.baseUrl, connection?.secretRef, refreshModels]);
  useEffect(() => { setConnectionCheck(null); }, [connection?.model]);

  useEffect(() => {
    if (!draft || !currentTool || !nativeAvailable) { setInspection(null); return; }
    const sequence = ++inspectionSequence.current;
    const timer = window.setTimeout(() => {
      void native.inspectRegisteredNativeDraft(currentTool, draft.files).then((result) => { if (sequence === inspectionSequence.current) setInspection(result); }).catch(() => { if (sequence === inspectionSequence.current) setInspection(null); });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [currentTool, fileSignature]);

  const roleModels = uiAdapter.modelMapping?.read(draft?.files[uiAdapter.modelMapping.fileRole] ?? '') ?? {};
  const primaryModel = draft?.connection ? uiAdapter.modelMapping?.decodeModel?.(connection?.model ?? '') ?? {model:connection?.model ?? '',name:'',longContext:false}
    : (uiAdapter.modelMapping?.primaryRole ? roleModels[uiAdapter.modelMapping.primaryRole] : undefined) ?? {model:connection?.model ?? '',name:'',longContext:false};
  if (uiAdapter.modelMapping?.primaryRole && connection) roleModels[uiAdapter.modelMapping.primaryRole] = primaryModel;
  const modelOptions = useMemo(() => [...new Set([...(primaryModel.model ? [primaryModel.model] : []), ...(modelDirectory?.models ?? [])])], [modelDirectory, primaryModel.model]);
  const availableRoles = workspace?.probe.nativeFiles.filter((item) => !item.sensitive).map((item) => item.role) ?? ['settings'];
  const activeFile = workspace?.probe.nativeFiles.find((item) => item.role === role);

  async function selectProfile(profile: RegisteredProfile) {
    if (dirty && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    setRawDisk(null); setNewSecret(''); setEditor('profile'); setSelectedId(profile.id); setDraft(structuredClone(profile)); savedDraft.current = JSON.stringify(profile);
    setView('form'); setError(''); setNotice(''); setApplyComparison(null);
  }

  async function switchResourceView(next: 'config' | 'mcp' | 'skills') {
    if (next === resourceView) return;
    const hadUnsaved = dirty || mcpDirty || skillsDirty;
    if (hadUnsaved && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    if (hadUnsaved) await discardUnsavedDrafts();
    setResourceView(next);
  }

  async function createProfile() {
    if (!currentTool) return;
    if (dirty && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    const next = emptyProfile(currentTool);
    const used = new Set(workspace?.profiles.map(profile => profile.name));
    let suffix = 1;
    while (used.has(suffix === 1 ? '新配置' : `新配置 ${suffix}`)) suffix++;
    next.name = suffix === 1 ? '新配置' : `新配置 ${suffix}`;
    const preset = workspace?.probe.providerPresets[0];
    next.connection = { ...defaultConnection(workspace?.probe.interfaceFormats ?? []), providerId: preset?.id ?? 'my-provider', baseUrl: preset?.baseUrl ?? '', interfaceFormat: preset?.interfaceFormat ?? workspace?.probe.interfaceFormats[0] ?? 'openai_responses' };
    setRawDisk(null); setEditor('profile'); setSelectedId(null); setDraft(next); savedDraft.current = JSON.stringify(next);
    setView('form'); setManualModel(false); setNewSecret(''); setError(''); setNotice(''); setApplyComparison(null);
  }

  async function editCommon() {
    if (!currentTool) return;
    if (dirty && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    setApplyComparison(null);
    invalidateDraftRequest();
    const next = structuredClone(workspace?.common ?? { tool: currentTool, version: 0, files: {} });
    setRawDisk(null); setNewSecret(''); setEditor('common'); setCommonDraft(next); savedDraft.current = JSON.stringify(next);
    setView('native'); setError(''); setNotice('');
  }

  async function save(applyAfter: boolean) {
    if (!nativeAvailable || busy) return;
    if (editor === 'profile' && draft && !draft.name.trim()) { setError('请输入配置名称。'); document.querySelector<HTMLInputElement>('[name="profile-name"]')?.focus(); return; }
    const started = captureDraft();
    setBusy(true); setError(''); setNotice('');
    let savedForTakeover: RegisteredProfile | null = null;
    try {
      if (editor === 'native' && pendingRaw && currentTool) {
        await native.saveRegisteredNativeFile(currentTool, scope, projectPath, pendingRaw.role, pendingRaw.original, pendingRaw.text);
        if (!stillCurrent(started)) return;
        const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, pendingRaw.role);
        if (!stillCurrent(started)) return;
        setRawDisk({ ...pendingRaw, original: text, text });
        const updated = await native.getRegisteredToolWorkspace(currentTool, scope, projectPath);
        if (!stillCurrent(started)) return;
        setWorkspace(updated); setNotice('已保存到正在使用的文件。');
      } else if (editor === 'common' && commonDraft) {
        const result = await native.saveRegisteredCommonConfig(commonDraft, commonDraft.version || null);
        if (!stillCurrent(started)) { setNotice('原通用草稿已保存；当前编辑内容已保留。'); return; }
        const saved = result.common;
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
        const failed = result.applications.filter((item) => item.status === 'failed');
        setNotice(failed.length ? `通用配置已保存；${failed.length} 个活动范围未能应用，请检查并重试。` : `通用配置已保存；${result.applications.length} 个活动范围已检查并应用。`);
        if (currentTool) await reload(currentTool, scope, projectPath, selectedId);
        setEditor('common');
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
      } else if (draft && currentTool) {
        let files = draft.files;
        if (pendingRaw) {
          const current = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, pendingRaw.role);
          if (!stillCurrent(started)) return;
          const text = current === pendingRaw.original ? pendingRaw.text : await native.mergeRegisteredNativeEdits(currentTool, pendingRaw.role, pendingRaw.original, pendingRaw.text, current);
          if (!stillCurrent(started)) return;
          files = { ...draft.files, [pendingRaw.role]: text };
        }
        const imported = await native.prepareRegisteredNativeImport(currentTool, files);
        if (!stillCurrent(started)) return;
        const nativeCredentials = { ...draft.nativeCredentials };
        if (pendingRaw) delete nativeCredentials[pendingRaw.role];
        Object.assign(nativeCredentials, imported.nativeCredentials);
        let editedConnection = pendingRaw ? imported.inspection.connection : imported.migratedSecret || !draft.connection ? importedConnection(imported, draft.connection) : draft.connection;
        editedConnection = await connectionWithSecret(editedConnection, started);
        if (!stillCurrent(started)) return;
        const edited = { ...draft, files: imported.files, nativeCredentials, connection: editedConnection };
        const saved = await native.saveRegisteredNativeProfile(edited, edited.version || null);
        savedForTakeover = saved;
        if (!stillCurrent(started)) { setNotice('原草稿已保存；当前继续编辑的内容已保留。'); return; }
        if (applyAfter) {
          const outcome = await native.applyRegisteredNativeProfile(currentTool, saved.id, scope, projectPath, false);
          if (!stillCurrent(started)) return;
          setNotice(outcome.status === 'already_matching' ? '原生文件已与配置一致。下次启动会读取这份配置。' : '已保存并给这个工具使用。下次启动会读取这份配置。');
        } else setNotice('配置已保存，尚未写入这个工具。');
        setNewSecret(''); setDraft(saved); savedDraft.current = JSON.stringify(saved); setSelectedId(saved.id);
        await reload(currentTool, scope, projectPath, saved.id);
      }
    } catch (value) {
      if (!stillCurrent(started)) return;
      const message = errorText(value);
      setError(message);
      if (editor === 'native' && pendingRaw && currentTool) {
        const current = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, pendingRaw.role).catch(() => null);
        if (stillCurrent(started) && current !== null && current !== pendingRaw.original) setFileConflict({ context: draftContext, current });
      }
      if ((message.includes('请确认接管') || message.includes('外部修改')) && savedForTakeover) await compareApplication(savedForTakeover);
      if (savedForTakeover) { setDraft(savedForTakeover); setSelectedId(savedForTakeover.id); savedDraft.current = JSON.stringify(savedForTakeover); }
    }
    finally { setBusy(false); }
  }

  async function compareApplication(profile:RegisteredProfile) {
    const started=captureDraft();
    try {const result=await native.compareRegisteredApplication(profile.id,scope,projectPath);if (stillCurrent(started)) setApplyComparison(result);}
    catch(value){if(stillCurrent(started))setError(errorText(value));}
  }
  async function resolveApplication() {
    if (!applyComparison || busy) return;
    const started=captureDraft();setBusy(true);setError('');
    try {await native.applyComparedApplication(applyComparison,scope,projectPath);if(stillCurrent(started)){setApplyComparison(null);setNotice('已使用此配置，下次启动生效。');await reload(applyComparison.profile.tool,scope,projectPath,applyComparison.profile.id);}}
    catch(value){if(stillCurrent(started))setError(errorText(value));}
    finally{setBusy(false);}
  }
  async function applySaved(profile: RegisteredProfile, allowTakeover = false) {
    if (!currentTool || busy) return;
    const started=captureDraft();
    setBusy(true); setError(''); setNotice('');
    try {
      const outcome = await native.applyRegisteredNativeProfile(currentTool, profile.id, scope, projectPath, allowTakeover);
      if (!stillCurrent(started)) {setNotice('所选配置已应用，继续编辑的内容已保留。');return;}
      setApplyComparison(null);
      
      setNotice(outcome.status === 'already_matching' ? '原生文件已与配置一致。' : '已使用此配置，下次启动生效。');
      await reload(currentTool, scope, projectPath, profile.id);
    } catch (value) {
      if (!stillCurrent(started)) return;
      const message = errorText(value);
      setError(message);
      if (message.includes('请确认接管') || message.includes('外部修改')) await compareApplication(profile);
    } finally { setBusy(false); }
  }

  async function connectionWithSecret(source: Connection | null, started: DraftRequest<RegisteredProfile>): Promise<Connection | null> {
    if (!newSecret) return source;
    if (!source) throw new Error('请先配置 API 地址，或返回常用设置填写连接。');
    const secretRef = await native.setConnectionSecret(newSecret);
    if (!stillCurrent(started)) return source;
    return { ...source, secretRef };
  }

  async function showSecret() {
    if (revealedSecret !== null) { setRevealedSecret(null); return; }
    const started = captureDraft();
    try {
      const secret = newSecret || (connection?.secretRef ? await native.getConnectionSecret(connection.secretRef) : '');
      if (stillCurrent(started)) setRevealedSecret(secret);
    } catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
  }

  async function duplicateProfile() {
    if (!draft || dirty && !await confirmChange('当前草稿尚未保存，复制前放弃这些修改？')) return;
    setApplyComparison(null);
    const names = workspace?.profiles.map(item => item.name) ?? [];
    const base = `${draft.name} 副本`; let name = base; let count = 2;
    while (names.includes(name)) name = `${base} ${count++}`;
    const copied = { ...structuredClone(draft), id: '', name, version: 0, revision: undefined };
    setDraft(copied); setSelectedId(null); setEditor('profile'); setView('form'); setRawDisk(null); savedDraft.current = ''; setNotice('');
  }

  async function fetchModels() {
    if (!connection || busy || modelLoading) return;
    const started = captureDraft();
    setBusy(true); setError('');
    try {
      const source = await connectionWithSecret(connection, started);
      if (!stillCurrent(started) || !source || !draft) return;
      if (source.secretRef !== connection.secretRef) {
        modelSource.current = JSON.stringify([source.providerId, source.interfaceFormat, source.baseUrl, source.secretRef]);
        setDraft({ ...draft, connection: source }); setNewSecret('');
      }
      await refreshModels(source, true);
    } catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function switchProject(path: string) {
    if (path === projectPath) return;
    if ((dirty || mcpDirty || skillsDirty) && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    invalidateDraftRequest(); setProjectPath(path);
  }

  async function chooseProjectFolder() {
    const context = draftContext;
    setChoosingProject(true);
    try {
      const picked = await open({ directory: true, multiple: false, title: '选择配置项目文件夹' });
      if (typeof picked === 'string' && latestDraft.current.context === context) switchProject(picked);
    } catch (value) { if (latestDraft.current.context === context) setError(errorText(value)); }
    finally { setChoosingProject(false); }
  }

  async function checkConnection(allowModelRequest: boolean) {
    if (!connection || checkingConnection) return;
    const started = captureDraft();
    if (allowModelRequest && !await confirmChange('这会向供应商发送一条最小模型请求，可能产生费用。', { title: '发送可能计费的请求？', confirmLabel: '发送请求' })) return;
    if (!stillCurrent(started)) return;
    setCheckingConnection(true); setConnectionCheck(null);
    try { const result = await native.testRegisteredProviderConnection(currentTool, connection, allowModelRequest); if (stillCurrent(started)) setConnectionCheck(result); }
    catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
    finally { setCheckingConnection(false); }
  }

  async function login() {
    if (!currentTool || busy) return;
    setBusy(true); setError('');
    try { await native.launchCliLogin(currentTool); setNotice(currentDescriptor?.login?.hint ?? '在外部终端完成登录。'); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function choosePath() {
    if (!currentTool || busy) return;
    setBusy(true); setError('');
    try { await native.setRegisteredCustomCliPath(currentTool, customPath.trim() || null); await reload(currentTool, scope, projectPath, selectedId); setNotice('CLI 路径已保存并重新检测。'); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function copyGuidance(command: string) {
    try { await navigator.clipboard.writeText(command); setNotice('命令已复制。请在终端执行，完成后点击“重新检测”。'); }
    catch { setError('复制失败，请手动选择命令文本复制。'); }
  }

  function applyPreset(providerId: string, baseUrl: string, interfaceFormat: string) {
    if (!draft?.connection) return;
    setDraft({ ...draft, connection: { ...draft.connection, providerId, baseUrl, interfaceFormat, secretRef: null, authEnvVar: null } });
    setConnectionCheck(null); setNotice('已填入官方接口地址与格式；模型和认证仍需确认。');
  }

  function adoptInspectedConnection() {
    if (!draft || !inspection?.connection) return;
    const found = inspection.connection;
    const sameAccount = draft.connection?.providerId === found.providerId && draft.connection?.baseUrl === found.baseUrl && draft.connection?.interfaceFormat === found.interfaceFormat;
    setDraft({ ...draft, connection: { ...found, secretRef: sameAccount ? draft.connection?.secretRef ?? null : null } });
    setNotice('表单已按当前原生草稿更新；未识别字段仍保留在原文中。');
  }

  async function importCurrentNative(automatic = false, copy = false) {
    if (!workspace || !currentTool) return;
    const started = captureDraft();
    if (dirty && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    if (!stillCurrent(started)) return;
    const sequence = ++importSequence.current;
    const roles = workspace.snapshots.filter((item) => item.fingerprint && !workspace.probe.nativeFiles.find((file) => file.role === item.role)?.sensitive).map((item) => item.role);
    if (!roles.length) { setError('还没有可读取的原生配置文件。'); return; }
    try {
      const imported = await native.prepareRegisteredNativeImportFromDisk(currentTool, scope, projectPath, roles, {});
      const primaryRole = roles.includes(role) ? role : roles[0];
      const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, primaryRole);
      if (sequence !== importSequence.current || !stillCurrent(started)) return;
      const next = { ...emptyProfile(currentTool), name: '本机配置', files: imported.files, connection: imported.inspection.connection, nativeCredentials: imported.nativeCredentials };
      setDraft(next); setSelectedId(null); setEditor('profile'); setNewSecret(''); savedDraft.current = automatic ? JSON.stringify(next) : '';
      setRole(primaryRole);
      setRawDisk(copy ? null : { context: JSON.stringify([currentTool, scope, projectPath, null, 'profile']), role: primaryRole, original: text, text });
      setInspection(imported.inspection); setView(copy ? 'form' : 'native'); setError('');
      setNotice('');
    } catch (value) { if (sequence === importSequence.current && stillCurrent(started)) setError(errorText(value)); }
  }

  async function openCurrentFile(nextRole = role, abandonConfirmed = false) {
    if (!currentTool) return;
    const started = captureDraft();
    if (dirty && !abandonConfirmed && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    if (!stillCurrent(started)) return;
    const sequence = ++rawSequence.current;
    try {
      const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, nextRole);
      if (sequence !== rawSequence.current || !stillCurrent(started)) return;
      setDraft(null); setSelectedId(null); setEditor('native'); setNewSecret(''); setRole(nextRole); setView('native'); savedDraft.current = '';
      setRawDisk({ context: JSON.stringify([currentTool, scope, projectPath, null, 'native']), role: nextRole, original: text, text });
      setNotice(''); setError('');
    } catch (value) { if (sequence === rawSequence.current && stillCurrent(started)) setError(errorText(value)); }
  }

  async function updateModel(model: string, longContext = primaryModel.longContext) {
    if (!draft || !connection) return;
    const value = {model,name:'',longContext};
    const mapping=uiAdapter.modelMapping;
    const nextConnection={...connection,model:mapping?.encodeModel?.(value) ?? model};
    if (!mapping?.primaryRole) { setDraft({...draft,connection:nextConnection}); return; }
    const started=captureDraft();
    try {
      const text=await mapping.update(draft.files[mapping.fileRole] ?? '',mapping.primaryRole,value);
      if (stillCurrent(started)) setDraft({...draft,connection:nextConnection,files:{...draft.files,[mapping.fileRole]:text}});
    } catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
  }
  async function updateRoleModel(id: string, value: ModelRoleValue, all = false) {
    if (!draft || !uiAdapter.modelMapping) return;
    const started = captureDraft();
    try {
      const fileRole=uiAdapter.modelMapping.fileRole;
      const text = all ? await uiAdapter.modelMapping.useModelForAll(draft.files[fileRole] ?? '', primaryModel.model) : await uiAdapter.modelMapping.update(draft.files[fileRole] ?? '', id, value);
      if (stillCurrent(started)) setDraft({ ...draft, files:{ ...draft.files,[fileRole]:text },connection: !all && id===uiAdapter.modelMapping.primaryRole && connection ? {...connection,model:uiAdapter.modelMapping.encodeModel?.(value) ?? value.model} : draft.connection });
    } catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
  }

  async function changeReasoningEffort(value: string) {
    if (!draft || !uiAdapter.reasoning) return;
    const started = captureDraft();
    const sequence = ++reasoningSequence.current;
    try {
      const settings = await uiAdapter.reasoning.update(draft.files.settings ?? '', value || null);
      if (sequence !== reasoningSequence.current || !stillCurrent(started)) return;
      setDraft({ ...draft, files: { ...draft.files, settings } });
    } catch (value) { if (sequence === reasoningSequence.current && stillCurrent(started)) setError(errorText(value)); }
  }

  async function deleteCurrent() {
    if (!draft?.id || !currentTool || busy) return;
    if (!await confirmChange(`删除命名配置“${draft.name}”？已经写入的原生文件不会自动删除。`, { title: '删除配置', confirmLabel: '删除配置', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteNativeProfile(draft.id, draft.version, draft.revision ?? '');
      await reload(currentTool, scope, projectPath);
      setNotice('命名配置已删除，原生文件保持原样。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  if (!visibleTools.length) return <div className={styles.empty}>还没有管理中的 CLI。请先在设置里选择要管理的工具。</div>;

  const hasCurrentNative = !!workspace?.snapshots.some(item => item.fingerprint && !workspace.probe.nativeFiles.find(file => file.role === item.role)?.sensitive);
  const configEmpty = !!workspace && !workspace.profiles.length && editor === 'profile' && !draft;
  const profileStatus = (item: RegisteredProfile) => {
    if (editor === 'profile' && selectedId === item.id && dirty) return '有未保存修改';
    if (workspace?.binding?.profileId === item.id) return workspace.binding.profileVersion === item.version ? '正在使用' : '已保存，尚未应用';
    return '已保存';
  };
  async function loadBackups() {
    if (!currentTool) return;
    const context = draftContext;
    try { const rows = await native.listNativeBackups(currentTool, scope, projectPath, role); if (latestDraft.current.context === context) setBackups(rows); }
    catch (value) { if (latestDraft.current.context === context) setError(errorText(value)); }
  }
  async function inspectBackup(id: string) {
    if (!currentTool) return;
    const context = draftContext;
    try { const result = await native.previewNativeBackup(currentTool, scope, projectPath, role, id); if (latestDraft.current.context === context) setBackupPreview(result); }
    catch (value) { if (latestDraft.current.context === context) setError(errorText(value)); }
  }
  async function restoreBackup() {
    if (!currentTool || !backupPreview || busy) return;
    const started = captureDraft();
    if (dirty && !await confirmChange('恢复前放弃当前未保存修改？')) return;
    if (!stillCurrent(started)) return;
    setBusy(true); setError('');
    try {
      await native.restoreNativeBackup(currentTool, scope, projectPath, role, backupPreview.transactionId, backupPreview.current);
      if (stillCurrent(started)) { setBackupPreview(null); await openCurrentFile(role, true); setNotice('已恢复此文件。'); }
    } catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
    finally { setBusy(false); }
  }

  function nativeEditor() { return <div className={styles.nativeEditor}>
              {availableRoles.length > 1 && <div className={styles.fileTabs}>{availableRoles.map((name) => <button key={name} type="button" className={role === name ? styles.selected : ''} disabled={busy} onClick={() => { if (editor === 'native') void openCurrentFile(name); else { rawSequence.current++; setRole(name); } }}>{workspace?.probe.nativeFiles.find(file => file.role === name)?.path.split(/[\\/]/).at(-1) ?? name}</button>)}</div>}
              <div className={styles.pathLabel}><strong title={activeFile?.path}>{activeFile?.path.split(/[\\/]/).pop() ?? '原生文件尚未确定'}</strong><span>{activeFile?.format?.toUpperCase() ?? ''}</span>{activeFile && <details><summary>文件位置</summary><small>{displayPath(activeFile.path)}</small><button type="button" onClick={() => void navigator.clipboard.writeText(displayPath(activeFile.path))}>复制路径</button></details>}</div>
              <CodeEditor key={draftContext + role} format={activeFile?.format ?? 'text'} label={`${role} 配置草稿`} value={activeRaw?.text ?? (editor === 'common' ? commonDraft?.files[role] : draft?.files[role]) ?? ''} onChange={(text) => { if (activeRaw) { invalidateDraftRequest(); setRawDisk({ ...activeRaw, text }); } else if (editor === 'common') { invalidateDraftRequest(); if (commonDraft) setCommonDraft({ ...commonDraft, files: { ...commonDraft.files, [role]: text } }); } else if (draft) setDraft({ ...draft, files: { ...draft.files, [role]: text } }); }} placeholder="在这里编辑原生配置。留空表示本配置不覆盖该文件。" />

            </div>; }

  const connectionForm = draft && connection ? <>
    <label>名称<small className={styles.fieldHint}>保存后出现在列表里，方便给这个工具切换使用</small><input name="profile-name" aria-label="配置名称" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：日常开发" /></label>
    <label>API 地址<small className={styles.fieldHint}>这个工具请求模型时使用的接口地址</small><input aria-label="API 地址" value={connection.baseUrl} onChange={event => setDraft({ ...draft, connection: { ...connection, baseUrl: event.target.value } })} placeholder="https://api.example.com/v1" /></label>
    <label>API 密钥<small className={styles.fieldHint}>保存在本机，只用于这份配置的连接</small><div className={styles.secretField}><input aria-label="API 密钥" type={revealedSecret !== null ? "text" : "password"} autoComplete="off" value={revealedSecret ?? newSecret} onChange={event => { invalidateDraftRequest(); setNewSecret(event.target.value); modelSequence.current++; setModelDirectory(null); setModelLoading(false); }} placeholder={connection.secretRef ? '已保存 · 输入可替换' : 'sk-… 或供应商提供的密钥'} /><button type="button" disabled={!newSecret && !connection.secretRef} onClick={() => void showSecret()}>{revealedSecret !== null ? '隐藏' : '显示'}</button></div></label>
    <div className={styles.modelPicker}><label>模型<small className={styles.fieldHint}>下次启动这个工具时默认使用</small><select aria-label="模型" value={manualModel ? '__manual__' : primaryModel.model} onChange={event => { if (event.target.value === '__manual__') setManualModel(true); else { setManualModel(false); updateModel(event.target.value); } }}><option value="">选择模型…</option>{modelOptions.map(model => <option key={model} value={model}>{model}</option>)}<option value="__manual__">手动输入模型</option></select></label><button type="button" disabled={busy || modelLoading || !connection.baseUrl.trim()} onClick={() => void fetchModels()}>{modelLoading ? '获取中…' : '获取模型'}</button></div>
    {!!modelOptions.length && <details className={styles.modelSearch} data-model-search><summary>搜索模型</summary><input aria-label="搜索模型" value={modelSearch} onChange={event => setModelSearch(event.target.value)} placeholder="输入模型名称" /><div>{modelOptions.filter(value => value.toLowerCase().includes(modelSearch.toLowerCase())).map(value => <button key={value} type="button" onClick={() => { setManualModel(false); updateModel(value); document.querySelector<HTMLDetailsElement>('details[data-model-search]')?.removeAttribute('open'); }}>{value}</button>)}</div></details>}
    {uiAdapter.modelMapping?.primaryRole && <label className={styles.check}><input type="checkbox" checked={primaryModel.longContext} onChange={event => updateModel(primaryModel.model,event.target.checked)} />1M 上下文</label>}
    {manualModel && <label>模型 ID<input aria-label="手动模型 ID" value={primaryModel.model} onChange={event => updateModel(event.target.value)} placeholder="供应商的模型 ID" /><small>手动模型尚未验证</small></label>}
    {modelDirectory && <p className={styles.hint} role="status">{modelDirectory.status === 'ready' ? '已获取 ' + modelDirectory.models.length + ' 个模型' : modelDirectory.status === 'empty' ? '目录为空，可手动输入模型。' : modelDirectory.status === 'stale' ? '显示旧目录：' + modelDirectory.error : modelDirectory.error}{modelDirectory.fetchedAt ? ' · 更新于 ' + new Date(modelDirectory.fetchedAt * 1000).toLocaleString() : ''}</p>}
  </> : null;

  const pathControl = workspace ? <details className={styles.pathControl}><summary><span className={styles.statusDot} data-ok={workspace.probe.nativeWrites.state === 'supported'} /><strong>{workspace.probe.selectedPath ? `${toolName} ${workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? ''}` : `${toolName} 未确认安装`}</strong><span>{workspace.probe.nativeWrites.reason}</span><span className={styles.diagnosticLabel}>检测路径与升级</span></summary><p><a href={workspace.probe.installUrl} target="_blank" rel="noreferrer">官方安装说明 ↗</a></p><div><input aria-label="CLI 可执行文件路径" value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="自定义可执行文件完整路径" /><button type="button" onClick={() => void choosePath()} disabled={busy}>保存并重检</button><button type="button" disabled={loading} onClick={() => currentTool && void reload(currentTool, scope, projectPath, selectedId)}>重新检测</button></div><p>{workspace.probe.upgradeHint}</p>{workspace.probe.installations.map((item) => <p key={item.path}>{item.status === 'available' ? '可用' : '检测失败'} · 来源：{item.source === 'npm_shim' ? '已验证 npm 入口' : item.source === 'claude_native' ? 'Claude 原生安装' : '未能确认'} · {item.path} {item.detail ?? ''}</p>)}{workspace.probe.dependencies.map((item) => <p key={item.name}>{item.name}：{item.status === 'found' ? '已找到' : item.status === 'outdated' ? '版本过旧' : '缺失'} · {item.detail}{item.status !== 'found' && <a href={item.helpUrl} target="_blank" rel="noreferrer"> 安装或更新 ↗</a>}</p>)}{workspace.probe.installCommand && <div><code>{workspace.probe.installCommand}</code><button type="button" onClick={() => void copyGuidance(workspace.probe.installCommand!)}>复制安装命令</button></div>}{workspace.probe.upgradeCommand ? <div><code>{workspace.probe.upgradeCommand}</code><button type="button" onClick={() => void copyGuidance(workspace.probe.upgradeCommand!)}>复制升级命令</button></div> : workspace.probe.selectedPath && <p>安装来源未能可靠确认，请先核对官方安装说明，再用原安装方式升级。</p>}</details> : null;

  const writeUnavailable = workspace && workspace.probe.nativeWrites.state !== 'supported' ? <div className={styles.error} role="alert" aria-label="原生写入不可用">
    <p>{workspace.probe.nativeWrites.reason || `${toolName} 当前无法写入原生配置。`}</p>
    <p>保存并应用前需要先解决安装或写入问题。路径与升级细节仍在更多选项中。</p>
    {workspace.probe.installUrl ? <a href={workspace.probe.installUrl} target="_blank" rel="noreferrer">官方安装说明 ↗</a> : null}
    {workspace.probe.installCommand ? <button type="button" onClick={() => void copyGuidance(workspace.probe.installCommand!)}>复制安装命令</button> : null}
    <button type="button" disabled={loading} onClick={() => currentTool && void reload(currentTool, scope, projectPath, selectedId)}>重新检测</button>
  </div> : null;

  const moreOptions = workspace ? <details className={styles.moreOptions} aria-label="配置更多选项"><summary>更多选项</summary>
    {pathControl}
    {editor === 'profile' && draft && <label className={styles.check}><input type="checkbox" checked={draft.inheritCommon} onChange={event => setDraft({ ...draft, inheritCommon: event.target.checked })} />继承本工具通用配置</label>}
    {editor === 'profile' && connection && <details className={styles.connectionAdvanced}><summary>高级连接选项</summary>
      {!!workspace.probe.providerPresets.length && <div className={styles.modelBar}><span>官方接口预设</span>{workspace.probe.providerPresets.map(item => <button key={item.id} type="button" title={item.sourceUrl} onClick={() => applyPreset(item.id, item.baseUrl, item.interfaceFormat)}>{item.label}</button>)}</div>}
      <div className={styles.formGrid}><label>供应商 ID<input value={connection.providerId} onChange={event => setDraft({ ...draft!, connection: { ...connection, providerId: event.target.value } })} /></label>{(workspace.probe.interfaceFormats.length > 1 || !workspace.probe.interfaceFormats.includes(connection.interfaceFormat as never)) && <label>接口格式<select value={connection.interfaceFormat} onChange={event => setDraft({ ...draft!, connection: { ...connection, interfaceFormat: event.target.value } })}>{!workspace.probe.interfaceFormats.includes(connection.interfaceFormat as never) && <option value={connection.interfaceFormat}>当前格式 · {formatLabel(connection.interfaceFormat)}</option>}{workspace.probe.interfaceFormats.map(item => <option key={item} value={item}>{formatLabel(item)}</option>)}</select></label>}</div>
      <label>认证环境变量名<input value={connection.authEnvVar ?? ''} onChange={event => setDraft({ ...draft!, connection: { ...connection, authEnvVar: event.target.value || null } })} placeholder="可选" /></label>
      {effectiveEnvName && !connection.secretRef && <p className={styles.hint}>原生配置引用：<code>{effectiveEnvName}</code></p>}
      <div className={styles.diagnosticActions}><button type="button" disabled={checkingConnection || !!newSecret} onClick={() => void checkConnection(false)}>检查连接</button><details><summary>更多诊断</summary><button type="button" disabled={checkingConnection || !!newSecret} onClick={() => void checkConnection(true)}>发送最小请求（可能计费）</button></details></div>
      {newSecret && <p className={styles.hint}>先获取模型或保存配置，再进行连接诊断。</p>}
      {connectionCheck && <details className={styles.diagnosticResult}><summary>连接诊断 · {connectionCheck.connectivity.state === 'failed' ? '未通过' : connectionCheck.connectivity.state === 'passed' ? '已连接' : '部分完成'}</summary><p>{connectionCheck.format.message}</p><p>{connectionCheck.connectivity.message}</p><p>{connectionCheck.modelRequest.message}</p></details>}
      {uiAdapter.modelMapping && <details className={styles.roleMapping}><summary>模型角色映射</summary><button type="button" disabled={!connection?.model} onClick={() => void updateRoleModel('', {model:'',name:'',longContext:false}, true)}>所有角色使用当前模型</button>{uiAdapter.modelMapping.roles.map(item => { const value = roleModels[item.id] ?? {model:'',name:'',longContext:false}; return <div key={item.id} className={styles.roleFields}><strong>{item.label}</strong>{item.displayName && <label>显示名称<input aria-label={`${item.label} 显示名称`} value={value.name} onChange={event => void updateRoleModel(item.id,{...value,name:event.target.value})} /></label>}<label>请求模型<select aria-label={`${item.label} 请求模型`} value={manualRoles.includes(item.id) ? '__manual__' : value.model} onChange={event => { if (event.target.value === '__manual__') setManualRoles([...manualRoles,item.id]); else { setManualRoles(manualRoles.filter(id => id !== item.id)); void updateRoleModel(item.id,{...value,model:event.target.value}); } }}><option value="">跟随 CLI 默认</option>{[...new Set([...(value.model ? [value.model] : []),...modelOptions])].map(model => <option value={model} key={model}>{model}</option>)}<option value="__manual__">手动输入模型</option></select></label>{manualRoles.includes(item.id) && <input aria-label={`${item.label} 手动模型`} value={value.model} onChange={event => void updateRoleModel(item.id,{...value,model:event.target.value})} />}{item.longContext && <label className={styles.check}><input type="checkbox" checked={value.longContext} onChange={event => void updateRoleModel(item.id,{...value,longContext:event.target.checked})} />1M 上下文</label>}</div>; })}</details>}
      {uiAdapter.reasoning && <label>{uiAdapter.reasoning.label}<select value={inspection?.reasoningEffort ?? ''} onChange={event => void changeReasoningEffort(event.target.value)}><option value="">跟随原生默认</option>{uiAdapter.reasoning.choices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}{inspection?.reasoningEffort && !uiAdapter.reasoning.choices.some(([id]) => id === inspection.reasoningEffort) && <option value={inspection.reasoningEffort}>当前原生值：{inspection.reasoningEffort}</option>}</select></label>}
      {inspection?.connection && connectionShape(inspection.connection) !== connectionShape(connection) && <button type="button" onClick={adoptInspectedConnection}>使用原生配置中的连接</button>}
    </details>}
    {(editor === 'profile' && draft) && <>
      <div className={styles.moreSection}><strong>原生文本</strong>{nativeEditor()}</div>
      <div className={styles.merged}><button type="button" className={styles.previewButton} onClick={() => setView(view === 'merged' ? 'form' : 'merged')}>{view === 'merged' ? '隐藏合并结果' : '查看合并结果'}</button>{view === 'merged' && <><p>只读结构化预览：通用配置、命名配置和连接设置合并；CLI 仍可能受到环境变量、项目信任和更高优先级原生设置影响。</p><CodeEditor format="json" label="合并配置预览" readOnly value={preview ? JSON.stringify(preview.documents[role] ?? {}, null, 2) : ''} placeholder="等待有效配置…" />{preview && <details><summary>查看字段来源</summary><pre>{Object.entries(preview.sources[role] ?? {}).map(([path, source]) => `${path} ← ${source}`).join('\n') || '没有覆盖字段'}</pre></details>}</>}</div>
    </>}
    {editor !== 'common' && <button type="button" onClick={() => void editCommon()}>通用配置</button>}
    {editor === 'native' && <details className={styles.backupHistory} onToggle={event => { if (event.currentTarget.open) void loadBackups(); }}><summary>修改记录</summary>{backups.length ? <select aria-label="选择修改记录" value={backupPreview?.transactionId ?? ''} onChange={event => { if (event.target.value) void inspectBackup(event.target.value); else setBackupPreview(null); }}><option value="">选择记录…</option>{backups.map((item, index) => <option key={item.transactionId} value={item.transactionId}>最近第 {index + 1} 次修改 · {item.path.split(/[\\/]/).pop()}</option>)}</select> : <p>此文件还没有可恢复的修改备份。</p>}{backupPreview && <><div className="file-conflict-columns"><div><strong>当前文件</strong><CodeEditor label="恢复前当前文件" readOnly compact format={activeFile?.format ?? 'text'} value={backupPreview.current} /></div><div><strong>修改前的备份</strong><CodeEditor label="修改前文件备份" readOnly compact format={activeFile?.format ?? 'text'} value={backupPreview.original} /></div></div><button type="button" disabled={busy} onClick={() => void restoreBackup()}>恢复此备份</button></>}</details>}
  </details> : null;

  return <section className={styles.workspace} aria-label="工具与连接">
    <div className={styles.toolbar}>
      <div className={styles.toolSwitcher} role="tablist" aria-label="CLI">{visibleTools.map((item) => <button key={item.id} type="button" role="tab" aria-selected={currentTool === item.id} className={currentTool === item.id ? styles.selected : ''} onClick={async () => { if (currentTool === item.id) return; if ((dirty || mcpDirty || skillsDirty) && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; invalidateDraftRequest(); setTool(item.id); }}><ToolIcon toolId={item.id} size={23} />{item.name}</button>)}</div>
    </div>
    <div className={styles.views} role="tablist" aria-label="当前任务">
      <button type="button" role="tab" aria-selected={resourceView === 'config'} className={resourceView === 'config' ? styles.selected : ''} onClick={() => void switchResourceView('config')}>配置这个工具</button>
      <button type="button" role="tab" aria-selected={resourceView === 'mcp'} className={resourceView === 'mcp' ? styles.selected : ''} onClick={() => void switchResourceView('mcp')}>添加 MCP</button>
      <button type="button" role="tab" aria-selected={resourceView === 'skills'} className={resourceView === 'skills' ? styles.selected : ''} onClick={() => void switchResourceView('skills')}>添加 Skill</button>
      <div className={styles.scopeBar}><label>配置范围 <select value={scope} onChange={async (event) => { const value = event.target.value as Scope; if ((dirty || mcpDirty || skillsDirty) && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; invalidateDraftRequest(); setScope(value); }}><option value="global">全局</option><option value="project">项目</option></select></label>{scope === 'project' && <><select aria-label="配置项目" title={projectPath || '选择已有项目'} value={projectPath} onChange={event => switchProject(event.target.value)}><option value="">选择项目…</option>{projects.map(project => <option key={project.id} value={project.path ?? project.id} disabled={!project.available || !project.path} title={project.path ?? ''}>{project.name}{project.available ? '' : ' · 目录不可用'}</option>)}{projectPath && !projects.some(project => project.path === projectPath) && <option value={projectPath}>{projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath}</option>}</select><button type="button" disabled={choosingProject || busy} onClick={() => void chooseProjectFolder()}>选择文件夹</button></>}</div>
    </div>
    <div hidden={resourceView !== 'config'}>
    <p className={styles.taskLead}>为 {toolName} 准备一份连接配置。完成后，下次启动会读取正在使用的那一份。</p>
    {scope === 'project' && !projectPath.trim() && <p className={styles.hint}>选择已有项目，或选择一个本机文件夹后，再编辑配置。</p>}
    {scope === 'project' && workspace?.probe.nativeFiles.find((item) => !item.sensitive && item.reason)?.reason && <p className={styles.hint}>{workspace.probe.nativeFiles.find((item) => !item.sensitive && item.reason)?.reason}</p>}
    {loading && <p className={styles.hint} role="status">正在检测 CLI 与原生文件…</p>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    {applyComparison && <section className="file-conflict" aria-label="配置应用冲突"><strong>比较当前文件与本次配置</strong>{applyComparison.files.map(file=><div className="file-conflict-columns" key={file.role}><div><strong>当前文件</strong><CodeEditor label={`当前 ${file.role} 文件`} readOnly compact format={file.format} value={file.current}/></div><div><strong>本次配置字段</strong><CodeEditor label={`本次 ${file.role} 配置`} readOnly compact format="json" value={JSON.stringify(file.proposed,null,2)}/></div></div>)}<div className="file-conflict-actions"><button type="button" onClick={()=>setApplyComparison(null)}>保留当前文件</button><button type="button" disabled={busy} onClick={()=>void resolveApplication()}>使用本次配置</button></div></section>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {workspace && !(scope === 'project' && !projectPath.trim()) && <>
      {!!workspace.recoveryNeeded.length && <div className={styles.error}>有 {workspace.recoveryNeeded.length} 项原生文件事务需要恢复。请检查目标文件和本机凭据库后重试。<button type="button" onClick={() => { void native.recoverNativeTransactions().then(() => { if (currentTool) return reload(currentTool, scope, projectPath, selectedId); }); }}>重试恢复</button></div>}
      {writeUnavailable}
      {configEmpty ? <div className={styles.taskEmpty}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void createProfile()}>新建配置</button>
        <p>按下后填写名称、API 地址、密钥和模型，再保存并给这个工具使用。</p>
        <button type="button" className={styles.secondaryLink} disabled={busy || !hasCurrentNative} onClick={() => void openCurrentFile()}>直接修改正在使用的文件</button>
        {moreOptions}
      </div> : <div className={styles.columns}>
        <aside className={styles.profileList} aria-label="配置列表">
          <div className={styles.listHeading}><strong>配置</strong><button type="button" onClick={() => void createProfile()}>＋ 新建</button></div>
          <button type="button" aria-label="正在使用的文件" className={editor === 'native' ? styles.activeProfile : ''} onClick={() => void openCurrentFile()}><strong>正在使用的文件</strong><small>保存即写入该文件</small></button>
          {workspace.profiles.map((item) => <button key={item.id} type="button" aria-label={item.name} className={editor === 'profile' && selectedId === item.id ? styles.activeProfile : ''} onClick={() => void selectProfile(item)}><strong>{item.name}</strong><small>{profileStatus(item)}</small></button>)}
          {editor === 'common' && <button type="button" className={styles.activeProfile}><strong>通用配置</strong><small>更多选项中打开</small></button>}
        </aside>
        <div className={styles.editor}>
          <div className={styles.editorHead}>{currentDescriptor?.login && <button type="button" disabled={busy} title={currentDescriptor.login.hint} onClick={() => void login()}>原 CLI 登录</button>}{editor === 'native' && hasCurrentNative && <button type="button" disabled={busy} onClick={() => void importCurrentNative(false, true)}>复制为命名配置</button>}<h2>{editor === 'native' ? '正在使用的文件' : editor === 'common' ? '通用配置' : draft?.name || '新配置'}</h2></div>
          {editor === 'profile' && !draft ? <div className={styles.empty}>选择一份配置，或新建一份。</div> : <>
            <div className={`${styles.actions} ${styles.leadActions}`}>
              {editor === 'profile' && draft?.id && <><button type="button" disabled={busy} onClick={() => void duplicateProfile()}>复制</button><button type="button" disabled={busy} onClick={() => void deleteCurrent()}>删除</button></>}
              <span>{dirty ? '有未保存的修改' : editor === 'profile' && workspace.binding?.profileId === draft?.id && workspace.binding?.profileVersion === draft?.version ? '正在使用 · 下次启动会读取' : editor === 'native' ? '保存即写入该文件' : editor === 'profile' && draft?.id ? '已保存，尚未应用到这个工具' : ''}</span>
              {editor === 'profile' && <button type="button" disabled={busy || !nativeAvailable} onClick={() => void save(false)}>仅保存</button>}
              <button type="button" className={styles.primary} disabled={busy || !nativeAvailable || (editor === 'native' && workspace.probe.nativeWrites.state !== 'supported') || (editor === 'profile' && workspace.probe.nativeWrites.state !== 'supported')} onClick={() => void save(editor === 'profile')}>{editor === 'native' ? '保存到正在使用的文件' : editor === 'common' ? '保存通用配置' : '保存并给这个工具使用'}</button>
            </div>
            {editor === 'profile' && draft && <div className={styles.form}>{connectionForm}</div>}
            {editor === 'native' && <>
              <p className={styles.hint}>这里直接改当前工具正在读取的文件；保存后立即写入磁盘。</p>
              {nativeEditor()}
            </>}
            {editor === 'common' && nativeEditor()}
            {fileConflict?.context === draftContext && pendingRaw && <FileConflict current={fileConflict.current} edited={pendingRaw.text} format={activeFile?.format ?? 'text'} busy={busy} onKeep={() => { setRawDisk({ ...pendingRaw, original:fileConflict.current, text:fileConflict.current }); setFileConflict(null); setError(''); }} onUse={() => { setRawDisk({ ...pendingRaw, original:fileConflict.current }); setFileConflict(null); setError(''); setNotice('已保留本次修改，点击保存写入。'); }} />}
            {moreOptions}
          </>}
        </div>
      </div>}
      {editor === 'profile' && draft?.id && !dirty && (workspace.binding?.profileId !== draft.id || workspace.binding.profileVersion !== draft.version) && <div className={styles.quickApply}><span>这份配置已保存，但尚未应用到当前范围。</span><button type="button" onClick={() => void applySaved(draft)} disabled={busy || workspace.probe.nativeWrites.state !== 'supported'}>应用这份配置</button></div>}
    </>}
    </div>
    <div hidden={resourceView !== 'mcp'}><McpWorkspace key={JSON.stringify([currentTool, scope, projectPath, resourceEpoch])} toolId={currentTool} scope={scope} projectPath={projectPath} tools={visibleTools} onDirtyChange={setMcpDirty} /></div>
    <div hidden={resourceView !== 'skills'}><SkillsWorkspace key={JSON.stringify([currentTool, scope, projectPath, resourceEpoch])} toolId={currentTool} scope={scope} projectPath={projectPath} onDirtyChange={setSkillsDirty} /></div>
  </section>;
}
