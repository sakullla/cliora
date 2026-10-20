import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { StatusBanner } from '../../components/StatusBanner';
import { SearchField } from '../../components/SearchField';
import { FilterSelect } from '../../components/FilterSelect';
import { CodeEditor } from '../../components/CodeEditor';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { writeClipboard } from '../../lib/clipboard';
import { useFeedback } from '../../lib/toast';
import { modLabel, withMod } from '../../lib/shortcut';
import { displayPath } from '../../lib/paths';
import type { MemoryAggregate, MemoryManagement, MemoryOperation, MemoryStoreEntry, MemoryTarget } from '../../types/native';
import { createTemplate, fileName, parseMemory, relativeTime, storeLabelParts, type ParsedMemory } from './memoryDocument';
import styles from './MemoryWorkspace.module.css';

const MemoryMarkdown = lazy(() => import('../records/MessageMarkdown'));

type Failure = { message: string; retry: (() => Promise<void>) | null };
type Doc = { text: string; fingerprint: string };
type OpenEntry = { key: string; target: MemoryTarget; id: string; text: string; fingerprint: string };
type Compose = { destination: string; id: string; text: string; template: string };
type Store = { key: string; label: string; name: string; path: string; directory: string; target: MemoryTarget; inUse: boolean; detail: string; entryCount: number };
type Row = { entry: MemoryStoreEntry; key: string; store: string; parsed: ParsedMemory | null; pending: boolean; modified: ReturnType<typeof relativeTime> };
type Destination = { value: string; label: string; detail?: string; note?: string; target: MemoryTarget };
export type MemoryProject = { name: string; path: string };

const writeOperations: MemoryOperation[] = ['create', 'edit', 'delete', 'master_switch', 'item_enable'];
const knownTypes = ['user', 'feedback', 'project', 'reference'];

function isExternalChange(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return message.includes('外部修改');
}

/** One store behind the aggregate. */
function storeKey(target: MemoryTarget): string {
  return JSON.stringify([target.scope, target.projectPath ?? null, target.contextId ?? null, target.storeDirectory ?? null]);
}

