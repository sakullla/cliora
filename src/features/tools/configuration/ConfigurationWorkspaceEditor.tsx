import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { uiAdapterFor } from '../../../adapters';
import { native, beginConfigurationDraft, updateConfigurationDraft, editConfigurationDraft, replaceConfigurationText, selectConfigurationCredential, setConfigurationDraftSecret, removeConfigurationDraftSecret, revealConfigurationDraftSecret, cancelConfigurationDraft, cancelConfigurationRequests, addConfigurationModels, listConfigurationModels, checkConfigurationConnection, saveConfigurationDraft, commonInfluence, applyCommonConfiguration, compareConfigurationCurrent, rebaseConfigurationCurrent, previewConfigurationBackup, restoreConfigurationBackup } from '../../../lib/native';
import { createConfigurationSession, configurationCredentialIdentity, rememberConfigurationApiBuffer, type ConfigurationApiBuffer, configurationRequestMatches } from '../../../lib/configurationDraft';
import { confirmAction } from '../../../lib/confirm';
import type { ConfigurationAction, ConfigurationCredential, ConfigurationDraft, ConfigurationSaveResult, ConfigurationSubject, CommonInfluence, CommonApplicationResult, ConfigurationCurrentComparison, ConfigurationBackupPreview } from '../../../types/configuration';
import type { Connection, ConnectionCheck, ModelDirectory, NativePreview, RegisteredProfile, RegisteredToolWorkspace, Scope, ApplyComparison } from '../../../types/native';
import type { AuthAccount, NativeLoginSnapshot } from '../../../types/accounts';
import { CodeEditor } from '../../../components/CodeEditor';
import { FileConflict } from '../../../components/FileConflict';
import { AccountPicker } from '../AccountPicker';
import type { useAccounts } from '../AccountsPanel';
import styles from './ConfigurationWorkspaceEditor.module.css';
import sharedStyles from '../../../components/configuration/configuration.module.css';

type Session = ReturnType<typeof createConfigurationSession>;
type Props = {
  toolId: string; subject: ConfigurationSubject; profile: RegisteredProfile | null; scope: Scope; projectPath: string;
  workspace: RegisteredToolWorkspace; accounts: ReturnType<typeof useAccounts>;
  onDirtyChange: (dirty: boolean) => void; onDraftChange: (draft: ConfigurationDraft) => void;
  onStored: (result: ConfigurationSaveResult) => void; onDone: (result: ConfigurationSaveResult, used?: boolean) => void; onClose: () => void;
};
const messageOf = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试。';

