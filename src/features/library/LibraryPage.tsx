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
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import { toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/EmptyState';
import { shortPath } from '../../lib/paths';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import { formatFailure } from '../../lib/feedback';
import { useToasts } from '../../lib/toast';
import { ToastStack } from '../../components/Toast';
import { SkeletonRows } from '../../components/Skeleton';
import { navigateChoices } from '../../lib/choiceNavigation';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
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

export function LibraryPage({ managedTools = [], active = true }: { managedTools?: AdapterDescriptor[]; active?: boolean }) {
  const { t } = useTranslation();
  const kindName = (value: LibraryKind) => t(value === 'prompt' ? 'library.page.prompt' : 'library.page.ruleShort');
  const [section, setSection] = useState<LibrarySection>('prompt');
  const [kind, setKind] = useState<LibraryKind>('prompt');
  const [search, setSearch] = useState('');
  const [createSignal, setCreateSignal] = useState(0);
  const [projectFilter, setProjectFilter] = useState('*');
  const [categoryFilter, setCategoryFilter] = useState('*');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [counts, setCounts] = useState<Partial<Record<LibraryKind, number>>>({});
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
    void native.listProjects().then(setProjects).catch((value) => showError(formatFailure(value, t('library.page.projectsFailed'), t('library.page.projectsFailedNext'))));
    void native.listRulePlacements().then((rows) => setRulePlacements(Array.isArray(rows) ? rows : [])).catch(() => setRulePlacements([]));
  }, [active]);
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    void Promise.all([native.listLibraryItems('prompt', null, ''), native.listLibraryItems('rule', null, '')])
      .then(([prompts, rules]) => { if (live) setCounts({ prompt: prompts.length, rule: rules.length }); })
      .catch(() => {});
    return () => { live = false; };
  }, [active, countStamp]);
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    setListLoading(true);
    void native.listLibraryItems(kind, null, search).then((result) => { if (live) { setItems(result); setListLoading(false); } })
      .catch((value) => { if (live) { setListLoading(false); showError(formatFailure(value, t('library.page.listFailed'), t('library.page.listNext'))); } });
    return () => { live = false; };
  }, [active, kind, search]);

  const categories = useMemo(() => Array.from(new Set(items.flatMap((item) => tagsOf(item.category)))).sort(), [items]);
  const shown = items.filter((item) => (projectFilter === '*' || (projectFilter === 'global' ? !item.projectId : item.projectId === projectFilter))
    && (categoryFilter === '*' || tagsOf(item.category).includes(categoryFilter)));

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
  async function refresh(nextKind = kind) { setItems(await native.listLibraryItems(nextKind, null, search)); }
  function keepSaved(saved: LibraryItem) {
    setItems((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
  }
  async function save() {
    if (!draft || busy || !nativeAvailable) return;
    setBusy(true); clearDialogResult();
    try {
      const saved = await native.saveLibraryItem(draft);
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
      showNotice(t('library.page.saved'));
    } catch (value) { showDialogError(formatFailure(value, t('library.page.saveFailed'), t('library.page.saveFailedNext'))); }
    finally { setBusy(false); }
  }
  function ruleFailure(value: unknown, hint = t('library.page.ruleFailedHint')) {
    const raw = value && typeof value === 'object' && 'message' in value ? String(value.message) : t('library.page.writeIncomplete');
    const detail = raw.trim().replace(/[。！？\s]+$/, '') || t('library.page.writeIncomplete');
    return t('library.page.ruleFailed', { detail, hint });
  }
  async function distributeRule(id: string, version: number, toolIds: string[], allowReplace: boolean) {
    try {
      const synced = await native.syncRuleClients(id, version, { toolIds, scope: 'global', projectPath: null, allowReplace });
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
      const listed = await native.listRulePlacements().catch(() => rulePlacements);
      setRulePlacements(Array.isArray(listed) ? listed : []);
      return true;
    } catch (value) { showDialogError(ruleFailure(value)); return false; }
  }
  async function toggleRule(item: LibraryItem, toolId: string, scope: Scope, projectPath: string | null) {
    if (busy) return;
    const current = rulePlacements.filter((place) => place.ruleId === item.id && place.scope === scope && (scope === 'global' || samePath(place.projectPath, projectPath))).map((place) => place.toolId);
    const next = current.includes(toolId) ? current.filter((id) => id !== toolId) : [...current, toolId];
    const toolName = managedTools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(scope, projectPath, projects) }) : '';
    setBusy(true); toasts.setError(null); toasts.setNotice(null);
    try {
      let rows = await native.syncRuleClients(item.id, item.version, { toolIds: next, scope, projectPath, allowReplace: false });
      rows = Array.isArray(rows) ? rows : [];
      if (rows.some((row) => row.status === 'conflict')) {
        const started = latest.current;
        if (!await confirmAction(t('library.page.confirmReplaceTool', { title: item.title, tool: toolName }), () => mounted.current && latest.current === started, { title: t('library.page.replaceTitle'), confirmLabel: t('library.page.replaceAction') })) return;
        rows = await native.syncRuleClients(item.id, item.version, { toolIds: next, scope, projectPath, allowReplace: true });
        rows = Array.isArray(rows) ? rows : [];
      }
      const failed = rows.find((row) => row.status === 'failed');
      if (failed) { showError(ruleFailure({ message: failed.detail }, t('library.page.ruleFailedRetryIcon'))); return; }
      const listed = await native.listRulePlacements().catch(() => rulePlacements);
      setRulePlacements(Array.isArray(listed) ? listed : []);
      showNotice(next.includes(toolId) ? t('library.page.written', { where, tool: toolName }) : t('library.page.removed', { where, tool: toolName }));
    } catch (value) { showError(ruleFailure(value, t('library.page.ruleFailedRetryIcon'))); }
    finally { setBusy(false); }
  }
  function openLaunch(item: LibraryItem) {
    setLaunchItem(item); setLaunchText(item.body); setLaunchTool(managedTools[0]?.id ?? ''); setLaunchProject(item.projectId ?? projects.find((project) => project.available)?.id ?? ''); setLaunchError('');
  }
  async function startSession() {
    if (!launchItem || !launchTool || launchBusy) return;
    setLaunchBusy(true); setLaunchError('');
    try {
      await native.launchCli({ toolId: launchTool, projectId: launchProject || null, sessionId: null, mode: 'normal', initialPrompt: launchText });
      setLaunchItem(null);
      showNotice(t('library.page.sessionStarted'));
    } catch (value) { setLaunchError(formatFailure(value, t('library.page.sessionFailed'), t('library.page.sessionFailedNext'))); }
    finally { setLaunchBusy(false); }
  }
  async function remove() {
    if (!draft?.id || draft.expectedVersion === null || busy || !await confirmCurrent(t('library.page.confirmDelete', { title: draft.title }), { title: t('library.page.deleteTitle'), confirmLabel: t('library.page.deleteAction'), destructive: true })) return;
    setBusy(true); clearDialogResult();
    try {
      await native.deleteLibraryItem(draft.id, draft.expectedVersion);
      setCountStamp((value) => value + 1);
      setDraft(null); setSavedText('');
      try { await refresh(); }
      catch (value) {
        toasts.showMixed(t('library.page.deleted'), formatFailure(value, t('library.page.listFailed'), t('library.page.listNext')));
        return;
      }
      showNotice(t('library.page.deleted'));
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
  return <section className={styles.page} aria-label={t('library.page.label')}>
    <div className={styles.toolbar}>
      <div className={styles.tabs} role="tablist" aria-label={t('library.page.typesAria')} onKeyDown={navigateChoices}>
        <button type="button" role="tab" aria-selected={section === 'prompt'} tabIndex={section === 'prompt' ? 0 : -1} onClick={() => void openSection('prompt')}>{t('library.page.prompt')}{counts.prompt != null && <span className={styles.tabCount} aria-hidden="true">{counts.prompt}</span>}</button>
        <button type="button" role="tab" aria-selected={section === 'rule'} tabIndex={section === 'rule' ? 0 : -1} onClick={() => void openSection('rule')}>{t('library.page.rule')}{counts.rule != null && <span className={styles.tabCount} aria-hidden="true">{counts.rule}</span>}</button>
        <button type="button" role="tab" aria-selected={section === 'mcp'} tabIndex={section === 'mcp' ? 0 : -1} onClick={() => void openSection('mcp')}>MCP</button>
        <button type="button" role="tab" aria-selected={section === 'skill'} tabIndex={section === 'skill' ? 0 : -1} onClick={() => void openSection('skill')}>Skill</button>
      </div>
      <button type="button" className={styles.primary} onClick={() => { if (section === 'prompt' || section === 'rule') start(kind); else setCreateSignal((value) => value + 1); }}><Icon name="plus" size={14} strokeWidth={2.2} />{section === 'mcp' ? t('library.resources.newMcp') : section === 'skill' ? t('tools.skills.add') : t('library.page.new', { kind: kindName(kind) })}</button>
    </div>
    {(section === 'mcp' || section === 'skill') && <LibraryResources section={section} active={active} tools={managedTools} projects={projects} createSignal={createSignal} />}
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
      <div className={styles.list} aria-label={t('library.page.listAria', { kind: kindName(kind) })}>
        {listLoading && !items.length ? <SkeletonRows count={3} /> : shown.length ? shown.map((item) => <article className={styles.card} key={item.id}>
          {(tagsOf(item.category).length > 0 || item.projectId || item.updatedAt) && <small className={styles.cardMeta}>
            {tagsOf(item.category).map((tag) => <em className={styles.tagChip} key={tag}>{tag}</em>)}
            {item.projectId && <span className={styles.cardProject}>{projects.find((project) => project.id === item.projectId)?.name ?? t('library.page.originalProject')}</span>}
            {!!item.updatedAt && <span className={styles.cardTime} title={fullTime(item.updatedAt)}><Icon name="clock" size={11} />{shortTime(item.updatedAt)}</span>}
          </small>}
          <button className={styles.cardTitle} type="button" data-card-title onClick={() => choose(item)} onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const titles = Array.from(event.currentTarget.closest(`.${styles.list}`)?.querySelectorAll<HTMLElement>('[data-card-title]') ?? []);
            const next = titles[titles.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)];
            if (next) { event.preventDefault(); next.focus(); }
          }}>{item.title}</button>
          <p>{item.body ? item.body.length > 160 ? `${item.body.slice(0, 160)}…` : item.body : t('library.page.emptyBody')}</p>
          <div className={styles.cardBar}>
            {kind === 'rule' ? <ScopeMarks label={t('library.page.cliMarks', { title: item.title })} tools={managedTools} places={rulePlacements.filter((entry) => entry.ruleId === item.id)} projects={projects} busy={busy} unavailable={(toolId, scope) => { const support = managedTools.find(tool => tool.id === toolId)?.management?.rules; return support && !support[scope] ? t('library.page.ruleUnsupported', { scope: scope === 'global' ? t('tools.apply.global') : t('tools.accounts.scopeProject') }) : null; }} onToggle={(toolId, scope, projectPath) => void toggleRule(item, toolId, scope, projectPath)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('library.page.markOff') };
              if (place.state === 'current') return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
              if (place.state === 'unavailable') return { pressed: true, state: 'unavailable', status: t('library.page.markUnavailable') };
              return { pressed: true, state: 'drifted', status: t('library.page.markDrifted') };
            }} /> : <span />}
            <div className={styles.cardActions}>{copiedId === item.id && toasts.notice?.text === copiedText()
              ? <button type="button" className={styles.quiet} aria-label={t('library.page.copy')} data-copied="true" onClick={() => void copy(item.body, 'page', item.id)}><Icon name="check" size={13} strokeWidth={2.2} />{t('home.launcher.copied')}</button>
              : <button type="button" className={styles.quiet} onClick={() => void copy(item.body, 'page', item.id)} disabled={!item.body}>{t('library.page.copy')}</button>}{kind === 'prompt' && <button type="button" className={styles.cardLaunch} onClick={() => openLaunch(item)} disabled={!item.body}>{t('library.page.launch')}</button>}<button type="button" className={styles.quiet} onClick={() => choose(item)}>{t('tools.workspace.edit')}</button></div>
          </div>
        </article>) : !items.length && !search.trim()
          ? <div className={styles.empty}><Icon name="library" size={28} strokeWidth={1.3} /><strong>{t('library.page.emptyTitle', { kind: kindName(kind) })}</strong>{kind === 'prompt' ? t('library.page.emptyPrompt') : t('library.page.emptyRule')}<button type="button" className={styles.primary} onClick={() => start(kind)}><Icon name="plus" size={14} strokeWidth={2.2} />{t('library.page.emptyCreate', { kind: kindName(kind) })}</button></div>
          : <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />{t('library.page.noResults', { kind: kindName(kind) })}</div>}
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
        <div className="dialog-footer"><span className={styles.saveState} data-dirty={dirty || undefined}>{dirty ? t('library.page.dirtyState') : t('tools.config.statusSaved')}</span><span className="dialog-footer-gap" /><button type="button" onClick={() => void copy(draft.body, 'dialog')} disabled={!draft.body}>{t('library.page.copy')}</button>{draft.id && <button type="button" onClick={() => void remove()} disabled={busy}>{t('tools.agents.delete')}</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.title.trim()} onClick={() => void save()}>{t('home.launcher.save')}</button></div>
      </div>}
    </GuideDialog>
    <GuideDialog open={!!launchItem} title={t('library.page.launchTitle')} hint={t('library.page.launchHint')} onClose={() => { if (!launchBusy) setLaunchItem(null); }}>
      {launchItem && <div className={styles.editor}>
        {launchError && <div className={styles.error} role="alert">{launchError}</div>}
        <div className={styles.fields}>
          <label>CLI<FilterSelect label={t('library.page.launchCli')} value={launchTool} options={toolOptions(managedTools)} placeholder={t('library.page.noCli')} disabled={!managedTools.length} searchLabel={t('library.page.searchCli')} onChange={setLaunchTool} /></label>
          <label>{t('library.page.launchProjectLabel')}<FilterSelect label={t('library.page.launchProject')} value={launchProject} options={[{ value: '', label: t('library.page.noProject') }, ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : t('library.page.staleDir') }))]} searchLabel={t('home.launcher.searchLabel')} onChange={setLaunchProject} /></label>
        </div>
        <label className={styles.body}>{t('library.page.firstMessage')}<textarea aria-label={t('library.page.launchPromptAria')} rows={8} value={launchText} onChange={(event) => setLaunchText(event.target.value)} /></label>
        <div className="dialog-footer"><span className="dialog-footer-gap" /><button type="button" onClick={() => setLaunchItem(null)} disabled={launchBusy}>{t('common.dialog.cancel')}</button><button type="button" className={styles.primary} disabled={launchBusy || !launchTool || !launchText.trim()} onClick={() => void startSession()}>{t('library.page.launchSubmit')}</button></div>
      </div>}
    </GuideDialog>
    </>}
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </section>;
}
