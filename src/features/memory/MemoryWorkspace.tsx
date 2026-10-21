import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { StatusBanner } from '../../components/StatusBanner';
import { SearchField } from '../../components/SearchField';
import { FilterSelect } from '../../components/FilterSelect';
import { CodeEditor } from '../../components/CodeEditor';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { DocumentWorkspace } from '../tools/DocumentWorkspace';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { writeClipboard } from '../../lib/clipboard';
import { useFeedback } from '../../lib/toast';
import { modLabel, withMod } from '../../lib/shortcut';
import { displayPath } from '../../lib/paths';
import type { MemoryAggregate, MemoryReadRequest, MemoryManagement, MemoryOperation, MemoryStoreEntry, MemoryTarget } from '../../types/native';
import { createTemplate, parseMemory, relativeTime, storeLabelParts, type ParsedMemory } from './memoryDocument';
import styles from './MemoryWorkspace.module.css';

// Shared across remounts so switching tools cannot exceed two native batches.
const bodySlots: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
let nextBodySlot = 0;
async function readBatch(requests: MemoryReadRequest[], current: () => boolean) {
  const slot = nextBodySlot++ % bodySlots.length;
  const previous = bodySlots[slot];
  let release!: () => void;
  bodySlots[slot] = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return current() ? await native.readMemories(requests) : null; }
  finally { release(); }
}

const MemoryMarkdown = lazy(() => import('./MemoryMarkdown'));

type Failure = { message: string; retry: (() => Promise<void>) | null };
type Doc = { text: string; fingerprint: string; parsed: ParsedMemory; search: string };
function documentCache(id: string, text: string, fingerprint: string): Doc {
  const parsed = parseMemory(id, text);
  return { text, fingerprint, parsed, search: [id, parsed.title, parsed.description, parsed.body].join("\n").toLocaleLowerCase() };
}
type OpenEntry = { key: string; target: MemoryTarget; id: string; text: string; fingerprint: string };
type Compose = { destination: string; id: string; text: string; template: string };
type Store = { key: string; label: string; name: string; path: string; directory: string; target: MemoryTarget; inUse: boolean; detail: string; entryCount: number };
type Row = { entry: MemoryStoreEntry; key: string; store: string; parsed: ParsedMemory | null; pending: boolean; modified: ReturnType<typeof relativeTime> };
type Destination = { value: string; label: string; detail?: string; note?: string; target: MemoryTarget };
export type MemoryProject = { name: string; path: string };

const knownTypes = ['user', 'feedback', 'project', 'reference'];

function isExternalChange(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return message.includes('外部修改');
}