export function ConfigurationWorkspaceEditor(props: Props) {
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
  const [directory, setDirectory] = useState<ModelDirectory | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState(new Set<string>());
  const [querying, setQuerying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [preview, setPreview] = useState<NativePreview | null>(null);
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
  const sourceBuffers = useRef<Partial<Record<ConfigurationCredential['source'], { credential: ConfigurationCredential; connection: Connection | null }>>>({});
  const apiBuffers = useRef(new Map<string, ConfigurationApiBuffer>());
  const apiCredential = useRef<{ identity: string; credential: ConfigurationApiBuffer['credential'] } | null>(null);
  const apiInputIdentity = useRef('');
  const focusReturn = useRef<HTMLElement | null>(null);

  useEffect(() => {
    alive.current = true;
    const generation = ++opening.current;
    const id = `configuration-${crypto.randomUUID()}`;
    void beginConfigurationDraft({ toolId, scope, projectPath: projectPath || null, sessionId: id, subject, profile: props.profile }).then(value => {
      if (!alive.current || opening.current !== generation) { void cancelConfigurationDraft(id).catch(() => {}); return; }
      if (!value || Editor && !value.descriptor) throw new Error('此安装尚未返回专属编辑能力，请刷新工具后重试。');
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
  const updateValidity = () => { setValid(session.current?.canSubmit ?? false); setPending(session.current?.pending ?? false); };
  async function edit(work: (current: ConfigurationDraft) => Promise<ConfigurationDraft>, raw = false) {
    const owner = session.current;
    if (!owner) throw new Error('草稿还未加载，请稍后重试。');
    if (requestCancellation.current) throw new Error('请求正在取消，请稍后继续编辑。');
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
    if (owner && apiInputIdentity.current !== configurationCredentialIdentity(owner.draft)) throw new Error('此密钥输入属于先前连接，请为当前连接提供新密钥。');
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
    if (paid && !await confirmAction('发送一个最小模型请求，可能产生费用。继续吗？', () => alive.current && session.current?.draft.sessionId === consent?.sessionId && session.current?.draft.revision === consent?.revision, { title: '可能计费的模型请求', confirmLabel: '发送请求' })) return;
    setQuerying(true); setError('');
    let token: number | undefined;
    try {
      await flushSecret();
      const owner = session.current; if (!owner || owner.pending) return;
      if (!owner.isFieldValid('connection-form')) throw new Error('请先设置供应商连接或取消连接修改，再检查当前草稿连接。');
      const started = owner.draft; token = ++sequence.current; setQuerying(true);
      const result = kind === 'directory' ? await listConfigurationModels(started, true, search) : await checkConfigurationConnection(started, paid);
      if (!alive.current || session.current !== owner || token !== sequence.current || !configurationRequestMatches(owner.draft, started, result)) return;
      if ('directory' in result) { setDirectory(result.directory); setDirectoryOpen(true); setChosen(new Set()); }
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
    const started = owner.draft; const token = ++sequence.current; setView('preview');
    try { const value = await native.previewRegisteredNativeProfile(started.profile, scope); if (alive.current && owner === session.current && token === sequence.current && owner.draft.revision === started.revision) setPreview(value); }
    catch (failure) { if (alive.current && token === sequence.current) setError(messageOf(failure)); }
  }
  async function applyStored(result: ConfigurationSaveResult) {
    if (result.profile) {
      try { await native.applyRegisteredNativeProfile(toolId, result.profile.id, scope, projectPath || undefined, false); }
      catch (failure) { setNotice('配置已保存，尚未使用；原有文件与当前绑定保留。'); setError(messageOf(failure)); setComparison(await native.compareRegisteredApplication(result.profile.id, scope, projectPath).catch(() => null)); return false; }
    } else if (result.common && influence) {
      const outcomes = await applyCommonConfiguration(result.common, influence.targets); setApplications(outcomes);
      if (outcomes.some(item => item.status === 'failed')) { setNotice('通用配置已保存；部分范围应用失败，可逐项重试。'); return false; }
    }
    return true;
  }
  async function save(use = false) {
    const owner = session.current; if (!owner || !owner.canSubmit || busy) return;
    if (subject === 'profile' && !owner.draft.profile.name.trim()) { setError('请输入配置名称。'); document.querySelector<HTMLInputElement>('[aria-label="配置名称"]')?.focus(); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await flushSecret(); if (!alive.current || owner !== session.current || !owner.canSubmit) return;
      const result = await saveConfigurationDraft(owner.draft);
      if (!alive.current || owner !== session.current) return;
      if (!owner.acceptSaved(result.draft)) return; acceptApiCredential(owner.draft); setDraft(owner.draft); setRawInputs(owner.draft.profile.files);
      baseline.current = JSON.stringify(owner.draft.profile); baselineRevision.current = owner.draft.revision; setSaved(result); latest.current.onStored(result); updateValidity();
      if (use && !await applyStored(result)) return;
      setNotice(subject === 'current' ? '当前文件已更新；下次会话读取新内容。' : use ? '已保存并使用；下次会话读取新内容。' : '已保存；正在使用的文件保持原版本。');
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
    })).then(() => { if (alive.current) { setCurrentConflict(null); setNotice('比较基线已更新，其它草稿保留；请保存到当前文件。'); setRawResetEpoch(value => value + 1); } }).catch(() => {});
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
    if (dirty && !await confirmAction('恢复此文件版本会替换本文件的未保存修改；其它文件草稿保留。继续吗？', () => alive.current && owner === session.current && owner.draft.revision === target.revision, { title: '恢复文件版本', confirmLabel: '恢复此版本' })) return;
    setBusy(true); setError('');
    try {
      const result = await restoreConfigurationBackup(owner.draft, target.role, target.transactionId);
      if (!alive.current || owner !== session.current || !owner.acceptSaved(result.draft)) return;
      setDraft(owner.draft); setRawInputs(owner.draft.profile.files); setRawResetEpoch(value => value + 1); setHistory(false); setBackup(null); latest.current.onDraftChange(owner.draft); updateValidity();
      setNotice('历史版本已写入当前文件；其它草稿保留，下次会话读取新内容。');
    } catch (failure) { if (alive.current) setError(messageOf(failure)); }
    finally { if (alive.current) setBusy(false); }
  }

  if (loading) return <div className={`${styles.shell} ${sharedStyles.controls}`}><p role="status">正在加载原生配置草稿…</p><button onClick={props.onClose}>取消</button></div>;
  if (!draft || Editor && !draft.descriptor) return <div className={`${styles.shell} ${sharedStyles.controls}`}><p role="alert">{error || '专属编辑器不可用'}</p><button onClick={props.onClose}>返回配置列表</button></div>;
  const canSubmit = valid && !pending && !busy && !picking && !querying && !cancelling;
  const format = workspace.probe.nativeFiles.find(file => file.role === rawRole)?.format ?? 'json';
  const files = [...new Set([...workspace.probe.nativeFiles.filter(file => !file.sensitive).map(file => file.role), ...Object.keys(draft.profile.files)])];
  const sourceLabel = source === 'native' ? 'CLI 当前登录或凭据' : source === 'account' ? '已管理账号' : source === 'api_key' ? '此连接的 API 密钥' : '需要选择凭据来源';
  return <div className={styles.shell}>
    <div className={`${styles.scroll} ${sharedStyles.controls}`}>
      {picking && <AccountPicker toolId={toolId} selectedAccountId={selectedAccountId} onSelect={account => void selectAccount(account)} onBack={() => { setPicking(false); requestAnimationFrame(() => focusReturn.current?.focus()); }} />}
      {history && <section aria-label="修改记录"><button onClick={() => { setHistory(false); setBackup(null); }}>返回编辑</button><div className={styles.buttons}>{backups.map(row => <button key={row.transactionId} onClick={() => void selectBackup(row.transactionId)}>{row.createdAt ? new Date(row.createdAt * 1000).toLocaleString() : row.transactionId}</button>)}</div>{!backups.length && <p>没有可恢复的历史版本。</p>}{backup && <><CodeEditor label="历史原文" format={workspace.probe.nativeFiles.find(file => file.role === backup.role)?.format ?? 'json'} readOnly value={backup.original} /><details><summary>当前文件</summary><CodeEditor label="历史比较当前内容" format={workspace.probe.nativeFiles.find(file => file.role === backup.role)?.format ?? 'json'} readOnly value={backup.current} /></details><button disabled={busy || cancelling} onClick={() => void restoreBackup()}>恢复这个版本</button></>}</section>}
      <div hidden={picking || history}>
        <nav className={styles.tabs} aria-label="配置内容"><button aria-pressed={view === 'models'} disabled={pending} onClick={() => setView('models')}>连接与模型</button><button aria-pressed={view === 'settings'} disabled={pending} onClick={() => setView('settings')}>常用设置</button><button aria-pressed={view === 'raw'} disabled={pending} onClick={() => setView('raw')}>原生文本</button><button disabled={!valid || pending || cancelling} onClick={() => void showPreview()}>合并与来源</button></nav>
        {subject === 'profile' && <label className={styles.name}>配置名称<input aria-label="配置名称" value={nameInput} disabled={busy || cancelling} onChange={event => { setNameInput(event.target.value); metadata({ name: event.target.value }); }} /></label>}
        {view === 'models' && subject !== 'common' && <section className={styles.sources} aria-label="凭据来源">
          {subject === 'profile' || subject === 'current' && apiWritable ? <label>使用方式<select aria-label="凭据来源" value={source ?? ''} disabled={busy || pending || cancelling} onChange={event => { focusReturn.current = event.currentTarget; void chooseSource(event.target.value as ConfigurationCredential['source']); }}><option value="" disabled>请选择本次配置的凭据来源</option><option value="native">使用 CLI 当前登录或凭据</option>{subject === 'profile' && accountSupported ? <option value="account">选择已管理账号</option> : source === 'account' && <option value="account" disabled>已绑定账号 · 当前能力待确认</option>}{apiWritable ? <option value="api_key">为此连接提供 API 密钥</option> : source === 'api_key' && <option value="api_key" disabled>已存 API 密钥 · 当前不可新增</option>}</select></label> : <strong>当前文件 · {sourceLabel}</strong>}
          {source === 'native' && <><p>{adapter.accounts?.nativeDescription ?? '沿用当前原生上下文；查看和保存配置不会纳入账号管理或复制凭据。'}</p>{nativeLogins?.logins.map((login, index) => <p key={index}>{login.identity?.email ?? login.identity?.subject ?? (login.authKind === 'api_key' ? '当前 CLI 凭据：API 密钥' : '当前身份未提供')} · {login.state === 'signed_in' ? login.authKind === 'api_key' ? '已配置，身份未核验' : login.identity ? 'CLI 已登录' : '身份待核验' : login.state}</p>)}{nativeError && <p role="alert">{nativeError}</p>}</>}
          {subject === 'profile' && source === 'account' && <><p>{selectedAccount?.identity?.email ?? selectedAccount?.identity?.subject ?? '尚未选择已核验账号'} · {selectedAccount?.state === 'signed_in' && selectedAccount.identity && selectedAccount.context && !selectedAccount.pendingLogin ? '已核验登录' : '待选择或重新核验'}</p><button disabled={busy || pending || cancelling} onClick={event => { focusReturn.current = event.currentTarget; setPicking(true); }}>选择账号或登录新账号</button></>}
          {source === 'api_key' && <><p>用于 {draft.nativeCredentialTarget?.label ?? (connection?.baseUrl || '当前连接')}；{subject === 'current' ? '保存后更新当前文件中的密钥。' : '密钥由系统凭据库保存。'}</p>{!apiWritable && <p role="alert">{apiReason ?? '当前范围不接受新密钥，请明确选择其他来源。'}</p>}{apiWritable && <div className={styles.secret}>{!secretReplacing && (draft.credential?.source === 'api_key' && draft.credential.secretRef) ? <><details><summary>{draft.credentialStatus === 'draft' ? '密钥在草稿中 · 尚未保存到系统' : draft.credentialStatus === 'stored' ? '密钥已保存到系统 · 空输入保留' : '已有密钥引用 · 保存状态待确认'}</summary><div className={styles.buttons}><button onClick={() => { startSecretInput(); setSecretReplacing(true); }}>替换密钥</button><button disabled={pending} onClick={() => void removeSecret()}>移除密钥</button><button onClick={() => { const ref = draft.credential?.source === 'api_key' ? draft.credential.secretRef : null; if (visibleSecret !== null) { setVisibleSecret(null); return; } const token = ++sequence.current; if (ref) void revealConfigurationDraftSecret(session.current!.draft).then(value => { if (alive.current && token === sequence.current) setVisibleSecret(value); }).catch(failure => setError(messageOf(failure))); }}>显示密钥</button>{visibleSecret !== null && <input aria-label="已保存密钥" type="text" readOnly value={visibleSecret} />}</div></details></> : <label>API 密钥<input aria-label="API 密钥" type="password" autoComplete="off" value={secretInput} disabled={busy || cancelling} placeholder="空输入保留已保存密钥" onChange={event => { sequence.current++; setDirectory(null); setCheck(null); startSecretInput(); setSecretInput(event.target.value); latest.current.onDirtyChange(true); }} /></label>}{subject === 'current' && draft.credential?.source === 'api_key' && !draft.credential.secretRef && <button disabled={busy || pending || cancelling} onClick={() => void removeSecret()}>移除当前密钥</button>}</div>}</>}
        </section>}
        {!accountSupported && accountSourceCapability?.reason && view === 'models' && <p>{accountSourceCapability.reason}</p>}
        {!apiWritable && apiReason && view === 'models' && <p>{apiReason}</p>}
        {!Editor && source === 'api_key' && connection && view === 'models' && <p className={styles.connectionSummary}>连接：{connection.baseUrl || '待补齐'} · {connection.interfaceFormat}。连接参数由下方专属编辑器提供。</p>}
        <div hidden={view === 'raw' || view === 'preview'}>{Editor ? <Editor draft={draft} descriptor={draft.descriptor!} mode={subject} section={view === 'settings' ? 'settings' : 'models'} disabled={busy || cancelling} pending={pending} rawResetEpoch={rawResetEpoch} onAction={onAction} onValidityChange={onValidityChange} /> : subject === 'profile' && source !== 'account' ? <section aria-label="兼容配置连接"><p>此 CLI 保留通用连接与原文编辑，原生映射由注册适配器负责。</p><details open={!legacyInputs?.baseUrl}><summary>连接 · {legacyInputs?.providerId || '待填写'}</summary><label>供应商 ID<input aria-label="供应商 ID" value={legacyInputs?.providerId ?? ''} disabled={busy || cancelling} onChange={event => legacyConnection('providerId', event.target.value)} /></label>{workspace.probe.connectionPolicy?.providerAddress.state !== 'unsupported' && <label>API 地址<input aria-label="API 地址" value={legacyInputs?.baseUrl ?? ''} disabled={busy || cancelling} onChange={event => legacyConnection('baseUrl', event.target.value)} /></label>}<label>接口协议<select aria-label="接口协议" disabled={busy || cancelling} value={legacyInputs?.interfaceFormat ?? ''} onChange={event => legacyConnection('interfaceFormat', event.target.value)}>{workspace.probe.interfaceFormats.map(value => <option key={value} value={value}>{value}</option>)}</select></label></details><label>模型<input aria-label="模型" value={legacyInputs?.model ?? ''} disabled={busy || cancelling} onChange={event => legacyConnection('model', event.target.value)} /></label><details><summary>高级连接</summary><label>认证环境变量名<input aria-label="认证环境变量名" disabled={busy || cancelling} value={legacyInputs?.authEnvVar ?? ''} onChange={event => legacyConnection('authEnvVar', event.target.value)} /></label></details></section> : <p>此范围可使用原生文本编辑；支持的字段和来源以注册能力为准。</p>}</div>
        {view === 'raw' && <><div className={styles.tabs}>{files.map(role => <button key={role} aria-pressed={rawRole === role} onClick={() => setRawRole(role)}>{role}</button>)}</div><p>原文与表单共用草稿。无效文本会保留并阻止提交；敏感凭据由后端保护。</p><CodeEditor documentId={rawRole} label={`${rawRole} 配置草稿`} format={format} value={rawInputs[rawRole] ?? ''} onChange={text => textChanged(rawRole, text)} readOnly={busy || cancelling} />{currentConflict && currentConflict.files.filter(file => file.current !== file.original).map(file => <section key={file.role}><strong>{file.role}{conflictChoices[file.role] && ` · 已选择${conflictChoices[file.role] === 'current' ? '当前内容' : '本次内容'}`}</strong><FileConflict current={file.current} edited={file.edited} format={workspace.probe.nativeFiles.find(meta => meta.role === file.role)?.format ?? 'json'} busy={busy || pending} onKeep={() => void chooseCurrent(file.role, 'current')} onUse={() => void chooseCurrent(file.role, 'edited')} /></section>)}</>}
        {view === 'preview' && <><p>只读合并结果；此操作不应用配置。</p><CodeEditor label="合并配置预览" format={format} readOnly value={preview?.rendered?.[rawRole] ?? ''} /><details open><summary>字段来源</summary><p>命名配置表示本层显式值；通用配置表示继承值。未写入的字段遵循适配器声明的原生默认；环境或更高层覆盖以对应 CLI 的说明为准。</p><dl>{Object.entries(preview?.sources?.[rawRole] ?? {}).map(([path, origin]) => <div key={path}><dt><code>{path}</code></dt><dd>{origin === '命名配置' ? '本层显式 · 命名配置' : origin === '通用配置' ? '继承 · 通用配置' : origin}</dd></div>)}</dl>{!Object.keys(preview?.sources?.[rawRole] ?? {}).length && <p>本预览没有字段来源记录，不推断它们已显式设置。</p>}</details></>}
        {view === 'models' && subject !== 'common' && <details className={styles.diagnostics}><summary>模型目录与连接检查</summary><div className={styles.buttons}><button disabled={querying || pending || !draft.catalogSupport?.available} onClick={() => void query('directory')}>获取模型目录</button><button disabled={querying || pending || !connection} onClick={() => void query('check')}>检查连接</button><button disabled={!querying || pending || cancelling} onClick={() => void cancelRequests()}>{cancelling ? '正在取消…' : '取消请求'}</button></div>{draft.catalogSupport?.reason && <p>{draft.catalogSupport.reason}；可继续手动新增模型。</p>}<details><summary>更多诊断</summary><button disabled={querying || pending || !connection} onClick={() => void query('check', true)}>发送最小请求（可能计费）</button></details>{check && <div role="status"><p>{check.format.message}</p><p>{check.connectivity.message}</p><p>{check.modelRequest.message}</p></div>}</details>}
        {directoryOpen && directory && <section aria-label="模型目录" className={styles.directory}><strong>目录：{directory.source || '供应商返回'} · {directory.fetchedAt ? new Date(directory.fetchedAt * 1000).toLocaleString() : '时效未提供'}</strong><p>模型 ID 不代表已核验能力；缺少必填参数时请在模型详情补齐。</p>{directory.error && <p role="alert">{directory.error}</p>}<label>搜索目录<input aria-label="搜索模型目录" value={search} onChange={event => setSearch(event.target.value)} /></label><ul>{directory.models.filter(id => id.toLowerCase().includes(search.toLowerCase())).map(id => <li key={id}><label><input type={draft.catalogSupport?.multiple ? 'checkbox' : 'radio'} name="catalog-model" checked={chosen.has(id)} onChange={event => setChosen(previous => { const next = draft.catalogSupport?.multiple ? new Set(previous) : new Set<string>(); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />{id}</label></li>)}</ul>{!directory.models.length && <p>目录为空，请手动新增模型。</p>}<div className={styles.buttons}><button disabled={pending || busy || !chosen.size} onClick={() => void addModels()}>添加所选模型</button><button onClick={() => setDirectoryOpen(false)}>返回模型编辑</button></div></section>}
        {subject === 'profile' && <details><summary>继承与其他选项</summary><label><input type="checkbox" disabled={busy || pending || cancelling} checked={draft.profile.inheritCommon} onChange={event => metadata({ inheritCommon: event.target.checked })} />继承本工具通用配置</label></details>}
        {subject === 'common' && <section aria-label="通用配置影响"><strong>已继承的活动范围</strong><button disabled={busy || cancelling} onClick={() => { void commonInfluence(toolId).then(value => { if (alive.current) setInfluence(value); }).catch(failure => setError(messageOf(failure))); }}>刷新影响范围</button>{influence?.targets.length ? <ul>{influence.targets.map(target => <li key={target.scopeKey}>{target.profileName} · {target.scope === 'global' ? '全局' : target.projectPath} · 最后应用版本 {target.appliedVersion}</li>)}</ul> : <p>当前没有活动范围继承此通用配置；保存仍只更新数据库。</p>}{applications.map(item => <p key={item.scopeKey} role={item.status === 'failed' ? 'alert' : 'status'}>{item.scopeKey} · {item.status} · {item.detail}{item.status === 'failed' && saved?.common && <button onClick={() => { const target = influence?.targets.find(target => target.scopeKey === item.scopeKey); if (target) void applyCommonConfiguration(saved.common!, [target]).then(next => setApplications(previous => previous.map(old => old.scopeKey === item.scopeKey ? next[0] : old))).catch(failure => setError(messageOf(failure))); }}>重试此范围</button>}</p>)}</section>}
        {subject === 'current' && <details><summary>当前文件恢复</summary><button disabled={pending || busy} onClick={() => void compareCurrent()}>重新比较文件</button><button disabled={pending || busy} onClick={() => void showHistory()}>修改记录</button></details>}
        {comparison && <section aria-label="应用冲突"><p>配置已保存，当前文件有外部变化。比较后明确选择内容。</p>{comparison.files.map(file => <details key={file.role}><summary>{file.role}</summary><CodeEditor label={`${file.role} 当前内容`} format={file.format} value={file.current} readOnly /><CodeEditor label={`${file.role} 本次内容`} format={file.format} value={file.proposedText} readOnly /></details>)}<button disabled={busy || cancelling} onClick={() => { setBusy(true); void native.applyComparedApplication(comparison, scope, projectPath).then(() => { if (alive.current) { setComparison(null); setNotice('已使用保存的配置；下次会话读取。'); } }).catch(failure => setError(messageOf(failure))).finally(() => { if (alive.current) setBusy(false); }); }}>使用本次内容</button><button onClick={() => setComparison(null)}>保留当前文件</button></section>}
      </div>
      {draft.issues.length > 0 && <div role="alert" className={styles.errors}>{draft.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
      {!valid && !pending && !draft.issues.length && <p role="alert">有未完成或无效的字段输入，请返回对应模型或连接完成修改。输入会保留。</p>}
      {error && <p role="alert" className={styles.errors}>{error}</p>}{notice && <p role="status">{notice}</p>}
    </div>
    <footer className={`${styles.footer} ${sharedStyles.controls}`}><button onClick={props.onClose}>取消</button><span>{error || (picking ? '登录与选择不应用配置' : dirty ? '未保存' : '草稿已保存')}</span>{!picking && !history && <div className={styles.actions}><button className={styles.primary} data-dialog-save disabled={!canSubmit || subject === 'current' && workspace.probe.nativeWrites.state !== 'supported'} onClick={() => void save()}>{subject === 'current' ? '保存到当前文件' : subject === 'common' ? '保存通用配置' : '保存配置'}</button>{subject === 'profile' && workspace.probe.nativeWrites.state === 'supported' && <button disabled={!canSubmit} onClick={() => void save(true)}>保存并使用</button>}{(subject === 'common' || saved) && <details><summary>更多保存操作</summary>{subject === 'common' && <button disabled={!canSubmit || !influence?.targets.length} onClick={() => void save(true)}>保存并应用到继承范围</button>}{saved && <button disabled={busy || cancelling} onClick={() => { setBusy(true); void applyStored(saved).finally(() => { if (alive.current) setBusy(false); }); }}>重试使用已保存版本</button>}</details>}</div>}</footer>
  </div>;
}
