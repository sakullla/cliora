import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction, type ConfirmationOptions } from '../../lib/confirm';
import { sameDraftRequest } from '../../lib/draftGuard';
import { importedConnection } from '../../lib/nativeDraft';
import type { ModelRoleValue } from '../../adapters/contract';
import type { DraftRequest } from '../../lib/draftGuard';
import type { ApiError } from '../../types/domain';
import type { Project, TrayRepairTarget } from '../../types/launch';
import type { AdapterDescriptor, ApplyComparison, Connection, ConnectionCheck, ModelDirectory, ModelRecord, NativeInspection, NativePreview, RegisteredCommon, RegisteredProfile, RegisteredToolWorkspace, Scope } from '../../types/native';
import { authEnvName, uiAdapterFor } from '../../adapters';
import { AccountsPanel, accountStates, useAccounts } from './AccountsPanel';
import { ProfileQuota, useUsageQuota } from './UsageQuota';
import { InstallPanel } from './InstallPanel';
import { ModelCombobox } from './ModelCombobox';
import { McpWorkspace, SkillsWorkspace } from './ResourceWorkspace';
import { PluginsWorkspace } from './PluginsWorkspace';
import { AgentsWorkspace } from './AgentsWorkspace';
import { ToolIcon } from '../../components/ToolIcon';
import { FileConflict } from '../../components/FileConflict';
import { FilterSelect } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { saveShortcutHint } from '../../lib/shortcut';
import { navigateChoices } from '../../lib/choiceNavigation';
import { CodeEditor, preloadCodeEditor } from '../../components/CodeEditor';
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