/** One store behind the aggregate. */
function storeKey(target: MemoryTarget): string {
  return JSON.stringify([target.toolId, target.scope, target.projectPath ?? null, target.contextId ?? null, target.storeDirectory ?? null]);
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
  const listRef = useRef<HTMLElement>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [aggregate, setAggregate] = useState<MemoryAggregate | null>(null);
  const aggregateRef = useRef(aggregate); aggregateRef.current = aggregate;
  const [docs, setDocs] = useState<Record<string, Doc | null>>({});
  const [docErrors, setDocErrors] = useState<Record<string, string>>({});
  const [listFailure, setListFailure] = useState<Failure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenEntry | null>(null);
  const openedRef = useRef(opened); openedRef.current = opened;
  const [reading, setReading] = useState(false);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [draft, setDraft] = useState('');
  const [missingDraft, setMissingDraft] = useState(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');

  const can = (operation: MemoryOperation) => memory.operations.includes(operation);
  const limitation = (memory.limitation || '').trim();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPropertiesOpen(false); }, [selected]);

  const loadEpoch = useRef(0);
  const readEpoch = useRef(0);
  const docsRef = useRef<Record<string, Doc | null>>({});
  const docRevision = useRef<Record<string, number>>({});
  const publishDocs = useCallback((value: Record<string, Doc | null>) => { docsRef.current = value; setDocs(value); }, []);
  const cacheDocument = (key: string, id: string, text: string, fingerprint: string) => {
    setDocErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    docRevision.current[key] = (docRevision.current[key] ?? 0) + 1;
    publishDocs({ ...docsRef.current, [key]: documentCache(id, text, fingerprint) });
  };
  // Two bounded batches in flight; unchanged fingerprints retain parsed bodies.
  const loadDocs = useCallback(async (value: MemoryAggregate, epoch: number) => {
    const next: Record<string, Doc | null> = {};
    const pending: MemoryStoreEntry[] = [];
    for (const entry of value.entries) {
      const key = `${storeKey(entry.target)}:${entry.id}`;
      const cached = docsRef.current[key];
      if (!entry.readError && cached?.fingerprint === entry.fingerprint) next[key] = cached;
      else pending.push(entry);
    }
    publishDocs(next);
    setDocErrors(Object.fromEntries(value.entries.filter(entry => entry.readError).map(entry => [`${storeKey(entry.target)}:${entry.id}`, entry.readError!])));
    // Refresh the open document through the unrestricted single read. It must
    // not wait behind slow batches or retain stale text after a batch size limit.
    const focusedIndex = dirtyRef.current ? -1 : pending.findIndex(entry => `${storeKey(entry.target)}:${entry.id}` === openedRef.current?.key);
    const focused = focusedIndex >= 0 ? pending.splice(focusedIndex, 1)[0] : null;
    const refreshFocused = async () => {
      if (!focused) return;
      const key = `${storeKey(focused.target)}:${focused.id}`;
      const revision = docRevision.current[key] ?? 0;
      try {
        const document = await native.readMemory(focused.target, focused.id);
        if (!mounted.current || epoch !== loadEpoch.current || (docRevision.current[key] ?? 0) !== revision) return;
        publishDocs({ ...docsRef.current, [key]: documentCache(focused.id, document.text, document.fingerprint) });
        setDocErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
      } catch (error) {
        if (!mounted.current || epoch !== loadEpoch.current || (docRevision.current[key] ?? 0) !== revision) return;
        publishDocs({ ...docsRef.current, [key]: null });
        setDocErrors(previous => ({ ...previous, [key]: formatFailure(error, t('common.memory.readFailed'), t('common.memory.retryNext')) }));
      }
    };
    let offset = 0;
    const worker = async () => {
      while (mounted.current && epoch === loadEpoch.current && offset < pending.length) {
        const batch = pending.slice(offset, offset += 32);
        const revisions = batch.map(entry => docRevision.current[`${storeKey(entry.target)}:${entry.id}`] ?? 0);
        const results = await readBatch(batch.map(entry => ({ target: entry.target, id: entry.id })), () => mounted.current && epoch === loadEpoch.current).catch(() => null);
        if (!mounted.current || epoch !== loadEpoch.current) return;
        const updated = { ...docsRef.current };
        const errors: Record<string, string> = {};
        const recovered: string[] = [];
        batch.forEach((entry, index) => {
          const key = `${storeKey(entry.target)}:${entry.id}`;
          if ((docRevision.current[key] ?? 0) !== revisions[index]) return;
          const document = results?.[index]?.document;
          if (!document) errors[key] = results?.[index]?.error || t('common.memory.readFailed');
          else recovered.push(key);
          updated[key] = document ? documentCache(entry.id, document.text, document.fingerprint) : null;
        });
        publishDocs(updated);
        setDocErrors(previous => { const next = { ...previous, ...errors }; for (const key of recovered) delete next[key]; return next; });
      }
    };
    await Promise.all([refreshFocused(), worker(), worker()]);
  }, [publishDocs, t]);

  const reload = useCallback(async (): Promise<MemoryAggregate | null> => {
    const epoch = ++loadEpoch.current;
    ++readEpoch.current;
    setReading(false);
    setRefreshing(true);
    try {
      const value = await native.listAllMemories(toolId);
      if (!mounted.current || epoch !== loadEpoch.current) return null;
      // An externally deleted entry must not make an unsaved editor disappear.
      setMissingDraft(false);
      const editingKey = dirtyRef.current ? openedRef.current?.key : null;
      if (editingKey && !value.entries.some(entry => `${storeKey(entry.target)}:${entry.id}` === editingKey)) {
        const retained = aggregateRef.current?.entries.find(entry => `${storeKey(entry.target)}:${entry.id}` === editingKey);
        if (retained) { value.entries.push(retained); setMissingDraft(true); }
      }
      setAggregate(value);
      setListFailure(null);
      void loadDocs(value, epoch);
      return value;
    } catch (error) {
      if (!mounted.current || epoch !== loadEpoch.current) return null;
      setListFailure({ message: formatFailure(error, t('common.memory.listFailed'), t('common.memory.retryNext')), retry: async () => { await reload(); } });
      return null;
    } finally { if (mounted.current && epoch === loadEpoch.current) setRefreshing(false); }
  }, [toolId, t, loadDocs]);

  useEffect(() => {
    ++loadEpoch.current; ++readEpoch.current; docRevision.current = {};
    setAggregate(null); publishDocs({}); setSelected(null); setOpened(null); setDraft(''); setMode('read');
    setCompose(null); setFailure(null); setBusy(false); setQuery(''); setSource('all'); setKind('all'); setPicked([]);
  }, [toolId, publishDocs]);
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
    const parsed = doc?.parsed ?? null;
    return { entry, key, store, parsed, pending: !(key in docs), modified: relativeTime(parsed?.modified ?? null, i18n.language) };
  }), [aggregate, docs, i18n.language]);

  const types = useMemo(() => {
    const found = new Set(rows.map(row => row.parsed?.type).filter((value): value is string => !!value));
    return [...found].sort((left, right) => (knownTypes.indexOf(left) + 1 || 99) - (knownTypes.indexOf(right) + 1 || 99) || left.localeCompare(right));
  }, [rows]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => rows.filter(row => {
    if (source !== 'all' && row.store !== source) return false;
    if (kind !== 'all' && row.parsed?.type !== kind) return false;
    if (!needle) return true;
    const haystack = (docs[row.key]?.search ?? row.entry.id.toLocaleLowerCase()) + '\n' + row.entry.sourceLabel.toLocaleLowerCase();
    return haystack.includes(needle);
  }), [rows, source, kind, needle, docs]);
  const ordered = useMemo(() => [...visible].sort((left, right) => (right.modified?.time ?? 0) - (left.modified?.time ?? 0) || (left.parsed?.title ?? left.entry.id).localeCompare(right.parsed?.title ?? right.entry.id)), [visible]);
  const filtering = !!needle || source !== 'all' || kind !== 'all';
  // Stores without entries stay valid write destinations but are not listed.
  const listedStores = stores.filter(store => rows.some(row => row.store === store.key));
  const total = rows.length;

  const current = rows.find(row => row.key === selected) ?? null;
  const currentStore = current ? stores.find(store => store.key === current.store) ?? null : null;
  const currentDoc = current ? (opened?.key === current.key ? { text: opened.text, fingerprint: opened.fingerprint } : docs[current.key] ?? null) : null;
  const currentParsed = useMemo(() => current && currentDoc ? parseMemory(current.entry.id, currentDoc.text) : current?.parsed ?? null, [current?.entry.id, currentDoc?.text, current?.parsed]);
  const editing = mode === 'edit' && !!opened && opened.key === selected && can('edit');
  const dirty = (editing && draft !== opened!.text) || (!!compose && (compose.id.trim() !== '' || compose.text !== compose.template));
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => {
    if (!opened || dirty || busy) return;
    const fresh = docs[opened.key];
    if (fresh && fresh.fingerprint !== opened.fingerprint) {
      setOpened({ ...opened, text: fresh.text, fingerprint: fresh.fingerprint });
      setDraft(fresh.text);
    }
  }, [docs, opened, dirty, busy]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const switchGroups = aggregate?.switchGroups ?? [];
  const shared = !!aggregate?.switchShared || switchGroups.length > 0;
  const masterStore = stores[0] ?? null;
  const storeSwitches = can('master_switch') && !shared ? listedStores : [];

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
      cacheDocument(row.key, row.entry.id, value.text, value.fingerprint);
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
    if (busy) return;
    if (row.key === selected && !compose && !docErrors[row.key]) return;
    if (!await mayLeave()) return;
    await openRow(row);
  }

  async function startEdit() {
    if (!current || busy) return;
    if (opened?.key === current.key) { setDraft(opened.text); setMode('edit'); return; }
    await openRow(current, 'edit');
  }

  async function stopEdit() {
    if (!await mayLeave()) return;
    if (missingDraft) {
      dirtyRef.current = false; setSelected(null); setOpened(null); setDraft(''); setMode('read');
      await reload(); return;
    }
    if (opened) setDraft(opened.text);
    setMode('read');
  }

  async function saveOpened(confirmExternal = false) {
    if (!opened) return;
    const target = opened;
    const text = draft;
    setReading(false);
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
      ++loadEpoch.current; ++readEpoch.current;
      const saved = await native.saveMemory({ target: target.target, id: target.id, text, baseline: target.text, confirmExternal: writeExternal });
      if (!mounted.current) return;
      setOpened({ ...target, id: saved.id, text: saved.text, fingerprint: saved.fingerprint });
      cacheDocument(target.key, saved.id, saved.text, saved.fingerprint);
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
        if (!accepted) { await reload(); return; }
        await saveOpened(true);
        return;
      }
      await reload();
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

  async function closeDocument() {
    if (compose) { await cancelCompose(); return; }
    if (!await mayLeave()) return;
    setSelected(null);
    setMode('read');
  }

  const idValid = (id: string) => aggregate?.nativeFileNames
    ? id.length > 0 && id.length <= 240 && !/^[.]|[. ]$|[\u0000-\u001f\u007f-\u009f/\\:<>"|?*]/.test(id) && !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:[. ]|$)/i.test(id)
    : /^[A-Za-z0-9_-]{1,80}$/.test(id) && id !== '_unbound';
  const idInvalid = t(aggregate?.nativeFileNames ? 'common.memory.nativeIdInvalid' : 'common.memory.idInvalid');

  async function createMemory(confirmExternal = false) {
    if (!compose) return;
    const destination = destinations.find(item => item.value === compose.destination);
    const id = compose.id.trim();
    if (!destination) return;
    if (!idValid(id)) { setFailure({ message: idInvalid, retry: null }); return; }
    if (!confirmExternal && rows.some(row => row.entry.id === id && storeKey(row.entry.target) === storeKey(destination.target))) { setFailure({ message: t('common.memory.idTaken', { id }), retry: null }); return; }
    const text = compose.text;
    ++loadEpoch.current; ++readEpoch.current;
    setReading(false);
    setBusy(true);
    try {
      const saved = await native.saveMemory({ target: destination.target, id, text, baseline: '', confirmExternal });
      if (!mounted.current) return;
      setCompose(null);
      setFailure(null);
      feedback.setNotice(t('common.memory.createdNotice', { title: parseMemory(id, saved.text).title }));
      const value = await reload();
      if (!mounted.current) return;
      if (value) {
        const created = value.entries.find(entry => entry.id === saved.id && (samePath(entry.path, saved.path) || storeKey(entry.target) === storeKey(destination.target)));
        if (created) {
          const key = `${storeKey(created.target)}:${created.id}`;
          setSelected(key);
          setMode('read');
          setOpened({ key, target: created.target, id: saved.id, text: saved.text, fingerprint: saved.fingerprint });
          setDraft(saved.text);
          cacheDocument(key, saved.id, saved.text, saved.fingerprint);
        }
      } else await reload();
    } catch (error) {
      if (!mounted.current) return;
      if (!confirmExternal && isExternalChange(error)) {
        setBusy(false);
        const accepted = await confirmAction(t('common.memory.externalMessage'), () => mounted.current, { title: t('common.memory.externalTitle'), confirmLabel: t('common.memory.externalConfirm') });
        if (!accepted) { await reload(); return; }
        await createMemory(true);
        return;
      }
      await reload();
      report(error, t('common.memory.saveFailed'), () => createMemory(confirmExternal));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function remove(row: Row, baseline: string) {
    ++loadEpoch.current; ++readEpoch.current;
    setReading(false);
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
      await reload();
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
    ++loadEpoch.current; ++readEpoch.current;
    setReading(false);
    setBusy(true);
    try {
      await native.setMemoryEnabled({ target, id: id ?? null, enabled });
      if (!mounted.current) return;
      setFailure(null);
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      await reload();
      report(error, t('common.memory.saveFailed'), () => setEnabled(enabled, target, id));
    } finally { if (mounted.current) setBusy(false); }
  }

  async function setGroupEnabled(groupId: string, enabled: boolean) {
    ++loadEpoch.current; ++readEpoch.current;
    setBusy(true);
    try {
      await native.setMemorySwitchGroup(toolId, groupId, enabled);
      if (!mounted.current) return;
      setFailure(null);
      await reload();
    } catch (error) {
      if (mounted.current) { await reload(); report(error, t('common.memory.saveFailed'), () => setGroupEnabled(groupId, enabled)); }
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
    if (busy) return;
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

  /** `[[target]]` resolves to an entry by id or frontmatter name, preferring the same store. */
  function linkedRow(target: string, store: string): Row | null {
    const normal = (value: string) => value.trim().toLowerCase().replace(/\.md$/, '').replace(/[_\s]+/g, '-');
    const wanted = normal(target);
    const matches = rows.filter(row => {
      const name = row.parsed?.properties.find(item => item.key.toLowerCase() === 'name')?.value ?? '';
      return normal(row.entry.id) === wanted || (!!name && normal(name) === wanted);
    });
    return matches.find(row => row.store === store) ?? matches[0] ?? null;
  }

  // ---------- Render ----------
  const typeLabel = (value: string) => knownTypes.includes(value) ? t(`common.memory.type.${value}`) : value;
  const scopeOf = (entry: MemoryStoreEntry, store: Store | null) => {
    const title = store?.path || store?.label || entry.sourceLabel;
    if (entry.target.scope === 'global') return { text: t('common.memory.scopeUser'), title };
    const marker = ' · ';
    const short = !store ? ''
      : store.path ? store.name
      : store.name.includes(marker) ? store.name.split(marker).slice(1).join(marker)
      : store.name && store.name !== t('common.memory.scopeProject') ? store.name
      : '';
    return { text: short ? t('common.memory.scopeProjectNamed', { name: short }) : t('common.memory.scopeProject'), title };
  };
  const sourceOptions = [{ value: 'all', label: t('common.memory.sourceAll'), note: String(total) }, ...listedStores.map(store => ({ value: store.key, label: store.name, detail: store.path || undefined, note: String(store.entryCount) }))];
  const composeDestination = compose ? destinations.find(item => item.value === compose.destination) ?? null : null;
  const composeIdError = compose && compose.id.trim() && !idValid(compose.id.trim()) ? idInvalid : '';

  const master = can('master_switch') && shared && switchGroups.length === 0 ? masterStore : null;
  const anyOff = stores.some(store => !store.inUse);
  const offWithoutSwitch = anyOff && !can('master_switch');

  const actions = <div className={styles.headActions}>
    {aggregate && master && <span className={styles.autoToggle} data-state={master.inUse ? 'on' : 'off'} title={limitation || undefined}>
      <span className={styles.autoDot} aria-hidden="true" />
      <span className={styles.autoLabel}>{t('common.memory.autoTitle')}<span className={styles.statusPill}>{master.inUse ? t('common.memory.autoOnShort') : t('common.memory.autoOffShort')}</span></span>
      <Switch checked={master.inUse} label={t('common.memory.master')} disabled={busy} onChange={value => void setEnabled(value, master.target)} />
    </span>}
    {aggregate && limitation && !master && <span className={styles.readOnlyPill} title={limitation}><Icon name="lock" size={13} />{t('common.memory.readOnly')}</span>}
    <button type="button" className={styles.iconButton} aria-label={t('common.memory.refresh')} title={t('common.memory.refresh')} disabled={refreshing || busy} data-spinning={refreshing || undefined} onClick={() => void reload()}><Icon name="refresh" size={15} /></button>
    {can('create') && <button type="button" className={`button primary ${styles.primary}`} disabled={busy || !aggregate || destinations.length === 0} title={destinations.length === 0 && aggregate ? t('common.memory.createUnavailable', { tool }) : undefined} onClick={() => void startCompose()}><Icon name="plus" size={14} />{t('common.memory.create')}</button>}
  </div>;

  const offDetail = ((detail: string) => detail && detail !== t('common.memory.notInUse') ? detail : t('common.memory.notInUseHint'))((master ? master.detail : stores.find(store => !store.inUse)?.detail) ?? '');
  const storeSwitchRow = (store: Store) => {
    const sample = rows.find(row => row.store === store.key);
    const scope = sample ? scopeOf(sample.entry, store) : { text: store.name, title: store.path || store.label };
    const off = !store.inUse && !master && !switchGroups.some(item => item.scope === store.target.scope && item.enabled === null);
    return <div key={store.key} className={styles.storeSwitch}>
      <span className={styles.storeSwitchName} title={scope.title}><Icon name={store.target.scope === 'global' ? 'globe' : 'folder'} size={13} /><span>{scope.text}</span></span>
      {off && <span className={styles.offBadge} title={store.detail || t('common.memory.notInUse')}>{t('common.memory.storeOff')}</span>}
      <Switch checked={store.inUse} label={t('common.memory.masterFor', { source: store.label })} disabled={busy} onChange={value => void setEnabled(value, store.target)} />
    </div>;
  };
  const entryButton = (row: Row) => {
    const title = row.parsed?.title ?? row.entry.id;
    const summary = row.parsed ? (row.parsed.description || row.parsed.excerpt) : '';
    const scope = scopeOf(row.entry, stores.find(item => item.key === row.store) ?? null);
    return <button key={row.key} type="button" tabIndex={selected === row.key || (!selected && row === ordered[0]) ? 0 : -1} data-key={row.key} data-entry-id={row.entry.id} disabled={busy} aria-current={selected === row.key || undefined} className={styles.item} data-disabled={!row.entry.enabled || undefined} onClick={() => void select(row)}>
      <span className={styles.itemTitle}><strong title={title}>{title}</strong></span>
      {docErrors[row.key]
        ? <span className={styles.itemSummary} title={docErrors[row.key]}>{t('common.memory.entryReadFailed')}</span>
        : summary
          ? <span className={styles.itemSummary}>{summary}</span>
          : row.pending && <span className={styles.itemSummaryPending} aria-hidden="true" />}
      <span className={styles.itemMeta}>
        {row.parsed?.type && <span className={styles.typeBadge} data-type={row.parsed.type}>{typeLabel(row.parsed.type)}</span>}
        <span className={styles.scopeBadge} data-scope={row.entry.target.scope} title={scope.title}>{scope.text}</span>
        {!row.entry.enabled && <span className={styles.typeBadge} data-type="off">{t('common.memory.disabledBadge')}</span>}
        {row.modified && <time dateTime={row.parsed?.modified ?? undefined} title={row.modified.absolute}>{row.modified.text}</time>}
      </span>
    </button>;
  };

  return <DocumentWorkspace label={t('tools.workspace.view.memory')} toolbarLabel={aggregate ? t('common.memory.toolbar') : undefined} onKeyDown={onEditorKey} backLabel={t('common.memory.back')} onBack={() => { void closeDocument(); }}
    toolbar={aggregate ? <>
      {total > 0 && <span className={styles.filters} data-document-hide>
        <SearchField type="search" className={styles.search} label={t('common.memory.searchLabel')} placeholder={t('common.memory.searchPlaceholder')} value={query} onChange={setQuery} />
        {listedStores.length > 1 && <FilterSelect className={styles.sourceSelect} label={t('common.memory.sourceFilter')} value={source} options={sourceOptions} triggerDetail={false} onChange={setSource} />}
        {types.length > 0 && <div className={styles.chips} role="group" aria-label={t('common.memory.typeFilter')}>
          {['all', ...types].map(value => <button key={value} type="button" aria-pressed={kind === value} data-type={value} onClick={() => setKind(value)}>{value === 'all' ? t('common.memory.typeAll') : typeLabel(value)}</button>)}
        </div>}
        <span className={styles.count}>{filtering ? t('common.memory.countFiltered', { filtered: visible.length, total }) : t('common.memory.countAll', { count: total, stores: listedStores.length })}</span>
      </span>}
      {switchGroups.length > 0 && switchGroups.map(group => <div key={group.id} className={styles.scopeSwitch}>
        <strong>{t(group.scope === 'global' ? 'common.memory.userScopeSwitch' : 'common.memory.projectScopeSwitch')}</strong>
        <span>{group.enabled === null ? t('common.memory.nativeDefault') : group.enabled ? t('common.memory.autoOnShort') : t('common.memory.autoOffShort')}</span>
        {can('master_switch') && <select aria-label={t(group.scope === 'global' ? 'common.memory.userScopeSwitch' : 'common.memory.projectScopeSwitch')} value={group.enabled === null ? 'default' : group.enabled ? 'on' : 'off'} disabled={busy} onChange={event => void setGroupEnabled(group.id, event.target.value === 'on')}>
          {group.enabled === null && <option value="default" disabled>{t('common.memory.nativeDefaultShort')}</option>}
          <option value="on">{t('common.memory.autoOnShort')}</option><option value="off">{t('common.memory.autoOffShort')}</option>
        </select>}
      </div>)}
      {storeSwitches.map(storeSwitchRow)}
      {(master && !master.inUse || offWithoutSwitch) && <p className={styles.offNote} role="status" title={offDetail}><Icon name="eyeOff" size={14} />{t('common.memory.notInUse')}</p>}
      {actions}
    </> : undefined}
    notices={<>
      {missingDraft && <StatusBanner tone="warning">{t('common.memory.missingDraft')}</StatusBanner>}
      {Object.keys(docErrors).length > 0 && <StatusBanner tone="warning" action={<button type="button" className="button" disabled={busy || refreshing} onClick={() => void reload()}>{t('common.memory.retryBodies')}</button>}>{t('common.memory.partialBodies', { count: Object.keys(docErrors).length })} {Object.values(docErrors)[0]}</StatusBanner>}
      {listFailure && <StatusBanner tone="error" action={listFailure.retry ? <button type="button" className="button" onClick={() => { const retry = listFailure.retry; setListFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{listFailure.message}</StatusBanner>}
      {failure && <StatusBanner tone="error" onDismiss={() => setFailure(null)} action={failure.retry ? <button type="button" className="button" onClick={() => { const retry = failure.retry; setFailure(null); void retry?.(); }}>{t('common.memory.retry')}</button> : undefined}>{failure.message}</StatusBanner>}
      {aggregate && aggregate.failedSources.length > 0 && <div className={styles.sourceFailures}>{aggregate.failedSources.map(item => <p key={item.label} role="status"><Icon name="alert" size={14} />{t('common.memory.sourceFailed', { label: item.label, reason: item.reason })}</p>)}</div>}
      {aggregate && can('create') && destinations.length === 0 && <p className={styles.hint}><Icon name="info" size={14} />{t('common.memory.createUnavailable', { tool })}</p>}
    </>}
    list={!aggregate && !listFailure
      ? <div className={styles.loading} role="status" aria-label={t('common.memory.loading')}><span className="skeleton-block short" /><span className="skeleton-block" /><span className="skeleton-block tall" /></div>
      : aggregate && total === 0
        ? <EmptyState icon="sparkle" title={t('common.memory.emptyTitle')} detail={aggregate.failedSources.length ? t('common.memory.emptyFailed') : t('common.memory.emptyAll')} action={can('create') && destinations.length > 0 ? <button type="button" className="button primary" disabled={busy} onClick={() => void startCompose()}><Icon name="plus" size={14} />{t('common.memory.create')}</button> : undefined} />
        : aggregate && filtering && visible.length === 0
          ? <div className={styles.noMatch}><Icon name="search" size={18} /><p>{needle ? t('common.memory.noMatch', { query: query.trim() }) : t('common.memory.noMatchFilter')}</p><button type="button" className="button" onClick={clearFilters}>{t('common.memory.clearFilters')}</button></div>
          : aggregate ? <nav ref={listRef} className={styles.list} aria-label={t('common.memory.listLabel')} onKeyDown={onListKey}>{ordered.map(entryButton)}</nav> : null}
    placeholder={aggregate && total > 0 && !current && !compose ? <div className={styles.placeholder}>
      <span className={styles.placeholderIcon} aria-hidden="true"><Icon name="sparkle" size={22} /></span>
      <strong>{t('common.memory.selectHint')}</strong>
      <p>{t('common.memory.selectDetail')}</p>
      <span className={styles.keys}><kbd>↑</kbd><kbd>↓</kbd>{t('common.memory.keysHint')}</span>
    </div> : null}
    document={compose ? <form className={styles.detail} aria-label={t('common.memory.createTitle')} onSubmit={event => { event.preventDefault(); void createMemory(false); }}>
      <div className={styles.titleBar}><h3>{compose.id.trim() ? parseMemory(compose.id.trim(), compose.text).title : t('common.memory.untitled')}</h3></div>
      <div className={styles.composeFields}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('common.memory.destination')}</span>
          <FilterSelect label={t('common.memory.destination')} triggerDetail={false} value={compose.destination} options={destinations.map(item => ({ value: item.value, label: item.label, detail: item.detail, note: item.note }))} onChange={value => setCompose(previous => previous ? { ...previous, destination: value } : previous)} forceSearch={destinations.length > 6} onPickFolder={memory.scope.project ? () => void chooseFolder() : undefined} pickFolderLabel={t('common.memory.pickFolder')} />
          {composeDestination && <small className={styles.fieldHint}>{t('common.memory.writeLocation', { target: composeDestination.detail ?? composeDestination.label })}</small>}
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('common.memory.idLabel')}</span>
          <span className={styles.idInput} data-invalid={!!composeIdError || undefined}><input aria-label={t('common.memory.idLabel')} aria-invalid={!!composeIdError} value={compose.id} placeholder={t('common.memory.idPlaceholder')} spellCheck={false} autoFocus onChange={event => { const value = event.target.value; setCompose(previous => previous ? { ...previous, id: value } : previous); }} /><span aria-hidden="true">.md</span></span>
          <small className={styles.fieldHint} data-tone={composeIdError ? 'error' : undefined}>{composeIdError || t(aggregate?.nativeFileNames ? 'common.memory.nativeIdHint' : 'common.memory.idHint')}</small>
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
    </form> : current ? <article className={styles.detail} aria-label={currentParsed?.title ?? current.entry.id} aria-busy={reading || undefined}>
      <div className={styles.titleBar}>
        <h3>{currentParsed?.title ?? current.entry.id}</h3>
        <div className={styles.titleTools}>
          {can('edit')
            ? <div className={styles.segmented} role="group" aria-label={t('common.memory.viewMode')}>
              <button type="button" aria-pressed={!editing} disabled={busy} onClick={() => { if (editing) void stopEdit(); }}><Icon name="eye" size={14} />{t('common.memory.read')}</button>
              <button type="button" aria-pressed={editing} disabled={busy || (reading && !editing)} onClick={() => { if (!editing) void startEdit(); }}><Icon name="pencil" size={14} />{t('common.memory.edit')}</button>
            </div>
            : <span className={styles.readOnlyPill}><Icon name="lock" size={12} />{t('common.memory.readOnly')}</span>}
          {can('item_enable') && <span className={styles.inlineSwitch}><span aria-hidden="true">{t('common.memory.enabledLabel')}</span><Switch checked={current.entry.enabled} label={t('common.memory.enable', { id: current.entry.id })} disabled={busy} onChange={value => void setEnabled(value, current.entry.target, current.entry.id)} /></span>}
          {!current.entry.enabled && <span className={styles.typeBadge} data-type="off">{t('common.memory.disabledBadge')}</span>}
          <button type="button" className={styles.metaButton} aria-expanded={propertiesOpen} onClick={() => setPropertiesOpen(value => !value)}><Icon name="info" size={13} />{t('common.memory.pathLayer')}</button>
          {can('delete') && <button type="button" className={`${styles.ghostIcon} ${styles.danger}`} aria-label={t('common.memory.delete', { id: current.entry.id })} title={t('common.memory.delete', { id: current.entry.id })} disabled={busy} onClick={() => void confirmRemove(current)}><Icon name="trash" size={15} /></button>}
        </div>
      </div>
      {propertiesOpen && <div className={styles.pathPanel} data-memory-path="">
        <p className={styles.pathLine}><span className={styles.mono}>{displayPath(current.entry.path)}</span><button type="button" className={styles.metaButton} onClick={() => void copyPath(current.entry.path)}><Icon name="copy" size={13} />{t('common.memory.copyPath')}</button></p>
        {currentStore?.path && currentStore.path !== displayPath(current.entry.path) && <p className={styles.pathSource}>{currentStore.path}</p>}
        {currentParsed?.modified && <p className={styles.metaText} title={relativeTime(currentParsed.modified, i18n.language)?.absolute}><Icon name="clock" size={13} />{t('common.memory.modified', { time: relativeTime(currentParsed.modified, i18n.language)?.text ?? currentParsed.modified })}</p>}
        {currentParsed && currentParsed.properties.length > 0 && <dl className={styles.properties}>{currentParsed.properties.map(item => <div key={item.key}><dt>{item.key}</dt><dd>{item.value || '—'}</dd></div>)}</dl>}
      </div>}
      {editing
        ? <>
          <div className={styles.editorArea}><CodeEditor key={current.key} label={t('common.memory.textLabel')} format="markdown" value={draft} onChange={setDraft} readOnly={busy} documentId={current.key} /></div>
          <div className={styles.detailFoot}>
            <span className={styles.footNote} data-dirty={dirty || undefined}>{dirty ? t('common.memory.unsaved') : t('common.memory.saveShortcut', { mod: modLabel })}</span>
            <button type="button" className="button" disabled={busy} onClick={() => void stopEdit()}>{dirty ? t('common.memory.discard') : t('common.memory.done')}</button>
            <button type="button" className={`button primary ${styles.primary}`} disabled={busy || !dirty} onClick={() => void saveOpened(false)}>{t('common.memory.save')}</button>
          </div>
        </>
        : <div className={styles.readBody} role="region" aria-label={t('common.memory.textLabel')}>
          {currentParsed
            ? currentParsed.displayBody.trim()
              ? <div className={styles.prose}><Suspense fallback={<pre className={styles.raw}>{currentParsed.displayBody}</pre>}><MemoryMarkdown text={currentParsed.displayBody} resolve={target => !!linkedRow(target, current.store)} onOpen={target => { const row = linkedRow(target, current.store); if (row) void select(row); }} /></Suspense></div>
              : <p className={styles.emptyBody}>{t('common.memory.emptyBody')}</p>
            : reading || current.pending
              ? <div className={styles.bodyPending} role="status" aria-label={t('common.memory.reading')}><span /><span /><span /></div>
              : <p className={styles.emptyBody}>{t('common.memory.readFailed')}</p>}
        </div>}
    </article> : null}
  />;
}
