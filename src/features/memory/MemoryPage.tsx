import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { StatusBanner } from '../../components/StatusBanner';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { navigateChoices } from '../../lib/choiceNavigation';
import type { AuthAccount } from '../../types/accounts';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, MemoryDocument, MemoryList, MemoryManagement, MemoryOperation, MemoryTarget } from '../../types/native';
import styles from './MemoryPage.module.css';

type Choice = { scope: 'global' | 'project'; projectPath: string | null; contextId: string | null; explicit: boolean };
type Failure = { message: string; retry: (() => Promise<void>) | null };

const writeOperations: MemoryOperation[] = ['create', 'edit', 'delete', 'master_switch', 'item_enable'];

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return '';
}

function isExternalChange(error: unknown): boolean {
  return messageOf(error).includes('外部修改');
}

function isUnavailableTarget(error: unknown): boolean {
  return /不存在或无法访问|目录不可用|请重新关联|请重新选择/.test(messageOf(error));
}

function suggestChoice(memory: MemoryManagement, suggestion: string | null, projects: Project[]): Choice {
  if (memory.scope.project && suggestion) {
    const match = projects.find(project => project.path === suggestion && project.available);
    if (match?.path) return { scope: 'project', projectPath: match.path, contextId: null, explicit: false };
  }
  if (memory.scope.global) return { scope: 'global', projectPath: null, contextId: null, explicit: false };
  return { scope: 'project', projectPath: null, contextId: null, explicit: false };
}

function toTarget(tool: AdapterDescriptor, choice: Choice): MemoryTarget {
  const target: MemoryTarget = {
    toolId: tool.id,
    scope: choice.scope,
    projectPath: choice.scope === 'project' ? choice.projectPath : null,
  };
  if (tool.management?.memory?.targets.includes('account') && choice.contextId) target.contextId = choice.contextId;
  return target;
}

