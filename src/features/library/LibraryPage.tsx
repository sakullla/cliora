import { CodeEditor } from '../../components/CodeEditor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction, type ConfirmationOptions } from '../../lib/confirm';
import type { Project } from '../../types/launch';
import type { LibraryDraft, LibraryItem, LibraryKind } from '../../types/library';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { RulePlacement } from '../../types/resources';
import { LibraryResources } from './LibraryResources';
import { LibraryMcp } from './LibraryMcp';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import { toolOptions } from '../../components/ToolIcon';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState } from '../../components/EmptyState';
import { shortPath } from '../../lib/paths';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import { formatFailure } from '../../lib/feedback';
import { failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from '../sessions/SessionWorkbench';
import { useToasts } from '../../lib/toast';
import { ToastScope } from '../../components/Toast';
import { SkeletonRows } from '../../components/Skeleton';
import { navigateChoices } from '../../lib/choiceNavigation';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { Badge, Button, Card, Toolbar } from '../../components/ui';
import i18n from '../../i18n';
import styles from './LibraryPage.module.css';

const copiedText = () => i18n.t('library.page.copied');
const sentenceEnd = () => i18n.language === 'en' ? '. ' : '。';

function listFailureAfterSave(value: unknown): string {
  const formatted = formatFailure(value, i18n.t('library.page.listFailed'), i18n.t('library.page.listNext'));
  const advice = i18n.t('library.page.listNext');
  if (!advice || !formatted.includes(advice)) return formatted;
  const detail = formatted.replaceAll(advice, '').replace(/[。！？\s]+$/g, '').trim();
  return `${detail || i18n.t('library.page.listFailed')}${sentenceEnd()}${i18n.t('library.page.savedListNext')}`;
}

function empty(kind: LibraryKind): LibraryDraft {
  return { id: null, kind, title: '', body: '', category: '', projectId: null, expectedVersion: null };
}

function tagsOf(category: string): string[] {
  return [...new Set(category.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))];
}

function dateLocale() { return i18n.language === 'en' ? 'en-US' : 'zh-CN'; }

