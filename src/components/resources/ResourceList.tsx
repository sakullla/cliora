import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCE_PAGE_SIZE, resourceError, resourceSortPreference } from '../../lib/resources';
import { SearchField } from '../SearchField';
import { useFeedback } from '../Feedback';
import styles from './ResourceList.module.css';

export type ResourceRow = { id: string; name: string; description: string; metadata?: string; search?: string; state?: string; facets?: string[] };
type Session = { query: string; filter: string; page: number; selected: string[]; scroll: number };
const sessions = new Map<string, Session>();

export function ResourceList({ context, label, rows, onOpen, actions, filters = [], onVisible, onSelected, onRefresh, bulk, addedId, toolbarActions }: {
  context: string; label: string; rows: ResourceRow[]; onOpen: (id: string) => void; actions?: (id: string) => ReactNode;
  filters?: { value: string; label: string }[]; onVisible?: (ids: string[]) => void; onSelected?: (ids: string[]) => void; onRefresh?: () => void;
  bulk?: (ids: string[]) => ReactNode; addedId?: string | null; toolbarActions?: ReactNode;
}) {
  const { t } = useTranslation();
  const feedback = useFeedback(context + ':sort');
  const [view, setView] = useState<Session>(() => sessions.get(context) ?? { query: '', filter: '', page: 0, selected: [], scroll: 0 });
  const [sort, setSort] = useState<'added' | 'name'>('added');
  const sortChanged = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useEffect(() => { let live = true; const result = feedback.begin('read'); void resourceSortPreference(context).then(value => { if (live && !sortChanged.current && (value === 'added' || value === 'name')) setSort(value); result.complete(); }).catch(error => result.error(resourceError(error))); return () => { live = false; }; }, [context]);
  useEffect(() => { sessions.set(context, { ...view, scroll: sessions.get(context)?.scroll ?? view.scroll }); }, [context, view]);
  useEffect(() => {
    const main = root.current?.closest('main');
    if (!main) return;
    const remember = () => { const old = sessions.get(context); if (old) sessions.set(context, { ...old, scroll: main.scrollTop }); };
    main.addEventListener('scroll', remember);
    return () => main.removeEventListener('scroll', remember);
  }, [context]);
  useEffect(() => {
    if (restored.current || !rows.length) return;
    restored.current = true;
    const main = root.current?.closest('main');
    if (main) main.scrollTop = sessions.get(context)?.scroll ?? 0;
  }, [rows.length, context]);
  const needle = view.query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (!needle || `${row.name} ${row.description} ${row.search ?? ''} ${row.metadata ?? ''}`.toLocaleLowerCase().includes(needle)) && (!view.filter || row.state === view.filter || row.facets?.includes(view.filter)));
  if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(filtered.length / RESOURCE_PAGE_SIZE));
  const page = Math.min(view.page, pages - 1);
  const visible = filtered.slice(page * RESOURCE_PAGE_SIZE, (page + 1) * RESOURCE_PAGE_SIZE);
  const visibleStamp = JSON.stringify(visible.map(row => row.id));
  useEffect(() => { onVisible?.(JSON.parse(visibleStamp) as string[]); }, [visibleStamp]);
  const selected = view.selected.filter(id => rows.some(row => row.id === id));
  const selectedStamp = JSON.stringify(selected);
  useEffect(() => { onSelected?.(JSON.parse(selectedStamp) as string[]); }, [selectedStamp]);
  const hidden = selected.filter(id => !filtered.some(row => row.id === id)).length;
  function select(ids: string[]) { setView(old => ({ ...old, selected: ids })); }
  function locate() {
    if (!addedId) return;
    const all = sort === 'name' ? [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : rows;
    setView(old => ({ ...old, query: '', filter: '', page: Math.max(0, Math.floor(all.findIndex(row => row.id === addedId) / RESOURCE_PAGE_SIZE)) }));
  }
  return <div className={styles.root} ref={root} data-resource-list={context}>
    <div className={styles.toolbar}>
      <SearchField label={t('library.page.searchLabel')} pageSearch value={view.query} onChange={query => setView(old => ({ ...old, query, page: 0 }))} placeholder={t('library.experience.search')} />
      {!!filters.length && <select aria-label={t('library.experience.filter')} value={view.filter} onChange={event => setView(old => ({ ...old, filter: event.target.value, page: 0 }))}><option value="">{t('library.experience.all')}</option>{filters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select>}
      <select aria-label={t('library.experience.sort')} value={sort} onChange={event => { const value = event.target.value as typeof sort; sortChanged.current = true; setSort(value); const result = feedback.begin('write'); void resourceSortPreference(context, value).then(() => result.complete()).catch(error => result.error(resourceError(error))); }}><option value="added">{t('library.experience.added')}</option><option value="name">{t('library.experience.name')}</option></select>
      {onRefresh && <button type="button" onClick={onRefresh}>{t('library.experience.refresh')}</button>}
      {toolbarActions}
    </div>
    {addedId && !visible.some(row => row.id === addedId) && <div className={styles.selection}><span>{t('library.experience.addedHidden')}</span><button type="button" onClick={locate}>{t('library.experience.locate')}</button></div>}
    <div className={styles.selection}><span>{t('library.experience.count', { count: selected.length, hidden })}</span><button type="button" onClick={() => select([...new Set([...selected, ...visible.map(row => row.id)])])}>{t('library.experience.selectPage')}</button><button type="button" onClick={() => select([...new Set([...selected, ...filtered.map(row => row.id)])])}>{t('library.experience.selectAll', { count: filtered.length })}</button>{!!selected.length && <button type="button" onClick={() => select([])}>{t('library.experience.clear')}</button>}</div>
    {!!selected.length && bulk?.(selected)}
    {view.filter && rows.some(row => row.state === 'unknown' || row.state === 'failed') && <p className={styles.meta}>{t('library.experience.incompleteFilter')}</p>}
    <div className={styles.rows} aria-label={label}>
      {visible.map(row => <article className={styles.row} key={row.id} data-selected={selected.includes(row.id)}>
        <input type="checkbox" aria-label={t('library.experience.select', { name: row.name })} checked={selected.includes(row.id)} onChange={event => select(event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} />
        <div className={styles.entry}><button type="button" className={styles.title} onClick={() => onOpen(row.id)}>{row.name}</button><span className={styles.summary} title={row.description}>{row.description}</span>{row.metadata && <span className={styles.meta}>{row.metadata}</span>}</div>
        <div className={styles.actions}>{actions?.(row.id)}<button type="button" onClick={() => onOpen(row.id)}>{t('tools.workspace.edit')}</button></div>
      </article>)}
      {!visible.length && <div className={styles.empty}>{t('library.experience.empty')}</div>}
    </div>
    <nav className={styles.pagination} aria-label={t('library.experience.pagination')}><span>{t('library.experience.page', { page: page + 1, pages, count: filtered.length, total: rows.length })}</span><button type="button" disabled={!page} onClick={() => setView(old => ({ ...old, page: page - 1 }))}>{t('library.experience.previous')}</button><button type="button" disabled={page + 1 >= pages} onClick={() => setView(old => ({ ...old, page: page + 1 }))}>{t('library.experience.next')}</button></nav>
  </div>;
}
