import { useEffect, useMemo, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import type { Project } from '../../types/launch';
import type { LibraryDraft, LibraryItem, LibraryKind } from '../../types/library';
import type { AdapterDescriptor } from '../../types/native';
import { RuleDistribution } from './RuleDistribution';
import styles from './LibraryPage.module.css';

function message(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}

function empty(kind: LibraryKind): LibraryDraft {
  return { id: null, kind, title: '', body: '', category: '', projectId: null, expectedVersion: null };
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
  const dirty = !!draft && JSON.stringify(draft) !== savedText;

  useEffect(() => {
    if (!nativeAvailable || !active) return;
    void native.listProjects().then(setProjects).catch((value) => setError(message(value)));
  }, [active]);
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    void native.listLibraryItems(kind, null, search).then((result) => { if (live) setItems(result); })
      .catch((value) => { if (live) setError(message(value)); });
    return () => { live = false; };
  }, [active, kind, search]);

  const categories = useMemo(() => Array.from(new Set(items.map((item) => item.category).filter(Boolean))).sort(), [items]);
  const shown = items.filter((item) => (projectFilter === '*' || (projectFilter === 'global' ? !item.projectId : item.projectId === projectFilter))
    && (categoryFilter === '*' || item.category === categoryFilter));

  function canReplace() { return !dirty || window.confirm('当前资料草稿尚未保存，切换会丢失修改。继续吗？'); }
  function choose(item: LibraryItem) {
    if (!canReplace()) return;
    const next = edit(item);
    setDraft(next); setSavedText(JSON.stringify(next)); setError(''); setNotice('');
  }
  function start(kind: LibraryKind) {
    if (!canReplace()) return;
    const next = empty(kind);
    setDraft(next); setSavedText(JSON.stringify(next)); setError(''); setNotice('');
  }
  function switchKind(next: LibraryKind) {
    if (next === kind || !canReplace()) return;
    setKind(next); setDraft(null); setSavedText(''); setCategoryFilter('*'); setNotice(''); setError('');
  }
  async function refresh(nextKind = kind) { setItems(await native.listLibraryItems(nextKind, null, search)); }
  async function save() {
    if (!draft || busy || !nativeAvailable) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await native.saveLibraryItem(draft);
      const next = edit(saved);
      setDraft(next); setSavedText(JSON.stringify(next));
      await refresh();
      setNotice('已保存在本机资料库。');
    } catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!draft?.id || draft.expectedVersion === null || busy || !window.confirm(`删除“${draft.title}”？`)) return;
    setBusy(true); setError('');
    try {
      await native.deleteLibraryItem(draft.id, draft.expectedVersion);
      setDraft(null); setSavedText(''); await refresh(); setNotice('已删除。');
    } catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('完整正文已复制。'); setError(''); }
    catch { setError('复制失败，请检查剪贴板权限。'); }
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
    <div className={styles.filters}>
      <input aria-label="搜索资料" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、正文或分类" />
      <select aria-label="项目筛选" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="*">所有项目</option><option value="global">全局资料</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
      <select aria-label="分类筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="*">所有分类</option>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select>
    </div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.layout}>
      <div className={styles.list} aria-label={`${kind === 'prompt' ? '提示词' : '规则'}列表`}>
        {shown.length ? shown.map((item) => <button type="button" key={item.id} className={draft?.id === item.id ? styles.active : ''} onClick={() => choose(item)}>
          <strong>{item.title}</strong><span>{item.category || '未分类'} · {item.projectId ? projects.find((project) => project.id === item.projectId)?.name ?? '原项目' : '全局'}</span><small>{item.body.slice(0, 110) || '正文为空'}</small>
        </button>) : <div className={styles.empty}>没有符合筛选条件的{kind === 'prompt' ? '提示词' : '规则'}。</div>}
      </div>
      {draft ? <div className={styles.editor}>
        <div className={styles.editorHead}><div><small>{draft.id ? '编辑资料' : '新资料'}</small><h2>{draft.title || (kind === 'prompt' ? '提示词' : '长期规则')}</h2></div><button type="button" onClick={() => void copy(draft.body)} disabled={!draft.body}>复制全文</button></div>
        <div className={styles.fields}><label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="简短清楚的名称" /></label>
          <label>分类<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="例如：开发" /></label>
          <label>关联项目<select value={draft.projectId ?? ''} onChange={(event) => setDraft({ ...draft, projectId: event.target.value || null })}><option value="">全局</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div>
        <label className={styles.body}>完整正文<textarea aria-label="资料正文" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder={kind === 'prompt' ? '写下可复制使用的提示词…' : '写下要保存或应用到 CLI 的规则…'} /></label>
        <div className={styles.actions}><span>{dirty ? '草稿尚未保存' : '已保存'}</span>{draft.id && <button type="button" onClick={() => void remove()} disabled={busy}>删除</button>}<button type="button" className={styles.primary} disabled={busy || !draft.title.trim()} onClick={() => void save()}>保存</button></div>
        {kind === 'rule' && draft.id && draft.expectedVersion !== null && !dirty && <RuleDistribution key={`${draft.id}:${draft.expectedVersion}`} rule={{ ...draft, id: draft.id, version: draft.expectedVersion, updatedAt: 0 }} tools={managedTools} projects={projects} />}
      </div> : <div className={styles.empty}>选择一条资料，或新建一条。</div>}
    </div>
  </section>;
}