function fullTime(value: number) {
  return new Date(value * 1000).toLocaleString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortTime(value: number) {
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const clock = date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const start = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const day = start(date);
  const today = start(new Date());
  if (day === today) return i18n.t('library.page.today', { time: clock });
  if (day === today - 86_400_000) return i18n.t('library.page.yesterday', { time: clock });
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const calendar = date.toLocaleDateString(dateLocale(), sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
  return `${calendar} ${clock}`;
}

function categoryOf(tags: string[]): string {
  return tags.join(',');
}

function edit(item: LibraryItem): LibraryDraft {
  return { id: item.id, kind: item.kind, title: item.title, body: item.body, category: item.category, projectId: item.projectId, expectedVersion: item.version };
}

type LibrarySection = LibraryKind | 'mcp' | 'skill';

/** Locate request emitted by the command palette; consumed once per token. */
export type LibrarySpotlight = { kind: LibraryKind; id: string; token: number };
export type LibraryMcpSpotlight = { id: string; token: number; source: 'connections' };

export function LibraryPage({ managedTools = [], remoteTargetId = 'local', active = true, spotlight = null, mcpSpotlight = null, onOpenConnections, onWorkbenchSession, onWorkbenchFailure }: { managedTools?: AdapterDescriptor[]; remoteTargetId?: string; active?: boolean; spotlight?: LibrarySpotlight | null; mcpSpotlight?: LibraryMcpSpotlight | null; onOpenConnections?: () => void; onWorkbenchSession?: (sessionId: string) => void; onWorkbenchFailure?: (failure: WorkbenchFailure) => void }) {
  const { t } = useTranslation();
  const kindName = (value: LibraryKind) => t(value === 'prompt' ? 'library.page.prompt' : 'library.page.ruleShort');
  const [section, setSection] = useState<LibrarySection>('prompt');
  const [kind, setKind] = useState<LibraryKind>('prompt');
  const [search, setSearch] = useState('');
  const [createSignal, setCreateSignal] = useState(0);
  const [projectFilter, setProjectFilter] = useState('*');
  const [categoryFilter, setCategoryFilter] = useState('*');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [counts, setCounts] = useState<Partial<Record<LibrarySection, number>>>({});
  const [countStamp, setCountStamp] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<LibraryDraft | null>(null);
  const [savedText, setSavedText] = useState('');
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();
  const [listLoading, setListLoading] = useState(nativeAvailable);
  const [dialogError, setDialogError] = useState('');
  const [dialogNotice, setDialogNotice] = useState('');
  const [tagText, setTagText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [rulePlacements, setRulePlacements] = useState<RulePlacement[]>([]);
  const [launchItem, setLaunchItem] = useState<LibraryItem | null>(null);
  const [launchTool, setLaunchTool] = useState('');
  const [launchProject, setLaunchProject] = useState('');
  const [launchText, setLaunchText] = useState('');
  const [launchError, setLaunchError] = useState('');
  const [launchBusy, setLaunchBusy] = useState(false);
  // Host switching changes the execution target. Keep the same library/tool
  // choices as the local view; availability is resolved only when launching.
  const scopedTools = managedTools;
  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedId, toasts.notice]);
  const dirty = !!draft && JSON.stringify(draft) !== savedText;
  const latest = useRef(''); latest.current = JSON.stringify([kind, draft, active]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function confirmCurrent(message: string, options: ConfirmationOptions = { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') }) {
    const started = latest.current;
    return confirmAction(message, () => mounted.current && latest.current === started, options);
  }

  function showError(text: string) { toasts.showError(text); }
  function showNotice(text: string) { toasts.showNotice(text); }
  function showDialogError(text: string) { setDialogNotice(''); setDialogError(text); }
  function showDialogNotice(text: string) { setDialogError(''); setDialogNotice(text); }
  function clearDialogResult() { setDialogError(''); setDialogNotice(''); }

  useEffect(() => {
    if (!nativeAvailable || !active) return;
    if (remoteTargetId !== 'local') {
      setProjects([]);
      let live = true;
      void native.listRemoteRulePlacements(remoteTargetId).then((rows) => { if (live) setRulePlacements(Array.isArray(rows) ? rows : []); }).catch(() => { if (live) setRulePlacements([]); });
      return () => { live = false; };
    }
    void native.listProjects().then(setProjects).catch((value) => showError(formatFailure(value, t('library.page.projectsFailed'), t('library.page.projectsFailedNext'))));
    void native.listRulePlacements().then((rows) => setRulePlacements(Array.isArray(rows) ? rows : [])).catch(() => setRulePlacements([]));
  }, [active, remoteTargetId]);
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    if (remoteTargetId !== 'local') {
      let live = true;
      void Promise.all([native.listRemoteLibraryItems(remoteTargetId, 'prompt', ''), native.listRemoteLibraryItems(remoteTargetId, 'rule', '')]).then(([prompts, rules]) => { if (live) setCounts({ prompt: prompts.length, rule: rules.length, mcp: 0, skill: 0 }); }).catch(() => { if (live) setCounts({ prompt: 0, rule: 0, mcp: 0, skill: 0 }); });
      return () => { live = false; };
    }
    let live = true;
    void Promise.all([native.listLibraryItems('prompt', null, ''), native.listLibraryItems('rule', null, ''), native.listMcpDefinitions(), native.listSkillPackages()])
      .then(([prompts, rules, mcps, skills]) => { if (live) setCounts({ prompt: prompts.length, rule: rules.length, mcp: mcps.filter((item) => item.inLibrary !== false).length, skill: skills.filter((item) => item.inLibrary !== false).length }); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, countStamp, remoteTargetId]);
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    if (remoteTargetId !== 'local') {
      let live = true;
      setListLoading(true);
      const timer = window.setTimeout(() => { void native.listRemoteLibraryItems(remoteTargetId, kind, search).then((result) => { if (live) { setItems(result); setListLoading(false); } }).catch((value) => { if (live) { setItems([]); setListLoading(false); showError(formatFailure(value, t('library.page.listFailed'), t('library.page.listNext'))); } }); }, search ? 180 : 0);
      return () => { live = false; window.clearTimeout(timer); };
    }
    let live = true;
    setListLoading(true);
    // Search keystrokes debounce like Records (180ms) so fast typing merges into one
    // native query; clearing the field skips the delay and restores the full list at once.
    const timer = window.setTimeout(() => {
      void native.listLibraryItems(kind, null, search).then((result) => { if (live) { setItems(result); setListLoading(false); } })
        .catch((value) => { if (live) { setListLoading(false); showError(formatFailure(value, t('library.page.listFailed'), t('library.page.listNext'))); } });
    }, search ? 180 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [active, kind, search, remoteTargetId]);
  // Spotlight from the command palette: settle the section and filters first, then
  // open the entry's edit dialog (its view/copy surface) once the list shows it.
  // Waiting is event-driven: the reveal simply fires when a matching item arrives.
  const revealedSpotlight = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !spotlight || revealedSpotlight.current === spotlight.token) return;
    if (section !== spotlight.kind) { void openSection(spotlight.kind); return; }
    if (search || projectFilter !== '*' || categoryFilter !== '*') { setSearch(''); setProjectFilter('*'); setCategoryFilter('*'); return; }
    const item = items.find((entry) => entry.id === spotlight.id);
    if (!item) return;
    revealedSpotlight.current = spotlight.token;
    document.querySelector<HTMLElement>(`[data-library-id="${CSS.escape(spotlight.id)}"]`)?.scrollIntoView({ block: 'center' });
    void choose(item);
  }, [spotlight?.id, spotlight?.kind, spotlight?.token, active, section, search, projectFilter, categoryFilter, items]);

  const revealedMcpSpotlight = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !mcpSpotlight || revealedMcpSpotlight.current === mcpSpotlight.token) return;
    if (section !== 'mcp') { void openSection('mcp'); return; }
    revealedMcpSpotlight.current = mcpSpotlight.token;
  }, [active, mcpSpotlight?.token, section]);

  const categories = useMemo(() => Array.from(new Set(items.flatMap((item) => tagsOf(item.category)))).sort(), [items]);
  const shown = items.filter((item) => (projectFilter === '*' || (projectFilter === 'global' ? !item.projectId : item.projectId === projectFilter))
    && (categoryFilter === '*' || tagsOf(item.category).includes(categoryFilter)));
  // The unfiltered count loads separately; clamp it so a fresh filtered batch never shows x > y.
  const listTotal = Math.max(counts[kind] ?? items.length, shown.length);

  async function canReplace() { return !dirty || confirmCurrent(t('library.page.confirmDiscard')); }
  async function choose(item: LibraryItem) {
    if (!await canReplace()) return;
    const next = edit(item);
    setDraft(next); setSavedText(JSON.stringify(next)); setTagText(''); toasts.setError(null); toasts.setNotice(null); clearDialogResult();
  }
  async function start(kind: LibraryKind) {
    if (!await canReplace()) return;
    const next = empty(kind);
    setDraft(next); setSavedText(JSON.stringify(next)); setTagText(''); toasts.setError(null); toasts.setNotice(null); clearDialogResult();
  }
  async function openSection(next: LibrarySection) {
    if (next === section || !await canReplace()) return;
    setSection(next); setDraft(null); setSavedText(''); toasts.setNotice(null); toasts.setError(null); clearDialogResult();
    if (next === 'prompt' || next === 'rule') { setKind(next); setCategoryFilter('*'); }
  }
  async function refresh(nextKind = kind) { setItems(await (remoteTargetId === 'local' ? native.listLibraryItems(nextKind, null, search) : native.listRemoteLibraryItems(remoteTargetId, nextKind, search))); }
  function keepSaved(saved: LibraryItem) {
    setItems((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
  }
  async function save() {
    if (!draft || busy || !nativeAvailable) return;
    setBusy(true); clearDialogResult();
    try {
      const saved = await (remoteTargetId === 'local' ? native.saveLibraryItem(draft) : native.saveRemoteLibraryItem(remoteTargetId, draft));
      setCountStamp((value) => value + 1);
      const next = edit(saved);
      setDraft(next); setSavedText(JSON.stringify(next));
      try { await refresh(); }
      catch (value) {
        keepSaved(saved);
        const failure = listFailureAfterSave(value);
        toasts.showMixed(t('library.page.saved'), failure);
        setDialogNotice(t('library.page.saved'));
        setDialogError(failure);
        return;
      }
      if (saved.kind === 'rule' && rulePlacements.some((item) => item.ruleId === saved.id)) {
        const ids = rulePlacements.filter((item) => item.ruleId === saved.id && item.scope === 'global').map((item) => item.toolId);
        const distributed = await distributeRule(saved.id, saved.version, ids, false);
        if (!distributed) { setDraft(next); setSavedText(JSON.stringify(next)); return; }
        setDraft(null); setSavedText(''); clearDialogResult();
        showNotice(t('library.page.ruleSaved'));
        return;
      }
      setDraft(null); setSavedText(''); clearDialogResult();
      showNotice(t(remoteTargetId === 'local' ? 'library.page.saved' : 'library.page.remoteSaved'));
    } catch (value) { showDialogError(formatFailure(value, t('library.page.saveFailed'), t('library.page.saveFailedNext'))); }
    finally { setBusy(false); }
  }
  function ruleFailure(value: unknown, hint = t('library.page.ruleFailedHint')) {
    const raw = value && typeof value === 'object' && 'message' in value ? String(value.message) : t('library.page.writeIncomplete');
    const detail = raw.trim().replace(/[。！？\s]+$/, '') || t('library.page.writeIncomplete');
    return t('library.page.ruleFailed', { detail, hint });
  }
  function syncRuleSelection(id: string, version: number, toolIds: string[], scope: Scope, projectPath: string | null, allowReplace: boolean) {
    const selection = { toolIds, scope, projectPath, allowReplace };
    return remoteTargetId === 'local'
      ? native.syncRuleClients(id, version, selection)
      : native.syncRemoteRuleClients(remoteTargetId, id, version, selection);
  }
  function reloadRulePlacements() {
    return remoteTargetId === 'local' ? native.listRulePlacements() : native.listRemoteRulePlacements(remoteTargetId);
  }
  async function distributeRule(id: string, version: number, toolIds: string[], allowReplace: boolean) {
    try {
      const synced = await syncRuleSelection(id, version, toolIds, 'global', null, allowReplace);
      const rows = Array.isArray(synced) ? synced : [];
      if (!allowReplace && rows.some((item) => item.status === 'conflict')) {
        const started = latest.current;
        if (!await confirmAction(t('library.page.confirmReplace'), () => mounted.current && latest.current === started, { title: t('library.page.replaceTitle'), confirmLabel: t('library.page.replaceAction') })) {
          showDialogNotice(t('library.page.replaceKept'));
          return false;
        }
        return distributeRule(id, version, toolIds, true);
      }
      const failed = rows.find((item) => item.status === 'failed');
      if (failed) { showDialogError(ruleFailure({ message: failed.detail })); return false; }
      const listed = await reloadRulePlacements().catch(() => rulePlacements);
      setRulePlacements(Array.isArray(listed) ? listed : []);
      return true;
    } catch (value) { showDialogError(ruleFailure(value)); return false; }
  }
  async function toggleRule(item: LibraryItem, toolId: string, scope: Scope, projectPath: string | null) {
    if (busy) return;
    const current = rulePlacements.filter((place) => place.ruleId === item.id && place.scope === scope && (scope === 'global' || samePath(place.projectPath, projectPath))).map((place) => place.toolId);
    const next = current.includes(toolId) ? current.filter((id) => id !== toolId) : [...current, toolId];
    const toolName = scopedTools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(scope, projectPath, projects) }) : '';
    setBusy(true); toasts.setError(null); toasts.setNotice(null);
    try {
      let rows = await syncRuleSelection(item.id, item.version, next, scope, projectPath, false);
      rows = Array.isArray(rows) ? rows : [];
      if (rows.some((row) => row.status === 'conflict')) {
        const started = latest.current;
        if (!await confirmAction(t('library.page.confirmReplaceTool', { title: item.title, tool: toolName }), () => mounted.current && latest.current === started, { title: t('library.page.replaceTitle'), confirmLabel: t('library.page.replaceAction') })) return;
        rows = await syncRuleSelection(item.id, item.version, next, scope, projectPath, true);
        rows = Array.isArray(rows) ? rows : [];
      }
      const failed = rows.find((row) => row.status === 'failed');
      if (failed) { showError(ruleFailure({ message: failed.detail }, t('library.page.ruleFailedRetryIcon'))); return; }
      const listed = await reloadRulePlacements().catch(() => rulePlacements);
      setRulePlacements(Array.isArray(listed) ? listed : []);
      showNotice(next.includes(toolId) ? t('library.page.written', { where, tool: toolName }) : t('library.page.removed', { where, tool: toolName }));
    } catch (value) { showError(ruleFailure(value, t('library.page.ruleFailedRetryIcon'))); }
    finally { setBusy(false); }
  }
  function openLaunch(item: LibraryItem) {
    setLaunchItem(item); setLaunchText(item.body); setLaunchTool(scopedTools[0]?.id ?? ''); setLaunchProject(item.projectId ?? projects.find((project) => project.available)?.id ?? ''); setLaunchError('');
  }
  async function startSession() {
    if (!launchItem || !launchTool || launchBusy) return;
    setLaunchBusy(true); setLaunchError('');
    const request = { toolId: launchTool, projectId: launchProject || null, sessionId: null, mode: 'normal' as const, initialPrompt: launchText };
    try {
      const result = await native.launchCli(request);
      const opened = workbenchSessionId(result);
      setLaunchItem(null);
      if (opened) { onWorkbenchSession?.(opened); return; }
      showNotice(t('library.page.sessionStarted'));
    } catch (value) {
      const desktop = scopedTools.find((item) => item.id === launchTool)?.launchForm === 'desktop';
      if (await failedInWorkbench(desktop)) {
        setLaunchItem(null);
        onWorkbenchFailure?.({ detail: formatFailure(value, t('library.page.sessionFailed'), t('library.page.sessionFailedNext')), retry: { kind: 'launch', request } });
        return;
      }
      setLaunchError(formatFailure(value, t('library.page.sessionFailed'), t('library.page.sessionFailedNext')));
    }
    finally { setLaunchBusy(false); }
  }
  async function remove() {
    if (!draft?.id || draft.expectedVersion === null || busy || !await confirmCurrent(t('library.page.confirmDelete', { title: draft.title }), { title: t('library.page.deleteTitle'), confirmLabel: t('library.page.deleteAction'), destructive: true })) return;
    setBusy(true); clearDialogResult();
    try {
      if (remoteTargetId === 'local') await native.deleteLibraryItem(draft.id, draft.expectedVersion);
      else await native.deleteRemoteLibraryItem(remoteTargetId, draft.id, draft.expectedVersion);
      setCountStamp((value) => value + 1);
      setDraft(null); setSavedText('');
      try { await refresh(); }
      catch (value) {
        toasts.showMixed(t('library.page.deleted'), formatFailure(value, t('library.page.listFailed'), t('library.page.listNext')));
        return;
      }
      showNotice(t(remoteTargetId === 'local' ? 'library.page.deleted' : 'library.page.remoteDeleted'));
    } catch (value) { showDialogError(formatFailure(value, t('library.page.deleteFailed'), t('library.page.deleteFailedNext'))); }
    finally { setBusy(false); }
  }
  async function copy(text: string, surface: 'page' | 'dialog' = 'page', itemId: string | null = null) {
    if (surface === 'dialog') clearDialogResult();
    else { toasts.setNotice(null); toasts.setError(null); setCopiedId(null); }
    try {
      await navigator.clipboard.writeText(text);
      if (surface === 'dialog') showDialogNotice(copiedText());
      else { showNotice(copiedText()); setCopiedId(itemId); }
    } catch {
      if (surface === 'dialog') showDialogError(t('library.page.copyFailed'));
      else showError(t('library.page.copyFailed'));
    }
  }
  function addTag(raw: string) {
    if (!draft) return;
    const next = raw.trim();
    if (!next) return;
    const tags = tagsOf(draft.category);
    if (tags.includes(next)) { setTagText(''); return; }
    const category = categoryOf([...tags, next]);
    if (category.length > 80) return;
    setDraft({ ...draft, category });
    setTagText('');
  }

  if (!nativeAvailable) return <EmptyState icon="library" title={t('library.page.nativeOnly')} />;
  const sectionTabs: Array<[LibrarySection, IconName, string]> = [
    ['prompt', 'sparkle', t('library.page.prompt')],
    ['rule', 'shield', t('library.page.rule')],
    ['mcp', 'connections', 'MCP'],
    ['skill', 'package', 'Skill'],
  ];
  return <section className={styles.page} aria-label={t('library.page.label')} data-host-target={remoteTargetId}><ToastScope toasts={toasts}>
    <Toolbar className={styles.libraryBar} role="group" primary={<Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => { if (section === 'prompt' || section === 'rule') start(kind); else setCreateSignal((value) => value + 1); }}>{section === 'mcp' ? t('library.resources.newMcp') : section === 'skill' ? t('tools.skills.add') : t('library.page.new', { kind: kindName(kind) })}</Button>}>
      <div className="tabs" role="tablist" aria-label={t('library.page.typesAria')} onKeyDown={navigateChoices}>
        {sectionTabs.map(([id, icon, label]) => <button key={id} type="button" role="tab" className={section === id ? 'active' : undefined} aria-selected={section === id} tabIndex={section === id ? 0 : -1} onClick={() => void openSection(id)}>
          <span className={styles.tabIcon} aria-hidden="true"><Icon name={icon} size={15} /></span>
          <span>{label}</span>
          {counts[id] != null && <Badge className={styles.tabCount} tone={section === id ? 'accent' : 'neutral'} aria-hidden="true">{counts[id]}</Badge>}
        </button>)}
      </div>
    </Toolbar>
    {section === 'mcp' && <LibraryMcp active={active} tools={scopedTools} projects={projects} remoteTargetId={remoteTargetId === 'local' ? null : remoteTargetId} spotlight={section === 'mcp' ? mcpSpotlight : null} onOpenConnections={mcpSpotlight?.source === 'connections' ? onOpenConnections : undefined} createSignal={createSignal} onCountChange={(count) => setCounts((prev) => prev.mcp === count ? prev : { ...prev, mcp: count })} />}
    {section === 'skill' && <LibraryResources active={active} tools={scopedTools} projects={projects} remoteTargetId={remoteTargetId === 'local' ? null : remoteTargetId} createSignal={createSignal} onCountChange={(count) => setCounts((prev) => prev.skill === count ? prev : { ...prev, skill: count })} />}
    {(section === 'prompt' || section === 'rule') && <>
    <div className={styles.filters}>
      <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.page.searchPlaceholder')} />
      <FilterSelect className={styles.filterPick} label={t('library.page.projectFilter')} value={projectFilter} options={[
        { value: '*', label: t('library.page.allProjects') },
        { value: 'global', label: t('library.page.globalItems') },
        ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : t('library.page.staleDir') })),
      ]} searchLabel={t('home.launcher.searchLabel')} onChange={setProjectFilter} />
      <FilterSelect className={styles.filterPick} label={t('library.page.tagFilter')} value={categoryFilter} options={[
        { value: '*', label: t('library.page.allTags') },
        ...categories.map((category) => ({ value: category, label: category })),
      ]} searchLabel={t('library.page.searchTags')} onChange={setCategoryFilter} />
    </div>
    <div className={styles.layout}>
      {(!listLoading || items.length > 0) && <div><Badge>{t('library.page.countFiltered', { filtered: shown.length, total: listTotal })}</Badge></div>}
      <div className={styles.list} aria-label={t('library.page.listAria', { kind: kindName(kind) })}>
        {listLoading && !items.length ? <SkeletonRows count={3} /> : shown.length ? shown.map((item) => <Card className={styles.card} interactive key={item.id} data-library-id={item.id}>
          {(tagsOf(item.category).length > 0 || item.projectId || item.updatedAt) && <small className={styles.cardMeta}>
            {tagsOf(item.category).map((tag) => <Badge className={styles.metaBadge} tone="accent" key={tag}>{tag}</Badge>)}
            {item.projectId && <Badge className={styles.metaBadge}>{projects.find((project) => project.id === item.projectId)?.name ?? t('library.page.originalProject')}</Badge>}
            {!!item.updatedAt && <span className={styles.cardTime} title={fullTime(item.updatedAt)}><Icon name="clock" size={12} />{shortTime(item.updatedAt)}</span>}
          </small>}
          <button className={styles.cardTitle} type="button" data-card-title onClick={() => choose(item)} onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const titles = Array.from(event.currentTarget.closest(`.${styles.list}`)?.querySelectorAll<HTMLElement>('[data-card-title]') ?? []);
            const next = titles[titles.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)];
            if (next) { event.preventDefault(); next.focus(); }
          }}>{item.title}</button>
          <p className={styles.cardBody}>{item.body ? item.body.length > 160 ? `${item.body.slice(0, 160)}…` : item.body : t('library.page.emptyBody')}</p>
          <div className={styles.cardBar}>
            {kind === 'rule' ? <ScopeMarks label={t('library.page.cliMarks', { title: item.title })} tools={scopedTools} places={rulePlacements.filter((entry) => entry.ruleId === item.id)} projects={projects} busy={busy} unavailable={(toolId, scope) => { const support = scopedTools.find(tool => tool.id === toolId)?.management?.rules; if (!support) return null; if (scope === 'project' && support.catalog) return t('library.page.ruleCatalog'); if (!support[scope]) return (scope === 'global' ? support.globalReason : support.projectReason) || t('library.page.ruleUnsupported', { scope: scope === 'global' ? t('tools.apply.global') : t('tools.accounts.scopeProject') }); return null; }} onToggle={(toolId, scope, projectPath) => void toggleRule(item, toolId, scope, projectPath)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('library.page.markOff') };
              if (place.state === 'current') return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
              if (place.state === 'unavailable') return { pressed: true, state: 'unavailable', status: t('library.page.markUnavailable') };
              return { pressed: true, state: 'drifted', status: t('library.page.markDrifted') };
            }} /> : <span />}
            <div className={styles.cardActions}>{copiedId === item.id && toasts.notice?.text === copiedText()
              ? <Button variant="ghost" size="sm" aria-label={t('library.page.copy')} data-copied="true" icon={<Icon name="check" size={14} />} onClick={() => void copy(item.body, 'page', item.id)}>{t('home.launcher.copied')}</Button>
              : <Button variant="ghost" size="sm" onClick={() => void copy(item.body, 'page', item.id)} disabled={!item.body}>{t('library.page.copy')}</Button>}{kind === 'prompt' && <Button size="sm" onClick={() => openLaunch(item)} disabled={!item.body}>{t('library.page.launch')}</Button>}<Button variant="ghost" size="sm" onClick={() => choose(item)}>{t('tools.workspace.edit')}</Button></div>
          </div>
        </Card>) : !items.length && !search.trim()
          ? <div className={styles.empty}><Icon name="library" size={24} /><strong>{t('library.page.emptyTitle', { kind: kindName(kind) })}</strong>{kind === 'prompt' ? t('library.page.emptyPrompt') : t('library.page.emptyRule')}<Button icon={<Icon name="plus" size={14} />} onClick={() => start(kind)}>{t('library.page.emptyCreate', { kind: kindName(kind) })}</Button></div>
          : <div className={styles.empty}><Icon name="search" size={24} />{t('library.page.noResults', { kind: kindName(kind) })}</div>}
      </div>
    </div>
    <GuideDialog open={!!draft} title={draft?.id ? t('library.page.editTitle', { kind: kindName(kind) }) : t('library.page.newTitle', { kind: kindName(kind) })} hint={kind === 'rule' ? t('library.page.ruleHint') : t('library.page.promptHint')} onClose={() => { void (async () => { if (await canReplace()) { setDraft(null); setSavedText(''); clearDialogResult(); } })(); }}>
      {draft && <div className={styles.editor}>
        {dialogError && <div className={styles.error} role="alert">{dialogError}</div>}
        {dialogNotice && <div className={styles.notice} role="status">{dialogNotice}</div>}
        <div className={styles.fields}>
          <label>{t('library.page.title')}<input autoFocus={!draft.id} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder={t('library.page.titlePlaceholder')} /></label>
          <label>{t('library.page.project')}<FilterSelect label={t('library.page.project')} value={draft.projectId ?? ''} options={[{ value: '', label: t('tools.apply.global') }, ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : t('library.page.staleDir') }))]} searchLabel={t('home.launcher.searchLabel')} onChange={(value) => setDraft({ ...draft, projectId: value || null })} /></label>
          <div className={styles.tags}>{t('library.page.tags')}
            <div className={styles.tagList}>
              {tagsOf(draft.category).map((tag) => <button type="button" key={tag} onClick={() => setDraft({ ...draft, category: categoryOf(tagsOf(draft.category).filter((item) => item !== tag)) })}>{tag} ×</button>)}
              <input aria-label={t('library.page.addTagAria')} value={tagText} placeholder={t('library.page.tagPlaceholder')} onChange={(event) => setTagText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(tagText); } }} />
            </div>
            {!!categories.filter((tag) => !tagsOf(draft.category).includes(tag)).length && <div className={styles.tagSuggestions}>{categories.filter((tag) => !tagsOf(draft.category).includes(tag)).map((tag) => <button type="button" key={tag} onClick={() => addTag(tag)}>{tag}</button>)}</div>}
          </div>
        </div>
        <label className={styles.body}><span className={styles.bodyHead}>{t('library.page.body')}<span className={styles.charCount}>{t('library.page.charCount', { count: draft.body.length })}</span></span><CodeEditor key={draft.id ?? 'new'} label={t('library.page.bodyEditorLabel')} format="markdown" value={draft.body} onChange={(body) => setDraft({ ...draft, body })} placeholder={kind === 'prompt' ? t('library.page.bodyPromptPlaceholder') : t('library.page.bodyRulePlaceholder')} /></label>
        <div className="dialog-footer"><span className={styles.saveState} data-dirty={dirty || undefined}>{dirty ? t('library.page.dirtyState') : t('tools.config.statusSaved')}</span><span className="dialog-footer-gap" /><Button onClick={() => void copy(draft.body, 'dialog')} disabled={!draft.body}>{t('library.page.copy')}</Button>{draft.id && <Button variant="ghost" className={styles.danger} onClick={() => void remove()} disabled={busy}>{t('tools.agents.delete')}</Button>}<Button variant="primary" data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.title.trim()} onClick={() => void save()}>{t('home.launcher.save')}</Button></div>
      </div>}
    </GuideDialog>
    <GuideDialog open={!!launchItem} title={t('library.page.launchTitle')} hint={t('library.page.launchHint')} onClose={() => { if (!launchBusy) setLaunchItem(null); }}>
      {launchItem && <div className={styles.editor}>
        {launchError && <div className={styles.error} role="alert">{launchError}</div>}
        <div className={styles.fields}>
          <label>CLI<FilterSelect label={t('library.page.launchCli')} value={launchTool} options={toolOptions(scopedTools)} placeholder={t('library.page.noCli')} disabled={!scopedTools.length} searchLabel={t('library.page.searchCli')} onChange={setLaunchTool} /></label>
          <label>{t('library.page.launchProjectLabel')}<FilterSelect label={t('library.page.launchProject')} value={launchProject} options={[{ value: '', label: t('library.page.noProject') }, ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : t('library.page.staleDir') }))]} searchLabel={t('home.launcher.searchLabel')} onChange={setLaunchProject} /></label>
        </div>
        <label className={styles.body}>{t('library.page.firstMessage')}<textarea aria-label={t('library.page.launchPromptAria')} rows={8} value={launchText} onChange={(event) => setLaunchText(event.target.value)} /></label>
        <div className="dialog-footer"><span className="dialog-footer-gap" /><Button onClick={() => setLaunchItem(null)} disabled={launchBusy}>{t('common.dialog.cancel')}</Button><Button variant="primary" disabled={launchBusy || !launchTool || !launchText.trim()} onClick={() => void startSession()}>{t('library.page.launchSubmit')}</Button></div>
      </div>}
    </GuideDialog>
    </>}
  </ToastScope></section>;
}