function formatBackupTime(createdAt: number, index: number): string {
  if (createdAt) return new Date(createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return index === 0 ? '最近一次' : `往前 ${index} 次`;
}

function formatLabel(value: string): string {
  return ({ openai_completions: 'Chat Completions', openai_responses: 'Responses', anthropic_messages: 'Anthropic Messages' } as Record<string, string>)[value] ?? value;
}

function profileFacts(item: RegisteredProfile): { label: string; title?: string }[] {
  const kind = item.authentication?.kind;
  const auth = kind === 'api_key' ? 'API Key' : kind === 'oauth' ? 'OAuth' : kind === 'rebind_required' ? '需重新绑定' : '原生认证';
  const url = item.connection?.baseUrl?.trim() ?? '';
  let host = '';
  if (url) {
    try { host = new URL(url).host; }
    catch { host = url.replace(/^https?:\/\//, '').split('/')[0] ?? ''; }
  }
  return [{ label: auth }, ...(host ? [{ label: host, title: url }] : [])];
}

function connectionShape(value: Connection | null): string {
  return value ? JSON.stringify([value.providerId, value.interfaceFormat, value.baseUrl, value.model, value.authEnvVar]) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Keep only keys already stored on the projected model. Edits cannot add fields. */
function mergeFields(base: Record<string, unknown>, edit?: Record<string, unknown>): Record<string, unknown> {
  if (!edit) return base;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (isRecord(value)) next[key] = mergeFields(value, isRecord(edit[key]) ? edit[key] : undefined);
    else next[key] = Object.prototype.hasOwnProperty.call(edit, key) ? edit[key] : value;
  }
  return next;
}

function setField(fields: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!head) return fields;
  if (!rest.length) return { ...fields, [head]: value };
  const child = fields[head];
  return { ...fields, [head]: setField(isRecord(child) ? child : {}, rest, value) };
}

function connectionForProvider(connection: Connection, providerId: string, patch: Partial<Connection> = {}): Connection {
  const next: Connection = { ...connection, ...patch, providerId };
  if (providerId !== connection.providerId) delete next.modelRecords;
  return next;
}

/** Model edits belong to the provider on screen; a different provider must not inherit them. */
function retainSameProviderModelRecords(next: Connection | null, current: Connection | null): Connection | null {
  if (!next || !current?.modelRecords || current.providerId !== next.providerId) return next;
  return { ...next, modelRecords: current.modelRecords };
}

function providerModelRecords(connection: Connection, inspection: NativeInspection | null, projection: string): ModelRecord[] | null {
  if (projection !== 'provider_models') return null;
  const selected = connection.providerId.trim();
  const inspected = inspection?.providerId?.trim() ?? '';
  const projected = inspection?.projectedModels;
  if (projected && inspected && selected && inspected !== selected) return [];
  if (!projected) return connection.modelRecords ?? [];
  const edits = connection.modelRecords ?? [];
  return projected.map((record) => {
    const edit = edits.find((item) => item.id === record.id);
    return { id: record.id, fields: mergeFields(record.fields, edit?.fields) };
  });
}

/** A finished numeric literal. Trailing dots, a lone sign, and an unfinished exponent are not numbers yet. */
function isCompleteNumber(text: string): boolean {
  const trimmed = text.trim();
  return /^[+-]?(?:\d+\.\d+|\d+|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed));
}

function completeJsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ModelNumberInput({ ariaLabel, value, onCommit }: { ariaLabel: string; value: number; onCommit: (next: number) => void }) {
  const [text, setText] = useState(() => String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    if (!(isCompleteNumber(text) && Number(text) === value)) setText(String(value));
    setSeen(value);
  }
  return <input aria-label={ariaLabel} value={text} onChange={(event) => {
    const typed = event.target.value;
    setText(typed);
    if (!isCompleteNumber(typed)) return;
    onCommit(Number(typed.trim()));
  }} />;
}

function ModelArrayInput({ ariaLabel, value, onCommit }: { ariaLabel: string; value: unknown[]; onCommit: (next: unknown[]) => void }) {
  const serialized = JSON.stringify(value);
  const [text, setText] = useState(serialized);
  const [seen, setSeen] = useState(serialized);
  if (serialized !== seen) {
    const parsed = completeJsonArray(text);
    if (!parsed || JSON.stringify(parsed) !== serialized) setText(serialized);
    setSeen(serialized);
  }
  return <input aria-label={ariaLabel} value={text} onChange={(event) => {
    const typed = event.target.value;
    setText(typed);
    const parsed = completeJsonArray(typed);
    if (parsed) onCommit(parsed);
  }} />;
}

function modelFieldControls(recordId: string, fields: Record<string, unknown>, onChange: (id: string, path: string[], value: unknown) => void, path: string[] = []): ReactNode[] {
  return Object.entries(fields).map(([key, value]) => {
    const next = [...path, key];
    const label = next.join('.');
    const aria = `${recordId} ${label}`;
    if (isRecord(value)) return <div key={label} className={styles.modelFields}>{modelFieldControls(recordId, value, onChange, next)}</div>;
    if (typeof value === 'boolean') return <label key={label} className={styles.check}><input type="checkbox" aria-label={aria} checked={value} onChange={(event) => onChange(recordId, next, event.target.checked)} />{label}</label>;
    if (Array.isArray(value)) return <label key={label}>{label}<ModelArrayInput ariaLabel={aria} value={value} onCommit={(parsed) => onChange(recordId, next, parsed)} /></label>;
    if (typeof value === 'number') return <label key={label}>{label}<ModelNumberInput ariaLabel={aria} value={value} onCommit={(parsed) => onChange(recordId, next, parsed)} /></label>;
    const text = value === null || value === undefined ? '' : String(value);
    return <label key={label}>{label}<input aria-label={aria} value={text} onChange={(event) => onChange(recordId, next, event.target.value)} /></label>;
  });
}

function workspaceKey(toolId: string, scope: Scope, projectPath: string) {
  return `${toolId}\0${scope}\0${projectPath}`;
}

const rememberedWorkspaces = new Map<string, RegisteredToolWorkspace>();
const workspaceRequests = new Map<string, Promise<RegisteredToolWorkspace>>();

function requestWorkspace(toolId: string, scope: Scope, projectPath: string, fresh: boolean) {
  const key = workspaceKey(toolId, scope, projectPath);
  if (!fresh) {
    const pending = workspaceRequests.get(key);
    if (pending) return pending;
  }
  const request = native.getRegisteredToolWorkspace(toolId, scope, projectPath, false, fresh).then((result) => {
    rememberedWorkspaces.set(key, result);
    return result;
  }).finally(() => {
    if (workspaceRequests.get(key) === request) workspaceRequests.delete(key);
  });
  if (!fresh) workspaceRequests.set(key, request);
  return request;
}

function emptyProfile(tool: string): RegisteredProfile {
  return { id: '', tool, name: '', version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} };
}

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = ref.current?.getBoundingClientRect();
      const menu = panel.current;
      if (!trigger || !menu) return;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(8, Math.min(trigger.right - width, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - trigger.bottom - 8;
      const top = spaceBelow >= height || trigger.top < height + 8
        ? Math.min(trigger.bottom + 4, Math.max(8, window.innerHeight - height - 8))
        : trigger.top - height - 4;
      setBox({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className={styles.rowMenu} ref={ref}>
    <button type="button" className={styles.rowMenuButton} aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)}>···</button>
    {open && createPortal(<div ref={panel} className={styles.rowMenuList} role="menu" style={box ? { top: box.top, left: box.left } : { top: 0, left: 0, visibility: 'hidden' }} onClick={() => setOpen(false)}>{children}</div>, document.body)}
  </div>;
}

export function ToolWorkspacePage({ managedTools, initialTool, openSequence = 0, active = true, repair, onDirtyChange }: { active?: boolean; managedTools: AdapterDescriptor[]; initialTool?: string; openSequence?: number; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [tool, setTool] = useState<string>(repair?.toolId ?? initialTool ?? managedTools[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>(repair?.scope ?? 'global');
  const [projectPath, setProjectPath] = useState(repair?.projectPath ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const quotaState = useUsageQuota(active);
  const [quotaAddFor, setQuotaAddFor] = useState<string | null>(null);
  const clearQuotaAdd = useCallback(() => setQuotaAddFor(null), []);
  const accountState = useAccounts(tool, active);
  const [preferredProfileId, setPreferredProfileId] = useState<string | null>(repair?.profileId ?? null);
  const appliedRepair = useRef(repair?.sequence ?? 0);
  const appliedOpenSequence = useRef(0);
  const [workspace, setWorkspace] = useState<RegisteredToolWorkspace | null>(null);
  const [editor, setEditor] = useState<Editor>('profile');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profileQuery, setProfileQuery] = useState('');
  const draftRevision = useRef(0);
  const [draft, setDraftState] = useState<RegisteredProfile | null>(null);
  const setDraft = (value: SetStateAction<RegisteredProfile | null>) => {
    draftRevision.current++;
    setDraftState(value);
  };
  const [commonDraft, setCommonDraft] = useState<RegisteredCommon | null>(null);
  const [view, setView] = useState<View>('form');
  const [resourceView, setResourceView] = useState<'config' | 'mcp' | 'skills' | 'accounts' | 'plugins' | 'agents'>(repair?.resourceView ?? 'config');
  const [mcpDirty, setMcpDirty] = useState(false);
  const [skillsDirty, setSkillsDirty] = useState(false);
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [resourceEpoch, setResourceEpoch] = useState(0);
  const [role, setRole] = useState('settings');
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const [modelDirectory, setModelDirectory] = useState<ModelDirectory | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck | null>(null);
  const [inspection, setInspection] = useState<NativeInspection | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [newSecret, setNewSecret] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [rawDisk, setRawDisk] = useState<{ context: string; role: string; original: string; text: string } | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enablingId, setEnablingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fileConflict, setFileConflict] = useState<{ context: string; current: string } | null>(null);
  const [backups, setBackups] = useState<{ transactionId: string; path: string; createdAt: number }[]>([]);
  const [backupPreview, setBackupPreview] = useState<{ transactionId: string; current: string; original: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [applyComparison, setApplyComparison] = useState<ApplyComparison | null>(null);
  const [copiedPath, setCopiedPath] = useState('');
  const copiedTimer = useRef(0);
  const [guide, setGuide] = useState(false);
  const pendingGuide = useRef(false);
  const editRef = useRef({ guide: false, editor: 'profile' as Editor, draft: null as RegisteredProfile | null, loaded: false });
  const loadSequence = useRef(0);
  const modelSequence = useRef(0);
  const modelWrite = useRef(0);
  const modelSource = useRef('');
  const inspectionSequence = useRef(0);
  const importSequence = useRef(0);
  const rawSequence = useRef(0);
  const editorContextId = useRef<string | null>(null);
  const reasoningSequence = useRef(0);
  const previewSequence = useRef(0);
  const savedDraft = useRef('');
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    void native.listProjects().then(result => { if (live) setProjects(result); }).catch(value => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [active]);

  const visibleTools = managedTools;
  const prefetchIds = visibleTools.map((item) => item.id).join('\0');
  const currentTool = visibleTools.some((item) => item.id === tool) ? tool : visibleTools[0]?.id;
  useEffect(()=>setApplyComparison(null),[currentTool,scope,projectPath]);
  const currentDescriptor = visibleTools.find((item) => item.id === currentTool);
  editRef.current = { guide, editor, draft, loaded: workspace !== null };
  const toolName = currentDescriptor?.name ?? currentTool ?? '';
  const uiAdapter = uiAdapterFor(currentTool ?? '');
  const management = currentDescriptor?.management;
  const supports = {
    config: true,
    accounts: management?.accounts ?? true,
    mcp: management?.mcp ?? true,
    skills: management?.skills ?? true,
    agents: management?.agents ?? true,
    plugins: (management?.plugins ?? true) && (scope !== 'project' || (management?.projectPlugins ?? true)),
  };
  useEffect(() => {
    if (!supports[resourceView]) setResourceView('config');
  }, [currentTool, resourceView, supports.accounts, supports.mcp, supports.skills, supports.agents, supports.plugins]);

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
  const refreshState = useRef({ currentTool, scope, projectPath, selectedId, editor, dirty, busy, mcpDirty, skillsDirty, agentsDirty });
  refreshState.current = { currentTool, scope, projectPath, selectedId, editor, dirty, busy, mcpDirty, skillsDirty, agentsDirty };
  const confirmationContext = JSON.stringify([draftContext, draft, commonDraft, rawDisk, newSecret, mcpDirty, skillsDirty, agentsDirty]);
  const latestConfirmation = useRef(confirmationContext); latestConfirmation.current = confirmationContext;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const refresh = () => {
      const state = refreshState.current;
      if (!state.currentTool || state.dirty || state.busy || state.mcpDirty || state.skillsDirty || state.agentsDirty) return;
      void native.getRegisteredToolWorkspace(state.currentTool, state.scope, state.projectPath, false, true).then((result) => {
        if (!mounted.current) return;
        const now = refreshState.current;
        if (now.dirty || now.busy || now.currentTool !== state.currentTool) return;
        const key = workspaceKey(state.currentTool, state.scope, state.projectPath);
        const previous = rememberedWorkspaces.get(key);
        if (previous) rememberedWorkspaces.set(key, { ...previous, probe: result.probe });
        setWorkspace((current) => current ? { ...current, probe: result.probe } : current);
      }).catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  async function confirmChange(message: string, options: ConfirmationOptions = { title: '放弃未保存修改？', confirmLabel: '放弃修改' }) {
    const started = captureDraft();
    const context = latestConfirmation.current;
    return confirmAction(message, () => mounted.current && stillCurrent(started) && context === latestConfirmation.current, options);
  }
  async function closeGuide() {
    if ((dirty || mcpDirty || skillsDirty || agentsDirty) && !await confirmChange('当前草稿尚未保存，关闭后会丢失这些修改。继续吗？')) return;
    setHistoryOpen(false); setBackupPreview(null);
    rawSequence.current++; setBusy(false);
    setGuide(false);
  }
  useLayoutEffect(() => { onDirtyChange?.(dirty || mcpDirty || skillsDirty || agentsDirty); }, [dirty, mcpDirty, skillsDirty, agentsDirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  const reload = useCallback(async (nextTool: string, nextScope: Scope, nextProject: string, preferredId?: string | null, fresh = false) => {
    if (!nativeAvailable || (nextScope === 'project' && !nextProject.trim())) { loadSequence.current++; setWorkspace(null); return; }
    const sequence = ++loadSequence.current;
    const cached = fresh ? undefined : rememberedWorkspaces.get(workspaceKey(nextTool, nextScope, nextProject));
    if (!cached) setLoading(true);
    setError('');
    try {
      const result = await requestWorkspace(nextTool, nextScope, nextProject, fresh);
      if (sequence !== loadSequence.current) return;
      const editing = editRef.current;
      const openAfterLoad = pendingGuide.current;
      pendingGuide.current = false;
      const keepEdit = editing.guide && (editing.editor !== 'profile' || !!editing.draft);
      setWorkspace(result);
      setCustomPath(result.customPath ?? '');
      if (keepEdit) return;
      setRawDisk(null);
      setEditor('profile');
      const next = result.profiles.find((item) => item.id === preferredId) ?? result.profiles.find((item) => item.id === result.binding?.profileId) ?? result.profiles[0] ?? null;
      setSelectedId(next?.id ?? null);
      setDraft(next ? structuredClone(next) : null);
      savedDraft.current = next ? JSON.stringify(next) : '';
      if (openAfterLoad && next) setGuide(true);
      else if (editing.guide && editing.editor === 'profile' && !editing.draft) setGuide(false);
      setCommonDraft(result.common ? structuredClone(result.common) : { tool: nextTool, version: 0, files: {} });
      setRole(result.probe.nativeFiles.find(item => !item.sensitive && item.role === uiAdapterFor(nextTool).primaryRole)?.role ?? result.probe.nativeFiles.find((item) => !item.sensitive)?.role ?? 'settings');
    } catch (value) {
      if (sequence === loadSequence.current) { setWorkspace(null); setError(errorText(value)); }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);

  useLayoutEffect(() => {
    loadSequence.current++; invalidateDraftRequest(); inspectionSequence.current++;
    rawSequence.current++; setBusy(false);
    setFileConflict(null); setBackups([]); setBackupPreview(null); setHistoryOpen(false); setRawDisk(null);
    setGuide(false);
    setNotice(''); setError(''); setInspection(null); setNewSecret(''); setProfileQuery('');
    const cached = currentTool && (scope !== 'project' || projectPath.trim()) ? rememberedWorkspaces.get(workspaceKey(currentTool, scope, projectPath)) : undefined;
    if (cached && currentTool) {
      setWorkspace(cached);
      setCustomPath(cached.customPath ?? '');
      setEditor('profile');
      const next = cached.profiles.find((item) => item.id === preferredProfileId) ?? cached.profiles.find((item) => item.id === cached.binding?.profileId) ?? cached.profiles[0] ?? null;
      setSelectedId(next?.id ?? null);
      setDraft(next ? structuredClone(next) : null);
      savedDraft.current = next ? JSON.stringify(next) : '';
      setCommonDraft(cached.common ? structuredClone(cached.common) : { tool: currentTool, version: 0, files: {} });
      setRole(cached.probe.nativeFiles.find(item => !item.sensitive && item.role === uiAdapterFor(currentTool).primaryRole)?.role ?? cached.probe.nativeFiles.find((item) => !item.sensitive)?.role ?? 'settings');
      setLoading(false);
    } else {
      setWorkspace(null); setDraft(null); setCommonDraft(null); setSelectedId(null); savedDraft.current = '';
      setLoading(!!currentTool && (scope !== 'project' || !!projectPath.trim()));
    }
  }, [currentTool, scope, projectPath]);
  useEffect(() => { if (active && currentTool) void reload(currentTool, scope, projectPath, preferredProfileId); }, [active, currentTool, scope, projectPath, preferredProfileId, reload]);
  useEffect(() => {
    if (!active || !currentTool || !nativeAvailable || (scope === 'project' && !projectPath.trim())) return;
    const others = prefetchIds.split('\0').filter((id) => id && id !== currentTool);
    let cancel = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const id of others) {
          if (cancel || rememberedWorkspaces.has(workspaceKey(id, scope, projectPath))) continue;
          try { await requestWorkspace(id, scope, projectPath, false); } catch { /* the click still loads this CLI and shows its error */ }
        }
      })();
    }, 300);
    return () => { cancel = true; window.clearTimeout(timer); };
  }, [active, currentTool, scope, projectPath, prefetchIds]);

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
      const hadUnsaved = dirty || mcpDirty || skillsDirty || agentsDirty;
      if (hadUnsaved && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
      if (!live) return;
      if (hadUnsaved) await discardUnsavedDrafts();
      else invalidateDraftRequest();
      if (!live) return;
      if (initialTool && initialTool !== tool) {
        pendingGuide.current = true;
        setTool(initialTool);
      } else if (editRef.current.draft?.id) setGuide(true);
      else if (!editRef.current.loaded) pendingGuide.current = true;
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
        if (current.dirty || current.busy || current.mcpDirty || current.skillsDirty || current.agentsDirty) {
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
      if ((dirty || mcpDirty || skillsDirty || agentsDirty) && !await confirmChange('当前草稿尚未保存，打开托盘指向的配置会丢失这些修改。继续吗？')) {
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
      const samePlace = repair.toolId === tool && (repair.scope ?? 'global') === scope && (repair.projectPath ?? '') === projectPath && (repair.profileId ?? null) === preferredProfileId;
      if (samePlace) {
        if (editRef.current.draft?.id) setGuide(true);
      } else pendingGuide.current = true;
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
  const connectionPolicy = workspace?.probe.connectionPolicy;
  const apiKeyState = connectionPolicy?.apiKey?.state ?? 'writable';
  const apiKeyWritable = apiKeyState === 'writable';
  const addressConfigurable = (connectionPolicy?.providerAddress?.state ?? 'configurable') !== 'unsupported';
  const projection = connectionPolicy?.projection ?? 'single_connection';
  const availableRoles = workspace?.probe.nativeFiles.filter((item) => !item.sensitive).map((item) => item.role) ?? ['settings'];
  const activeFile = workspace?.probe.nativeFiles.find((item) => item.role === role);

  async function selectProfile(profile: RegisteredProfile) {
    if (dirty && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    setRawDisk(null); setNewSecret(''); setEditor('profile'); setSelectedId(profile.id); setDraft(structuredClone(profile)); savedDraft.current = JSON.stringify(profile);
    setView('form'); setError(''); setNotice(''); setApplyComparison(null); setGuide(true);
  }

  async function switchResourceView(next: 'config' | 'mcp' | 'skills' | 'accounts' | 'plugins' | 'agents') {
    if (next === resourceView) return;
    const hadUnsaved = dirty || mcpDirty || skillsDirty || agentsDirty;
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
    const preset = addressConfigurable ? workspace?.probe.providerPresets[0] : undefined;
    next.connection = { ...defaultConnection(workspace?.probe.interfaceFormats ?? []), providerId: preset?.id ?? 'my-provider', baseUrl: preset?.baseUrl ?? '', interfaceFormat: preset?.interfaceFormat ?? workspace?.probe.interfaceFormats[0] ?? 'openai_responses' };
    setRawDisk(null); setEditor('profile'); setSelectedId(null); setDraft(next); savedDraft.current = JSON.stringify(next);
    setView('form'); setNewSecret(''); setError(''); setNotice(''); setApplyComparison(null); setGuide(true);
  }

  async function editCommon() {
    if (!currentTool) return;
    if (dirty && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    setApplyComparison(null);
    invalidateDraftRequest();
    const next = structuredClone(workspace?.common ?? { tool: currentTool, version: 0, files: {} });
    setRawDisk(null); setNewSecret(''); setEditor('common'); setCommonDraft(next); savedDraft.current = JSON.stringify(next);
    setView('native'); setError(''); setNotice(''); setGuide(true);
  }

  async function save(applyAfter: boolean, activate = false) {
    if (!nativeAvailable || busy) return;
    if (editor === 'profile' && draft && !draft.name.trim()) { setError('请输入配置名称。'); document.querySelector<HTMLInputElement>('[name="profile-name"]')?.focus(); return; }
    const started = captureDraft();
    setBusy(true); setError(''); setNotice('');
    let savedForTakeover: RegisteredProfile | null = null;
    try {
      if (editor === 'native' && pendingRaw && currentTool) {
        await native.saveRegisteredNativeFile(currentTool, scope, projectPath, pendingRaw.role, pendingRaw.original, pendingRaw.text, editorContextId.current);
        if (!stillCurrent(started)) return;
        const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, pendingRaw.role);
        if (!stillCurrent(started)) return;
        setRawDisk({ ...pendingRaw, original: text, text });
        const updated = await native.getRegisteredToolWorkspace(currentTool, scope, projectPath);
        if (!stillCurrent(started)) return;
        setWorkspace(updated); setNotice('已保存到正在使用的文件。'); setGuide(false);
      } else if (editor === 'common' && commonDraft) {
        const result = await native.saveRegisteredCommonConfig(commonDraft, commonDraft.version || null);
        if (!stillCurrent(started)) { setNotice('原通用草稿已保存；当前编辑内容已保留。'); return; }
        const saved = result.common;
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
        const failed = result.applications.filter((item) => item.status === 'failed');
        setNotice(failed.length ? `通用配置已保存；${failed.length} 个活动范围未能应用，请检查并重试。` : `通用配置已保存；${result.applications.length} 个活动范围已检查并应用。`);
        if (currentTool) await reload(currentTool, scope, projectPath, selectedId);
        setEditor('common');
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved); setGuide(false);
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
        const usingReplacement = !!pendingRaw || imported.migratedSecret || !draft.connection;
        const nextConnection = pendingRaw ? imported.inspection.connection : usingReplacement ? importedConnection(imported, draft.connection) : draft.connection;
        let editedConnection = usingReplacement ? retainSameProviderModelRecords(nextConnection, draft.connection) : nextConnection;
        editedConnection = await connectionWithSecret(editedConnection, started);
        if (!stillCurrent(started)) return;
        const oauth = draft.authentication?.kind === 'oauth';
        const edited = { ...draft, files: imported.files, nativeCredentials: oauth ? {} : nativeCredentials, connection: oauth ? null : editedConnection };
        const saved = await native.saveRegisteredNativeProfile(edited, edited.version || null);
        savedForTakeover = saved;
        if (!stillCurrent(started)) { setNotice('原草稿已保存；当前继续编辑的内容已保留。'); return; }
        const activeId = workspace?.binding?.profileId;
        const activeName = workspace?.profiles.find((item) => item.id === activeId)?.name;
        if (applyAfter && (saved.id === activeId || activate)) {
          await native.applyRegisteredNativeProfile(currentTool, saved.id, scope, projectPath, false);
          if (!stillCurrent(started)) return;
          setNotice(saved.id === activeId ? '已保存。' : '已保存并启用，下次启动会读取这份配置。');
        } else if (applyAfter && activeName) setNotice(`已保存。当前仍使用「${activeName}」。`);
        else if (applyAfter) setNotice('已保存。点启用后，下次启动会读取这份配置。');
        else setNotice('已保存。当前无法写入这个工具。');
        setNewSecret(''); setDraft(saved); savedDraft.current = JSON.stringify(saved); setSelectedId(saved.id);
        await reload(currentTool, scope, projectPath, saved.id);
        setGuide(false);
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
    try {
      const result=await native.compareRegisteredApplication(profile.id,scope,projectPath);
      if (stillCurrent(started)) { setApplyComparison(result); setError(''); setGuide(false); }
    }
    catch(value){if(stillCurrent(started))setError(errorText(value));}
  }
  async function resolveApplication() {
    if (!applyComparison || busy) return;
    const started=captureDraft();setBusy(true);setError('');
    try {await native.applyComparedApplication(applyComparison,scope,projectPath);if(stillCurrent(started)){setApplyComparison(null);setNotice('');await reload(applyComparison.profile.tool,scope,projectPath,applyComparison.profile.id);}}
    catch(value){if(stillCurrent(started))setError(errorText(value));}
    finally{setBusy(false);}
  }
  async function applySaved(profile: RegisteredProfile, allowTakeover = false) {
    if (!currentTool || busy || enablingId) return;
    const started = captureDraft();
    const previousBinding = workspace?.binding ?? null;
    setEnablingId(profile.id); setError('');
    setWorkspace((current) => current ? { ...current, binding: { scopeKey: current.binding?.scopeKey ?? (scope === 'project' ? `project:${projectPath}` : 'global'), tool: currentTool, profileId: profile.id, profileVersion: profile.version, managed: {} } } : current);
    try {
      await native.applyRegisteredNativeProfile(currentTool, profile.id, scope, projectPath, allowTakeover);
      if (!stillCurrent(started)) { setNotice('所选配置已应用，继续编辑的内容已保留。'); return; }
      setApplyComparison(null);
      setNotice('');
    } catch (value) {
      setWorkspace((current) => current ? { ...current, binding: previousBinding } : current);
      setNotice('');
      if (!stillCurrent(started)) return;
      const message = errorText(value);
      setError(message);
      if (message.includes('请确认接管') || message.includes('外部修改')) await compareApplication(profile);
    } finally { setEnablingId(null); }
  }

  async function connectionWithSecret(source: Connection | null, started: DraftRequest<RegisteredProfile>): Promise<Connection | null> {
    if (!newSecret || !apiKeyWritable) return source;
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

  async function duplicateGiven(item: RegisteredProfile) {
    if (dirty && !await confirmChange('当前草稿尚未保存，复制前放弃这些修改？')) return;
    setApplyComparison(null);
    const names = workspace?.profiles.map(entry => entry.name) ?? [];
    const base = `${item.name} 副本`; let name = base; let count = 2;
    while (names.includes(name)) name = `${base} ${count++}`;
    const copied = { ...structuredClone(item), id: '', name, version: 0, revision: undefined };
    setDraft(copied); setSelectedId(null); setEditor('profile'); setView('form'); setRawDisk(null); savedDraft.current = ''; setNotice(''); setGuide(true);
  }
  async function duplicateProfile() {
    if (draft) await duplicateGiven(draft);
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
    if (scope === 'project' && path === projectPath) return;
    if ((dirty || mcpDirty || skillsDirty || agentsDirty) && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    invalidateDraftRequest(); setScope('project'); setProjectPath(path);
  }

  async function switchGlobal() {
    if (scope === 'global') return;
    if ((dirty || mcpDirty || skillsDirty || agentsDirty) && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    invalidateDraftRequest(); setScope('global');
  }

  async function chooseProjectFolder() {
    const context = draftContext;
    try {
      const picked = await open({ directory: true, multiple: false, title: '选择配置项目文件夹' });
      if (typeof picked === 'string' && latestDraft.current.context === context) switchProject(picked);
    } catch (value) { if (latestDraft.current.context === context) setError(errorText(value)); }
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
    try { await native.setRegisteredCustomCliPath(currentTool, customPath.trim() || null); await reload(currentTool, scope, projectPath, selectedId); setNotice('CLI 路径已保存。'); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function useInstallation(path: string) {
    if (!currentTool || busy) return;
    setBusy(true); setError('');
    try {
      await native.setRegisteredCustomCliPath(currentTool, path);
      setCustomPath(path);
      await reload(currentTool, scope, projectPath, selectedId);
      setNotice('已改用这个安装。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function maintain(action: 'install' | 'upgrade' | 'install_native' | 'uninstall_npm', source?: string) {
    if (!currentTool || busy) return;
    const channel = source === 'npm_shim' ? 'npm' : source === 'native' || action === 'install_native' ? '原生' : '';
    const label = action === 'uninstall_npm' ? '卸载' : action === 'upgrade' ? '更新' : '安装';
    const message = action === 'uninstall_npm' ? '将在外部终端卸载 npm 全局包。' : channel ? `将在外部终端${label} ${channel} 版。` : `将在外部终端运行官方${label}命令。`;
    if (!await confirmChange(message, { title: `开始${label}？`, confirmLabel: label })) return;
    setBusy(true); setError('');
    try {
      await native.maintainRegisteredCli(currentTool, action, source);
      setNotice('已在终端开始。回到这里后会重新读取版本。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function copyDisplayedPath(path: string) {
    const value = displayPath(path);
    const copied = await writeClipboard(value);
    window.clearTimeout(copiedTimer.current);
    setCopiedPath(copied ? value : `fail:${value}`);
    copiedTimer.current = window.setTimeout(() => setCopiedPath(''), 1600);
  }

  function applyPreset(providerId: string, baseUrl: string, interfaceFormat: string) {
    if (!draft?.connection) return;
    setDraft({ ...draft, connection: connectionForProvider(draft.connection, providerId, { baseUrl, interfaceFormat, secretRef: null, authEnvVar: null }) });
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
    editorContextId.current = workspace?.effectiveContextId ?? null;
    if (!currentTool) return;
    const started = captureDraft();
    if (dirty && !abandonConfirmed && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    if (!stillCurrent(started)) return;
    const sequence = ++rawSequence.current;
    preloadCodeEditor();
    setBusy(true); setError('');
    try {
      const text = await native.readRegisteredNativeFileForEdit(currentTool, scope, projectPath, nextRole);
      if (sequence !== rawSequence.current || !stillCurrent(started)) return;
      setDraft(null); setSelectedId(null); setEditor('native'); setNewSecret(''); setRole(nextRole); setView('native'); savedDraft.current = ''; setGuide(true);
      setRawDisk({ context: JSON.stringify([currentTool, scope, projectPath, null, 'native']), role: nextRole, original: text, text });
      setNotice(''); setError('');
    } catch (value) { if (sequence === rawSequence.current && stillCurrent(started)) setError(errorText(value)); }
    finally { if (sequence === rawSequence.current) setBusy(false); }
  }

  async function updateModel(model: string, longContext = primaryModel.longContext) {
    if (!draft || !connection) return;
    const sequence = ++modelWrite.current;
    const value = {model,name:'',longContext};
    const mapping=uiAdapter.modelMapping;
    const nextConnection={...connection,model:mapping?.encodeModel?.(value) ?? model};
    if (!mapping?.primaryRole) { setDraft({...draft,connection:nextConnection}); return; }
    const started=captureDraft();
    try {
      const text=await mapping.update(draft.files[mapping.fileRole] ?? '',mapping.primaryRole,value);
      if (sequence === modelWrite.current && stillCurrent(started)) setDraft({...draft,connection:nextConnection,files:{...draft.files,[mapping.fileRole]:text}});
    } catch (value) { if (sequence === modelWrite.current && stillCurrent(started)) setError(errorText(value)); }
  }
  async function updateRoleModel(id: string, value: ModelRoleValue, all = false) {
    if (!draft || !uiAdapter.modelMapping) return;
    const sequence = ++modelWrite.current;
    const started = captureDraft();
    try {
      const fileRole=uiAdapter.modelMapping.fileRole;
      const text = all ? await uiAdapter.modelMapping.useModelForAll(draft.files[fileRole] ?? '', primaryModel.model, primaryModel.longContext) : await uiAdapter.modelMapping.update(draft.files[fileRole] ?? '', id, value);
      if (sequence === modelWrite.current && stillCurrent(started)) setDraft({ ...draft, files:{ ...draft.files,[fileRole]:text },connection: !all && id===uiAdapter.modelMapping.primaryRole && connection ? {...connection,model:uiAdapter.modelMapping.encodeModel?.(value) ?? value.model} : draft.connection });
    } catch (value) { if (sequence === modelWrite.current && stillCurrent(started)) setError(errorText(value)); }
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

  async function deleteGiven(item: RegisteredProfile) {
    if (!item.id || !currentTool || busy) return;
    if (!await confirmChange(`删除命名配置“${item.name}”？已经写入的原生文件不会自动删除。`, { title: '删除配置', confirmLabel: '删除配置', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteNativeProfile(item.id, item.version, item.revision ?? '');
      await reload(currentTool, scope, projectPath);
      setNotice('命名配置已删除，原生文件保持原样。');
      setGuide(false);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function deleteCurrent() {
    if (draft?.id) await deleteGiven(draft);
  }

  const authKind = draft?.authentication?.kind;
  const authLabel = authKind === 'api_key' ? (apiKeyWritable ? 'API Key' : apiKeyState === 'scope_denied' ? '当前范围不保存新密钥' : '不保存新密钥') : authKind === 'oauth' ? 'OAuth 账号' : authKind === 'rebind_required' ? '需要重新绑定账号' : '沿用原生认证';
  const profileEditorHint = editor === 'profile' && draft ? `${toolName} · ${draft.name.trim() || '未命名'} · ${authLabel}。${draft.id && workspace?.binding?.profileId === draft.id ? '这份配置正在使用，保存会写入当前文件。' : workspace?.probe.nativeWrites.state === 'supported' ? '只保存不会替换正在使用的文件；要立即切换，请选“保存并启用”。' : '保存不会替换正在使用的文件。'}` : undefined;
  const saveState = dirty ? '未保存' : editor === 'profile' && draft?.id ? (workspace?.binding?.profileId === draft.id ? '正在使用' : '尚未启用') : '';

  if (!visibleTools.length) return <div className={styles.empty}>还没有管理中的 CLI。请先在设置里选择要管理的工具。</div>;

  const hasCurrentNative = !!workspace?.snapshots.some(item => item.fingerprint && !workspace.probe.nativeFiles.find(file => file.role === item.role)?.sensitive);
  const profileStatus = (item: RegisteredProfile) => {
    if (editor === 'profile' && selectedId === item.id && dirty) return '有未保存修改';
    if (workspace?.binding?.profileId === item.id) return workspace.binding.profileVersion === item.version ? '正在使用' : '已保存，尚未应用';
    return '已保存';
  };
  const quotaProfileIds = new Set(quotaState.queries.map(query => query.config.identity.profileId).filter(Boolean));
  const isSubscription = (item: RegisteredProfile) => quotaProfileIds.has(item.id) || item.authentication?.kind === 'oauth';
  function profileRow(item: RegisteredProfile, probe: NonNullable<typeof workspace>['probe']) {
    const status = profileStatus(item);
    const current = status === '正在使用';
    const writable = probe.nativeWrites.state === 'supported';
    const model = item.connection?.model?.trim();
    return <div className={styles.profileRow} role="listitem" data-profile-id={item.id} data-active={current || undefined} key={item.id}>
      <span><button type="button" className={styles.profileName} onClick={() => void selectProfile(item)}>{item.name}</button><span className={styles.profileMeta}><span className={styles.badge} data-tone={status === '正在使用' ? 'ok' : status === '已保存' ? undefined : 'warn'}>{status}</span>{profileFacts(item).map(fact => <span className={styles.profileFact} title={fact.title} key={fact.label}>{fact.label}</span>)}{model ? <span className={styles.profileModel} title={model}>{model}</span> : null}</span></span>
      <span className={styles.profileActions}>{!current && <button type="button" className={styles.primary} disabled={busy || enablingId !== null || !writable} title={writable ? '写入原生文件，下次启动读取这份配置' : probe.nativeWrites.reason || '当前不能写入这个工具的配置'} onClick={() => void applySaved(item)}>{enablingId === item.id ? '启用中' : '启用'}</button>}<button type="button" onClick={() => void selectProfile(item)}>修改</button><RowMenu label={`${item.name} 更多操作`}><button type="button" role="menuitem" onClick={() => void selectProfile(item)}>修改配置</button><button type="button" role="menuitem" disabled={busy} onClick={() => void duplicateGiven(item)}>复制配置</button><button type="button" role="menuitem" disabled={!nativeAvailable} onClick={() => setQuotaAddFor(item.id)}>添加额度查询</button><button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void deleteGiven(item)}>删除配置</button></RowMenu></span>
      <ProfileQuota key={`${item.id}:${item.version}`} profileId={item.id} profileVersion={item.version} toolId={item.tool} profileAccountId={item.authentication?.kind === 'oauth' ? item.authentication.accountId : undefined} state={quotaState} addRequested={quotaAddFor === item.id} onAddHandled={clearQuotaAdd} />
    </div>;
  }
  async function openHistory() {
    if (!currentTool) return;
    const context = draftContext;
    setHistoryOpen(true); setBackupPreview(null); setError('');
    try {
      const rows = await native.listNativeBackups(currentTool, scope, projectPath, role);
      if (latestDraft.current.context !== context) return;
      setBackups(rows);
      if (rows[0]) {
        const result = await native.previewNativeBackup(currentTool, scope, projectPath, role, rows[0].transactionId);
        if (latestDraft.current.context === context) setBackupPreview(result);
      }
    } catch (value) { if (latestDraft.current.context === context) setError(errorText(value)); }
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
    if (!await confirmChange('用这条记录替换当前文件。现在的内容会先留下一份备份。', { title: '恢复这个版本？', confirmLabel: '恢复' })) return;
    if (!stillCurrent(started)) return;
    setBusy(true); setError('');
    try {
      await native.restoreNativeBackup(currentTool, scope, projectPath, role, backupPreview.transactionId, backupPreview.current, editorContextId.current);
      if (stillCurrent(started)) { setHistoryOpen(false); setBackupPreview(null); await openCurrentFile(role, true); setNotice('已恢复此文件。'); }
    } catch (value) { if (stillCurrent(started)) setError(errorText(value)); }
    finally { setBusy(false); }
  }

  function nativeEditor() { return <div className={styles.nativeEditor}>
              {availableRoles.length > 1 && <div className={styles.fileTabs}>{availableRoles.map((name) => <button key={name} type="button" className={role === name ? styles.selected : ''} disabled={busy} onClick={() => { if (editor === 'native') void openCurrentFile(name); else { rawSequence.current++; setRole(name); } }}>{workspace?.probe.nativeFiles.find(file => file.role === name)?.path.split(/[\\/]/).at(-1) ?? name}</button>)}</div>}
              <div className={styles.pathLabel}><strong title={activeFile?.path}>{activeFile?.path.split(/[\\/]/).pop() ?? '原生文件尚未确定'}</strong><span>{activeFile?.format?.toUpperCase() ?? ''}</span>{activeFile && <small className={styles.pathValue} title={displayPath(activeFile.path)}>{displayPath(activeFile.path)}</small>}{activeFile && <button type="button" className={styles.secondary} onClick={() => void copyDisplayedPath(activeFile.path)}>{copiedPath === displayPath(activeFile.path) ? '已复制' : copiedPath === `fail:${displayPath(activeFile.path)}` ? '复制失败' : '复制路径'}</button>}</div>
              <CodeEditor key={draftContext} documentId={role} format={activeFile?.format ?? 'text'} label={`${role} 配置草稿`} value={activeRaw?.text ?? (editor === 'common' ? commonDraft?.files[role] : draft?.files[role]) ?? ''} onChange={(text) => { if (activeRaw) { invalidateDraftRequest(); setRawDisk({ ...activeRaw, text }); } else if (editor === 'common') { invalidateDraftRequest(); if (commonDraft) setCommonDraft({ ...commonDraft, files: { ...commonDraft.files, [role]: text } }); } else if (draft) setDraft({ ...draft, files: { ...draft.files, [role]: text } }); }} placeholder="在这里编辑原生配置。留空表示本配置不覆盖该文件。" />

            </div>; }

  const reasoningValue = draft && uiAdapter.reasoning ? uiAdapter.reasoning.read(draft.files.settings ?? '') ?? '' : '';
  const reasoningControl = draft && uiAdapter.reasoning ? <label>{uiAdapter.reasoning.label}<select aria-label={uiAdapter.reasoning.label} value={reasoningValue} onChange={event => void changeReasoningEffort(event.target.value)}><option value="">跟随原生默认</option>{uiAdapter.reasoning.choices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}{reasoningValue && !uiAdapter.reasoning.choices.some(([id]) => id === reasoningValue) && <option value={reasoningValue}>当前原生值：{reasoningValue}</option>}</select></label> : null;
  const listedModels = draft && connection && projection === 'provider_models' ? providerModelRecords(connection, inspection, projection) : null;
  function editModelField(id: string, path: string[], value: unknown) {
    if (!draft?.connection || !listedModels) return;
    const modelRecords = listedModels.map((record) => record.id === id ? { id, fields: setField(record.fields, path, value) } : record);
    setDraft({ ...draft, connection: { ...draft.connection, modelRecords } });
  }
  const connectionForm = draft && connection ? <>
    <label className={styles.pair}>名称<input name="profile-name" aria-label="配置名称" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
    <div className={styles.sectionLabel}>连接</div>
    {addressConfigurable && <label>API 地址<input aria-label="API 地址" value={connection.baseUrl} onChange={event => setDraft({ ...draft, connection: { ...connection, baseUrl: event.target.value } })} placeholder="https://api.example.com/v1" /></label>}
    {apiKeyWritable && <label>API 密钥<div className={styles.secretField}><input aria-label="API 密钥" type={revealedSecret !== null ? "text" : "password"} autoComplete="off" value={revealedSecret ?? newSecret} onChange={event => { invalidateDraftRequest(); setNewSecret(event.target.value); modelSequence.current++; setModelDirectory(null); setModelLoading(false); }} placeholder={connection.secretRef ? '已保存' : 'sk-…'} /><button type="button" disabled={!newSecret && !connection.secretRef} onClick={() => void showSecret()}>{revealedSecret !== null ? '隐藏' : '显示'}</button></div></label>}
    <div className={styles.sectionLabel}>模型</div>
    {listedModels?.length ? <>
      <label>当前模型<select aria-label="当前模型" value={connection.model} onChange={event => void updateModel(event.target.value)}>{!listedModels.some((record) => record.id === connection.model) && <option value={connection.model}>{connection.model || '选择已有模型'}</option>}{listedModels.map((record) => <option key={record.id} value={record.id}>{record.id}</option>)}</select></label>
      <div className={styles.modelRecords} aria-label="已有模型字段">{listedModels.map((record) => <fieldset key={record.id} className={styles.modelRecord}><legend>{record.id}</legend>{modelFieldControls(record.id, record.fields, editModelField)}</fieldset>)}</div>
    </> : <><div className={styles.modelPicker}><label>模型<ModelCombobox label="模型" value={primaryModel.model} placeholder="选择或输入模型" options={modelOptions} onChange={model => void updateModel(model)} /></label><button type="button" disabled={busy || modelLoading || !connection.baseUrl.trim()} onClick={() => void fetchModels()}>{modelLoading ? '获取中…' : '获取模型'}</button></div>
    {modelDirectory && <p className={styles.hint} role="status">{modelDirectory.status === 'ready' ? '已获取 ' + modelDirectory.models.length + ' 个模型' : modelDirectory.status === 'empty' ? '目录为空，可手动输入模型。' : modelDirectory.status === 'stale' ? '显示旧目录：' + modelDirectory.error : modelDirectory.error}{modelDirectory.fetchedAt ? ' · 更新于 ' + new Date(modelDirectory.fetchedAt * 1000).toLocaleString() : ''}</p>}</>}
    {uiAdapter.incompleteConnectionText && (!connection.baseUrl.trim() || !primaryModel.model.trim()) && <p className={styles.hint}>{uiAdapter.incompleteConnectionText.replace(/^；/, '')}</p>}
    {uiAdapter.modelMapping?.primaryRole && <label className={styles.check}><input type="checkbox" checked={primaryModel.longContext} disabled={!primaryModel.model} onChange={event => updateModel(primaryModel.model,event.target.checked)} />1M 上下文</label>}
    {reasoningControl}
    {!!uiAdapter.modelMapping && <div className={styles.roleMapping}>
      <div className={styles.roleHeading}><strong>其他角色</strong><button type="button" className="text-button" disabled={!primaryModel.model} onClick={() => void updateRoleModel('', { model: '', name: '', longContext: false }, true)}>所有角色使用当前模型</button></div>
      {uiAdapter.modelMapping.roles.filter(item => item.id !== uiAdapter.modelMapping?.primaryRole).map(item => {
        const value = roleModels[item.id] ?? { model: '', name: '', longContext: false };
        return <div key={item.id} className={styles.roleRow}>
          <strong>{item.label}</strong>
          <ModelCombobox label={`${item.label} 请求模型`} value={value.model} placeholder="跟随默认，或直接输入" options={[...new Set([...(value.model ? [value.model] : []), ...modelOptions])]} onChange={model => void updateRoleModel(item.id, { ...value, model })} />
          {item.longContext ? <label className={styles.check}><input type="checkbox" aria-label={`${item.label} 1M 上下文`} checked={value.longContext} disabled={!value.model} onChange={event => void updateRoleModel(item.id, { ...value, longContext: event.target.checked })} />1M</label> : <span className={styles.roleSlot} />}
          {item.displayName && <input className={styles.roleName} aria-label={`${item.label} 显示名称`} placeholder="显示名称，可选" value={value.name} onChange={event => void updateRoleModel(item.id, { ...value, name: event.target.value })} />}
        </div>;
      })}
    </div>}
  </> : null;

  const pathControl = workspace ? <InstallPanel key={currentTool ?? 'cli'} toolName={toolName} probe={workspace.probe} customPath={customPath} busy={busy} loading={loading} onCustomPath={setCustomPath} onSavePath={() => void choosePath()} onMaintain={(action, source) => void maintain(action, source)} onUsePath={(path) => void useInstallation(path)} /> : null;

  const writeUnavailable = workspace && workspace.probe.nativeWrites.state === 'unsupported' ? <div className={`${styles.error} ${styles.writeUnavailable}`} role="alert" aria-label="原生写入不可用">
    <p>{workspace.probe.nativeWrites.reason}</p>
  </div> : null;

  const moreOptions = workspace ? <details className={styles.moreOptions} aria-label="配置更多选项"><summary>更多选项</summary>
    {editor === 'profile' && draft && <label className={styles.check}><input type="checkbox" checked={draft.inheritCommon} onChange={event => setDraft({ ...draft, inheritCommon: event.target.checked })} />继承本工具通用配置</label>}
    {editor === 'profile' && connection && <details className={styles.connectionAdvanced}><summary>高级连接选项</summary>
      {addressConfigurable && !!workspace.probe.providerPresets.length && <div className={styles.modelBar}><span>官方接口预设</span>{workspace.probe.providerPresets.map(item => <button key={item.id} type="button" title={item.sourceUrl} onClick={() => applyPreset(item.id, item.baseUrl, item.interfaceFormat)}>{item.label}</button>)}</div>}
      <div className={styles.formGrid}><label>供应商 ID<input value={connection.providerId} onChange={event => setDraft({ ...draft!, connection: connectionForProvider(connection, event.target.value) })} /></label>{(workspace.probe.interfaceFormats.length > 1 || !workspace.probe.interfaceFormats.includes(connection.interfaceFormat as never)) && <label>接口格式<select value={connection.interfaceFormat} onChange={event => setDraft({ ...draft!, connection: { ...connection, interfaceFormat: event.target.value } })}>{!workspace.probe.interfaceFormats.includes(connection.interfaceFormat as never) && <option value={connection.interfaceFormat}>当前格式 · {formatLabel(connection.interfaceFormat)}</option>}{workspace.probe.interfaceFormats.map(item => <option key={item} value={item}>{formatLabel(item)}</option>)}</select></label>}<label>认证环境变量名<input value={connection.authEnvVar ?? ''} onChange={event => setDraft({ ...draft!, connection: { ...connection, authEnvVar: event.target.value || null } })} placeholder="可选" /></label></div>
      {effectiveEnvName && !connection.secretRef && <p className={styles.hint}>原生配置引用：<code>{effectiveEnvName}</code></p>}
      <div className={styles.diagnosticActions}><button type="button" disabled={checkingConnection || !!newSecret} onClick={() => void checkConnection(false)}>检查连接</button><details><summary>更多诊断</summary><button type="button" disabled={checkingConnection || !!newSecret} onClick={() => void checkConnection(true)}>发送最小请求（可能计费）</button></details></div>
      {newSecret && <p className={styles.hint}>先获取模型或保存配置，再进行连接诊断。</p>}
      {connectionCheck && <details className={styles.diagnosticResult}><summary>连接诊断 · {connectionCheck.connectivity.state === 'failed' ? '未通过' : connectionCheck.connectivity.state === 'passed' ? '已连接' : '部分完成'}</summary><p>{connectionCheck.format.message}</p><p>{connectionCheck.connectivity.message}</p><p>{connectionCheck.modelRequest.message}</p></details>}
      {inspection?.connection && connectionShape(inspection.connection) !== connectionShape(connection) && <button type="button" onClick={adoptInspectedConnection}>使用原生配置中的连接</button>}
    </details>}
    {(editor === 'profile' && draft) && <>
      <div className={styles.moreSection}><strong>原生文本</strong>{nativeEditor()}</div>
      <div className={styles.merged}><button type="button" className={styles.previewButton} onClick={() => setView(view === 'merged' ? 'form' : 'merged')}>{view === 'merged' ? '隐藏合并结果' : '查看合并结果'}</button>{view === 'merged' && <><p>只读结构化预览：通用配置、命名配置和连接设置合并；CLI 仍可能受到环境变量、项目信任和更高优先级原生设置影响。</p><CodeEditor format={activeFile?.format ?? 'json'} label="合并配置预览" readOnly value={preview?.rendered?.[role] ?? ''} placeholder="等待有效配置…" />{preview && <details><summary>查看字段来源</summary><pre>{Object.entries(preview.sources[role] ?? {}).map(([path, source]) => `${path} ← ${source}`).join('\n') || '没有覆盖字段'}</pre></details>}</>}</div>
    </>}
    {editor !== 'common' && <button type="button" className={styles.secondary} onClick={() => void editCommon()}>通用配置</button>}
  </details> : null;

  return <section className={styles.workspace} aria-label="工具与连接">
    <div className={styles.toolbar}>
      <div className={styles.toolSwitcher} role="tablist" aria-label="CLI" onKeyDown={navigateChoices}>{visibleTools.map((item) => <button key={item.id} type="button" role="tab" aria-selected={currentTool === item.id} tabIndex={currentTool === item.id ? 0 : -1} title={item.name} className={currentTool === item.id ? styles.selected : ''} onClick={async () => { if (currentTool === item.id) return; if ((dirty || mcpDirty || skillsDirty || agentsDirty) && !await confirmChange('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; invalidateDraftRequest(); setTool(item.id); }}><ToolIcon toolId={item.id} size={23} />{item.name}</button>)}</div>
    </div>
    <div className={styles.taskBar}>
      <div className={styles.views} role="tablist" aria-label="当前任务" onKeyDown={navigateChoices}>
        <button type="button" role="tab" aria-selected={resourceView === 'config'} tabIndex={resourceView === 'config' ? 0 : -1} className={resourceView === 'config' ? styles.selected : ''} onClick={() => void switchResourceView('config')}>配置</button>
        {supports.accounts && <button type="button" role="tab" aria-selected={resourceView === 'accounts'} tabIndex={resourceView === 'accounts' ? 0 : -1} className={resourceView === 'accounts' ? styles.selected : ''} onClick={() => void switchResourceView('accounts')}>账号</button>}
        {supports.mcp && <button type="button" role="tab" aria-selected={resourceView === 'mcp'} tabIndex={resourceView === 'mcp' ? 0 : -1} className={resourceView === 'mcp' ? styles.selected : ''} onClick={() => void switchResourceView('mcp')}>MCP</button>}
        {supports.skills && <button type="button" role="tab" aria-selected={resourceView === 'skills'} tabIndex={resourceView === 'skills' ? 0 : -1} className={resourceView === 'skills' ? styles.selected : ''} onClick={() => void switchResourceView('skills')}>Skill</button>}
        {supports.agents && <button type="button" role="tab" aria-selected={resourceView === 'agents'} tabIndex={resourceView === 'agents' ? 0 : -1} className={resourceView === 'agents' ? styles.selected : ''} onClick={() => void switchResourceView('agents')}>Agents</button>}
        {supports.plugins && <button type="button" role="tab" aria-selected={resourceView === 'plugins'} tabIndex={resourceView === 'plugins' ? 0 : -1} className={resourceView === 'plugins' ? styles.selected : ''} onClick={() => void switchResourceView('plugins')}>插件</button>}
      </div>
      <div className={styles.scopeBar}><FilterSelect className={styles.projectSelect} label="配置范围" triggerDetail={false} value={scope === 'global' ? '__global__' : projectPath} options={[{ value: '__global__', label: '全局配置' }, ...projects.map((project) => ({ value: project.path ?? project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : '目录不可用', disabled: !project.available || !project.path })), ...(projectPath && !projects.some((project) => project.path === projectPath) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath, detail: shortPath(projectPath) }] : [])]} placeholder="选择项目…" forceSearch searchLabel="搜索项目" title={scope === 'global' ? '全局配置' : projectPath || '选择已有项目'} onChange={(value) => void (value === '__global__' ? switchGlobal() : switchProject(value))} onPickFolder={() => void chooseProjectFolder()} pickFolderLabel="选择文件夹…" /></div>
    </div>
    <div hidden={resourceView !== 'config'}>
    {scope === 'project' && !projectPath.trim() && <p className={styles.hint}>选择已有项目，或选择一个本机文件夹后，再编辑配置。</p>}
    {scope === 'project' && workspace?.probe.nativeFiles.find((item) => !item.sensitive && item.reason)?.reason && <p className={styles.hint}>{workspace.probe.nativeFiles.find((item) => !item.sensitive && item.reason)?.reason}</p>}
    {loading && <p className={styles.hint} role="status">正在读取配置…</p>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    <GuideDialog wide open={!!applyComparison} title="比较当前文件与本次配置" hint="原生文件里已有不同内容。可以保留现有文件，或改用这次保存的配置。" onClose={() => setApplyComparison(null)}>
      {applyComparison && <div className="file-conflict" aria-label="配置应用冲突">{applyComparison.files.map(file=><div className="file-conflict-columns" key={file.role}><div><strong>当前文件</strong><CodeEditor label={`当前 ${file.role} 文件`} readOnly compact format={file.format} value={file.current}/></div><div><strong>本次配置</strong><CodeEditor label={`本次 ${file.role} 配置`} readOnly compact format={file.format} value={file.proposedText ?? ''}/></div></div>)}<div className="file-conflict-actions"><button type="button" onClick={()=>setApplyComparison(null)}>保留当前文件</button><button type="button" disabled={busy} onClick={()=>void resolveApplication()}>使用本次配置</button></div></div>}
    </GuideDialog>
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {(scope !== 'project' || !!projectPath.trim()) && <>
      {pathControl}
      {!!workspace?.recoveryNeeded.length && <div className={styles.error}>有 {workspace.recoveryNeeded.length} 项原生文件事务需要恢复。请检查目标文件和本机凭据库后重试。<button type="button" onClick={() => { void native.recoverNativeTransactions().then(() => { if (currentTool) return reload(currentTool, scope, projectPath, selectedId); }); }}>重试恢复</button></div>}
      {writeUnavailable}
      {workspace && workspace.profiles.length ? <div className={styles.profileList} aria-label="配置列表">
          <div className={styles.listHeading}><strong>配置</strong><span className={styles.listActions}><button type="button" onClick={() => void editCommon()}>通用配置</button><button type="button" className={styles.primary} onClick={() => void createProfile()}>新建配置</button></span></div>
          <div className={styles.profileRow} data-kind="native"><span><button type="button" className={styles.profileName} onClick={() => void openCurrentFile()}>正在使用的文件</button><small>直接改 CLI 正在读取的文件</small></span><button type="button" onClick={() => void openCurrentFile()}>修改</button></div>
          {workspace.profiles.length > 6 && <label className={styles.profileFilter}><input aria-label="搜索配置" placeholder="搜索配置" value={profileQuery} onChange={event => setProfileQuery(event.target.value)} /></label>}
          <div role="list" aria-label="配置项" className={workspace.profiles.length > 6 ? styles.profileScroll : undefined}>{(() => {
            const visible = workspace.profiles.filter(item => item.name.toLowerCase().includes(profileQuery.trim().toLowerCase()));
            const groups = [{ id: 'subscription', label: '订阅套餐', hint: '带额度查询或 OAuth 账号', items: visible.filter(isSubscription) }, { id: 'other', label: '其他配置', hint: 'API Key 与原生认证', items: visible.filter(item => !isSubscription(item)) }].filter(group => group.items.length);
            return groups.map(group => <div key={group.id} role="presentation" className={styles.profileGroup} data-group={group.id}>
              {groups.length > 1 && <div role="presentation" className={styles.groupLabel}><strong>{group.label}</strong><span>{group.items.length}</span><small>{group.hint}</small></div>}
              {group.items.map(item => profileRow(item, workspace.probe))}
            </div>);
          })()}{profileQuery.trim() && !workspace.profiles.some(item => item.name.toLowerCase().includes(profileQuery.trim().toLowerCase())) && <p className={styles.profileEmpty}>没有匹配的配置</p>}</div>
        </div> : <div className={styles.taskEmpty}>
        <p>还没有命名配置。新建一份，或先改通用配置。</p>
        <button type="button" className={styles.primary} disabled={busy || !currentTool} onClick={() => void createProfile()}>新建配置</button>
        <button type="button" className={styles.secondary} disabled={busy || !currentTool} onClick={() => void editCommon()}>通用配置</button>
        <button type="button" className={styles.secondary} disabled={busy || !hasCurrentNative} onPointerEnter={preloadCodeEditor} onFocus={preloadCodeEditor} onClick={() => void openCurrentFile()}>修改正在使用的文件</button>
      </div>}
      <GuideDialog wide open={guide && (editor !== 'profile' || !!draft)} title={historyOpen && editor === 'native' ? '修改记录' : editor === 'native' ? '修改正在使用的文件' : editor === 'common' ? '修改通用配置' : draft?.id ? '修改配置' : '新建配置'} hint={historyOpen && editor === 'native' ? '最多 20 次。选一条查看当时的文件，确认后才会写回。' : profileEditorHint} onClose={() => void closeGuide()}>
        <div className={styles.editor}>
            {historyOpen && editor === 'native' ? <div className={styles.history}>{backups.length ? <ul className={styles.historyList} aria-label="修改记录">{backups.map((item, index) => <li key={item.transactionId}><button type="button" aria-pressed={backupPreview?.transactionId === item.transactionId} disabled={busy} onClick={() => void inspectBackup(item.transactionId)}>{formatBackupTime(item.createdAt, index)}</button></li>)}</ul> : <p className={styles.historyEmpty}>还没有可恢复的修改。</p>}{backups.length > 0 && <div className={styles.historyPreview}><CodeEditor label="当时的文件" readOnly format={activeFile?.format ?? 'text'} value={backupPreview?.original ?? ''} placeholder={backupPreview ? '' : '正在读取…'} /></div>}</div> : <div className={styles.editorScroll}>
            {editor === 'profile' && draft && <div className={styles.form}><div className={styles.sectionLabel}>基本信息</div><label className={styles.pair}>认证方式<select aria-label="认证方式" value={draft.authentication?.kind === 'api_key' && !apiKeyWritable ? 'native' : draft.authentication?.kind ?? 'native'} onChange={event => { const kind = event.target.value; setNewSecret(''); setDraft({ ...draft, authentication: kind === 'oauth' ? { kind, accountId: accountState.accounts.find(account => account.state === 'signed_in')?.id ?? '' } : { kind: kind as 'native' | 'api_key' }, connection: kind === 'oauth' ? null : draft.connection, nativeCredentials: kind === 'oauth' ? {} : draft.nativeCredentials }); }}><option value="native">沿用原生认证（兼容）</option>{apiKeyWritable && <option value="api_key">API Key</option>}{supports.accounts && <option value="oauth">OAuth 账号</option>}{draft.authentication?.kind === 'rebind_required' && <option value="rebind_required">需要重新绑定</option>}</select></label>
              {apiKeyState === 'scope_denied' && connectionPolicy?.apiKey.reason && <p className={styles.hint}>{connectionPolicy.apiKey.reason}</p>}
              {draft.authentication?.kind === 'oauth' ? <><label className={styles.pair}>配置名称<input aria-label="配置名称" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>绑定账号<select aria-label="绑定账号" value={draft.authentication.accountId} onChange={event => setDraft({ ...draft, authentication: { kind: 'oauth', accountId: event.target.value } })}><option value="">请选择已登录账号</option>{accountState.accounts.map(account => <option key={account.id} value={account.id}>{account.label} · {accountStates[account.state]}</option>)}</select></label><p className={styles.hint}>账号在“账号”页管理。保存不会立刻切换；启用后，下次启动和资源页才会使用这个账号。</p><CodeEditor label="OAuth 配置内容" format={activeFile?.format ?? 'json'} value={draft.files.settings ?? ''} onChange={value => setDraft({ ...draft, files: { ...draft.files, settings: value } })} /></> : draft.authentication?.kind === 'rebind_required' ? <p role="alert">跨设备导入的 OAuth 配置需要重新选择此设备上的账号。</p> : connectionForm}</div>}
            {(editor === 'native' || editor === 'common') && nativeEditor()}
            {fileConflict?.context === draftContext && pendingRaw && <FileConflict current={fileConflict.current} edited={pendingRaw.text} format={activeFile?.format ?? 'text'} busy={busy} onKeep={() => { setRawDisk({ ...pendingRaw, original:fileConflict.current, text:fileConflict.current }); setFileConflict(null); setError(''); }} onUse={() => { setRawDisk({ ...pendingRaw, original:fileConflict.current }); setFileConflict(null); setError(''); setNotice('已保留本次修改，点击保存写入。'); }} />}
            {moreOptions}
            </div>}
            {error && <div className={styles.error} role="alert">{error}</div>}
            {notice && <div className={styles.notice} role="status">{notice}</div>}
            <div className={styles.actions}>
              {historyOpen && editor === 'native' ? <>
                <button type="button" disabled={busy} onClick={() => { setHistoryOpen(false); setBackupPreview(null); }}>返回编辑</button>
                <span />
                <button type="button" className={styles.primary} disabled={busy || !backupPreview} onClick={() => void restoreBackup()}>恢复这个版本</button>
              </> : <>
              {editor === 'profile' && draft?.id && <><button type="button" disabled={busy} onClick={() => void duplicateProfile()}>复制</button><button type="button" disabled={busy} onClick={() => void deleteCurrent()}>删除</button></>}
              {currentDescriptor?.login && draft?.authentication?.kind !== 'oauth' && <button type="button" disabled={busy} title={currentDescriptor.login.hint} onClick={() => void login()}>登录</button>}
              {editor === 'native' && <button type="button" disabled={busy} onClick={() => void openHistory()}>修改记录</button>}
              {editor === 'native' && hasCurrentNative && <button type="button" disabled={busy} onClick={() => void importCurrentNative(false, true)}>复制为配置</button>}
              <span data-tone={dirty || saveState === '尚未启用' ? 'warn' : saveState ? 'ok' : undefined}>{saveState}</span>
              {editor === 'profile' && draft && workspace?.probe.nativeWrites.state === 'supported' && workspace.binding?.profileId !== draft.id && <button type="button" title="保存后写入原生文件，下次启动读取这份配置" disabled={busy || !nativeAvailable || enablingId !== null} onClick={() => void save(true, true)}>保存并启用</button>}
              <button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint} disabled={busy || !nativeAvailable || (editor === 'native' && workspace?.probe.nativeWrites.state !== 'supported')} onClick={() => void save(editor === 'profile' && workspace?.probe.nativeWrites.state === 'supported')}>保存</button>
              </>}
            </div>
        </div>
      </GuideDialog>
      {editor === 'profile' && draft?.id && workspace && !dirty && (workspace.binding?.profileId !== draft.id || workspace.binding.profileVersion !== draft.version) && <div className={styles.quickApply}><span>这份配置已保存，但尚未应用到当前范围。</span><button type="button" onClick={() => void applySaved(draft)} disabled={busy || enablingId !== null || workspace.probe.nativeWrites.state !== 'supported'}>启用</button></div>}
    </>}
    </div>
    {supports.accounts && resourceView === 'accounts' && currentTool && <AccountsPanel key={currentTool} toolId={currentTool} state={accountState} />}
    {supports.agents && resourceView === 'agents' && currentTool && <AgentsWorkspace key={JSON.stringify([currentTool, scope, projectPath, resourceEpoch, workspace?.effectiveContextId])} toolId={currentTool} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={setAgentsDirty} />}
    {supports.plugins && resourceView === 'plugins' && currentTool && <PluginsWorkspace key={JSON.stringify([currentTool, scope, projectPath, resourceEpoch, workspace?.effectiveContextId])} toolId={currentTool} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} />}
    {supports.mcp && resourceView === 'mcp' && currentTool && <McpWorkspace key={JSON.stringify([currentTool, scope, projectPath, resourceEpoch, workspace?.effectiveContextId])} toolId={currentTool} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={setMcpDirty} />}
    {supports.skills && resourceView === 'skills' && currentTool && <SkillsWorkspace key={JSON.stringify([currentTool, scope, projectPath, resourceEpoch, workspace?.effectiveContextId])} toolId={currentTool} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={setSkillsDirty} />}
  </section>;
}
