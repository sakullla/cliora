import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { sameDraftRequest } from '../../lib/draftGuard';
import { importedConnection } from '../../lib/nativeDraft';
import type { DraftRequest } from '../../lib/draftGuard';
import type { ApiError } from '../../types/domain';
import type { TrayRepairTarget } from '../../types/launch';
import type { AdapterDescriptor, Connection, ConnectionCheck, ModelDirectory, NativeInspection, NativePreview, RegisteredCommon, RegisteredProfile, RegisteredToolWorkspace, Scope } from '../../types/native';
import { authEnvName, uiAdapterFor } from './adapters';
import styles from './ToolWorkspace.module.css';

type View = 'form' | 'native' | 'merged';
type Editor = 'profile' | 'common';

function errorText(value: unknown): string {
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

export function ToolWorkspacePage({ managedTools, initialTool, repair, onDirtyChange }: { managedTools: AdapterDescriptor[]; initialTool?: string; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [tool, setTool] = useState<string>(repair?.toolId ?? initialTool ?? managedTools[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>(repair?.scope ?? 'global');
  const [projectPath, setProjectPath] = useState(repair?.projectPath ?? '');
  const [projectInput, setProjectInput] = useState(repair?.projectPath ?? '');
  const [preferredProfileId, setPreferredProfileId] = useState<string | null>(repair?.profileId ?? null);
  const appliedRepair = useRef(repair?.sequence ?? 0);
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
  const [view, setView] = useState<View>('native');
  const [role, setRole] = useState('settings');
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const [modelDirectory, setModelDirectory] = useState<ModelDirectory | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck | null>(null);
  const [inspection, setInspection] = useState<NativeInspection | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [newSecret, setNewSecret] = useState('');
  const [rawDisk, setRawDisk] = useState<{ context: string; role: string; original: string; text: string } | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [takeoverId, setTakeoverId] = useState<string | null>(null);
  const [takeoverProfile, setTakeoverProfile] = useState<RegisteredProfile | null>(null);
  const loadSequence = useRef(0);
  const modelSequence = useRef(0);
  const inspectionSequence = useRef(0);
  const importSequence = useRef(0);
  const rawSequence = useRef(0);
  const reasoningSequence = useRef(0);
  const previewSequence = useRef(0);
  const savedDraft = useRef('');

  const visibleTools = managedTools;
  const currentTool = visibleTools.some((item) => item.id === tool) ? tool : visibleTools[0]?.id;
  const currentDescriptor = visibleTools.find((item) => item.id === currentTool);
  const toolName = currentDescriptor?.name ?? currentTool ?? '';
  const uiAdapter = uiAdapterFor(currentTool ?? '');
  const draftContext = JSON.stringify([currentTool, scope, projectPath, selectedId, editor]);
  const latestDraft = useRef<DraftRequest<RegisteredProfile>>({ context: draftContext, revision: draftRevision.current, draft });
  latestDraft.current = { context: draftContext, revision: draftRevision.current, draft };
  const captureDraft = (): DraftRequest<RegisteredProfile> => ({ ...latestDraft.current });
  const stillCurrent = (started: DraftRequest<RegisteredProfile>) => sameDraftRequest(started, { ...latestDraft.current, revision: draftRevision.current });
  const invalidateDraftRequest = () => { draftRevision.current++; };
  const connection = draft?.connection ?? null;
  const fileSignature = JSON.stringify(draft?.files ?? {});
  const effectiveEnvName = authEnvName(uiAdapter, connection, currentTool ?? '');
  const pendingRaw = rawDisk?.context === draftContext ? rawDisk : null;
  const activeRaw = pendingRaw?.role === role ? pendingRaw : null;
  const dirty = (editor === 'profile' ? !!draft && JSON.stringify(draft) !== savedDraft.current : !!commonDraft && JSON.stringify(commonDraft) !== savedDraft.current) || !!pendingRaw && pendingRaw.text !== pendingRaw.original;
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
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
      setRole(result.probe.nativeFiles.find((item) => !item.sensitive)?.role ?? 'settings');
    } catch (value) {
      if (sequence === loadSequence.current) { setWorkspace(null); setError(errorText(value)); }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);

  useEffect(() => { if (currentTool) void reload(currentTool, scope, projectPath, preferredProfileId); }, [currentTool, scope, projectPath, preferredProfileId, reload]);

  useEffect(() => {
    if (!repair || repair.page !== 'connections' || appliedRepair.current === repair.sequence || !repair.toolId) return;
    appliedRepair.current = repair.sequence;
    if (dirty && !window.confirm('当前草稿尚未保存，打开托盘指向的配置会丢失这些修改。继续吗？')) {
      setNotice('当前草稿已保留；可保存后再从托盘打开修复位置。');
      return;
    }
    invalidateDraftRequest();
    setTool(repair.toolId);
    setScope(repair.scope ?? 'global');
    setProjectPath(repair.projectPath ?? '');
    setProjectInput(repair.projectPath ?? '');
    setPreferredProfileId(repair.profileId);
    setNotice('已打开托盘操作对应的配置位置。');
    if (repair.toolId === currentTool && repair.scope === scope && (repair.projectPath ?? '') === projectPath && repair.profileId === preferredProfileId) {
      void reload(repair.toolId, repair.scope, repair.projectPath ?? '', repair.profileId);
    }
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
    modelSequence.current++;
    setConnectionCheck(null);
    setModelLoading(false);
    if (!connection) { setModelDirectory(null); return; }
    setModelDirectory(null);
    const timer = window.setTimeout(() => { void refreshModels(connection, false); }, 500);
    return () => window.clearTimeout(timer);
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

  const modelOptions = useMemo(() => (modelDirectory?.models ?? []).filter((id) => id.toLowerCase().includes(modelSearch.trim().toLowerCase())), [modelDirectory, modelSearch]);
  const availableRoles = workspace?.probe.nativeFiles.filter((item) => !item.sensitive).map((item) => item.role) ?? ['settings'];
  const activeFile = workspace?.probe.nativeFiles.find((item) => item.role === role);

  function selectProfile(profile: RegisteredProfile) {
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    setRawDisk(null); setEditor('profile'); setSelectedId(profile.id); setDraft(structuredClone(profile)); savedDraft.current = JSON.stringify(profile);
    setError(''); setNotice(''); setTakeoverId(null);
  }

  function createProfile() {
    if (!currentTool) return;
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    const next = emptyProfile(currentTool);
    setRawDisk(null); setEditor('profile'); setSelectedId(null); setDraft(next); savedDraft.current = JSON.stringify(next);
    setView('form'); setError(''); setNotice(''); setTakeoverId(null);
  }

  function editCommon() {
    if (!currentTool) return;
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    invalidateDraftRequest();
    const next = structuredClone(workspace?.common ?? { tool: currentTool, version: 0, files: {} });
    setRawDisk(null); setEditor('common'); setCommonDraft(next); savedDraft.current = JSON.stringify(next);
    setView('native'); setError(''); setNotice('');
  }

  async function save(applyAfter: boolean) {
    if (!nativeAvailable || busy) return;
    setBusy(true); setError(''); setNotice('');
    let savedForTakeover: RegisteredProfile | null = null;
    try {
      if (editor === 'common' && commonDraft) {
        const result = await native.saveRegisteredCommonConfig(commonDraft, commonDraft.version || null);
        const saved = result.common;
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
        const failed = result.applications.filter((item) => item.status === 'failed');
        setNotice(failed.length ? `通用配置已保存；${failed.length} 个活动范围未能应用，请检查并重试。` : `通用配置已保存；${result.applications.length} 个活动范围已检查并应用。`);
        if (currentTool) await reload(currentTool, scope, projectPath, selectedId);
        setEditor('common');
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
      } else if (draft && currentTool) {
        let edited = draft;
        if (pendingRaw) {
          const current = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, pendingRaw.role);
          if (current !== pendingRaw.original) throw new Error('磁盘原生文件在编辑期间已变化；请重新打开原文，原修改尚未写入。');
          const imported = await native.prepareRegisteredNativeImport(currentTool, { ...draft.files, [pendingRaw.role]: pendingRaw.text });
          const nativeCredentials = { ...draft.nativeCredentials };
          delete nativeCredentials[pendingRaw.role];
          Object.assign(nativeCredentials, imported.nativeCredentials);
          edited = { ...draft, files: imported.files, connection: imported.inspection.connection, nativeCredentials };
        }
        const saved = await native.saveRegisteredNativeProfile(edited, edited.version || null);
        savedForTakeover = saved;
        setDraft(saved); savedDraft.current = JSON.stringify(saved);
        setSelectedId(saved.id);
        if (applyAfter) {
          const outcome = await native.applyRegisteredNativeProfile(currentTool, saved.id, scope, projectPath, false);
          setNotice(outcome.status === 'already_matching' ? '原生文件已与配置一致。' : '原生文件已写入；下次启动时仍受 CLI 的配置优先级和项目信任规则影响。');
        } else setNotice('配置草稿已保存，当前原生文件尚未更改。');
        await reload(currentTool, scope, projectPath, saved.id);
      }
    } catch (value) {
      const message = errorText(value);
      setError(message);
      if (message.includes('请确认接管') && savedForTakeover) { setTakeoverId(savedForTakeover.id); setTakeoverProfile(savedForTakeover); }
    }
    finally { setBusy(false); }
  }

  async function applySaved(profile: RegisteredProfile, allowTakeover = false) {
    if (!currentTool || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const outcome = await native.applyRegisteredNativeProfile(currentTool, profile.id, scope, projectPath, allowTakeover);
      setTakeoverId(null);
      setTakeoverProfile(null);
      setNotice(outcome.status === 'already_matching' ? '原生文件已与配置一致。' : '原生文件已写入；下次启动时仍受 CLI 的配置优先级和项目信任规则影响。');
      await reload(currentTool, scope, projectPath, profile.id);
    } catch (value) {
      const message = errorText(value);
      setError(message);
      setTakeoverId(message.includes('请确认接管') ? profile.id : null);
    } finally { setBusy(false); }
  }

  async function saveSecret() {
    if (!newSecret || !draft?.connection) return;
    const started = captureDraft();
    setBusy(true); setError('');
    try {
      const secretRef = await native.setConnectionSecret(newSecret);
      if (!stillCurrent(started)) return;
      setDraft({ ...draft, connection: { ...draft.connection, secretRef } });
      setNewSecret(''); setNotice('密钥已存入系统凭据库。保存并应用配置后，会写入目标 CLI 支持的原生认证字段；直接从终端启动也可使用。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function checkConnection(allowModelRequest: boolean) {
    if (!connection || checkingConnection) return;
    if (allowModelRequest && !window.confirm('这会向供应商发送一条最小模型请求，可能产生费用。继续吗？')) return;
    setCheckingConnection(true); setConnectionCheck(null);
    try { setConnectionCheck(await native.testRegisteredProviderConnection(currentTool, connection, allowModelRequest)); }
    catch (value) { setError(errorText(value)); }
    finally { setCheckingConnection(false); }
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

  async function importDiskFile() {
    if (!draft || !currentTool) return;
    const started = captureDraft();
    const sequence = ++importSequence.current;
    try {
      const imported = await native.prepareRegisteredNativeImportFromDisk(currentTool, scope, projectPath, [role], draft.files);
      if (sequence !== importSequence.current || !stillCurrent(started)) return;
      const found = imported.inspection;
      const nativeCredentials = { ...draft.nativeCredentials };
      delete nativeCredentials[role];
      Object.assign(nativeCredentials, imported.nativeCredentials);
      setDraft({ ...draft, files: imported.files, nativeCredentials, connection: importedConnection(imported, draft.connection) });
      setInspection(found); setView('form');
      setNotice(imported.migratedSecret ? '原生 API 密钥已安全迁入系统凭据库；应用后将按 CLI 原生机制写入，磁盘原文件目前尚未更改。' : found.connection ? '已从原生文件识别连接与模型，可在表单继续编辑；原文与未知字段保留在草稿中。' : '原生文件已填入草稿；未识别为完整连接的字段仍保留在原文中。');
    } catch (value) { if (sequence === importSequence.current && stillCurrent(started)) setError(errorText(value)); }
  }

  async function importCurrentNative() {
    if (!workspace || !currentTool) return;
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    const started = captureDraft();
    const sequence = ++importSequence.current;
    const roles = workspace.snapshots.filter((item) => item.fingerprint && !workspace.probe.nativeFiles.find((file) => file.role === item.role)?.sensitive).map((item) => item.role);
    if (!roles.length) { setError('还没有可读取的原生配置文件。'); return; }
    try {
      const imported = await native.prepareRegisteredNativeImportFromDisk(currentTool, scope, projectPath, roles, {});
      const primaryRole = roles.includes(role) ? role : roles[0];
      const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, primaryRole);
      if (sequence !== importSequence.current || !stillCurrent(started)) return;
      const next = { ...emptyProfile(currentTool), name: '本机配置', files: imported.files, connection: imported.inspection.connection, nativeCredentials: imported.nativeCredentials };
      setDraft(next); setSelectedId(null); setEditor('profile'); savedDraft.current = '';
      setRole(primaryRole);
      setRawDisk({ context: JSON.stringify([currentTool, scope, projectPath, null, 'profile']), role: primaryRole, original: text, text });
      setInspection(imported.inspection); setView('native'); setError('');
      setNotice('已打开当前磁盘原文。保存前不会修改原生文件。');
    } catch (value) { if (sequence === importSequence.current && stillCurrent(started)) setError(errorText(value)); }
  }

  async function editDiskRaw() {
    if (!currentTool || editor !== 'profile') return;
    const started = captureDraft();
    const sequence = ++rawSequence.current;
    try {
      const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, role);
      if (sequence !== rawSequence.current || !stillCurrent(started)) return;
      setRawDisk({ context: draftContext, role, original: text, text });
      setNotice('已打开完整磁盘原文。本次保存以这里的 JSON/TOML 为准；此前未保存的表单连接值会由原文重新识别。');
    } catch (value) { if (sequence === rawSequence.current && stillCurrent(started)) setError(errorText(value)); }
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
    if (!window.confirm(`删除命名配置“${draft.name}”？已经写入的原生文件不会自动删除。`)) return;
    setBusy(true); setError('');
    try {
      await native.deleteNativeProfile(draft.id, draft.version);
      await reload(currentTool, scope, projectPath);
      setNotice('命名配置已删除，原生文件保持原样。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  if (!visibleTools.length) return <div className={styles.empty}>还没有管理中的 CLI。请先在设置里选择要管理的工具。</div>;

  return <section className={styles.workspace} aria-label="工具与连接">
    <div className={styles.toolbar}>
      <div className={styles.toolSwitcher} role="tablist" aria-label="CLI">{visibleTools.map((item) => <button key={item.id} type="button" role="tab" aria-selected={currentTool === item.id} className={currentTool === item.id ? styles.selected : ''} onClick={() => { if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; invalidateDraftRequest(); setTool(item.id); }}>{item.name}</button>)}</div>
      <div className={styles.scopeBar}><label>配置范围 <select value={scope} onChange={(event) => { if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; invalidateDraftRequest(); setScope(event.target.value as Scope); }}><option value="global">全局</option><option value="project">项目</option></select></label>{scope === 'project' && <><input aria-label="项目目录" placeholder="项目目录的完整路径" value={projectInput} onChange={(event) => setProjectInput(event.target.value)} /><button type="button" onClick={() => { if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; invalidateDraftRequest(); setProjectPath(projectInput.trim()); }}>打开项目</button></>}</div>
    </div>
    {scope === 'project' && !projectPath.trim() && <p className={styles.hint}>填写项目目录并点击打开后，才会读取该项目的原生配置。切换配置范围不会修改启动目录。</p>}
    {scope === 'project' && workspace?.probe.nativeFiles.find((item) => !item.sensitive && item.reason)?.reason && <p className={styles.hint}>{workspace.probe.nativeFiles.find((item) => !item.sensitive && item.reason)?.reason}。其他原文字段可编辑并保留。</p>}
    {loading && <p className={styles.hint} role="status">正在检测 CLI 与原生文件…</p>}
    {error && <div className={styles.error} role="alert">{error}{takeoverId && (takeoverProfile?.id === takeoverId || workspace?.profiles.some((item) => item.id === takeoverId)) && <button type="button" onClick={() => { const profile = takeoverProfile?.id === takeoverId ? takeoverProfile : workspace?.profiles.find((item) => item.id === takeoverId); if (profile) void applySaved(profile, true); }}>确认接管该字段</button>}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {workspace && <>
      <div className={styles.installBar}>
        <span className={styles.statusDot} data-ok={workspace.probe.nativeWrites.state === 'supported'} />
        <span><strong>{workspace.probe.selectedPath ? `${toolName} ${workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? ''}` : `${toolName} 未确认安装`}</strong><small>{workspace.probe.nativeWrites.reason}</small></span>
        <a href={workspace.probe.installUrl} target="_blank" rel="noreferrer">官方安装说明 ↗</a>
      </div>
      <details className={styles.pathControl}><summary>检测路径与升级</summary><div><input aria-label="CLI 可执行文件路径" value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="自定义可执行文件完整路径" /><button type="button" onClick={() => void choosePath()} disabled={busy}>保存并重检</button><button type="button" disabled={loading} onClick={() => currentTool && void reload(currentTool, scope, projectPath, selectedId)}>重新检测</button></div><p>{workspace.probe.upgradeHint}</p>{workspace.probe.installations.map((item) => <p key={item.path}>{item.status === 'available' ? '可用' : '检测失败'} · 来源：{item.source === 'npm_shim' ? '已验证 npm 入口' : item.source === 'claude_native' ? 'Claude 原生安装' : '未能确认'} · {item.path} {item.detail ?? ''}</p>)}{workspace.probe.dependencies.map((item) => <p key={item.name}>{item.name}：{item.status === 'found' ? '已找到' : item.status === 'outdated' ? '版本过旧' : '缺失'} · {item.detail}{item.status !== 'found' && <a href={item.helpUrl} target="_blank" rel="noreferrer"> 安装或更新 ↗</a>}</p>)}{workspace.probe.installCommand && <div><code>{workspace.probe.installCommand}</code><button type="button" onClick={() => void copyGuidance(workspace.probe.installCommand!)}>复制安装命令</button></div>}{workspace.probe.upgradeCommand ? <div><code>{workspace.probe.upgradeCommand}</code><button type="button" onClick={() => void copyGuidance(workspace.probe.upgradeCommand!)}>复制升级命令</button></div> : workspace.probe.selectedPath && <p>安装来源未能可靠确认，请先核对官方安装说明，再用原安装方式升级。</p>}</details>
      {!!workspace.recoveryNeeded.length && <div className={styles.error}>有 {workspace.recoveryNeeded.length} 项原生文件事务需要恢复。请检查目标文件和本机凭据库后重试。<button type="button" onClick={() => { void native.recoverNativeTransactions().then(() => { if (currentTool) return reload(currentTool, scope, projectPath, selectedId); }); }}>重试恢复</button></div>}
      <div className={styles.columns}>
        <aside className={styles.profileList} aria-label="命名配置"><div className={styles.listHeading}><strong>命名配置</strong><button type="button" onClick={createProfile}>＋ 新建</button></div>
          <button type="button" className={editor === 'common' ? styles.activeProfile : ''} onClick={editCommon}><strong>通用配置</strong><small>供本工具的命名配置继承</small></button>
          {workspace.snapshots.some((item) => item.fingerprint && !workspace.probe.nativeFiles.find((file) => file.role === item.role)?.sensitive) && <button type="button" onClick={() => void importCurrentNative()}><strong>编辑当前原生配置</strong><small>打开磁盘上的完整原文</small></button>}
          {workspace.profiles.map((item) => <button key={item.id} type="button" className={editor === 'profile' && selectedId === item.id ? styles.activeProfile : ''} onClick={() => selectProfile(item)}><strong>{item.name}</strong><small>{workspace.binding?.profileId === item.id ? workspace.binding.profileVersion === item.version ? '✓ 当前已应用' : '有未应用的修改' : item.connection?.model || '未应用'}</small></button>)}
          {!workspace.profiles.length && <p>还没有命名配置。可以新建，或打开当前原生配置。</p>}
        </aside>
        <div className={styles.editor}>
          <div className={styles.editorHead}><div><small>{editor === 'common' ? '同工具基础' : '命名原生配置'}</small><h2>{editor === 'common' ? '通用配置' : draft?.name || '新配置'}</h2></div><span>{scope === 'global' ? '全局' : '项目'}</span></div>
          {editor === 'profile' && !draft ? <div className={styles.empty}>选择一份配置，或新建一份。</div> : <>
            <div className={styles.views} role="tablist" aria-label="配置视图"><button type="button" className={view === 'form' ? styles.selected : ''} onClick={() => setView('form')} disabled={editor === 'common' || !!pendingRaw}>常用设置</button><button type="button" className={view === 'native' ? styles.selected : ''} onClick={() => setView('native')}>原生文件</button><button type="button" className={view === 'merged' ? styles.selected : ''} onClick={() => setView('merged')} disabled={editor === 'common' || !!pendingRaw}>合并结果</button></div>
            {view === 'form' && editor === 'profile' && draft && <div className={styles.form}>
              <label>配置名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：日常开发" /></label>
              <label className={styles.check}><input type="checkbox" checked={draft.inheritCommon} onChange={(event) => setDraft({ ...draft, inheritCommon: event.target.checked })} />继承本工具通用配置</label>
              {Object.values(draft.nativeCredentials ?? {}).some((items) => Object.keys(items).length > 0) && <p className={styles.hint}>原生 API 密钥已存入系统凭据库；未指定的模型与地址继续由 CLI 默认值决定。应用时会写入该 CLI 可直接读取的原生认证字段。</p>}
              <div className={styles.formDivider}><strong>连接与模型</strong><label className={styles.check}><input type="checkbox" checked={!!draft.connection} onChange={(event) => setDraft({ ...draft, connection: event.target.checked ? defaultConnection(workspace.probe.interfaceFormats) : null })} />配置供应商连接</label></div>
              {(inspection?.providerId || inspection?.model) && <p className={styles.hint}>原生草稿识别到：{inspection.providerId ?? '未知供应商'} · {inspection.model ?? '未指定模型'}{!inspection.connection && (uiAdapter.incompleteConnectionText ?? '；连接字段不完整，原文仍会保留')}</p>}
              {inspection?.connection && connectionShape(inspection.connection) !== connectionShape(connection) && <button type="button" onClick={adoptInspectedConnection}>按原生草稿更新表单连接</button>}
              {connection && <>
                {!!workspace.probe.providerPresets.length && <div className={styles.modelBar}><span>常用 API 地址</span>{workspace.probe.providerPresets.map((item) => <button key={item.id} type="button" title={`接口依据：${item.sourceUrl}`} onClick={() => applyPreset(item.id, item.baseUrl, item.interfaceFormat)}>{item.label}</button>)}</div>}
                <div className={styles.formGrid}><label>供应商 ID<input value={connection.providerId} onChange={(event) => setDraft({ ...draft, connection: { ...connection, providerId: event.target.value } })} placeholder="my-provider" /></label><label>接口格式<select value={connection.interfaceFormat} onChange={(event) => setDraft({ ...draft, connection: { ...connection, interfaceFormat: event.target.value } })}>{workspace.probe.interfaceFormats.includes(connection.interfaceFormat as never) ? null : <option value={connection.interfaceFormat}>未知格式 · 只读</option>}{workspace.probe.interfaceFormats.map((item) => <option key={item} value={item}>{formatLabel(item)}</option>)}</select></label></div>
                <label>API 地址<input value={connection.baseUrl} onChange={(event) => setDraft({ ...draft, connection: { ...connection, baseUrl: event.target.value } })} placeholder="https://api.example.com/v1" /></label>
                <div className={styles.formGrid}><label>模型 ID<input list="native-model-options" value={connection.model} onChange={(event) => setDraft({ ...draft, connection: { ...connection, model: event.target.value } })} placeholder="直接输入或从目录选择" /><datalist id="native-model-options">{modelOptions.map((model) => <option key={model} value={model} />)}</datalist></label><label>搜索已获取模型<input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="筛选目录" /></label></div>
                <div className={styles.modelBar}><span>{modelLoading ? '正在读取供应商模型目录…' : modelDirectory?.status === 'ready' ? `目录列出 ${modelDirectory.models.length} 个模型` : modelDirectory?.status === 'empty' ? '供应商返回空目录，可直接填写' : modelDirectory?.status === 'stale' ? `显示旧缓存：${modelDirectory.error}` : modelDirectory?.error ?? '模型 ID 可直接填写'}</span><button type="button" disabled={modelLoading} onClick={() => void refreshModels(connection, true)}>刷新目录</button></div>
                <div className={styles.modelBar}><span>连接检查</span><button type="button" disabled={checkingConnection} onClick={() => void checkConnection(false)}>检查格式与连通性</button><button type="button" disabled={checkingConnection} onClick={() => void checkConnection(true)}>最小模型请求（可能计费）</button></div>
                {connectionCheck && <div className={styles.hint} role="status">格式：{connectionCheck.format.message}；连通性：{connectionCheck.connectivity.message}；模型请求：{connectionCheck.modelRequest.message}</div>}
                <label>CLI 认证环境变量名<input value={connection.authEnvVar ?? ''} onChange={(event) => setDraft({ ...draft, connection: { ...connection, authEnvVar: event.target.value || null } })} placeholder="例如 MY_API_KEY（可选）" /></label>
                {effectiveEnvName && !connection.secretRef && <p className={styles.hint}>原生配置引用：<code>{effectiveEnvName}</code>。直接从终端使用时需自行提供该环境变量。</p>}
                <div className={styles.secretBar}><label>API 密钥（系统凭据库）<input type="password" autoComplete="off" value={newSecret} onChange={(event) => setNewSecret(event.target.value)} placeholder={connection.secretRef ? '已存入系统凭据库' : '可选'} /></label><button type="button" disabled={!newSecret || busy} onClick={() => void saveSecret()}>保存密钥</button></div><p className={styles.hint}>保存并应用后，CLI 会从受保护的原生配置读取密钥；原生文件因此含有必要的明文凭据。项目共享文件不会写入密钥。</p>
              </>}
              {uiAdapter.reasoning && <label>{uiAdapter.reasoning.label}<select value={inspection?.reasoningEffort ?? ''} onChange={(event) => void changeReasoningEffort(event.target.value)}><option value="">跟随原生默认</option>{uiAdapter.reasoning.choices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}{inspection?.reasoningEffort && !uiAdapter.reasoning.choices.some(([id]) => id === inspection.reasoningEffort) && <option value={inspection.reasoningEffort}>当前原生值：{inspection.reasoningEffort}</option>}</select></label>}
            </div>}
            {view === 'native' && <div className={styles.nativeEditor}>
              <div className={styles.fileTabs}>{availableRoles.map((name) => <button key={name} type="button" className={role === name ? styles.selected : ''} disabled={!!pendingRaw && name !== pendingRaw.role} onClick={() => { rawSequence.current++; setRole(name); }}>{name === 'settings' ? activeFile?.path.split(/[\\/]/).at(-1) ?? 'settings' : name}</button>)}</div>
              <p className={styles.pathLabel}>{activeFile?.path ?? '原生文件尚未确定'} · {activeFile?.format?.toUpperCase() ?? ''}</p>
              {editor === 'profile' && <div className={styles.modelBar}><span>{activeRaw ? '当前磁盘原文 · 含完整原生字段' : '命名配置草稿 · 密钥由系统凭据库管理'}</span>{activeRaw ? <button type="button" onClick={() => setRawDisk(null)} disabled={busy}>{activeRaw.text !== activeRaw.original ? '放弃原文修改，返回草稿' : '返回配置草稿'}</button> : <button type="button" onClick={() => void editDiskRaw()} disabled={busy}>编辑当前磁盘原文</button>}</div>}
              {activeRaw ? <p className={styles.hint}>本次保存以完整磁盘原文为准，连接表单会据此更新；保存并应用会把认证字段写回 CLI 原生文件。</p> : editor === 'profile' && !!draft?.connection && <p className={styles.hint}>这是命名配置的原生文本基础；表单中的连接字段会在应用时合并覆盖。最终结果可在“合并结果”查看。</p>}
              {activeRaw && <p className={styles.hint}>正在编辑完整磁盘原文，包括原生认证字段。保存时密钥会进入系统凭据库；“保存并应用”会把修改写回 CLI 文件。</p>}
              <textarea spellCheck={false} aria-label={`${role} 配置草稿`} value={activeRaw?.text ?? (editor === 'common' ? commonDraft?.files[role] : draft?.files[role]) ?? ''} onChange={(event) => activeRaw ? setRawDisk({ ...activeRaw, text: event.target.value }) : editor === 'common' ? commonDraft && setCommonDraft({ ...commonDraft, files: { ...commonDraft.files, [role]: event.target.value } }) : draft && setDraft({ ...draft, files: { ...draft.files, [role]: event.target.value } })} placeholder="在这里编辑原生配置。留空表示本配置不覆盖该文件。" />
              <details className={styles.diskPreview}><summary>磁盘文件状态</summary><pre>{workspace.snapshots.find((item) => item.role === role)?.error ?? '文件尚不存在'}</pre>{editor === 'profile' && <button type="button" onClick={() => void importDiskFile()}>安全接入此文件</button>}</details>
            </div>}
            {view === 'merged' && <div className={styles.merged}><p>只读结构化预览：通用配置、命名配置和连接设置合并；CLI 仍可能受到环境变量、项目信任和更高优先级原生设置影响。</p><pre>{preview ? JSON.stringify(preview.documents[role] ?? {}, null, 2) : '等待有效配置…'}</pre>{preview && <details><summary>查看字段来源</summary><pre>{Object.entries(preview.sources[role] ?? {}).map(([path, source]) => `${path} ← ${source}`).join('\n') || '没有覆盖字段'}</pre></details>}</div>}
            <div className={styles.actions}>{editor === 'profile' && draft?.id && <button type="button" disabled={busy} onClick={() => void deleteCurrent()}>删除</button>}<span>{dirty ? '草稿尚未保存' : editor === 'profile' && workspace.binding?.profileId === draft?.id && workspace.binding?.profileVersion === draft?.version ? '当前范围已应用' : '保存草稿不会切换原生配置'}</span><button type="button" disabled={busy || !nativeAvailable} onClick={() => void save(false)}>保存</button>{editor === 'profile' && <button type="button" className={styles.primary} disabled={busy || !nativeAvailable || workspace.probe.nativeWrites.state !== 'supported'} onClick={() => void save(true)}>保存并应用到{scope === 'global' ? '全局' : '项目'}</button>}</div>
          </>}
        </div>
      </div>
      {editor === 'profile' && draft?.id && !dirty && (workspace.binding?.profileId !== draft.id || workspace.binding.profileVersion !== draft.version) && <div className={styles.quickApply}><span>这份配置已保存，但尚未应用到当前范围。</span><button type="button" onClick={() => void applySaved(draft)} disabled={busy || workspace.probe.nativeWrites.state !== 'supported'}>应用这份配置</button></div>}
    </>}
  </section>;
}
