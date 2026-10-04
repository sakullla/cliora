import { CodeEditor } from '../../components/CodeEditor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction, type ConfirmationOptions } from '../../lib/confirm';
import type { Project } from '../../types/launch';
import type { LibraryDraft, LibraryItem, LibraryKind } from '../../types/library';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { RulePlacement } from '../../types/resources';
import { LibraryResources } from './LibraryResources';
import { FilterSelect } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { shortPath } from '../../lib/paths';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import { navigateChoices } from '../../lib/choiceNavigation';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import styles from './LibraryPage.module.css';

const copiedText = '完整正文已复制，可以粘贴使用。';

function formatFailure(error: unknown, objectText: string, nextText: string): string {
  const fallback = `${objectText}。${nextText}`;
  if (typeof error === 'string') {
    const text = error.trim();
    return !text || text.replace(/[。！？，,\s]/g, '') === '操作失败请重试' ? fallback : text;
  }
  if (!error || typeof error !== 'object') return fallback;
  const value = error as { message?: unknown; action?: unknown };
  const raw = 'message' in value && value.message != null ? String(value.message).trim() : '';
  const action = typeof value.action === 'string' ? value.action.trim() : '';
  if (!raw || raw.replace(/[。！？，,\s]/g, '') === '操作失败请重试' || /^操作失败[。！]?$/.test(raw)) {
    const next = action && !/^请重试[。！]?$/.test(action) ? action : nextText;
    const step = /[。！？]$/.test(next) ? next : `${next}。`;
    return `${objectText}。${step}`;
  }
  const detail = raw.replace(/[。！？\s]+$/, '');
  const next = action || nextText;
  const bare = next.replace(/[。！？\s]+$/, '');
  if (!bare || detail.includes(bare)) return /[。！？]$/.test(raw) ? raw : `${detail}。`;
  return `${detail}。${/[。！？]$/.test(next) ? next : `${next}。`}`;
}

const libraryNext = '可调整搜索，或点击上方的新建。';
const savedListNext = '可点击关闭后查看列表。';

function listFailureAfterSave(value: unknown): string {
  const formatted = formatFailure(value, '资料列表读取失败', savedListNext);
  if (!/搜索|新建/.test(formatted)) return formatted;
  const detail = formatted.replace(/可调整搜索[，,]?\s*或?\s*点击上方的新建[。！]?/g, '').replace(/[。！？\s]+$/g, '').trim();
  return `${detail || '资料列表读取失败'}。${savedListNext}`;
}

function empty(kind: LibraryKind): LibraryDraft {
  return { id: null, kind, title: '', body: '', category: '', projectId: null, expectedVersion: null };
}

function tagsOf(category: string): string[] {
  return [...new Set(category.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))];
}

