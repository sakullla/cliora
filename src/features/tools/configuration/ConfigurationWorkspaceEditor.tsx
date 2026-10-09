import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uiAdapterFor } from '../../../adapters';
import { native, beginConfigurationDraft, updateConfigurationDraft, editConfigurationDraft, replaceConfigurationText, selectConfigurationCredential, setConfigurationDraftSecret, removeConfigurationDraftSecret, revealConfigurationDraftSecret, cancelConfigurationDraft, cancelConfigurationRequests, addConfigurationModels, listConfigurationModels, checkConfigurationConnection, saveConfigurationDraft, commonInfluence, applyCommonConfiguration, compareConfigurationCurrent, rebaseConfigurationCurrent, previewConfigurationBackup, restoreConfigurationBackup } from '../../../lib/native';
import { createConfigurationSession, configurationCredentialIdentity, rememberConfigurationApiBuffer, type ConfigurationApiBuffer, configurationRequestMatches } from '../../../lib/configurationDraft';
import { confirmAction } from '../../../lib/confirm';
import type { ConfigurationAction, ConfigurationCredential, ConfigurationDraft, ConfigurationSaveResult, ConfigurationSubject, CommonInfluence, CommonApplicationResult, ConfigurationCurrentComparison, ConfigurationBackupPreview } from '../../../types/configuration';
import type { Connection, ConnectionCheck, ModelDirectory, NativePreview, RegisteredProfile, RegisteredToolWorkspace, Scope, ApplyComparison } from '../../../types/native';
import type { AuthAccount, NativeLoginSnapshot } from '../../../types/accounts';
import { CodeEditor } from '../../../components/CodeEditor';
import { ConflictCompare } from '../../../components/configuration/ConflictCompare';
import { applyScopeCopy, applyStatusCopy } from './applyCopy';
import { AccountPicker } from '../AccountPicker';
import type { useAccounts } from '../AccountsPanel';
import { ConnectionCredential, ConnectionCredentialProvider } from '../../../components/configuration/ConnectionCredential';
import { StepHead, configurationStepOrder, type ConfigurationStepKey } from '../../../components/configuration/ConfigurationStep';
import styles from './ConfigurationWorkspaceEditor.module.css';
import sharedStyles from '../../../components/configuration/configuration.module.css';
import { saveShortcutHint } from '../../../lib/shortcut';
import i18n from '../../../i18n';

