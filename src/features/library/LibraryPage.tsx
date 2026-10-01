import { CodeEditor } from '../../components/CodeEditor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction, type ConfirmationOptions } from '../../lib/confirm';
import type { Project } from '../../types/launch';
import type { LibraryDraft, LibraryItem, LibraryKind } from '../../types/library';
import type { AdapterDescriptor } from '../../types/native';
import { NativeRuleEditor } from './NativeRuleEditor';
import { RuleDistribution } from './RuleDistribution';
import { GuideDialog } from '../../components/GuideDialog';
import styles from './LibraryPage.module.css';

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

function categoryOf(tags: string[]): string {
  return tags.join(',');
}

function edit(item: LibraryItem): LibraryDraft {
  return { id: item.id, kind: item.kind, title: item.title, body: item.body, category: item.category, projectId: item.projectId, expectedVersion: item.version };
}

export function LibraryPage({ managedTools = [], active = true }: { managedTools?: AdapterDescriptor[]; active?: boolean }) {
  const [kind, setKind] = useState<LibraryKind>('prompt');
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('*');
  const [categoryFilter, setCategoryFilter] = useState('*');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<LibraryDraft | null>(null);
  const [savedText, setSavedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [dialogNotice, setDialogNotice] = useState('');
  const [tagText, setTagText] = useState('');
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
  }, [active]);
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
  async function switchKind(next: LibraryKind) {
    if (next === kind || !await canReplace()) return;
    setKind(next); setDraft(null); setSavedText(''); setCategoryFilter('*'); setNotice(''); setError(''); clearDialogResult();
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
      showDialogNotice('已保存在本机资料库。');
    } catch (value) { showDialogError(formatFailure(value, '资料保存失败', '可修改后再次点击保存。')); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!draft?.id || draft.expectedVersion === null || busy || !await confirmCurrent(`删除“${draft.title}”？`, { title: '删除资料', confirmLabel: '删除资料', destructive: true })) return;
    setBusy(true); clearDialogResult();
    try {
      await native.deleteLibraryItem(draft.id, draft.expectedVersion);
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
  async function copy(text: string, surface: 'page' | 'dialog' = 'page') {
    if (surface === 'dialog') clearDialogResult();
    else { setNotice(''); setError(''); }
    try {
      await navigator.clipboard.writeText(text);
      if (surface === 'dialog') showDialogNotice('完整正文已复制，可以粘贴使用。');
      else showNotice('完整正文已复制，可以粘贴使用。');
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
      <div className={styles.tabs} role="tablist" aria-label="资料类型">
        <button type="button" role="tab" aria-selected={kind === 'prompt'} onClick={() => switchKind('prompt')}>提示词</button>
        <button type="button" role="tab" aria-selected={kind === 'rule'} onClick={() => switchKind('rule')}>长期规则</button>
      </div>
      <button type="button" className={styles.primary} onClick={() => start(kind)}>＋ 新建{kind === 'prompt' ? '提示词' : '规则'}</button>
    </div>
    {kind === 'rule' && <NativeRuleEditor tools={managedTools} projects={projects} />}
    <div className={styles.filters}>
      <input aria-label="搜索资料" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、正文或标签" />
      <select aria-label="项目筛选" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="*">所有项目</option><option value="global">全局资料</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
      <select aria-label="标签筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="*">所有标签</option>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select>
    </div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.layout}>
      <div className={styles.list} aria-label={`${kind === 'prompt' ? '提示词' : '规则'}列表`}>
        {shown.length ? shown.map((item) => <article className={styles.card} key={item.id}>
          <small>{tagsOf(item.category).join(' · ') || '无标签'} · {item.projectId ? projects.find((project) => project.id === item.projectId)?.name ?? '原项目' : '全局'}</small><button className={styles.cardTitle} type="button" onClick={() => choose(item)}>{item.title}</button><p>{item.body.slice(0, 160) || '正文为空'}</p><div className={styles.cardActions}><button type="button" onClick={() => void copy(item.body)} disabled={!item.body}>复制全文</button><button type="button" onClick={() => choose(item)}>修改</button></div>
        </article>) : <div className={styles.empty}>筛选结果为空，没有符合条件的{kind === 'prompt' ? '提示词' : '规则'}。请使用上方的「新建」。</div>}
      </div>
    </div>
    <GuideDialog open={!!draft} title={draft?.id ? `修改${kind === 'prompt' ? '提示词' : '规则'}` : `新建${kind === 'prompt' ? '提示词' : '规则'}`} hint="填写标题和正文，然后保存。规则还可以继续分发到 CLI。" onClose={() => { void (async () => { if (await canReplace()) { setDraft(null); setSavedText(''); clearDialogResult(); } })(); }}>
      {draft && <div className={styles.editor}>
        <div className={styles.editorHead}><div><small>{draft.id ? '编辑资料' : '新资料'}</small><h2>{draft.title || (kind === 'prompt' ? '提示词' : '长期规则')}</h2></div></div>
        <div className={styles.actions}><span>{dirty ? '草稿尚未保存' : '已保存'}</span><button type="button" onClick={() => void copy(draft.body, 'dialog')} disabled={!draft.body}>复制全文</button>{draft.id && <button type="button" onClick={() => void remove()} disabled={busy}>删除</button>}<button type="button" className={styles.primary} disabled={busy || !draft.title.trim()} onClick={() => void save()}>保存</button></div>
        {dialogError && <div className={styles.error} role="alert">{dialogError}</div>}
        {dialogNotice && <div className={styles.notice} role="status">{dialogNotice}</div>}
        <div className={styles.fields}>
          <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="名称" /></label>
          <label>关联项目<select value={draft.projectId ?? ''} onChange={(event) => setDraft({ ...draft, projectId: event.target.value || null })}><option value="">全局</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
          <div className={styles.tags}>标签
            <div className={styles.tagList}>
              {tagsOf(draft.category).map((tag) => <button type="button" key={tag} onClick={() => setDraft({ ...draft, category: categoryOf(tagsOf(draft.category).filter((item) => item !== tag)) })}>{tag} ×</button>)}
              <input aria-label="添加标签" value={tagText} placeholder="输入后回车" onChange={(event) => setTagText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(tagText); } }} />
            </div>
            {!!categories.filter((tag) => !tagsOf(draft.category).includes(tag)).length && <div className={styles.tagSuggestions}>{categories.filter((tag) => !tagsOf(draft.category).includes(tag)).map((tag) => <button type="button" key={tag} onClick={() => addTag(tag)}>{tag}</button>)}</div>}
          </div>
        </div>
        <label className={styles.body}>完整正文<CodeEditor key={draft.id ?? 'new'} label="资料正文" format="markdown" value={draft.body} onChange={(body) => setDraft({ ...draft, body })} placeholder={kind === 'prompt' ? '写下可复制使用的提示词…' : '写下要保存或应用到 CLI 的规则…'} /></label>
        {kind === 'rule' && draft.id && draft.expectedVersion !== null && !dirty && <RuleDistribution key={`${draft.id}:${draft.expectedVersion}`} rule={{ ...draft, id: draft.id, version: draft.expectedVersion, updatedAt: 0 }} tools={managedTools} projects={projects} />}
      </div>}
    </GuideDialog>
  </section>;
}