function samePath(left: string, right: string): boolean {
  const normal = (value: string) => displayPath(value).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  return normal(left) === normal(right);
}

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" className={styles.switch} aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function MemoryWorkspace({ toolId, toolName, memory, active, suggestedProjectPath, projects = [], onDirtyChange }: {
  toolId: string;
  toolName?: string;
  memory: MemoryManagement;
  active: boolean;
  suggestedProjectPath: string | null;
  projects?: MemoryProject[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const feedback = useFeedback();
  const tool = toolName || toolId;
  const mounted = useRef(true);
  const root = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [aggregate, setAggregate] = useState<MemoryAggregate | null>(null);
  const [docs, setDocs] = useState<Record<string, Doc | null>>({});
  const [listFailure, setListFailure] = useState<Failure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenEntry | null>(null);
  const [reading, setReading] = useState(false);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [draft, setDraft] = useState('');
  const [compose, setCompose] = useState<Compose | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const can = (operation: MemoryOperation) => memory.operations.includes(operation);
  const limitation = (memory.limitation || '').trim();
  const showWrites = writeOperations.some(operation => can(operation));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // The workspace chrome above stays pinned; the reading pane sticks just below it.
  useLayoutEffect(() => {
    const section = root.current;
    const chrome = document.querySelector<HTMLElement>('[data-workspace-chrome]');
    if (!section || !chrome) return;
    const update = () => section.style.setProperty('--memory-sticky-top', `${Math.round(chrome.getBoundingClientRect().height) + 14}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(chrome);
    return () => observer.disconnect();
  }, []);

  // The reading pane never runs past the window: its height follows the space
  // left below its current top, so the editor footer stays reachable.
  useLayoutEffect(() => {
    const section = root.current;
    if (!section || !pane) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = Math.max(0, pane.getBoundingClientRect().top);
      section.style.setProperty('--memory-detail-max', `${Math.max(340, Math.round(window.innerHeight - top - 16))}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => { if (frame) cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, [pane]);

  const loadEpoch = useRef(0);
  // Bodies are read per entry over the existing read IPC for titles, summaries,
  // and search. Failures are silent: an unreadable body still lists its entry.
  const loadDocs = useCallback(async (value: MemoryAggregate) => {
    const epoch = ++loadEpoch.current;
    const results = await Promise.allSettled(value.entries.map(async entry => {
      const document = await native.readMemory(entry.target, entry.id);
      return { text: document.text, fingerprint: document.fingerprint };
    }));
    if (!mounted.current || epoch !== loadEpoch.current) return;
    setDocs(Object.fromEntries(value.entries.map((entry, index) => {
      const result = results[index];
      return [`${storeKey(entry.target)}:${entry.id}`, result.status === 'fulfilled' ? result.value : null];
    })));
  }, []);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const value = await native.listAllMemories(toolId);
      if (!mounted.current) return;
      setAggregate(value);
      setListFailure(null);
      void loadDocs(value);
    } catch (error) {
      if (!mounted.current) return;
      setAggregate(null);
      setDocs({});
      setListFailure({ message: formatFailure(error, t('common.memory.listFailed'), t('common.memory.retryNext')), retry: () => reload() });
    } finally { if (mounted.current) setRefreshing(false); }
  }, [toolId, t, loadDocs]);

  useEffect(() => {
    setAggregate(null); setDocs({}); setSelected(null); setOpened(null); setDraft(''); setMode('read');
    setCompose(null); setFailure(null); setBusy(false); setQuery(''); setSource('all'); setKind('all'); setPicked([]);
  }, [toolId]);
  useEffect(() => { if (active) void reload(); }, [active, reload]);

  const report = useCallback((error: unknown, summary: string, retry: (() => Promise<void>) | null) => {
    setFailure({ message: formatFailure(error, summary, t('common.memory.retryNext')), retry });
  }, [t]);

  // ---------- Derived view ----------
  const stores = useMemo<Store[]>(() => {
    const summaries = aggregate?.stores ?? [];
    const map = new Map<string, Store>();
    const add = (label: string, directory: string, target: MemoryTarget, inUse: boolean, detail: string, entryCount: number) => {
      const key = storeKey(target);
      if (map.has(key)) return;
      const parts = storeLabelParts(displayPath(label));
      map.set(key, { key, label, name: parts.name, path: parts.path, directory, target, inUse, detail, entryCount });
    };
    for (const store of summaries) add(store.label, store.directory, store.target, store.inUse, store.detail, store.entryCount);
    for (const entry of aggregate?.entries ?? []) {
      const key = storeKey(entry.target);
      if (!map.has(key)) add(entry.sourceLabel, entry.target.storeDirectory ?? '', entry.target, entry.inUse, entry.detail, (aggregate?.entries ?? []).filter(item => storeKey(item.target) === key).length);
    }
    return [...map.values()];
  }, [aggregate]);

  const rows = useMemo<Row[]>(() => (aggregate?.entries ?? []).map(entry => {
    const store = storeKey(entry.target);
    const key = `${store}:${entry.id}`;
    const doc = docs[key];
    const parsed = doc ? parseMemory(entry.id, doc.text) : null;
    return { entry, key, store, parsed, pending: !(key in docs), modified: relativeTime(parsed?.modified ?? null, i18n.language) };
  }), [aggregate, docs, i18n.language]);

  const types = useMemo(() => {
    const found = new Set(rows.map(row => row.parsed?.type).filter((value): value is string => !!value));
    return [...found].sort((left, right) => (knownTypes.indexOf(left) + 1 || 99) - (knownTypes.indexOf(right) + 1 || 99) || left.localeCompare(right));
  }, [rows]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = rows.filter(row => {
    if (source !== 'all' && row.store !== source) return false;
    if (kind !== 'all' && row.parsed?.type !== kind) return false;
    if (!needle) return true;
    const haystack = [row.entry.id, row.parsed?.title, row.parsed?.description, row.entry.sourceLabel, row.parsed ? row.parsed.body : ''].join('\n').toLocaleLowerCase();
    return haystack.includes(needle);
  });
  const groups = stores
    .filter(store => source === 'all' || store.key === source)
    .map(store => ({
      store,
      rows: visible.filter(row => row.store === store.key).sort((left, right) => (right.modified?.time ?? 0) - (left.modified?.time ?? 0) || (left.parsed?.title ?? left.entry.id).localeCompare(right.parsed?.title ?? right.entry.id)),
      latest: Math.max(0, ...rows.filter(row => row.store === store.key).map(row => row.modified?.time ?? 0)),
    }))
    .filter(group => group.rows.length > 0 || (!needle && kind === 'all'))
    .sort((left, right) => Number(right.store.target.scope === 'global') - Number(left.store.target.scope === 'global') || right.latest - left.latest || right.store.entryCount - left.store.entryCount);
  const ordered = groups.flatMap(group => collapsed.has(group.store.key) ? [] : group.rows);
  const filtering = !!needle || source !== 'all' || kind !== 'all';
  const total = rows.length;

  const current = rows.find(row => row.key === selected) ?? null;
  const currentStore = current ? stores.find(store => store.key === current.store) ?? null : null;
  const currentDoc = current ? (opened?.key === current.key ? { text: opened.text, fingerprint: opened.fingerprint } : docs[current.key] ?? null) : null;
  const currentParsed = current && currentDoc ? parseMemory(current.entry.id, currentDoc.text) : current?.parsed ?? null;
  const editing = mode === 'edit' && !!opened && opened.key === selected && can('edit');
  const focusWriting = editing || !!compose;
  // Writing gets the full window: bring the pane up to its pinned position.
  useEffect(() => {
    if (!focusWriting || !pane) return;
    const frame = requestAnimationFrame(() => pane.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [focusWriting, pane]);
  const dirty = (editing && draft !== opened!.text) || (!!compose && (compose.id.trim() !== '' || compose.text !== compose.template));
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const shared = !!aggregate?.switchShared;
  const masterStore = stores[0] ?? null;

  // ---------- Destinations for new entries ----------
  const destinations = useMemo<Destination[]>(() => {
    const list: Destination[] = stores.map(store => ({ value: `store:${store.key}`, label: store.name, detail: store.path || undefined, note: t('common.memory.entryCount', { count: store.entryCount }), target: store.target }));
    if (memory.scope.global && !stores.some(store => store.target.scope === 'global')) list.push({ value: 'global', label: t('common.memory.targetGlobal'), target: { toolId, scope: 'global', projectPath: null } });
    if (memory.scope.project) {
      const candidates = [suggestedProjectPath, ...projects.map(project => project.path), ...picked].filter((value): value is string => !!value);
      const seen: string[] = [];
      for (const path of candidates) {
        if (seen.some(item => samePath(item, path))) continue;
        seen.push(path);
        if (stores.some(store => samePath(store.label, path) || (store.target.projectPath && samePath(store.target.projectPath, path)))) continue;
        const name = projects.find(project => samePath(project.path, path))?.name ?? storeLabelParts(displayPath(path)).name;
        list.push({ value: `project:${path}`, label: t('common.memory.targetProject', { name }), detail: displayPath(path), note: t('common.memory.newStore'), target: { toolId, scope: 'project', projectPath: path } });
      }
    }
    return list;
  }, [stores, memory.scope.global, memory.scope.project, suggestedProjectPath, projects, picked, toolId, t]);

  function defaultDestination(): string {
    const preferred = source !== 'all' ? source : current?.store ?? null;
    if (preferred && destinations.some(item => item.value === `store:${preferred}`)) return `store:${preferred}`;
    if (suggestedProjectPath) {
      const match = destinations.find(item => item.target.projectPath && samePath(item.target.projectPath, suggestedProjectPath))
        ?? destinations.find(item => item.value.startsWith('store:') && stores.find(store => `store:${store.key}` === item.value && samePath(store.label, suggestedProjectPath)));
      if (match) return match.value;
    }
    return destinations[0]?.value ?? '';
  }

  // ---------- Actions ----------
  async function mayLeave(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    return confirmAction(t('common.memory.abandonMessage'), () => mounted.current, { title: t('common.memory.abandonTitle'), confirmLabel: t('common.memory.abandonConfirm'), destructive: true });
  }

  const readEpoch = useRef(0);
  async function openRow(row: Row, nextMode: 'read' | 'edit' = 'read') {
    const epoch = ++readEpoch.current;
    setSelected(row.key);
    setMode(nextMode);
    setCompose(null);
    setReading(true);
    try {
      const value = await native.readMemory(row.entry.target, row.entry.id);
      if (!mounted.current || epoch !== readEpoch.current) return;
      setOpened({ key: row.key, target: row.entry.target, id: value.id, text: value.text, fingerprint: value.fingerprint });
      setDocs(previous => ({ ...previous, [row.key]: { text: value.text, fingerprint: value.fingerprint } }));
      setDraft(value.text);
      setFailure(null);
    } catch (error) {
      if (!mounted.current || epoch !== readEpoch.current) return;
      setOpened(null);
      setMode('read');
      report(error, t('common.memory.readFailed'), () => openRow(row, nextMode));
    } finally { if (mounted.current && epoch === readEpoch.current) setReading(false); }
  }

  async function select(row: Row) {
    if (row.key === selected && !compose) return;
    if (!await mayLeave()) return;
    await openRow(row);
  }

  async function startEdit() {
    if (!current) return;
    if (opened?.key === current.key) { setDraft(opened.text); setMode('edit'); return; }
    await openRow(current, 'edit');
  }

  async function stopEdit() {
    if (!await mayLeave()) return;
    if (opened) setDraft(opened.text);
    setMode('read');
  }

  async function saveOpened(confirmExternal = false) {
    if (!opened) return;
    const target = opened;
    const text = draft;
    setBusy(true);
    try {
      let writeExternal = confirmExternal;
      if (!writeExternal) {
        const fresh = await native.readMemory(target.target, target.id);
        if (!mounted.current) return;
        if (fresh.fingerprint !== target.fingerprint) {
          setBusy(false);
          const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, { title: t('common.memory.externalTitle'), confirmLabel: t('common.memory.externalConfirm') });
          if (!accepted) return;
          writeExternal = true;
          setBusy(true);
        }
      }
      const saved = await native.saveMemory({ target: target.target, id: target.id, text, baseline: target.text, confirmExternal: writeExternal });
      if (!mounted.current) return;
      setOpened({ ...target, id: saved.id, text: saved.text, fingerprint: saved.fingerprint });
      setDocs(previous => ({ ...previous, [target.key]: { text: saved.text, fingerprint: saved.fingerprint } }));
      setDraft(value => value === text ? saved.text : value);
      setMode('read');
      setFailure(null);
      feedback.setNotice(t('common.memory.savedNotice', { title: parseMemory(target.id, saved.text).title }));
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, { title: t('common.memory.externalTitle'), confirmLabel: t('common.memory.externalConfirm') });
        if (!accepted) return;
        await saveOpened(true);
        return;
      }
      report(error, t('common.memory.saveFailed'), () => saveOpened(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function startCompose() {
    if (!await mayLeave()) return;
    const template = rows.some(row => row.parsed?.hasFrontmatter) ? createTemplate('') : '';
    readEpoch.current++;
    setSelected(null);
    setOpened(null);
    setMode('read');
    setFailure(null);
    setCompose({ destination: defaultDestination(), id: '', text: template, template });
  }

  async function cancelCompose() {
    if (!await mayLeave()) return;
    setCompose(null);
  }

  const idValid = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id) && id !== '_unbound';

  async function createMemory(confirmExternal = false) {
    if (!compose) return;
    const destination = destinations.find(item => item.value === compose.destination);
    const id = compose.id.trim();
    if (!destination) return;
    if (!idValid(id)) { setFailure({ message: t('common.memory.idInvalid'), retry: null }); return; }
    if (!confirmExternal && rows.some(row => row.entry.id === id && storeKey(row.entry.target) === storeKey(destination.target))) { setFailure({ message: t('common.memory.idTaken', { id }), retry: null }); return; }
    const text = compose.text;
    setBusy(true);
    try {
      const saved = await native.saveMemory({ target: destination.target, id, text, baseline: '', confirmExternal });
      if (!mounted.current) return;
      setCompose(null);
      setFailure(null);
      feedback.setNotice(t('common.memory.createdNotice', { title: parseMemory(id, saved.text).title }));
      const value = await native.listAllMemories(toolId).catch(() => null);
      if (!mounted.current) return;
      if (value) {
        setAggregate(value);
        void loadDocs(value);
        const created = value.entries.find(entry => entry.id === saved.id && (samePath(entry.path, saved.path) || storeKey(entry.target) === storeKey(destination.target)));
        if (created) {
          const key = `${storeKey(created.target)}:${created.id}`;
          setSelected(key);
          setMode('read');
          setOpened({ key, target: created.target, id: saved.id, text: saved.text, fingerprint: saved.fingerprint });
          setDraft(saved.text);
          setDocs(previous => ({ ...previous, [key]: { text: saved.text, fingerprint: saved.fingerprint } }));
        }
      } else await reload();
    } catch (error) {
      if (!mounted.current) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, { title: t('common.memory.externalTitle'), confirmLabel: t('common.memory.externalConfirm') });
        if (!accepted) return;
        await createMemory(true);
        return;
      }
      report(error, t('common.memory.saveFailed'), () => createMemory(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function remove(row: Row, baseline: string) {
    setBusy(true);
    try {
      await native.deleteMemory({ target: row.entry.target, id: row.entry.id, baseline });
      if (!mounted.current) return;
      if (selected === row.key) {
        const index = ordered.findIndex(item => item.key === row.key);
        const next = ordered[index + 1] ?? ordered[index - 1] ?? null;
        setSelected(next?.key ?? null);
        setOpened(null);
        setDraft('');
        setMode('read');
        if (next) void openRow(next);
      }
      setFailure(null);
      feedback.setNotice(t('common.memory.deletedNotice', { title: row.parsed?.title ?? row.entry.id }));
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      report(error, t('common.memory.deleteFailed'), () => remove(row, baseline));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function confirmRemove(row: Row) {
    const accepted = await confirmAction(t('common.memory.deleteMessage', { id: row.parsed?.title && row.parsed.title !== row.entry.id ? `${row.parsed.title}（${row.entry.id}）` : row.entry.id }), () => mounted.current, {
      title: t('common.memory.deleteTitle'),
      confirmLabel: t('common.memory.deleteConfirm'),
      destructive: true,
    });
    if (!accepted || !mounted.current) return;
    let baseline = opened?.key === row.key ? opened.text : '';
    if (!baseline) {
      setBusy(true);
      try {
        const fresh = await native.readMemory(row.entry.target, row.entry.id);
        if (!mounted.current) return;
        baseline = fresh.text;
      } catch (error) {
        if (!mounted.current) return;
        report(error, t('common.memory.readFailed'), () => confirmRemove(row));
        return;
      } finally { if (mounted.current) setBusy(false); }
    }
    await remove(row, baseline);
  }

  async function setEnabled(enabled: boolean, target: MemoryTarget, id?: string) {
    setBusy(true);
    try {
      await native.setMemoryEnabled({ target, id: id ?? null, enabled });
      if (!mounted.current) return;
      setFailure(null);
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      report(error, t('common.memory.saveFailed'), () => setEnabled(enabled, target, id));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function copyPath(path: string) {
    const ok = await writeClipboard(displayPath(path));
    if (!mounted.current) return;
    feedback.setNotice(ok ? t('common.memory.pathCopied') : t('common.memory.copyFailed'));
  }

  async function chooseFolder() {
    try {
      const value = await pickFolder({ directory: true, multiple: false, title: t('common.memory.pickFolder') });
      if (typeof value !== 'string' || !mounted.current) return;
      setPicked(previous => previous.some(item => samePath(item, value)) ? previous : [...previous, value]);
      setCompose(previous => previous ? { ...previous, destination: `project:${value}` } : previous);
    } catch (error) {
      if (mounted.current) report(error, t('common.memory.pickFailed'), null);
    }
  }

  function onListKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    if (!ordered.length) return;
    event.preventDefault();
    const index = ordered.findIndex(row => row.key === selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ordered.length - 1
      : index < 0 ? 0 : Math.max(0, Math.min(ordered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const row = ordered[next];
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"]`)?.focus();
    void select(row);
  }

  function onEditorKey(event: KeyboardEvent<HTMLElement>) {
    if (withMod(event) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (event.repeat || busy) return;
      if (compose) void createMemory(false);
      else if (editing && dirty) void saveOpened(false);
    }
  }

  function clearFilters() { setQuery(''); setSource('all'); setKind('all'); }
  function toggleGroup(key: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  // ---------- Render ----------
  const typeLabel = (value: string) => knownTypes.includes(value) ? t(`common.memory.type.${value}`) : value;
  const showDetail = !!current || !!compose;
  const sourceOptions = [{ value: 'all', label: t('common.memory.sourceAll'), note: String(total) }, ...stores.map(store => ({ value: store.key, label: store.name, detail: store.path || undefined, note: String(store.entryCount) }))];
  const composeDestination = compose ? destinations.find(item => item.value === compose.destination) ?? null : null;
  const composeIdError = compose && compose.id.trim() && !idValid(compose.id.trim()) ? t('common.memory.idInvalid') : '';

  const master = can('master_switch') && shared ? masterStore : null;
  const anyOff = stores.some(store => !store.inUse);
  const offWithoutSwitch = anyOff && !can('master_switch');

  return <section ref={root} className={styles.page} aria-label={t('tools.workspace.view.memory')} onKeyDown={onEditorKey}>
    <header className={styles.head}>
      <div className={styles.headCopy}>
        <h2>{t('common.memory.title')}</h2>
        <p>{t('common.memory.description', { tool })}</p>
      </div>
      <div className={styles.headActions}>
        <button type="button" className={styles.iconButton} aria-label={t('common.memory.refresh')} title={t('common.memory.refresh')} disabled={refreshing || busy} data-spinning={refreshing || undefined} onClick={() => void reload()}><Icon name="refresh" size={15} /></button>
        {can('create') && <button type="button" className={`button primary ${styles.primary}`} disabled={busy || !aggregate || destinations.length === 0} title={destinations.length === 0 && aggregate ? t('common.memory.createUnavailable', { tool }) : undefined} onClick={() => void startCompose()}><Icon name="plus" size={14} />{t('common.memory.create')}</button>}
      </div>
    </header>

    {aggregate && (master || offWithoutSwitch || limitation) && <div className={styles.statusCard} data-state={master ? (master.inUse ? 'on' : 'off') : offWithoutSwitch ? 'off' : 'info'}>
      <span className={styles.statusIcon} aria-hidden="true"><Icon name={master ? (master.inUse ? 'sparkle' : 'eyeOff') : offWithoutSwitch ? 'alert' : showWrites ? 'info' : 'lock'} size={18} /></span>
      <div className={styles.statusCopy}>
        {master
          ? <><strong>{t('common.memory.autoTitle')}<span className={styles.statusPill}>{master.inUse ? t('common.memory.autoOnShort') : t('common.memory.autoOffShort')}</span></strong>
            <span>{master.inUse ? t('common.memory.autoOn', { tool }) : (master.detail || t('common.memory.notInUse'))}</span></>
          : offWithoutSwitch
            ? <><strong>{t('common.memory.notInUse')}</strong><span>{stores.find(store => !store.inUse)?.detail || t('common.memory.notInUseHint')}</span></>
            : <strong>{showWrites ? t('common.memory.noteTitle') : t('common.memory.readOnlyTitle')}</strong>}
        {limitation && <small role="status">{limitation}</small>}
      </div>
      {master && <Switch checked={master.inUse} label={t('common.memory.master')} disabled={busy} onChange={value => void setEnabled(value, master.target)} />}
    </div>}

    {listFailure && <StatusBanner tone="error" action={listFailure.retry ? <button type="button" className="button" onClick={() => { const retry = listFailure.retry; setListFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{listFailure.message}</StatusBanner>}
    {failure && <StatusBanner tone="error" onDismiss={() => setFailure(null)} action={failure.retry ? <button type="button" className="button" onClick={() => { const retry = failure.retry; setFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{failure.message}</StatusBanner>}
    {aggregate && aggregate.failedSources.length > 0 && <div className={styles.sourceFailures}>{aggregate.failedSources.map(item => <p key={item.label} role="status"><Icon name="alert" size={14} />{t('common.memory.sourceFailed', { label: item.label, reason: item.reason })}</p>)}</div>}

    {!aggregate && !listFailure && <div className={styles.loading} role="status" aria-label={t('common.memory.loading')}><span className="skeleton-block short" /><div className={styles.loadingSplit}><div><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block" /></div><span className="skeleton-block tall" /></div></div>}

    {aggregate && total === 0 && stores.length === 0 && !compose && <EmptyState icon="sparkle" title={t('common.memory.emptyTitle')} detail={aggregate.failedSources.length ? t('common.memory.emptyFailed') : t('common.memory.emptyAll')} action={can('create') && destinations.length > 0 ? <button type="button" className="button primary" disabled={busy} onClick={() => void startCompose()}><Icon name="plus" size={14} />{t('common.memory.create')}</button> : undefined} />}
    {aggregate && can('create') && destinations.length === 0 && <p className={styles.hint}><Icon name="info" size={14} />{t('common.memory.createUnavailable', { tool })}</p>}

    {aggregate && (total > 0 || stores.length > 0 || compose) && <>
      {total > 0 && <div className={styles.toolbar}>
        <SearchField type="search" className={styles.search} label={t('common.memory.searchLabel')} placeholder={t('common.memory.searchPlaceholder')} value={query} onChange={setQuery} />
        {stores.length > 1 && <FilterSelect className={styles.sourceSelect} label={t('common.memory.sourceFilter')} value={source} options={sourceOptions} triggerDetail={false} onChange={setSource} />}
        {types.length > 0 && <div className={styles.chips} role="group" aria-label={t('common.memory.typeFilter')}>
          {['all', ...types].map(value => <button key={value} type="button" aria-pressed={kind === value} data-type={value} onClick={() => setKind(value)}>{value === 'all' ? t('common.memory.typeAll') : typeLabel(value)}</button>)}
        </div>}
        <span className={styles.count}>{filtering ? t('common.memory.countFiltered', { filtered: visible.length, total }) : t('common.memory.countAll', { count: total, stores: stores.length })}</span>
      </div>}

      <div className={styles.split} data-view={showDetail ? 'detail' : 'list'} data-writing={focusWriting || undefined}>
        <div className={styles.listPane}>
          {filtering && visible.length === 0
            ? <div className={styles.noMatch}><Icon name="search" size={18} /><p>{needle ? t('common.memory.noMatch', { query: query.trim() }) : t('common.memory.noMatchFilter')}</p><button type="button" className="button" onClick={clearFilters}>{t('common.memory.clearFilters')}</button></div>
            : <nav ref={listRef} className={styles.list} aria-label={t('common.memory.listLabel')} onKeyDown={onListKey}>
              {groups.map(group => {
                const closed = collapsed.has(group.store.key);
                return <div key={group.store.key} className={styles.group}>
                  <div className={styles.groupHead}>
                    <button type="button" className={styles.groupToggle} aria-expanded={!closed} title={group.store.path || group.store.name} onClick={() => toggleGroup(group.store.key)}>
                      <Icon name={closed ? 'chevronRight' : 'chevronDown'} size={13} />
                      <span className={styles.groupIcon} data-scope={group.store.target.scope}><Icon name={group.store.target.scope === 'global' ? 'globe' : 'folder'} size={13} /></span>
                      <span className={styles.groupName}><strong>{group.store.name}</strong>{group.store.path && <small>{group.store.path}</small>}</span>
                      <span className={styles.groupCount}>{filtering ? `${group.rows.length}/${group.store.entryCount}` : group.store.entryCount}</span>
                    </button>
                    {!group.store.inUse && !master && <span className={styles.offBadge} title={group.store.detail || t('common.memory.notInUse')}>{t('common.memory.storeOff')}</span>}
                    {can('master_switch') && !shared && <Switch checked={group.store.inUse} label={t('common.memory.masterFor', { source: group.store.label })} disabled={busy} onChange={value => void setEnabled(value, group.store.target)} />}
                  </div>
                  {!closed && group.rows.length === 0 && <p className={styles.groupEmpty}>{t('common.memory.storeEmpty')}</p>}
                  {!closed && group.rows.map(row => {
                    const title = row.parsed?.title ?? row.entry.id;
                    const summary = row.parsed ? (row.parsed.description || row.parsed.excerpt) : '';
                    return <button key={row.key} type="button" tabIndex={selected === row.key || (!selected && row === ordered[0]) ? 0 : -1} data-key={row.key} aria-current={selected === row.key || undefined} className={styles.item} data-disabled={!row.entry.enabled || undefined} onClick={() => void select(row)}>
                      <span className={styles.itemTitle}><strong title={title}>{title}</strong>{row.parsed?.type && <span className={styles.typeBadge} data-type={row.parsed.type}>{typeLabel(row.parsed.type)}</span>}{!row.entry.enabled && <span className={styles.typeBadge} data-type="off">{t('common.memory.disabledBadge')}</span>}</span>
                      {summary ? <span className={styles.itemSummary}>{summary}</span> : row.pending && <span className={styles.itemSummaryPending} aria-hidden="true" />}
                      <span className={styles.itemMeta}><span className={styles.mono}>{fileName(row.entry.path)}</span>{row.modified && <time dateTime={row.parsed?.modified ?? undefined} title={row.modified.absolute}>{row.modified.text}</time>}</span>
                    </button>;
                  })}
                </div>;
              })}
            </nav>}
        </div>

        <div ref={setPane} className={styles.detailPane}>
          {compose ? <form className={styles.detail} aria-label={t('common.memory.createTitle')} onSubmit={event => { event.preventDefault(); void createMemory(false); }}>
            <div className={styles.detailHead}>
              <button type="button" className={styles.back} onClick={() => void cancelCompose()}><Icon name="arrowLeft" size={14} />{t('common.memory.back')}</button>
              <span className={styles.crumb}><Icon name="plus" size={13} />{t('common.memory.createTitle')}</span>
              <h3>{compose.id.trim() ? parseMemory(compose.id.trim(), compose.text).title : t('common.memory.untitled')}</h3>
              <p className={styles.detailDescription}>{t('common.memory.createHint', { tool })}</p>
            </div>
            <div className={styles.composeFields}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('common.memory.destination')}</span>
                <FilterSelect label={t('common.memory.destination')} triggerDetail={false} value={compose.destination} options={destinations.map(item => ({ value: item.value, label: item.label, detail: item.detail, note: item.note }))} onChange={value => setCompose(previous => previous ? { ...previous, destination: value } : previous)} forceSearch={destinations.length > 6} onPickFolder={memory.scope.project ? () => void chooseFolder() : undefined} pickFolderLabel={t('common.memory.pickFolder')} />
                {composeDestination && <small className={styles.fieldHint}>{t('common.memory.writeLocation', { target: composeDestination.detail ?? composeDestination.label })}</small>}
              </div>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('common.memory.idLabel')}</span>
                <span className={styles.idInput} data-invalid={!!composeIdError || undefined}><input aria-label={t('common.memory.idLabel')} aria-invalid={!!composeIdError} value={compose.id} placeholder={t('common.memory.idPlaceholder')} spellCheck={false} autoFocus onChange={event => { const value = event.target.value; setCompose(previous => previous ? { ...previous, id: value } : previous); }} /><span aria-hidden="true">.md</span></span>
                <small className={styles.fieldHint} data-tone={composeIdError ? 'error' : undefined}>{composeIdError || t('common.memory.idHint')}</small>
              </label>
            </div>
            <div className={styles.editorArea}>
              <CodeEditor label={t('common.memory.textLabel')} format="markdown" value={compose.text} onChange={value => setCompose(previous => previous ? { ...previous, text: value } : previous)} placeholder={t('common.memory.textPlaceholder')} />
            </div>
            <div className={styles.detailFoot}>
              <span className={styles.footNote}>{t('common.memory.saveShortcut', { mod: modLabel })}</span>
              <button type="button" className="button" disabled={busy} onClick={() => void cancelCompose()}>{t('common.memory.cancel')}</button>
              <button type="submit" className={`button primary ${styles.primary}`} disabled={busy || !composeDestination || !compose.id.trim() || !!composeIdError}>{t('common.memory.save')}</button>
            </div>
          </form>
          : current ? <article className={styles.detail} aria-label={currentParsed?.title ?? current.entry.id} aria-busy={reading || undefined}>
            <div className={styles.detailHead}>
              <button type="button" className={styles.back} onClick={() => void (async () => { if (await mayLeave()) { setSelected(null); setMode('read'); } })()}><Icon name="arrowLeft" size={14} />{t('common.memory.back')}</button>
              <span className={styles.crumb} title={currentStore?.path || currentStore?.label}><Icon name={current.entry.target.scope === 'global' ? 'globe' : 'folder'} size={13} />{currentStore?.name ?? current.entry.sourceLabel}<span aria-hidden="true">/</span><span className={styles.mono}>{fileName(current.entry.path)}</span></span>
              <div className={styles.titleRow}>
                <h3>{currentParsed?.title ?? current.entry.id}</h3>
                {currentParsed?.type && <span className={styles.typeBadge} data-type={currentParsed.type}>{typeLabel(currentParsed.type)}</span>}
                {!current.entry.enabled && <span className={styles.typeBadge} data-type="off">{t('common.memory.disabledBadge')}</span>}
              </div>
              {currentParsed?.description && <p className={styles.detailDescription}>{currentParsed.description}</p>}
              <div className={styles.detailBar}>
                {can('edit')
                  ? <div className={styles.segmented} role="group" aria-label={t('common.memory.viewMode')}>
                    <button type="button" aria-pressed={!editing} onClick={() => { if (editing) void stopEdit(); }}><Icon name="eye" size={14} />{t('common.memory.read')}</button>
                    <button type="button" aria-pressed={editing} disabled={reading && !editing} onClick={() => { if (!editing) void startEdit(); }}><Icon name="pencil" size={14} />{t('common.memory.edit')}</button>
                  </div>
                  : <span className={styles.readOnlyPill}><Icon name="lock" size={12} />{t('common.memory.readOnly')}</span>}
                {currentParsed?.modified && <span className={styles.metaText}><Icon name="clock" size={13} />{t('common.memory.modified', { time: relativeTime(currentParsed.modified, i18n.language)?.text ?? currentParsed.modified })}</span>}
                <span className={styles.barGap} />
                {can('item_enable') && <span className={styles.inlineSwitch}><span aria-hidden="true">{t('common.memory.enabledLabel')}</span><Switch checked={current.entry.enabled} label={t('common.memory.enable', { id: current.entry.id })} disabled={busy} onChange={value => void setEnabled(value, current.entry.target, current.entry.id)} /></span>}
                <button type="button" className={styles.iconButton} aria-label={t('common.memory.copyPath')} title={`${t('common.memory.copyPath')}\n${displayPath(current.entry.path)}`} onClick={() => void copyPath(current.entry.path)}><Icon name="copy" size={15} /></button>
                {can('delete') && <button type="button" className={`${styles.iconButton} ${styles.danger}`} aria-label={t('common.memory.delete', { id: current.entry.id })} title={t('common.memory.delete', { id: current.entry.id })} disabled={busy} onClick={() => void confirmRemove(current)}><Icon name="trash" size={15} /></button>}
              </div>
            </div>
            {editing
              ? <>
                <div className={styles.editorArea}><CodeEditor key={current.key} label={t('common.memory.textLabel')} format="markdown" value={draft} onChange={setDraft} readOnly={busy} documentId={current.key} /></div>
                <div className={styles.detailFoot}>
                  <span className={styles.footNote} data-dirty={dirty || undefined}>{dirty ? t('common.memory.unsaved') : t('common.memory.saveShortcut', { mod: modLabel })}</span>
                  <button type="button" className="button" disabled={busy} onClick={() => void stopEdit()}>{dirty ? t('common.memory.discard') : t('common.memory.done')}</button>
                  <button type="button" className={`button primary ${styles.primary}`} disabled={busy || !dirty} onClick={() => void saveOpened(false)}>{t('common.memory.save')}</button>
                </div>
              </>
              : <div className={styles.readBody}>
                {currentParsed && currentParsed.properties.length > 0 && <details className={styles.properties}>
                  <summary>{t('common.memory.properties', { count: currentParsed.properties.length })}</summary>
                  <dl>{currentParsed.properties.map(item => <div key={item.key}><dt>{item.key}</dt><dd>{item.value || '—'}</dd></div>)}</dl>
                </details>}
                {currentParsed
                  ? currentParsed.displayBody.trim()
                    ? <div className={styles.prose}><Suspense fallback={<pre className={styles.raw}>{currentParsed.displayBody}</pre>}><MemoryMarkdown text={currentParsed.displayBody} /></Suspense></div>
                    : <p className={styles.emptyBody}>{t('common.memory.emptyBody')}</p>
                  : reading || current.pending
                    ? <div className={styles.bodyPending} role="status" aria-label={t('common.memory.reading')}><span /><span /><span /></div>
                    : <p className={styles.emptyBody}>{t('common.memory.readFailed')}</p>}
              </div>}
          </article>
          : <div className={styles.placeholder}>
            <span className={styles.placeholderIcon} aria-hidden="true"><Icon name="sparkle" size={22} /></span>
            <strong>{total > 0 ? t('common.memory.selectHint') : t('common.memory.noEntriesHint')}</strong>
            <p>{t('common.memory.selectDetail')}</p>
            {total > 0 && <span className={styles.keys}><kbd>↑</kbd><kbd>↓</kbd>{t('common.memory.keysHint')}</span>}
          </div>}
        </div>
      </div>
    </>}
  </section>;
}