type Session = ReturnType<typeof createConfigurationSession>;
type Props = {
  toolId: string; subject: ConfigurationSubject; profile: RegisteredProfile | null; scope: Scope; projectPath: string;
  workspace: RegisteredToolWorkspace; accounts: ReturnType<typeof useAccounts>;
  onDirtyChange: (dirty: boolean) => void; onDraftChange: (draft: ConfigurationDraft) => void;
  onStored: (result: ConfigurationSaveResult) => void; onDone: (result: ConfigurationSaveResult, used?: boolean) => void; onClose: () => void;
};
const messageOf = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('tools.workspace.operationFailed');
type ConfigView = 'models' | 'settings' | 'raw' | 'preview';
function configViews(subject: 'profile' | 'current' | 'common', hasEditor: boolean, fieldCount: number, fileCount: number): ConfigView[] {
  const views: ConfigView[] = [];
  if (subject !== 'common') views.push('models');
  if (subject === 'common' ? fieldCount > 0 : hasEditor) views.push('settings');
  if (fileCount > 0) {
    views.push('raw');
    if (subject !== 'common' || fieldCount > 0) views.push('preview');
  }
  return views;
}
function backupStamp(ms: number) {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function ConfigurationWorkspaceEditor(props: Props) {
  const { t } = useTranslation();
  const { toolId, subject, scope, projectPath, workspace } = props;
  const adapter = uiAdapterFor(toolId);
  const Editor = adapter.configuration?.Editor;
  const [draft, setDraft] = useState<ConfigurationDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [valid, setValid] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [legacyInputs, setLegacyInputs] = useState<Connection | null>(props.profile?.connection ?? null);
  const [nameInput, setNameInput] = useState(props.profile?.name ?? '');
  const [view, setView] = useState<'models' | 'settings' | 'raw' | 'preview'>(subject === 'common' ? 'settings' : 'models');
  const [picking, setPicking] = useState(false);
  const [nativeLogins, setNativeLogins] = useState<NativeLoginSnapshot | null>(null);
  const [nativeError, setNativeError] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [secretReplacing, setSecretReplacing] = useState(false);
  const [visibleSecret, setVisibleSecret] = useState<string | null>(null);
  const [secretShown, setSecretShown] = useState(false);
  const nameId = useId();
  const modelPane = useRef<HTMLDivElement>(null);
  const directoryPanel = useRef<HTMLElement>(null);
  const [directory, setDirectory] = useState<ModelDirectory | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState(new Set<string>());
  const [querying, setQuerying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const problems = useRef<HTMLDivElement>(null);
  const [rawResetEpoch, setRawResetEpoch] = useState(0);
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  const [rawRole, setRawRole] = useState(workspace.probe.nativeFiles.find(file => !file.sensitive)?.role ?? 'settings');
  const [influence, setInfluence] = useState<CommonInfluence | null>(null);
  const [applications, setApplications] = useState<CommonApplicationResult[]>([]);
  const [comparison, setComparison] = useState<ApplyComparison | null>(null);
  const [currentConflict, setCurrentConflict] = useState<ConfigurationCurrentComparison | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, 'current' | 'edited'>>({});
  const [history, setHistory] = useState(false);
  const [backups, setBackups] = useState<{ transactionId: string; path: string; createdAt: number }[]>([]);
  const [backup, setBackup] = useState<ConfigurationBackupPreview | null>(null);
  const [saved, setSaved] = useState<ConfigurationSaveResult | null>(null);
  const session = useRef<Session | null>(null);
  const baseline = useRef('');
  const baselineRevision = useRef(0);
  const alive = useRef(false);
  const opening = useRef(0);
  const sequence = useRef(0);
  const requestCancellation = useRef(false);
  const rawSequence = useRef(0);
  const latest = useRef(props); latest.current = props;
  // Model lists survive form edits: the cache is keyed by connection+credential
  // identity, so typing a model name never empties the combobox options.
  const catalogCache = useRef<{ key: string; models: string[] }>({ key: '', models: [] });
  const sourceBuffers = useRef<Partial<Record<ConfigurationCredential['source'], { credential: ConfigurationCredential; connection: Connection | null }>>>({});
  const apiBuffers = useRef(new Map<string, ConfigurationApiBuffer>());
  const apiCredential = useRef<{ identity: string; credential: ConfigurationApiBuffer['credential'] } | null>(null);
  const apiInputIdentity = useRef('');
  const focusReturn = useRef<HTMLElement | null>(null);
  const credentialPanel = useRef<HTMLDivElement>(null);
  const credentialSource = useRef<ConfigurationCredential['source'] | null>(null);

  useEffect(() => {
    alive.current = true;
    const generation = ++opening.current;
    const id = `configuration-${crypto.randomUUID()}`;
    void beginConfigurationDraft({ toolId, scope, projectPath: projectPath || null, sessionId: id, subject, profile: props.profile }).then(value => {
      if (!alive.current || opening.current !== generation) { void cancelConfigurationDraft(id).catch(() => {}); return; }
      if (!value || Editor && !value.descriptor) throw new Error(t('tools.config.noCapability'));
      session.current = createConfigurationSession(value); baseline.current = JSON.stringify(value.profile); baselineRevision.current = value.revision;
      setDraft(value); setLegacyInputs(value.draftConnection ?? value.profile.connection); setNameInput(value.profile.name); setRawInputs(value.profile.files); setValid(session.current.canSubmit); setLoading(false);
      if (value.credential) {
        const connection = value.draftConnection ?? value.profile.connection;
        sourceBuffers.current[value.credential.source] = { credential: value.credential, connection };
        if (value.credential.source === 'api_key') acceptApiCredential(value);
      }
    }).catch(failure => { if (alive.current && opening.current === generation) { setError(messageOf(failure)); setLoading(false); } });
    if (subject === 'common') void commonInfluence(toolId).then(value => { if (alive.current) setInfluence(value); }).catch(failure => { if (alive.current) setError(messageOf(failure)); });
    return () => { alive.current = false; opening.current++; sequence.current++; session.current?.close(); session.current = null; void cancelConfigurationDraft(id).catch(() => {}); latest.current.onDirtyChange(false); };
  }, []);
  useEffect(() => {
    if (subject !== 'profile') return;
    let live = true;
    void native.discoverNativeLogins(toolId).then(value => { if (live) setNativeLogins(value); }).catch(failure => { if (live) setNativeError(messageOf(failure)); });
    return () => { live = false; };
  }, [subject, toolId]);

  const dirty = !!draft && (draft.revision !== baselineRevision.current || JSON.stringify(draft.profile) !== baseline.current) || !!secretInput || !valid || pending;
  useLayoutEffect(() => { props.onDirtyChange(dirty); }, [dirty]);
  // Problems render below the form; bring a new failure into view instead of
  // leaving it hidden beneath long model lists.
  useEffect(() => { if (error) problems.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [error]);
  const updateValidity = () => { setValid(session.current?.canSubmit ?? false); setPending(session.current?.pending ?? false); };
  async function edit(work: (current: ConfigurationDraft) => Promise<ConfigurationDraft>, raw = false) {
    const owner = session.current;
    if (!owner) throw new Error(t('tools.config.draftNotLoaded'));
    if (requestCancellation.current) throw new Error(t('tools.config.cancellingError'));
    sequence.current++; setComparison(null); setCurrentConflict(null); setQuerying(false); setDirectory(null); setCheck(null); setVisibleSecret(null); setError('');
    latest.current.onDirtyChange(true);
    const promise = owner.edit(work); updateValidity();
    try {
      const accepted = await promise;
      if (!alive.current || session.current !== owner || !accepted) return;
      const next = owner.draft; setDraft(next);
      if (!raw) setRawInputs(next.profile.files);
      latest.current.onDraftChange(next);
    } catch (failure) { if (alive.current && session.current === owner) setError(messageOf(failure)); throw failure; }
    finally { if (alive.current && session.current === owner) updateValidity(); }
  }
  const fire = (work: (current: ConfigurationDraft) => Promise<ConfigurationDraft>) => { void edit(work).catch(() => {}); };
  const onAction = (action: ConfigurationAction) => edit(current => editConfigurationDraft(current, action));
  const onValidityChange = (field: string, isValid: boolean) => { if (!isValid) latest.current.onDirtyChange(true); session.current?.setFieldValidity(field, isValid); updateValidity(); };
  function metadata(patch: Partial<RegisteredProfile>) { fire(current => updateConfigurationDraft(current, { ...current.profile, ...patch })); }
  function legacyConnection(field: keyof Connection, value: string) {
    const blank: Connection = { providerId: '', baseUrl: '', model: '', interfaceFormat: workspace.probe.interfaceFormats[0] ?? '', secretRef: null, authEnvVar: null };
    setLegacyInputs(previous => ({ ...(previous ?? blank), [field]: value }));
    fire(current => updateConfigurationDraft(current, { ...current.profile, connection: { ...(current.draftConnection ?? current.profile.connection ?? blank), [field]: value } }));
  }
  const source = draft?.credential?.source ?? null;
  const connection = draft?.draftConnection ?? draft?.profile.connection ?? null;
  const apiSourceCapability = draft?.sourceCapabilities?.find(capability => capability.source === 'api_key');
  const accountSourceCapability = draft?.sourceCapabilities?.find(capability => capability.source === 'account');
  const apiWritable = subject === 'current' ? apiSourceCapability?.available === true && !!(draft?.nativeCredentialTarget || connection)
    : apiSourceCapability?.available ?? (subject === 'profile' && workspace.probe.connectionPolicy?.apiKey.state === 'writable');
  const apiReason = apiSourceCapability?.reason ?? workspace.probe.connectionPolicy?.apiKey.reason;
  const accountSupported = accountSourceCapability?.available ?? (!!props.accounts.capability && (props.accounts.capability.managedLogin || props.accounts.accounts.some(account => account.state === 'signed_in' && account.identity && account.context && !account.pendingLogin)));
  const selectedAccountId = draft?.credential?.source === 'account' ? draft.credential.accountId : '';
  const selectedAccount = props.accounts.accounts.find(account => account.id === selectedAccountId);

  function rememberApi() {
    const confirmed = apiCredential.current;
    if (confirmed) rememberConfigurationApiBuffer(apiBuffers.current, confirmed.identity, confirmed.credential, apiInputIdentity.current, secretInput, secretReplacing);
  }
  function acceptApiCredential(value: ConfigurationDraft, input = '', replacing = false) {
    if (value.credential?.source !== 'api_key') return;
    const identity = configurationCredentialIdentity(value);
    apiCredential.current = { identity, credential: value.credential };
    apiInputIdentity.current = identity;
    apiBuffers.current.set(identity, { credential: value.credential, input, replacing });
    setSecretInput(input); setSecretReplacing(replacing);
  }
  function startSecretInput() {
    const current = session.current?.draft;
    if (!current) return;
    const identity = configurationCredentialIdentity(current);
    if (apiInputIdentity.current !== identity) { rememberApi(); apiInputIdentity.current = identity; }
  }
  async function chooseSource(next: ConfigurationCredential['source']) {
    if (!draft) return;
    if (draft.credential) sourceBuffers.current[draft.credential.source] = { credential: draft.credential, connection };
    if (draft.credential?.source === 'api_key') rememberApi();
    const api = next === 'api_key' ? apiBuffers.current.get(configurationCredentialIdentity(draft)) : undefined;
    const previous = next === 'api_key' ? undefined : sourceBuffers.current[next];
    const credential: ConfigurationCredential = api?.credential ?? previous?.credential ?? (next === 'account' ? { source: next, accountId: '' } : next === 'api_key' ? { source: next, secretRef: null } : { source: next });
    if (credential.source === 'account' && !credential.accountId) { setPicking(true); return; }
    try {
      await edit(current => selectConfigurationCredential(current, credential));
      if (alive.current && next === 'api_key' && session.current?.draft.credential?.source === 'api_key') {
        acceptApiCredential(session.current.draft, api?.input ?? '', api?.replacing ?? false);
      }
    } catch {}
  }
  async function selectAccount(account: AuthAccount) {
    const owner = session.current; const id = owner?.draft.sessionId;
    await edit(current => selectConfigurationCredential(current, { source: 'account', accountId: account.id })).catch(() => {});
    if (alive.current && session.current === owner && owner?.draft.sessionId === id) { setPicking(false); requestAnimationFrame(() => focusReturn.current?.focus()); }
  }
  async function flushSecret() {
    if (source !== 'api_key' || !secretInput) return;
    const value = secretInput; const owner = session.current;
    if (owner && apiInputIdentity.current !== configurationCredentialIdentity(owner.draft)) throw new Error(t('tools.config.staleSecret'));
    rememberApi();
    await edit(current => setConfigurationDraftSecret(current, value));
    // Empty input means keep. The server now owns an isolated temporary ref.
    if (alive.current && session.current === owner && owner) acceptApiCredential(owner.draft);
  }
  async function removeSecret() {
    const owner = session.current;
    rememberApi();
    try {
      await edit(current => removeConfigurationDraftSecret(current));
      if (!alive.current || session.current !== owner || owner?.draft.credential?.source !== 'api_key' || !owner.draft.credential.remove) return;
      acceptApiCredential(owner.draft);
    } catch {}
  }
  async function query(kind: 'directory' | 'check', paid = false) {
    const consent = session.current?.draft;
    if (paid && !await confirmAction(t('tools.config.paidConfirm'), () => alive.current && session.current?.draft.sessionId === consent?.sessionId && session.current?.draft.revision === consent?.revision, { title: t('tools.config.paidTitle'), confirmLabel: t('tools.config.paidAction') })) return;
    setQuerying(true); setError('');
    let token: number | undefined;
    try {
      await flushSecret();
      const owner = session.current; if (!owner || owner.pending) return;
      if (!owner.isFieldValid('connection-form')) throw new Error(t('tools.config.connectionFirst'));
      const started = owner.draft; token = ++sequence.current; setQuerying(true);
      const result = kind === 'directory' ? await listConfigurationModels(started, true, search) : await checkConfigurationConnection(started, paid);
      if (!alive.current || session.current !== owner || token !== sequence.current || !configurationRequestMatches(owner.draft, started, result)) return;
      if ('directory' in result) { setDirectory(result.directory); setDirectoryOpen(true); setChosen(new Set()); catalogCache.current = { key: `${started.credential?.source ?? ''}|${configurationCredentialIdentity(started)}`, models: result.directory.models }; }
      else setCheck(result.check);
    } catch (failure) { if (alive.current && (token === undefined || token === sequence.current)) setError(messageOf(failure)); }
    finally { if (alive.current && (token === undefined || token === sequence.current)) setQuerying(false); }
  }
  async function cancelRequests() {
    const owner = session.current;
    if (!owner || owner.pending || requestCancellation.current) return;
    const started = owner.draft;
    sequence.current++; requestCancellation.current = true;
    setCancelling(true); setError('');
    try {
      const next = await cancelConfigurationRequests(started);
      if (!alive.current || session.current !== owner || owner.draft.revision !== started.revision || owner.draft.requestGeneration !== started.requestGeneration) return;
      if (!owner.acceptSaved(next)) return;
      setDraft(owner.draft); setQuerying(false); updateValidity();
    } catch (failure) {
      if (alive.current && session.current === owner) setError(messageOf(failure));
    } finally { requestCancellation.current = false; if (alive.current && session.current === owner) setCancelling(false); }
  }
  async function addModels() {
    await edit(current => addConfigurationModels(current, [...chosen])).catch(() => {});
    if (alive.current) { setDirectoryOpen(false); setChosen(new Set()); }
  }
  function textChanged(role: string, text: string) {
    const token = ++rawSequence.current;
    setRawInputs(previous => ({ ...previous, [role]: text })); props.onDirtyChange(true);
    void edit(current => replaceConfigurationText(current, { ...current.profile.files, [role]: text }), true).then(() => {
      if (alive.current && token === rawSequence.current && session.current) { setRawInputs(session.current.draft.profile.files); if (!session.current.draft.issues.length) setRawResetEpoch(value => value + 1); }
    }).catch(() => {});
  }
  async function showPreview() {
    const owner = session.current; if (!owner || !owner.canSubmit) return;
    const started = owner.draft; const token = ++sequence.current; setView('preview'); setPreviewLoading(true);
    try { const value = await native.previewRegisteredNativeProfile(started.profile, scope); if (alive.current && owner === session.current && token === sequence.current && owner.draft.revision === started.revision) setPreview(value); }
    catch (failure) { if (alive.current && token === sequence.current) setError(messageOf(failure)); }
    finally { if (alive.current && token === sequence.current) setPreviewLoading(false); }
  }
  async function applyStored(result: ConfigurationSaveResult) {
    if (result.profile) {
      try { await native.applyRegisteredNativeProfile(toolId, result.profile.id, scope, projectPath || undefined, false); }
      catch (failure) { setNotice(t('tools.config.savedNotUsed')); setError(messageOf(failure)); setComparison(await native.compareRegisteredApplication(result.profile.id, scope, projectPath).catch(() => null)); return false; }
    } else if (result.common && influence) {
      const outcomes = await applyCommonConfiguration(result.common, influence.targets); setApplications(outcomes);
      if (outcomes.some(item => item.status === 'failed')) { setNotice(t('tools.config.commonPartial')); return false; }
    }
    return true;
  }
  async function save(use = false) {
    const owner = session.current; if (!owner || !owner.canSubmit || busy) return;
    if (subject === 'profile' && !owner.draft.profile.name.trim()) { setError(t('tools.config.nameRequired')); document.querySelector<HTMLInputElement>(`[aria-label="${t('tools.config.name')}"]`)?.focus(); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await flushSecret(); if (!alive.current || owner !== session.current || !owner.canSubmit) return;
      const result = await saveConfigurationDraft(owner.draft);
      if (!alive.current || owner !== session.current) return;
      if (!owner.acceptSaved(result.draft)) return; acceptApiCredential(owner.draft); setDraft(owner.draft); setRawInputs(owner.draft.profile.files);
      baseline.current = JSON.stringify(owner.draft.profile); baselineRevision.current = owner.draft.revision; setSaved(result); latest.current.onStored(result); updateValidity();
      if (use && !await applyStored(result)) return;
      setNotice(subject === 'current' ? t('tools.config.savedCurrent') : use ? t('tools.config.savedUsed') : t('tools.config.savedKept'));
      latest.current.onDone(result, use);
    } catch (failure) {
      if (!alive.current || owner !== session.current) return;
      setError(messageOf(failure));
      if (subject === 'current') {
        await compareCurrent();
      }
    } finally { if (alive.current) setBusy(false); }
  }
  async function compareCurrent() {
    const owner = session.current; if (!owner || owner.pending) return;
    const started = owner.draft; const token = ++sequence.current;
    try {
      const value = await compareConfigurationCurrent(started);
      if (!alive.current || token !== sequence.current || owner !== session.current || owner.draft.revision !== started.revision) return;
      setCurrentConflict(value); setConflictChoices({}); setView('raw');
    } catch (failure) { if (alive.current && token === sequence.current) setError(messageOf(failure)); }
  }
  async function chooseCurrent(role: string, choice: 'current' | 'edited') {
    const captured = currentConflict; if (!captured) return;
    const choices = { ...conflictChoices, [role]: choice }; setConflictChoices(choices);
    const changed = captured.files.filter(file => file.current !== file.original);
    if (changed.some(file => !choices[file.role])) return;
    await edit(current => rebaseConfigurationCurrent(current, captured.comparisonId, {
      ...current.profile.files,
      ...Object.fromEntries(changed.map(file => [file.role, choices[file.role] === 'current' ? file.current : file.edited])),
    })).then(() => { if (alive.current) { setCurrentConflict(null); setNotice(t('tools.config.rebased')); setRawResetEpoch(value => value + 1); } }).catch(() => {});
  }
  async function showHistory() {
    const owner = session.current; if (!owner) return; const started = owner.draft;
    setHistory(true); setBackup(null); setError('');
    try { const rows = await native.listNativeBackups(toolId, scope, projectPath, rawRole); if (alive.current && owner === session.current && owner.draft.revision === started.revision) setBackups(rows); }
    catch (failure) { if (alive.current) setError(messageOf(failure)); }
  }
  async function selectBackup(id: string) {
    const owner = session.current; if (!owner) return; const started = owner.draft; const token = ++sequence.current;
    try { const value = await previewConfigurationBackup(started, rawRole, id); if (alive.current && token === sequence.current && owner === session.current && owner.draft.revision === started.revision) setBackup(value); }
    catch (failure) { if (alive.current && token === sequence.current) setError(messageOf(failure)); }
  }
  async function restoreBackup() {
    const owner = session.current; const target = backup; if (!owner || !target || owner.pending) return;
    if (dirty && !await confirmAction(t('tools.config.restoreConfirm'), () => alive.current && owner === session.current && owner.draft.revision === target.revision, { title: t('tools.config.restoreTitle'), confirmLabel: t('tools.config.restoreAction') })) return;
    setBusy(true); setError('');
    try {
      const result = await restoreConfigurationBackup(owner.draft, target.role, target.transactionId);
      if (!alive.current || owner !== session.current || !owner.acceptSaved(result.draft)) return;
      setDraft(owner.draft); setRawInputs(owner.draft.profile.files); setRawResetEpoch(value => value + 1); setHistory(false); setBackup(null); latest.current.onDraftChange(owner.draft); updateValidity();
      setNotice(t('tools.config.restored'));
    } catch (failure) { if (alive.current) setError(messageOf(failure)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function applyComparison() {
    if (!comparison) return;
    setBusy(true);
    try { await native.applyComparedApplication(comparison, scope, projectPath); if (alive.current) { setComparison(null); setNotice(t('tools.workspace.appliedShort')); } }
    catch (failure) { if (alive.current) setError(messageOf(failure)); }
    finally { if (alive.current) setBusy(false); }
  }

  const fieldCount = draft?.descriptor?.fields.length ?? 0;
  const fileCount = draft ? new Set([...workspace.probe.nativeFiles.filter(file => !file.sensitive).map(file => file.role), ...Object.keys(draft.profile.files)]).size : 0;
  const views = configViews(subject, Boolean(Editor), fieldCount, fileCount);
  const activeView = views.includes(view) ? view : views[0] ?? view;
  useEffect(() => {
    const previous = credentialSource.current;
    credentialSource.current = source;
    if (!previous || previous === source || source !== 'api_key' || activeView !== 'models') return;
    credentialPanel.current?.scrollIntoView({ block: 'nearest' });
  }, [source, activeView]);
  // A fetched multi-model directory opens below the model list; bring it into view.
  useEffect(() => { if (directoryOpen) requestAnimationFrame(() => directoryPanel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })); }, [directoryOpen, directory]);
  useEffect(() => { if (!secretInput) setSecretShown(false); }, [secretInput]);
  const viewKey = views.join();
  useEffect(() => {
    const next = viewKey ? viewKey.split(',') as ConfigView[] : [];
    if (next.length && !next.includes(view)) setView(next[0]);
  }, [viewKey, view]);
  if (loading) return <div className={`${styles.shell} config-editor ${sharedStyles.controls}`}><div className={styles.loading} role="status" aria-label={t('tools.config.loading')}><span className="skeleton-block short" /><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block tall" /></div><footer className={styles.footer}><button onClick={props.onClose}>{t('common.dialog.cancel')}</button><span>{t('tools.config.loading')}</span></footer></div>;
  if (!draft || Editor && !draft.descriptor) return <div className={`${styles.shell} config-editor ${sharedStyles.controls}`}><div className={styles.loadFailed}><strong>{t('tools.config.loadFailed')}</strong><p role="alert">{error || t('tools.config.editorUnavailable')}</p><p className={styles.hint}>{t('tools.config.loadFailedHint')}</p></div><footer className={styles.footer}><button onClick={props.onClose}>{t('tools.config.backToList')}</button></footer></div>;
  const canSubmit = valid && !pending && !busy && !picking && !querying && !cancelling;
  const format = workspace.probe.nativeFiles.find(file => file.role === rawRole)?.format ?? 'json';
  const files = [...new Set([...workspace.probe.nativeFiles.filter(file => !file.sensitive).map(file => file.role), ...Object.keys(draft.profile.files)])];
  const changedConflictFiles = currentConflict ? currentConflict.files.filter(file => file.current !== file.original) : [];
  const sourceLabel = source === 'native' ? t('tools.config.sourceNative') : source === 'account' ? t('tools.config.sourceAccount') : source === 'api_key' ? t('tools.config.sourceApiKey') : t('tools.config.sourceNone');
  const describeInvalid = (key: string): string => {
    const labelFor = (id: string) => draft.descriptor?.fields.find(field => field.id === id)?.label ?? id;
    if (key === 'connection-form') return t('tools.config.invalidConnection');
    if (key.endsWith('-actions')) return t('tools.config.invalidModelActions');
    if (key.includes(':new-model:')) return t('tools.config.invalidNewModel');
    if (key.startsWith('common:')) return t('tools.config.invalidCommon', { label: labelFor(key.slice('common:'.length)) });
    const rest = key.startsWith(`${draft.sessionId}:`) ? key.slice(draft.sessionId.length + 1) : key;
    if (rest.startsWith('{')) {
      const sep = rest.indexOf('}:');
      if (sep > 0) try {
        const target = JSON.parse(rest.slice(0, sep + 1)) as { kind?: string; id?: string };
        return t('tools.config.invalidTarget', { target: target.kind === 'settings' ? t('tools.config.invalidSettings') : target.id ? t('tools.config.invalidModel', { id: target.id }) : t('tools.config.invalidModelFallback'), label: labelFor(rest.slice(sep + 2)) });
      } catch { /* fall through to the raw key */ }
    }
    return labelFor(rest);
  };
  const invalidList = valid ? [] : [...new Set((session.current?.invalidFields ?? []).map(describeInvalid))];
  const problemCount = draft.issues.length || invalidList.length;
  const status: { text: string; tone?: 'error' | 'warn' | 'ok'; jump?: boolean } = error ? { text: error, tone: 'error' }
    : picking ? { text: t('tools.config.statusPicking') }
    : pending ? { text: t('tools.config.statusSyncing') }
    : !valid || draft.issues.length ? { text: problemCount ? t('tools.config.statusPending', { count: problemCount }) : t('tools.config.statusInvalid'), tone: 'warn', jump: true }
    : dirty ? { text: t('tools.config.statusDirty'), tone: 'warn' }
    : { text: saved ? t('tools.config.statusSaved') : t('tools.config.statusClean'), tone: 'ok' };
  const catalogKey = `${draft.credential?.source ?? ''}|${configurationCredentialIdentity(draft)}`;
  const catalog = { models: catalogCache.current.key === catalogKey ? catalogCache.current.models : [], supported: !!draft.catalogSupport?.available, busy: querying, fetch: () => { void query('directory'); } };
  const picker = subject === 'profile' || subject === 'current' && apiWritable;
  const storedSecret = draft.credential?.source === 'api_key' && !!draft.credential.secretRef;
  const accountReady = selectedAccount?.state === 'signed_in' && !!selectedAccount.identity && !!selectedAccount.context && !selectedAccount.pendingLogin;
  const sourceChoice = (value: ConfigurationCredential['source'], aria: string, title: string, detail: string) => <button type="button" role="radio" aria-checked={source === value} disabled={busy || pending || cancelling} onClick={event => { focusReturn.current = event.currentTarget; void chooseSource(value); }}><span className="sr-only">{aria}</span><span className={styles.sourceMark} aria-hidden="true" /><span className={styles.sourceCopy} aria-hidden="true"><strong>{title}</strong><small>{detail}</small></span></button>;
  const stepLabels: Record<ConfigurationStepKey, string> = { connection: t('tools.config.chainConnection'), login: t('tools.config.chainLogin'), model: t('tools.config.chainModel') };
  // CLIs without a managed provider connection (devin/cline/zcode/…) drop the connection step entirely.
  const connectionConfigurable = !!Editor || workspace.probe.connectionPolicy?.providerAddress.state !== 'unsupported';
  const stepDone: Record<ConfigurationStepKey, boolean> = {
    connection: !!(connection?.providerId?.trim() || connection?.baseUrl?.trim()),
    login: source === 'native' || source === 'account' && accountReady || source === 'api_key' && (storedSecret || !!secretInput),
    model: !!connection?.model?.trim(),
  };
  const steps = configurationStepOrder.filter(key => key !== 'connection' || connectionConfigurable).map(key => ({ key, label: stepLabels[key], done: stepDone[key] }));
  // Jump to a numbered step and hand keyboard focus to its first control.
  const jumpTo = (key: ConfigurationStepKey) => {
    const target = modelPane.current?.querySelector<HTMLElement>(`[data-config-step="${key}"]`);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    const focusable = ['input:not([disabled]):not([type="hidden"]), select:not([disabled])', '[role="radio"][aria-checked="true"]:not([disabled])', 'button:not([disabled])'];
    for (const selector of focusable) { const control = target.querySelector<HTMLElement>(selector); if (control) { control.focus({ preventScroll: true }); break; } }
  };
  const visibleDirectory = directory ? directory.models.filter(id => id.toLowerCase().includes(search.toLowerCase())) : [];
  const loginSection = (
        <section data-config-step="login" className={`${styles.sources} ${sharedStyles.step}`} aria-label={t('tools.config.sourcesLabel')}>
          <StepHead step="login" title={picker ? t('tools.config.sourcePickerTitle') : t('tools.config.currentFileSource', { source: sourceLabel })} meta={picker ? t('tools.config.sourcePickerNote') : undefined} />
          {picker && <div className={styles.sourcePicker} role="radiogroup" aria-label={t('tools.config.sourcesLabel')}>
            <div className={styles.sourceChoices}>
            {sourceChoice('native', t('tools.config.useNative'), t('tools.config.useNativeTitle'), t('tools.config.useNativeDetail'))}
            {subject === 'profile' && accountSupported ? sourceChoice('account', t('tools.config.useAccount'), t('tools.config.useAccountTitle'), t('tools.config.useAccountDetail')) : source === 'account' && <button type="button" role="radio" aria-checked disabled>{t('tools.config.accountBoundPending')}</button>}
            {apiWritable ? sourceChoice('api_key', t('tools.config.useApiKey'), t('tools.config.useApiKeyTitle'), t('tools.config.useApiKeyDetail')) : source === 'api_key' && <button type="button" role="radio" aria-checked disabled>{t('tools.config.apiKeyStoredReadonly')}</button>}
            </div>
          </div>}
          {source === 'native' && <div className={styles.sourceBody}><p className={styles.hint}>{adapter.accounts?.nativeDescription ?? t('tools.config.nativeHint')}</p>{nativeLogins?.logins.map((login, index) => { const ok = login.state === 'signed_in'; return <p className={styles.identity} data-tone={ok ? 'ok' : 'warn'} key={index}><span className={styles.identityName}>{login.identity?.email ?? login.identity?.subject ?? (login.authKind === 'api_key' ? t('tools.config.cliKeyIdentity') : t('tools.config.noIdentity'))}</span><span className={styles.identityState}>{' · '}{ok ? login.authKind === 'api_key' ? t('tools.config.configuredUnverified') : login.identity ? t('tools.config.cliSignedIn') : t('tools.config.identityPending') : login.state}</span></p>; })}{nativeLogins && !nativeLogins.logins.length && <p className={styles.identity} data-tone="warn"><span className={styles.identityName}>{t('tools.config.noNativeLogin')}</span></p>}{nativeError && <p role="alert">{nativeError}</p>}</div>}
          {subject === 'profile' && source === 'account' && <div className={`${styles.sourceBody} ${styles.accountBody}`}><p className={styles.identity} data-tone={accountReady ? 'ok' : 'warn'}><span className={styles.identityName}>{selectedAccount?.identity?.email ?? selectedAccount?.identity?.subject ?? t('tools.config.noAccountSelected')}</span><span className={styles.identityState}>{' · '}{accountReady ? t('tools.config.verified') : t('tools.config.pendingVerify')}</span></p><button className={sharedStyles.accent} disabled={busy || pending || cancelling} onClick={event => { focusReturn.current = event.currentTarget; setPicking(true); }}>{t('tools.config.pickAccount')}</button></div>}
          {source === 'api_key' && <div ref={credentialPanel} className={styles.sourceBody}>{!apiWritable && <p role="alert">{apiReason ?? t('tools.config.noNewSecret')}</p>}{apiWritable && <div className={styles.secret}>{!secretReplacing && storedSecret ? <><details className={styles.secretStored} data-status={draft.credentialStatus}><summary>{draft.credentialStatus === 'draft' ? t('tools.config.secretDraft') : draft.credentialStatus === 'stored' ? t('tools.config.secretStored') : t('tools.config.secretUnknown')}</summary><div className={styles.buttons}><button onClick={() => { startSecretInput(); setSecretReplacing(true); }}>{t('tools.config.replaceSecret')}</button><button onClick={() => { const ref = draft.credential?.source === 'api_key' ? draft.credential.secretRef : null; if (visibleSecret !== null) { setVisibleSecret(null); return; } const token = ++sequence.current; if (ref) void revealConfigurationDraftSecret(session.current!.draft).then(value => { if (alive.current && token === sequence.current) setVisibleSecret(value); }).catch(failure => setError(messageOf(failure))); }}>{visibleSecret !== null ? t('tools.config.hideSecret') : t('tools.config.showSecret')}</button><button className={sharedStyles.danger} disabled={pending} onClick={() => void removeSecret()}>{t('tools.config.removeSecret')}</button>{visibleSecret !== null && <input aria-label={t('tools.config.savedSecretAria')} type="text" readOnly value={visibleSecret} />}</div></details></> : <label>{t('tools.config.apiKeyLabel')}<span className={styles.secretField}><input aria-label={t('tools.config.apiKeyLabel')} type={secretShown ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={secretInput} disabled={busy || cancelling} placeholder={storedSecret ? t('tools.config.secretPlaceholder') : t('tools.config.secretPlaceholderNew')} onChange={event => { sequence.current++; setDirectory(null); setCheck(null); startSecretInput(); setSecretInput(event.target.value); latest.current.onDirtyChange(true); }} /><button type="button" className={styles.secretToggle} aria-pressed={secretShown} disabled={!secretInput} onClick={() => setSecretShown(value => !value)}>{secretShown ? t('tools.config.hideInput') : t('tools.config.showInput')}</button></span></label>}{subject === 'current' && draft.credential?.source === 'api_key' && !draft.credential.secretRef && <button className={sharedStyles.danger} disabled={busy || pending || cancelling} onClick={() => void removeSecret()}>{t('tools.config.removeCurrentSecret')}</button>}</div>}<p className={styles.hint}>{t('tools.config.usedFor', { target: draft.nativeCredentialTarget?.label ?? (connection?.baseUrl || t('tools.config.currentConnection')), note: subject === 'current' ? t('tools.config.currentNote') : t('tools.config.profileNote') })}</p></div>}
          {!accountSupported && accountSourceCapability?.reason && <p className={styles.hint}>{accountSourceCapability.reason}</p>}
          {!apiWritable && apiReason && <p className={styles.hint}>{apiReason}</p>}
        </section>
  );
  return <div className={`${styles.shell} config-editor`}>
    <div className={`${styles.scroll} ${sharedStyles.controls}`}>
      {picking && <AccountPicker toolId={toolId} selectedAccountId={selectedAccountId} onSelect={account => void selectAccount(account)} onBack={() => { setPicking(false); requestAnimationFrame(() => focusReturn.current?.focus()); }} />}
      {history && <section aria-label={t('tools.config.historyLabel')}><button onClick={() => { setHistory(false); setBackup(null); }}>{t('tools.config.backToEdit')}</button><div className={styles.buttons}>{backups.map(row => <button key={row.transactionId} onClick={() => void selectBackup(row.transactionId)}>{row.createdAt ? backupStamp(row.createdAt) : row.transactionId}</button>)}</div>{!backups.length && <p>{t('tools.config.noBackups')}</p>}{backup && <><CodeEditor label={t('tools.config.historyOriginal')} format={workspace.probe.nativeFiles.find(file => file.role === backup.role)?.format ?? 'json'} readOnly value={backup.original} /><details><summary>{t('tools.config.historyCurrentSummary')}</summary><CodeEditor label={t('tools.config.historyCurrentLabel')} format={workspace.probe.nativeFiles.find(file => file.role === backup.role)?.format ?? 'json'} readOnly value={backup.current} /></details><button disabled={busy || cancelling} onClick={() => void restoreBackup()}>{t('tools.config.restoreThis')}</button></>}</section>}
      <div hidden={picking || history}>
        {subject === 'profile' && <div className={styles.name} data-empty={!nameInput.trim() || undefined}><label htmlFor={nameId}>{t('tools.config.name')}<span className={styles.required} aria-hidden="true">*</span></label><input id={nameId} aria-label={t('tools.config.name')} aria-required="true" aria-invalid={!nameInput.trim() || undefined} placeholder={t('tools.config.namePlaceholder')} value={nameInput} disabled={busy || cancelling} onChange={event => { setNameInput(event.target.value); metadata({ name: event.target.value }); }} /></div>}
        {views.length > 1 && <nav className={styles.tabs} aria-label={t('tools.config.tabsLabel')}>{views.includes('models') && <button aria-pressed={activeView === 'models'} disabled={pending} onClick={() => setView('models')}>{t('tools.config.tabModels')}</button>}{views.includes('settings') && <button aria-pressed={activeView === 'settings'} disabled={pending} onClick={() => setView('settings')}>{t('tools.config.tabSettings')}</button>}{views.includes('raw') && <button aria-pressed={activeView === 'raw'} disabled={pending} onClick={() => setView('raw')}>{t('tools.config.tabRaw')}</button>}{views.includes('preview') && <button aria-pressed={activeView === 'preview'} title={!valid ? t('tools.config.previewDisabledTitle') : undefined} disabled={!valid || pending || cancelling} onClick={() => void showPreview()}>{t('tools.config.tabPreview')}</button>}</nav>}
        <ConnectionCredentialProvider value={activeView === 'models' && subject !== 'common' ? loginSection : null}><div ref={modelPane} className={styles.modelPane} data-under-tabs={views.length > 1 || undefined} hidden={activeView === 'raw' || activeView === 'preview'}>
          {activeView === 'models' && subject !== 'common' && (Editor || subject === 'profile' && source !== 'account') && <ol className={styles.chain} aria-label={t('tools.config.chainLabel')}>{steps.map(step => <li key={step.key} data-done={step.done || undefined}><button type="button" aria-label={step.done ? t('tools.config.stepDoneAria', { step: step.label }) : step.label} title={t('tools.config.stepJump', { step: step.label })} onClick={() => jumpTo(step.key)}>{step.label}</button></li>)}</ol>}
          {Editor ? <Editor draft={draft} descriptor={draft.descriptor!} mode={subject} section={activeView === 'settings' ? 'settings' : 'models'} disabled={busy || cancelling} pending={pending} rawResetEpoch={rawResetEpoch} catalog={catalog} onAction={onAction} onValidityChange={onValidityChange} />
          : subject === 'profile' && source !== 'account' ? <section aria-label={t('tools.config.legacyLabel')} className={styles.legacy}>
            {connectionConfigurable && <div data-config-step="connection" className={sharedStyles.step}>
              <StepHead step="connection" title={t('tools.config.legacyConnection', { provider: legacyInputs?.providerId || t('tools.config.providerMissing') })} meta={t('tools.config.legacyNote')} />
              <div className={sharedStyles.fieldGrid}>
                <label>{t('tools.config.providerId')}<input aria-label={t('tools.config.providerId')} value={legacyInputs?.providerId ?? ''} spellCheck={false} placeholder={t('common.provider.idPlaceholder')} disabled={busy || cancelling} onChange={event => legacyConnection('providerId', event.target.value)} /></label>
                <label>{t('tools.config.interfaceProtocol')}<select aria-label={t('tools.config.interfaceProtocol')} disabled={busy || cancelling} value={legacyInputs?.interfaceFormat ?? ''} onChange={event => legacyConnection('interfaceFormat', event.target.value)}>{workspace.probe.interfaceFormats.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className={sharedStyles.span}>{t('tools.config.apiUrl')}<input aria-label={t('tools.config.apiUrl')} value={legacyInputs?.baseUrl ?? ''} spellCheck={false} inputMode="url" placeholder="https://api.example.com/v1" disabled={busy || cancelling} onChange={event => legacyConnection('baseUrl', event.target.value)} /></label>
              </div>
            </div>}
            <ConnectionCredential />
            <div data-config-step="model" className={sharedStyles.step}>
              <StepHead step="model" title={t('tools.config.modelStepTitle')} meta={t('tools.config.modelStepHint')} actions={catalog.supported ? <button type="button" className={sharedStyles.catalogButton} disabled={querying || pending} onClick={catalog.fetch}>{querying ? t('common.models.fetching') : t('tools.config.catalogSuggest')}</button> : undefined} />
              <label>{t('tools.config.model')}<input aria-label={t('tools.config.model')} value={legacyInputs?.model ?? ''} spellCheck={false} list={catalog.models.length ? `${nameId}-models` : undefined} placeholder={t('common.field.pickOrType')} disabled={busy || cancelling} onChange={event => legacyConnection('model', event.target.value)} /></label>
              {catalog.models.length > 0 && <datalist id={`${nameId}-models`}>{catalog.models.map(model => <option key={model} value={model} />)}</datalist>}
              {connectionConfigurable && <details className={styles.inlineDisclosure}><summary>{t('tools.config.advancedConnection')}</summary><label>{t('tools.config.authEnvVar')}<input aria-label={t('tools.config.authEnvVar')} spellCheck={false} disabled={busy || cancelling} value={legacyInputs?.authEnvVar ?? ''} onChange={event => legacyConnection('authEnvVar', event.target.value)} /></label></details>}
            </div>
          </section> : <><p className={styles.hint}>{t('tools.config.rawOnlyNote')}</p><ConnectionCredential /></>}
        </div></ConnectionCredentialProvider>
        {directoryOpen && directory && draft.catalogSupport?.multiple === true && <section ref={directoryPanel} aria-label={t('tools.config.directoryLabel')} className={styles.directory}>
          <div className={styles.directoryHead}><strong>{t('tools.config.directoryTitle', { source: directory.source || t('tools.config.sourceFallback'), time: directory.fetchedAt ? new Date(directory.fetchedAt * 1000).toLocaleString() : t('tools.config.timeMissing') })}</strong><span className="count-chip">{directory.models.length}</span></div>
          <p className={styles.hint}>{t('tools.config.directoryNote')}</p>
          {directory.error && <p role="alert">{directory.error}</p>}
          <label>{t('tools.config.searchDirectory')}<input aria-label={t('tools.config.searchDirectoryAria')} type="search" spellCheck={false} value={search} onChange={event => setSearch(event.target.value)} /></label>
          {directory.models.length > 0 && <ul>{visibleDirectory.map(id => <li key={id}><label><input type="checkbox" name="catalog-model" checked={chosen.has(id)} onChange={event => setChosen(previous => { const next = new Set(previous); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />{id}</label></li>)}{!visibleDirectory.length && <li className={styles.directoryMiss}>{t('tools.config.directoryNoMatch')}</li>}</ul>}
          {!directory.models.length && <p className={styles.hint}>{t('tools.config.directoryEmpty')}</p>}
          <div className={styles.directoryFoot}><span>{t('tools.config.directoryChosen', { count: chosen.size })}</span><div className={styles.buttons}><button onClick={() => setDirectoryOpen(false)}>{t('tools.config.backToModels')}</button><button className={sharedStyles.accent} disabled={pending || busy || !chosen.size} onClick={() => void addModels()}>{t('tools.config.addSelected')}</button></div></div>
        </section>}
        {!Editor && source === 'api_key' && connection && activeView === 'models' && <p className={`${styles.hint} ${styles.connectionSummary}`}>{t('tools.config.connectionSummary', { url: connection.baseUrl || t('tools.config.urlMissing'), format: connection.interfaceFormat })}</p>}
        {activeView === 'raw' && <>{files.length > 1 && <div className={styles.fileTabs} role="group" aria-label={t('tools.config.rawFilesLabel')}>{files.map(role => <button key={role} aria-pressed={rawRole === role} onClick={() => setRawRole(role)}>{role}</button>)}</div>}<p className={styles.hint}>{files.length === 1 && <code>{files[0]}</code>} {t('tools.config.rawHint')}</p><CodeEditor documentId={rawRole} label={t('tools.config.rawEditorLabel', { role: rawRole })} format={format} value={rawInputs[rawRole] ?? ''} onChange={text => textChanged(rawRole, text)} readOnly={busy || cancelling} />{currentConflict && changedConflictFiles.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? t('home.conflict.banner') : undefined} status={conflictChoices[file.role] ? (conflictChoices[file.role] === 'current' ? t('tools.config.choseCurrent') : t('tools.config.choseNext')) : undefined} currentContent={file.current} nextContent={file.edited} format={workspace.probe.nativeFiles.find(meta => meta.role === file.role)?.format ?? 'json'} busy={busy || pending} onKeepCurrent={() => void chooseCurrent(file.role, 'current')} onUseNext={() => void chooseCurrent(file.role, 'edited')} />)}</>}
        {activeView === 'preview' && <>{files.length > 1 && <div className={styles.fileTabs} role="group" aria-label={t('tools.config.previewFilesLabel')}>{files.map(role => <button key={role} aria-pressed={rawRole === role} onClick={() => setRawRole(role)}>{role}</button>)}</div>}<p className={styles.hint}>{t('tools.config.previewHint')}{previewLoading ? t('tools.config.previewLoading') : ''}</p>{preview && !previewLoading && preview.rendered?.[rawRole] === undefined && <p className={styles.hint}>{t('tools.config.previewEmpty', { role: rawRole })}</p>}<CodeEditor label={t('tools.config.previewEditorLabel')} format={format} readOnly value={preview?.rendered?.[rawRole] ?? ''} /><details><summary>{t('tools.config.sourcesSummary')}</summary><p>{t('tools.config.sourcesNote')}</p><dl>{Object.entries(preview?.sources?.[rawRole] ?? {}).map(([path, origin]) => <div key={path}><dt><code>{path}</code></dt><dd>{origin === '命名配置' ? t('tools.config.originNamed') : origin === '通用配置' ? t('tools.config.originCommon') : origin}</dd></div>)}</dl>{!Object.keys(preview?.sources?.[rawRole] ?? {}).length && <p>{t('tools.config.noSources')}</p>}</details></>}
        {activeView === 'models' && subject !== 'common' && directory && draft.catalogSupport?.multiple !== true && <p role="status" className={styles.hint}>{t('tools.config.directoryFetched', { count: directory.models.length, synced: Editor ? t('tools.config.dirSynced') : t('tools.config.dirAvailable') })}</p>}
        {activeView === 'models' && subject !== 'common' && <details className={styles.diagnostics}><summary>{Editor && draft.catalogSupport?.multiple !== true ? t('tools.config.diagConnection') : t('tools.config.diagCatalog')}</summary><div className={styles.buttons}>{!(Editor && draft.catalogSupport?.multiple !== true) && <button className={sharedStyles.accent} disabled={querying || pending || !draft.catalogSupport?.available} onClick={() => void query('directory')}>{t('common.field.fetchCatalog')}</button>}<button disabled={querying || pending || !connection} onClick={() => void query('check')}>{t('tools.config.checkConnection')}</button><button disabled={!querying || pending || cancelling} onClick={() => void cancelRequests()}>{cancelling ? t('tools.config.cancellingRequests') : t('tools.config.cancelRequests')}</button></div>{draft.catalogSupport?.reason && <p className={styles.hint}>{draft.catalogSupport.reason}{t('tools.config.catalogReasonSuffix')}</p>}<details><summary>{t('tools.config.moreDiagnostics')}</summary><button disabled={querying || pending || !connection} onClick={() => void query('check', true)}>{t('tools.config.sendMinimal')}</button></details>{check && <div role="status"><p className={styles.hint}>{check.format.message}</p><p className={styles.hint}>{check.connectivity.message}</p><p className={styles.hint}>{check.modelRequest.message}</p></div>}</details>}
        {subject === 'profile' && <details className={sharedStyles.disclosureCard}><summary>{t('tools.config.inheritSummary')}</summary><label><input type="checkbox" disabled={busy || pending || cancelling} checked={draft.profile.inheritCommon} onChange={event => metadata({ inheritCommon: event.target.checked })} />{t('tools.config.inheritCommon')}</label></details>}
        {subject === 'common' && <section aria-label={t('tools.config.influenceLabel')} className={styles.influence}><div className={styles.influenceHead}><strong>{t('tools.config.influenceTitle')}{influence && <span className="count-chip">{influence.targets.length}</span>}</strong><button disabled={busy || cancelling} onClick={() => { void commonInfluence(toolId).then(value => { if (alive.current) setInfluence(value); }).catch(failure => setError(messageOf(failure))); }}>{t('tools.config.influenceRefresh')}</button></div>{influence?.targets.length ? <ul>{influence.targets.map(target => <li key={target.scopeKey}>{t('tools.config.influenceEntry', { profile: target.profileName, scope: target.scope === 'global' ? t('tools.apply.global') : target.projectPath, version: target.appliedVersion })}</li>)}</ul> : <p>{t('tools.config.influenceEmpty')}</p>}{applications.map(item => <p key={item.scopeKey} role={item.status === 'failed' ? 'alert' : 'status'}>{applyScopeCopy(item.scopeKey, influence?.targets ?? [])} · {applyStatusCopy(item.status, item.detail)}{item.status === 'failed' && saved?.common && <button onClick={() => { const target = influence?.targets.find(target => target.scopeKey === item.scopeKey); if (target) void applyCommonConfiguration(saved.common!, [target]).then(next => setApplications(previous => previous.map(old => old.scopeKey === item.scopeKey ? next[0] : old))).catch(failure => setError(messageOf(failure))); }}>{t('tools.config.retryScope')}</button>}</p>)}</section>}
        {subject === 'current' && <details className={sharedStyles.disclosureCard}><summary>{t('tools.config.restoreSummary')}</summary><button disabled={pending || busy} onClick={() => void compareCurrent()}>{t('tools.config.recompare')}</button><button disabled={pending || busy} onClick={() => void showHistory()}>{t('tools.config.historyButton')}</button></details>}
        {comparison && <section aria-label={t('tools.config.conflictLabel')}>{comparison.files.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? t('tools.config.conflictBanner') : undefined} actions={false} currentContent={file.current} nextContent={file.proposedText} format={file.format} busy={busy || cancelling} onUseNext={() => void applyComparison()} onKeepCurrent={() => setComparison(null)} />)}<div className={styles.buttons}><button disabled={busy || cancelling} onClick={() => void applyComparison()}>{t('common.conflict.useNext')}</button><button onClick={() => setComparison(null)}>{t('common.conflict.keepCurrent')}</button></div></section>}
      </div>
      <div ref={problems} className={styles.problems}>
      {draft.issues.length > 0 && <div role="alert" className={styles.errors}>{draft.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
      {!valid && !pending && !draft.issues.length && <p role="alert" className={styles.warning}>{t('tools.config.invalidWarning', { fields: invalidList.length ? t('tools.config.invalidFields', { fields: invalidList.join('；') }) : '' })}</p>}
      {error && <p role="alert" className={styles.errors}>{error}</p>}{notice && <p role="status" className={styles.success}>{notice}</p>}
      </div>
    </div>
    <footer className={`${styles.footer} ${sharedStyles.controls}`}><button onClick={props.onClose}>{t('common.dialog.cancel')}</button>{status.jump ? <button type="button" className={styles.status} data-tone={status.tone} title={t('tools.config.statusJumpTitle')} onClick={() => problems.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>{status.text}</button> : <span className={styles.status} data-tone={status.tone} title={status.text}>{status.text}</span>}{!picking && !history && <div className={styles.actions}><button className={subject === 'profile' && workspace.probe.nativeWrites.state === 'supported' ? undefined : styles.primary} data-dialog-save title={saveShortcutHint()} disabled={!canSubmit || subject === 'current' && workspace.probe.nativeWrites.state !== 'supported'} onClick={() => void save()}>{subject === 'current' ? t('tools.config.saveCurrent') : subject === 'common' ? t('tools.config.saveCommon') : t('tools.config.saveProfile')}</button>{subject === 'profile' && workspace.probe.nativeWrites.state === 'supported' && <button className={styles.primary} disabled={!canSubmit} onClick={() => void save(true)}>{t('tools.config.saveAndUse')}</button>}{(subject === 'common' || saved) && <details><summary>{t('tools.config.moreSaveActions')}</summary>{subject === 'common' && <button disabled={!canSubmit || !influence?.targets.length} onClick={() => void save(true)}>{t('tools.config.saveAndApply')}</button>}{saved && <button disabled={busy || cancelling} onClick={() => { setBusy(true); void applyStored(saved).finally(() => { if (alive.current) setBusy(false); }); }}>{t('tools.config.retryUse')}</button>}</details>}</div>}</footer>
  </div>;
}