export function MemoryPage({ active, tools, suggestedProjectPath }: { active: boolean; tools: AdapterDescriptor[]; suggestedProjectPath: string | null }) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const suggested = useRef(suggestedProjectPath).current;
  const [toolId, setToolId] = useState(tools[0]?.id ?? '');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [list, setList] = useState<MemoryList | null>(null);
  const [opened, setOpened] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState('');
  const [newText, setNewText] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reselect, setReselect] = useState(false);
  const [busy, setBusy] = useState(false);
  const listedTargets = useRef<Set<string>>(new Set());
  const previousByToolScope = useRef<Record<string, Choice>>({});
  const preserveReselect = useRef(false);

  const descriptor = tools.find(item => item.id === toolId) ?? tools[0];
  const memory = descriptor?.management?.memory ?? null;
  const stored = descriptor ? choices[descriptor.id] : undefined;
  const choice = descriptor && memory
    ? stored ?? (memory.scope.project && !projectsReady ? null : suggestChoice(memory, suggested, projects))
    : null;
  const target = descriptor && memory && choice && (choice.scope === 'global' || choice.projectPath)
    ? toTarget(descriptor, choice)
    : null;
  const targetKey = target ? JSON.stringify(target) : '';
  const targetKeyRef = useRef(targetKey);
  const targetRef = useRef(target);
  targetKeyRef.current = targetKey;
  targetRef.current = target;
  const needsAccount = !!memory?.targets.includes('account');
  const operations = list?.operations ?? memory?.operations ?? [];
  const can = (operation: MemoryOperation) => operations.includes(operation);
  const limitation = (list?.limitation || memory?.limitation || '').trim();
  const showWrites = writeOperations.some(operation => can(operation));

  const sameTarget = (current: MemoryTarget) => mounted.current && targetKeyRef.current === JSON.stringify(current);
  const report = useCallback((error: unknown, summary: string, retry: (() => Promise<void>) | null) => {
    if (isUnavailableTarget(error)) setReselect(true);
    setFailure({ message: formatFailure(error, summary, t('common.memory.retryNext')), retry });
  }, [t]);

  const loadList = useCallback(async (current: MemoryTarget) => {
    const identity = JSON.stringify({
      toolId: current.toolId,
      scope: current.scope,
      projectPath: current.scope === 'project' ? current.projectPath : null,
      contextId: current.contextId ?? null,
    });
    const choiceOf = (value: MemoryTarget): Choice => ({
      scope: value.scope,
      projectPath: value.scope === 'project' ? value.projectPath : null,
      contextId: value.contextId ?? null,
      explicit: true,
    });
    try {
      const value = await native.listMemories(current);
      if (mounted.current && targetKeyRef.current === JSON.stringify(current)) {
        listedTargets.current.add(identity);
        previousByToolScope.current[`${current.toolId}:${current.scope}`] = choiceOf(current);
        setList(value);
        setFailure(null);
      }
    } catch (error) {
      if (!mounted.current || targetKeyRef.current !== JSON.stringify(current)) return;
      if (isUnavailableTarget(error) && !listedTargets.current.has(identity)) {
        const previous = previousByToolScope.current[`${current.toolId}:${current.scope}`];
        const failed = choiceOf(current);
        const samePrevious = !!previous && previous.scope === failed.scope && previous.projectPath === failed.projectPath && previous.contextId === failed.contextId;
        if (previous && !samePrevious) {
          preserveReselect.current = true;
          setChoices(existing => ({ ...existing, [current.toolId]: previous }));
          setReselect(true);
          return;
        }
      }
      if (isUnavailableTarget(error)) setReselect(true);
      setFailure({ message: formatFailure(error, t('common.memory.listFailed'), t('common.memory.retryNext')), retry: () => loadList(current) });
    }
  }, [t]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (toolId && tools.some(item => item.id === toolId)) return;
    setToolId(tools[0]?.id ?? '');
  }, [tools, toolId]);
  useEffect(() => {
    if (!nativeAvailable) { setProjectsReady(true); return; }
    let live = true;
    void native.listProjects().then(value => {
      if (!live) return;
      setProjects(Array.isArray(value) ? value : []);
      setProjectsReady(true);
    }).catch(error => {
      if (!live) return;
      setProjects([]);
      setProjectsReady(true);
      report(error, t('common.memory.listFailed'), async () => { setProjectEpoch(value => value + 1); });
    });
    return () => { live = false; };
  }, [projectEpoch, report, t]);
  useEffect(() => {
    if (!needsAccount || !descriptor) { setAccounts([]); return; }
    let live = true;
    void native.listAccounts().then(value => {
      if (!live) return;
      const rows = Array.isArray(value) ? value : [];
      setAccounts(rows.filter(account => account.toolId === descriptor.id && account.context?.id));
    }).catch(() => { if (live) setAccounts([]); });
    return () => { live = false; };
  }, [needsAccount, descriptor]);
  useEffect(() => {
    setList(null);
    setOpened(null);
    setDraft('');
    setCreating(false);
    setFailure(null);
    if (preserveReselect.current) {
      preserveReselect.current = false;
      setReselect(true);
    } else setReselect(false);
  }, [targetKey]);
  useEffect(() => {
    if (!active) return;
    const current = targetRef.current;
    if (!current) return;
    void loadList(current);
  }, [active, targetKey, loadList]);

  function chooseScope(scope: 'global' | 'project') {
    if (!descriptor || !memory || !choice) return;
    if (scope === 'global' && !memory.scope.global) return;
    if (scope === 'project' && !memory.scope.project) return;
    setReselect(false);
    setChoices(current => ({
      ...current,
      [descriptor.id]: { scope, projectPath: choice.projectPath, contextId: choice.contextId, explicit: true },
    }));
  }

  function chooseProject(path: string) {
    if (!descriptor || !choice) return;
    if (!path) {
      setReselect(false);
      setChoices(current => ({ ...current, [descriptor.id]: { ...choice, scope: 'project', projectPath: null, explicit: true } }));
      return;
    }
    const recorded = projects.find(item => item.path === path);
    if (recorded && !recorded.available) {
      setReselect(true);
      return;
    }
    setReselect(false);
    setChoices(current => ({
      ...current,
      [descriptor.id]: { scope: 'project', projectPath: path, contextId: choice.contextId, explicit: true },
    }));
  }

  async function pickDirectory() {
    const tool = descriptor;
    const currentChoice = choice;
    if (!tool || !currentChoice || !memory?.scope.project) return;
    try {
      const picked = await open({ directory: true, multiple: false, title: t('common.memory.pickDirectoryTitle') });
      if (!mounted.current || typeof picked !== 'string' || !picked.trim()) return;
      chooseProject(picked.trim());
    } catch (error) {
      if (mounted.current) report(error, t('common.memory.pickFailed'), () => pickDirectory());
    }
  }

  function chooseAccount(contextId: string) {
    if (!descriptor || !choice) return;
    setChoices(current => ({
      ...current,
      [descriptor.id]: { ...choice, contextId: contextId || null, explicit: true },
    }));
  }

  async function openEntry(id: string) {
    if (!target) return;
    const current = target;
    setBusy(true);
    try {
      const value = await native.readMemory(current, id);
      if (!sameTarget(current)) return;
      setOpened(value);
      setDraft(value.text);
      setCreating(false);
      setFailure(null);
    } catch (error) {
      if (!sameTarget(current)) return;
      report(error, t('common.memory.readFailed'), () => openEntry(id));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function saveOpened(confirmExternal = false) {
    if (!target || !opened) return;
    const current = target;
    const id = opened.id;
    const baseline = opened.text;
    const fingerprint = opened.fingerprint;
    const text = draft;
    setBusy(true);
    try {
      let writeExternal = confirmExternal;
      if (!writeExternal) {
        const fresh = await native.readMemory(current, id);
        if (!sameTarget(current)) return;
        if (fresh.fingerprint !== fingerprint) {
          setBusy(false);
          const accepted = await confirmAction(t('common.memory.externalMessage'), () => sameTarget(current), {
            title: t('common.memory.externalTitle'),
            confirmLabel: t('common.memory.externalConfirm'),
          });
          if (!accepted) return;
          writeExternal = true;
          setBusy(true);
        }
      }
      const saved = await native.saveMemory({ target: current, id, text, baseline, confirmExternal: writeExternal });
      if (!sameTarget(current)) return;
      setOpened(saved);
      setDraft(value => value === text ? saved.text : value);
      setFailure(null);
      await loadList(current);
    } catch (error) {
      if (!sameTarget(current)) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => sameTarget(current), {
          title: t('common.memory.externalTitle'),
          confirmLabel: t('common.memory.externalConfirm'),
        });
        if (!accepted) return;
        await saveOpened(true);
        return;
      }
      report(error, t('common.memory.saveFailed'), () => saveOpened(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function createMemory(confirmExternal = false) {
    if (!target) return;
    const id = newId.trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || id === '_unbound') {
      setFailure({ message: t('common.memory.idInvalid'), retry: null });
      return;
    }
    const current = target;
    const text = newText;
    setBusy(true);
    try {
      const saved = await native.saveMemory({ target: current, id, text, baseline: '', confirmExternal });
      if (!sameTarget(current)) return;
      setOpened(saved);
      setDraft(saved.text);
      setCreating(false);
      setNewId('');
      setNewText('');
      setFailure(null);
      await loadList(current);
    } catch (error) {
      if (!sameTarget(current)) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => sameTarget(current), {
          title: t('common.memory.externalTitle'),
          confirmLabel: t('common.memory.externalConfirm'),
        });
        if (!accepted) return;
        await createMemory(true);
        return;
      }
      report(error, t('common.memory.saveFailed'), () => createMemory(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function remove(id: string, baseline: string) {
    if (!target) return;
    const current = target;
    setBusy(true);
    try {
      await native.deleteMemory({ target: current, id, baseline });
      if (!sameTarget(current)) return;
      if (opened?.id === id) { setOpened(null); setDraft(''); }
      setFailure(null);
      await loadList(current);
    } catch (error) {
      if (!sameTarget(current)) return;
      report(error, t('common.memory.deleteFailed'), () => remove(id, baseline));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function confirmRemove(id: string) {
    if (!target) return;
    const current = target;
    const accepted = await confirmAction(t('common.memory.deleteMessage', { id }), () => sameTarget(current), {
      title: t('common.memory.deleteTitle'),
      confirmLabel: t('common.memory.deleteConfirm'),
      destructive: true,
    });
    if (!accepted || !sameTarget(current)) return;
    let baseline = opened?.id === id ? opened.text : '';
    if (opened?.id !== id) {
      setBusy(true);
      try {
        const fresh = await native.readMemory(current, id);
        if (!sameTarget(current)) return;
        baseline = fresh.text;
      } catch (error) {
        if (!sameTarget(current)) return;
        report(error, t('common.memory.readFailed'), () => confirmRemove(id));
        return;
      } finally { if (mounted.current) setBusy(false); }
    }
    await remove(id, baseline);
  }

  async function setEnabled(enabled: boolean, id?: string) {
    if (!target) return;
    const current = target;
    setBusy(true);
    try {
      const next = await native.setMemoryEnabled({ target: current, id: id ?? null, enabled });
      if (!sameTarget(current)) return;
      setList(next);
      setFailure(null);
    } catch (error) {
      if (!sameTarget(current)) return;
      report(error, t('common.memory.saveFailed'), () => setEnabled(enabled, id));
    } finally { if (mounted.current) setBusy(false); }
  }

  if (!descriptor || !memory) return null;
  const selectedProject = projects.find(project => project.path && project.path === choice?.projectPath);
  const scopeText = !choice || choice.scope === 'global'
    ? t('common.memory.targetGlobal')
    : choice.projectPath
      ? t('common.memory.targetProject', { name: selectedProject?.name || choice.projectPath })
      : t('common.memory.projectPlaceholder');
  const accountName = needsAccount && choice?.contextId
    ? accounts.find(account => account.context?.id === choice.contextId)?.label.trim() ?? ''
    : '';
  const targetText = accountName
    ? t('common.memory.targetWithAccount', { target: scopeText, account: accountName })
    : scopeText;
  const missingProject = choice?.scope === 'project' && !choice.projectPath;

  return <section className={styles.page} aria-label={t('common.nav.memory')}>
    <div className={`tabs ${styles.tabs}`} role="tablist" aria-label={t('common.memory.cliLabel')} onKeyDown={navigateChoices}>
      {tools.filter(item => item.management?.memory).map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === descriptor.id} tabIndex={item.id === descriptor.id ? 0 : -1} className={item.id === descriptor.id ? 'active' : ''} onClick={() => setToolId(item.id)}>{item.name}</button>)}
    </div>
    {!choice ? <p className={styles.prompt} role="status">{t('common.memory.loading')}</p> : <>
      <div className={styles.toolbar}>
        <div className={styles.field}><span id="memory-scope-label">{t('common.memory.scopeLabel')}</span>
          <div className={styles.scopes} role="group" aria-labelledby="memory-scope-label">
            {memory.scope.global && <button type="button" aria-pressed={choice.scope === 'global'} onClick={() => chooseScope('global')}>{t('common.memory.global')}</button>}
            {memory.scope.project && <button type="button" aria-pressed={choice.scope === 'project'} onClick={() => chooseScope('project')}>{t('common.memory.project')}</button>}
          </div>
        </div>
        {choice.scope === 'project' && <div className={styles.projectPick}>
          <label className={styles.field}>{t('common.memory.projectLabel')}
            <select value={choice.projectPath ?? ''} onChange={event => chooseProject(event.target.value)}>
              <option value="">{t('common.memory.projectPlaceholder')}</option>
              {projects.filter(project => project.path).map(project => <option key={project.id} value={project.path ?? ''}>{project.available ? project.name : t('common.memory.unavailableOption', { name: project.name })}</option>)}
              {choice.projectPath && !projects.some(project => project.path === choice.projectPath) && <option value={choice.projectPath}>{choice.projectPath}</option>}
            </select>
          </label>
          <button type="button" className="button" disabled={busy} onClick={() => void pickDirectory()}>{t('common.memory.pickDirectory')}</button>
        </div>}
        {needsAccount && <label className={styles.field}>{t('common.memory.accountLabel')}
          <select value={choice.contextId ?? ''} onChange={event => chooseAccount(event.target.value)}>
            <option value="">{t('common.memory.accountUnspecified')}</option>
            {accounts.map(account => <option key={account.id} value={account.context?.id ?? ''}>{account.label}</option>)}
          </select>
        </label>}
      </div>
      <p className={styles.target}>{t('common.memory.targetLine', { target: targetText })}</p>
      {missingProject && <p className={styles.prompt} role="status">{t('common.memory.projectMissing')}</p>}
      {reselect && <StatusBanner tone="warning">{t('common.memory.reselect')}</StatusBanner>}
      {limitation && !showWrites && <p className={styles.limitation} role="status">{limitation}</p>}
      {list && !list.inUse && <StatusBanner tone="warning">{list.detail || t('common.memory.notInUse')}</StatusBanner>}
      {failure && <StatusBanner tone="error" action={failure.retry ? <button type="button" className="button" onClick={() => { const retry = failure.retry; setFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{failure.message}</StatusBanner>}
      {list && can('master_switch') && <label className={styles.switch}><input type="checkbox" checked={list.inUse} disabled={busy} onChange={event => void setEnabled(event.target.checked)} />{t('common.memory.master')}</label>}
      {list && <ul className={styles.list}>
        {list.entries.length === 0 && <li className={styles.prompt}>{t('common.memory.empty')}</li>}
        {list.entries.map(entry => <li key={entry.id} className={styles.entry}>
          <strong>{entry.id}</strong>
          <span className={styles.path} title={entry.path}>{entry.path}</span>
          <span className={styles.actions}>
            {can('item_enable') && <label className={styles.switch}><input type="checkbox" aria-label={t('common.memory.enable', { id: entry.id })} checked={entry.enabled} disabled={busy} onChange={event => void setEnabled(event.target.checked, entry.id)} /></label>}
            {can('open') && <button type="button" className="button" disabled={busy} onClick={() => void openEntry(entry.id)}>{t('common.memory.open', { id: entry.id })}</button>}
            {can('delete') && <button type="button" className="button destructive" disabled={busy} onClick={() => void confirmRemove(entry.id)}>{t('common.memory.delete', { id: entry.id })}</button>}
          </span>
        </li>)}
      </ul>}
      {can('create') && !creating && <div className={styles.row}><button type="button" className="button primary" disabled={busy || !target} onClick={() => { setCreating(true); setOpened(null); setDraft(''); }}>{t('common.memory.create')}</button></div>}
      {creating && can('create') && <form className={styles.create} onSubmit={event => { event.preventDefault(); void createMemory(false); }}>
        <label className={styles.field}>{t('common.memory.idLabel')}<input aria-label={t('common.memory.idLabel')} value={newId} onChange={event => setNewId(event.target.value)} /></label>
        <label className={styles.field}>{t('common.memory.textLabel')}<textarea aria-label={t('common.memory.textLabel')} rows={8} value={newText} onChange={event => setNewText(event.target.value)} /></label>
        <div className={styles.row}><button type="submit" className="button primary" disabled={busy || !target}>{t('common.memory.save')}</button></div>
      </form>}
      {opened && <form className={styles.editor} onSubmit={event => { event.preventDefault(); if (can('edit')) void saveOpened(false); }}>
        <label className={styles.field}>{t('common.memory.textLabel')}<textarea aria-label={t('common.memory.textLabel')} rows={10} readOnly={!can('edit')} value={draft} onChange={event => setDraft(event.target.value)} /></label>
        {can('edit') && <div className={styles.row}><button type="submit" className="button primary" disabled={busy}>{t('common.memory.save')}</button></div>}
      </form>}
    </>}
  </section>;
}