function fullTime(value: number) {
  return new Date(value * 1000).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortTime(value: number) {
  return new Date(value * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function categoryOf(tags: string[]): string {
  return tags.join(',');
}

function edit(item: LibraryItem): LibraryDraft {
  return { id: item.id, kind: item.kind, title: item.title, body: item.body, category: item.category, projectId: item.projectId, expectedVersion: item.version };
}

type LibrarySection = LibraryKind | 'mcp' | 'skill';

export function LibraryPage({ managedTools = [], active = true }: { managedTools?: AdapterDescriptor[]; active?: boolean }) {
  const [section, setSection] = useState<LibrarySection>('prompt');
  const [kind, setKind] = useState<LibraryKind>('prompt');
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('*');
  const [categoryFilter, setCategoryFilter] = useState('*');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [counts, setCounts] = useState<Partial<Record<LibraryKind, number>>>({});
  const [countStamp, setCountStamp] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<LibraryDraft | null>(null);
  const [savedText, setSavedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
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
  }, [copiedId, notice]);
  const dirty = !!draft && JSON.stringify(draft) !== savedText;
  const latest = useRef(''); latest.current = JSON.stringify([kind, draft, active]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function confirmCurrent(message: string, options: ConfirmationOptions = { title: '放弃未保存修改？', confirmLabel: '放弃修改' }) {
    const started = latest.current;
    return confirmAction(message, () => mounted.current && latest.current === started, options);
  }

  function showError(text: string) { setNotice(''); setError(text); }
  function showNotice(text: string) { setError(''); setNotice(text); }
  function showDialogError(text: string) { setDialogNotice(''); setDialogError(text); }
  function showDialogNotice(text: string) { setDialogError(''); setDialogNotice(text); }
  function clearDialogResult() { setDialogError(''); setDialogNotice(''); }

  useEffect(() => {
    if (!nativeAvailable || !active) return;
    void native.listProjects().then(setProjects).catch((value) => showError(formatFailure(value, '项目列表读取失败', '可先打开其他页面，再回到资料库重新读取。')));
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
    void native.listLibraryItems(kind, null, search).then((result) => { if (live) setItems(result); })
      .catch((value) => { if (live) showError(formatFailure(value, '资料列表读取失败', libraryNext)); });
    return () => { live = false; };
  }, [active, kind, search]);

  const categories = useMemo(() => Array.from(new Set(items.flatMap((item) => tagsOf(item.category)))).sort(), [items]);
  const shown = items.filter((item) => (projectFilter === '*' || (projectFilter === 'global' ? !item.projectId : item.projectId === projectFilter))
    && (categoryFilter === '*' || tagsOf(item.category).includes(categoryFilter)));

  async function canReplace() { return !dirty || confirmCurrent('当前资料草稿尚未保存，切换会丢失修改。继续吗？'); }
  async function choose(item: LibraryItem) {
    if (!await canReplace()) return;
    const next = edit(item);
    setDraft(next); setSavedText(JSON.stringify(next)); setTagText(''); setError(''); setNotice(''); clearDialogResult();
  }
  async function start(kind: LibraryKind) {
    if (!await canReplace()) return;
    const next = empty(kind);
    setDraft(next); setSavedText(JSON.stringify(next)); setTagText(''); setError(''); setNotice(''); clearDialogResult();
  }
  async function openSection(next: LibrarySection) {
    if (next === section || !await canReplace()) return;
    setSection(next); setDraft(null); setSavedText(''); setNotice(''); setError(''); clearDialogResult();
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
        setNotice('已保存在本机资料库。');
        setError(failure);
        setDialogNotice('已保存在本机资料库。');
        setDialogError(failure);
        return;
      }
      if (saved.kind === 'rule' && rulePlacements.some((item) => item.ruleId === saved.id)) {
        const ids = rulePlacements.filter((item) => item.ruleId === saved.id && item.scope === 'global').map((item) => item.toolId);
        const distributed = await distributeRule(saved.id, saved.version, ids, false);
        if (!distributed) { setDraft(next); setSavedText(JSON.stringify(next)); return; }
        setDraft(null); setSavedText(''); clearDialogResult();
        showNotice('规则已保存。');
        return;
      }
      setDraft(null); setSavedText(''); clearDialogResult();
      showNotice('已保存在本机资料库。');
    } catch (value) { showDialogError(formatFailure(value, '资料保存失败', '可修改后再次点击保存。')); }
    finally { setBusy(false); }
  }
  function ruleFailure(value: unknown) {
    const raw = value && typeof value === 'object' && 'message' in value ? String(value.message) : '写入没有完成';
    const detail = raw.trim().replace(/[。！？\s]+$/, '') || '写入没有完成';
    return `规则保存失败：${detail}。可以修改后再次点击保存并分发。`;
  }
  async function distributeRule(id: string, version: number, toolIds: string[], allowReplace: boolean) {
    try {
      const synced = await native.syncRuleClients(id, version, { toolIds, scope: 'global', projectPath: null, allowReplace });
      const rows = Array.isArray(synced) ? synced : [];
      if (!allowReplace && rows.some((item) => item.status === 'conflict')) {
        const started = latest.current;
        if (!await confirmAction('规则文件已有外部修改。确认后用拼接结果替换。', () => mounted.current && latest.current === started, { title: '替换规则文件？', confirmLabel: '替换并写入' })) {
          showDialogNotice('正文已保存。规则文件保持原样。');
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
    const where = scope === 'project' ? `${scopeLabel(scope, projectPath, projects)} 的 ` : '';
    setBusy(true); setError(''); setNotice('');
    try {
      let rows = await native.syncRuleClients(item.id, item.version, { toolIds: next, scope, projectPath, allowReplace: false });
      rows = Array.isArray(rows) ? rows : [];
      if (rows.some((row) => row.status === 'conflict')) {
        const started = latest.current;
        if (!await confirmAction(`「${item.title}」要写入的 ${toolName} 规则文件已有外部修改。确认后用拼接结果替换。`, () => mounted.current && latest.current === started, { title: '替换规则文件？', confirmLabel: '替换并写入' })) return;
        rows = await native.syncRuleClients(item.id, item.version, { toolIds: next, scope, projectPath, allowReplace: true });
        rows = Array.isArray(rows) ? rows : [];
      }
      const failed = rows.find((row) => row.status === 'failed');
      if (failed) { showError(ruleFailure({ message: failed.detail }).replace('可以修改后再次点击保存并分发', '可以再次点击该 CLI 图标')); return; }
      const listed = await native.listRulePlacements().catch(() => rulePlacements);
      setRulePlacements(Array.isArray(listed) ? listed : []);
      showNotice(next.includes(toolId) ? `已写入 ${where}${toolName}。` : `已从 ${where}${toolName} 移除。`);
    } catch (value) { showError(ruleFailure(value).replace('可以修改后再次点击保存并分发', '可以再次点击该 CLI 图标')); }
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
      showNotice('已请求外部终端启动会话。');
    } catch (value) { setLaunchError(formatFailure(value, '会话没有启动', '可以修改提示词后再次点击启动。')); }
    finally { setLaunchBusy(false); }
  }
  async function remove() {
    if (!draft?.id || draft.expectedVersion === null || busy || !await confirmCurrent(`删除“${draft.title}”？`, { title: '删除资料', confirmLabel: '删除资料', destructive: true })) return;
    setBusy(true); clearDialogResult();
    try {
      await native.deleteLibraryItem(draft.id, draft.expectedVersion);
      setCountStamp((value) => value + 1);
      setDraft(null); setSavedText('');
      try { await refresh(); }
      catch (value) {
        showNotice('已删除。');
        setError(formatFailure(value, '资料列表读取失败', libraryNext));
        return;
      }
      showNotice('已删除。');
    } catch (value) { showDialogError(formatFailure(value, '资料删除失败', '可再次点击删除。')); }
    finally { setBusy(false); }
  }
  async function copy(text: string, surface: 'page' | 'dialog' = 'page', itemId: string | null = null) {
    if (surface === 'dialog') clearDialogResult();
    else { setNotice(''); setError(''); setCopiedId(null); }
    try {
      await navigator.clipboard.writeText(text);
      if (surface === 'dialog') showDialogNotice(copiedText);
      else { showNotice(copiedText); setCopiedId(itemId); }
    } catch {
      if (surface === 'dialog') showDialogError('复制失败，正文仍在页面上，可以手动选择。');
      else showError('复制失败，正文仍在页面上，可以手动选择。');
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

  if (!nativeAvailable) return <div className={styles.empty}>资料库仅在桌面应用中读取和保存。</div>;
  return <section className={styles.page} aria-label="资料库内容">
    <div className={styles.toolbar}>
      <div className={styles.tabs} role="tablist" aria-label="资料类型" onKeyDown={navigateChoices}>
        <button type="button" role="tab" aria-selected={section === 'prompt'} tabIndex={section === 'prompt' ? 0 : -1} onClick={() => void openSection('prompt')}>提示词{counts.prompt != null && <span className={styles.tabCount} aria-hidden="true">{counts.prompt}</span>}</button>
        <button type="button" role="tab" aria-selected={section === 'rule'} tabIndex={section === 'rule' ? 0 : -1} onClick={() => void openSection('rule')}>长期规则{counts.rule != null && <span className={styles.tabCount} aria-hidden="true">{counts.rule}</span>}</button>
        <button type="button" role="tab" aria-selected={section === 'mcp'} tabIndex={section === 'mcp' ? 0 : -1} onClick={() => void openSection('mcp')}>MCP</button>
        <button type="button" role="tab" aria-selected={section === 'skill'} tabIndex={section === 'skill' ? 0 : -1} onClick={() => void openSection('skill')}>Skill</button>
      </div>
      {(section === 'prompt' || section === 'rule') && <button type="button" className={styles.primary} onClick={() => start(kind)}>＋ 新建{kind === 'prompt' ? '提示词' : '规则'}</button>}
    </div>
    {(section === 'mcp' || section === 'skill') && <LibraryResources section={section} active={active} tools={managedTools} projects={projects} />}
    {(section === 'prompt' || section === 'rule') && <>
    <div className={styles.filters}>
      <div className={styles.searchBox}>
        <Icon name="search" size={14} />
        <input aria-label="搜索资料" data-page-search title={searchShortcutHint} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); setSearch(''); } }} placeholder="搜索标题、正文或标签" />
      </div>
      <FilterSelect className={styles.filterPick} label="项目筛选" value={projectFilter} options={[
        { value: '*', label: '所有项目' },
        { value: 'global', label: '全局资料' },
        ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : '目录失效' })),
      ]} searchLabel="搜索项目" onChange={setProjectFilter} />
      <FilterSelect className={styles.filterPick} label="标签筛选" value={categoryFilter} options={[
        { value: '*', label: '所有标签' },
        ...categories.map((category) => ({ value: category, label: category })),
      ]} searchLabel="搜索标签" onChange={setCategoryFilter} />
    </div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.layout}>
      <div className={styles.list} aria-label={`${kind === 'prompt' ? '提示词' : '规则'}列表`}>
        {shown.length ? shown.map((item) => <article className={styles.card} key={item.id}>
          <small className={styles.cardMeta}>
            {tagsOf(item.category).length ? tagsOf(item.category).map((tag) => <em className={styles.tagChip} key={tag}>{tag}</em>) : <em className={styles.tagChip} data-muted="true">无标签</em>}
            {item.projectId && <span className={styles.cardProject}>{projects.find((project) => project.id === item.projectId)?.name ?? '原项目'}</span>}
            {!!item.updatedAt && <span className={styles.cardTime} title={fullTime(item.updatedAt)}><Icon name="clock" size={11} />{shortTime(item.updatedAt)}</span>}
          </small>
          <button className={styles.cardTitle} type="button" onClick={() => choose(item)}>{item.title}</button>
          <p>{item.body ? item.body.length > 160 ? `${item.body.slice(0, 160)}…` : item.body : '正文为空'}</p>
          <div className={styles.cardBar}>
            {kind === 'rule' ? <ScopeMarks label={`${item.title} 的 CLI`} tools={managedTools} places={rulePlacements.filter((entry) => entry.ruleId === item.id)} projects={projects} busy={busy} unavailable={(toolId, scope) => { const support = managedTools.find(tool => tool.id === toolId)?.management?.rules; return support && !support[scope] ? `当前${scope === 'global' ? '全局' : '项目'}范围不支持原生长期规则` : null; }} onToggle={(toolId, scope, projectPath) => void toggleRule(item, toolId, scope, projectPath)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: '未写入' };
              if (place.state === 'current') return { pressed: true, state: 'current', status: '已生效' };
              if (place.state === 'unavailable') return { pressed: true, state: 'unavailable', status: '未生效' };
              return { pressed: true, state: 'drifted', status: '文件已变化' };
            }} /> : <span />}
            <div className={styles.cardActions}>{copiedId === item.id && notice === copiedText
              ? <button type="button" aria-label="复制全文" data-copied="true" onClick={() => void copy(item.body, 'page', item.id)}><Icon name="check" size={13} strokeWidth={2.2} />已复制</button>
              : <button type="button" onClick={() => void copy(item.body, 'page', item.id)} disabled={!item.body}>复制全文</button>}{kind === 'prompt' && <button type="button" className={styles.cardLaunch} onClick={() => openLaunch(item)} disabled={!item.body}>启动会话</button>}<button type="button" onClick={() => choose(item)}>修改</button></div>
          </div>
        </article>) : !items.length && !search.trim()
          ? <div className={styles.empty}><Icon name="library" size={28} strokeWidth={1.3} /><strong>还没有{kind === 'prompt' ? '提示词' : '规则'}</strong>{kind === 'prompt' ? '把常用的提示词存在这里。保存后可以选择 CLI，直接开一场会话。' : '保存后，在卡片上点 CLI 图标即可写入。彩色表示已经生效，灰色表示还没写入。'}<button type="button" className={styles.primary} onClick={() => start(kind)}>＋ 新建第一条{kind === 'prompt' ? '提示词' : '规则'}</button></div>
          : <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />筛选结果为空，没有符合条件的{kind === 'prompt' ? '提示词' : '规则'}。请使用上方的「新建」。</div>}
      </div>
    </div>
    <GuideDialog open={!!draft} title={draft?.id ? `修改${kind === 'prompt' ? '提示词' : '规则'}` : `新建${kind === 'prompt' ? '提示词' : '规则'}`} hint={kind === 'rule' ? '填写标题和正文。分发到哪些 CLI，保存后回到列表点图标。' : '填写标题和正文，然后保存。'} onClose={() => { void (async () => { if (await canReplace()) { setDraft(null); setSavedText(''); clearDialogResult(); } })(); }}>
      {draft && <div className={styles.editor}>
        <div className={styles.editorHead}><div><small>{draft.id ? '编辑资料' : '新资料'}</small><h2>{draft.title || (kind === 'prompt' ? '提示词' : '长期规则')}</h2></div></div>
        {dialogError && <div className={styles.error} role="alert">{dialogError}</div>}
        {dialogNotice && <div className={styles.notice} role="status">{dialogNotice}</div>}
        <div className={styles.fields}>
          <label>标题<input autoFocus={!draft.id} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="名称" /></label>
          <label>关联项目<FilterSelect label="关联项目" value={draft.projectId ?? ''} options={[{ value: '', label: '全局' }, ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : '目录失效' }))]} searchLabel="搜索项目" onChange={(value) => setDraft({ ...draft, projectId: value || null })} /></label>
          <div className={styles.tags}>标签
            <div className={styles.tagList}>
              {tagsOf(draft.category).map((tag) => <button type="button" key={tag} onClick={() => setDraft({ ...draft, category: categoryOf(tagsOf(draft.category).filter((item) => item !== tag)) })}>{tag} ×</button>)}
              <input aria-label="添加标签" value={tagText} placeholder="输入后回车" onChange={(event) => setTagText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(tagText); } }} />
            </div>
            {!!categories.filter((tag) => !tagsOf(draft.category).includes(tag)).length && <div className={styles.tagSuggestions}>{categories.filter((tag) => !tagsOf(draft.category).includes(tag)).map((tag) => <button type="button" key={tag} onClick={() => addTag(tag)}>{tag}</button>)}</div>}
          </div>
        </div>
        <label className={styles.body}><span className={styles.bodyHead}>完整正文<span className={styles.charCount}>{draft.body.length} 字</span></span><CodeEditor key={draft.id ?? 'new'} label="资料正文" format="markdown" value={draft.body} onChange={(body) => setDraft({ ...draft, body })} placeholder={kind === 'prompt' ? '写下可复制使用的提示词…' : '写下要保存或应用到 CLI 的规则…'} /></label>
        <div className="dialog-footer"><span className={styles.saveState} data-dirty={dirty || undefined}>{dirty ? '草稿尚未保存' : '已保存'}</span><span className="dialog-footer-gap" /><button type="button" onClick={() => void copy(draft.body, 'dialog')} disabled={!draft.body}>复制全文</button>{draft.id && <button type="button" onClick={() => void remove()} disabled={busy}>删除</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint} disabled={busy || !draft.title.trim()} onClick={() => void save()}>保存</button></div>
      </div>}
    </GuideDialog>
    <GuideDialog open={!!launchItem} title="用这条提示词启动" hint="选择 CLI 和项目。提示词会作为第一条消息发出，启动前可以改。" onClose={() => { if (!launchBusy) setLaunchItem(null); }}>
      {launchItem && <div className={styles.editor}>
        {launchError && <div className={styles.error} role="alert">{launchError}</div>}
        <div className={styles.fields}>
          <label>CLI<FilterSelect label="启动 CLI" value={launchTool} options={toolOptions(managedTools)} placeholder="还没有可启动的 CLI" disabled={!managedTools.length} searchLabel="搜索 CLI" onChange={setLaunchTool} /></label>
          <label>项目<FilterSelect label="启动项目" value={launchProject} options={[{ value: '', label: '不指定项目' }, ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, note: project.available ? undefined : '目录失效' }))]} searchLabel="搜索项目" onChange={setLaunchProject} /></label>
        </div>
        <label className={styles.body}>第一条消息<textarea aria-label="启动提示词" rows={8} value={launchText} onChange={(event) => setLaunchText(event.target.value)} /></label>
        <div className="dialog-footer"><span className="dialog-footer-gap" /><button type="button" onClick={() => setLaunchItem(null)} disabled={launchBusy}>取消</button><button type="button" className={styles.primary} disabled={launchBusy || !launchTool || !launchText.trim()} onClick={() => void startSession()}>在外部终端启动</button></div>
      </div>}
    </GuideDialog>
    </>}
  </section>;
}
