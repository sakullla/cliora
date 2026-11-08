import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { RemoteReadStatus, useRemoteReads } from '../../lib/remoteReads';
import type { RemoteDirectoryListing, RemoteProject, RemoteTarget } from '../../types/remote';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import rowMenuStyles from '../../components/RowMenu.module.css';
import { writeClipboard } from '../../lib/clipboard';
import { isEditableTarget, modLabel } from '../../lib/shortcut';
import { beginDirectoryInspection, beginDirectoryReceipt, blocksDirectoryCreation, loadDirectoryReceipts, updateDirectoryReceipt, useDirectoryReceipts, type DirectoryReceipt } from './directoryReceipts';
import { normalizeRemotePath, remoteBaseName, remoteJoin, remoteParent, remoteStartPath } from './remoteLaunch';
import styles from './RemoteFolderPicker.module.css';

const hiddenKey = 'cliora:remote-picker-hidden';
const pinsKey = (targetId: string) => `cliora:remote-picker-pins:${targetId}`;
const PAGE = 8;

function readPins(targetId: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(pinsKey(targetId)) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(normalizeRemotePath).filter((item) => item.startsWith('/')) : [];
  } catch { return []; }
}

/** What was right-clicked: a listed folder, a breadcrumb, a sidebar place, or the folder itself (blank space). */
type MenuKind = 'folder' | 'crumb' | 'place' | 'blank';
type MenuState = { kind: MenuKind; path: string; x: number; y: number; returnFocus: HTMLElement | null };

/** The folder a step up lands on, so the list keeps the place you came from selected. */
function childOnTheWay(ancestor: string, from: string) {
  if (!from || ancestor === from) return null;
  const prefix = ancestor === '/' ? '/' : ancestor + '/';
  if (!from.startsWith(prefix)) return null;
  const next = from.slice(prefix.length).split('/').filter(Boolean)[0];
  return next ? remoteJoin(ancestor, next) : null;
}

function commonPrefix(values: string[]) {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index].toLowerCase() === value[index].toLowerCase()) index++;
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

function errorText(error: unknown) {
  const value = error as { message?: string; action?: string };
  return [value?.message || String(error), value?.action].filter(Boolean).join(' · ');
}
const missing = (error: unknown) => (error as { remote?: { reason?: string } })?.remote?.reason === 'directory_missing';

/**
 * The remote counterpart of the system folder dialog. It only answers "which folder": the host is
 * the current run location, and the caller decides what to launch there.
 */
export function RemoteFolderPicker({ open, targetId, initialPath, title, onClose, onPick }: {
  open: boolean;
  targetId: string;
  initialPath?: string;
  title?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<RemoteTarget[] | null>(null);
  const [recent, setRecent] = useState<RemoteProject[]>([]);
  const target = targets?.find((item) => item.id === targetId) ?? null;
  const [cwd, setCwd] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(() => { try { return localStorage.getItem(hiddenKey) === 'true'; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [listing, setListing] = useState<{ key: string; value: RemoteDirectoryListing } | null>(null);
  const [failure, setFailure] = useState<{ key: string; text: string; missing: boolean } | null>(null);
  const [busy, setBusy] = useState<'list' | 'mkdir' | ''>('');
  const [message, setMessage] = useState('');
  const receipts = useDirectoryReceipts();
  const [receiptsReady, setReceiptsReady] = useState(false);
  const inspections = useRef(new Set<AbortController>());
  const inspectingIds = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number } | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [back, setBack] = useState<string[]>([]);
  const [forward, setForward] = useState<string[]>([]);
  const [flash, setFlash] = useState<{ id: number; text: string; failed: boolean } | null>(null);
  const reveal = useRef<string | null>(null);
  const [cameFrom, setCameFrom] = useState<string | null>(null);
  const typeahead = useRef({ text: '', at: 0 });

  const reads = useRemoteReads(targetId, cwd, open && !!cwd);
  const context = JSON.stringify([reads.identity, target?.updatedAt, cwd, open]);
  const current = useRef(context);
  current.current = context;
  const operation = useRef<{ controller: AbortController; serial: number } | null>(null);
  const serial = useRef(0);

  // Each opening starts from the requested folder, after this host's record is known.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { openedFor.current = null; return; }
    let live = true;
    const loadTargets = () => { void native.listRemoteTargets().then((items) => { if (live) setTargets(Array.isArray(items) ? items : []); }).catch(() => { if (live) setTargets([]); }); };
    loadTargets();
    void native.listRemoteProjects(targetId).then((items) => { if (live && Array.isArray(items)) setRecent(items.filter((item) => item.targetId === targetId).sort((a, b) => b.updatedAt - a.updatedAt)); }).catch(() => {});
    // A host edited while browsing gets a new revision; its old listing must not stay on screen.
    window.addEventListener('cliora:remote-targets-changed', loadTargets);
    return () => { live = false; window.removeEventListener('cliora:remote-targets-changed', loadTargets); };
  }, [open, targetId]);
  useEffect(() => {
    if (!open || !target) return;
    const token = `${targetId}|${initialPath ?? ''}`;
    if (openedFor.current === token) return;
    openedFor.current = token;
    setCwd(normalizeRemotePath(initialPath ?? '') || remoteStartPath(target));
    setSelected(null); setFilter(''); setEditing(false); setCreating(false); setMessage('');
    setBack([]); setForward([]); setMenu(null); reveal.current = null;
  }, [open, target, targetId, initialPath]);
  useEffect(() => { if (open) setPins(readPins(targetId)); }, [open, targetId]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);
  useEffect(() => () => { for (const controller of inspections.current) controller.abort(); inspections.current.clear(); }, [open]);

  useEffect(() => {
    setBusy(''); setMessage('');
    if (open && target && cwd) void loadDirectories();
    return () => { operation.current?.controller.abort(); operation.current = null; };
  }, [context]);
  // A new folder clears the selection and filter; a typed new-folder name stays as a draft.
  useEffect(() => { setSelected(null); setFilter(''); setCameFrom(null); }, [cwd, targetId]);
  const folderNameRef = useRef(folderName);
  folderNameRef.current = folderName;

  // A failed refresh keeps the last good listing of this folder on screen; a new host identity clears it.
  const loaded = listing?.key === context ? listing.value : null;
  const failed = failure?.key === context ? failure : null;
  const shownListing = loaded;
  const folders = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (shownListing?.items ?? [])
      .map((path) => ({ path: normalizeRemotePath(path), name: remoteBaseName(path) }))
      .filter((item) => item.name && (showHidden || !item.name.startsWith('.')) && (!needle || item.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [shownListing, filter, showHidden]);
  const allFolders = useMemo(() => (shownListing?.items ?? []).map((path) => ({ path: normalizeRemotePath(path), name: remoteBaseName(path) })).filter((item) => item.name), [shownListing]);
  // After stepping up or back, mark the folder you came from and keep it in view. It is not selected:
  // the footer and 选择此文件夹 keep meaning the folder you went to.
  useEffect(() => {
    const wanted = reveal.current;
    if (!wanted || !shownListing) return;
    reveal.current = null;
    const index = folders.findIndex((item) => item.path === wanted);
    if (index < 0) return;
    setCameFrom(wanted);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [folders, shownListing]);
  const hiddenCount = useMemo(() => (shownListing?.items ?? []).filter((path) => remoteBaseName(path).startsWith('.')).length, [shownListing]);
  const chosen = selected ?? cwd;
  const newFolderPath = folderName.trim() ? remoteJoin(cwd, folderName.trim()) : '';
  const folderNameInvalid = !!folderName.trim() && (/[/\\]/.test(folderName) || ['.', '..'].includes(folderName.trim()));
  const creationBlocked = !!newFolderPath && receipts.some((item) => blocksDirectoryCreation(item, target, newFolderPath));
  const segments = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean);
    return [{ label: '/', path: '/' }, ...parts.map((part, index) => ({ label: part, path: '/' + parts.slice(0, index + 1).join('/') }))];
  }, [cwd]);

  function begin() {
    operation.current?.controller.abort();
    const request = { controller: new AbortController(), serial: ++serial.current };
    operation.current = request;
    const key = context;
    return { ...request, key, isCurrent: () => current.current === key && operation.current?.serial === request.serial };
  }

  async function loadDirectories(fresh = false) {
    if (!target || !cwd) return;
    const request = begin();
    setBusy('list'); setMessage('');
    try {
      await loadDirectoryReceipts(fresh).then(() => setReceiptsReady(true), (error) => { if (request.isCurrent()) setMessage(errorText(error)); });
      const value = await reads.native.listRemoteDirectories(targetId, cwd, { fresh, signal: request.controller.signal });
      if (!request.isCurrent()) return;
      setListing({ key: request.key, value });
      setFailure(null);
    } catch (error) {
      if (request.isCurrent()) setFailure({ key: request.key, text: errorText(error), missing: missing(error) });
    } finally { if (request.isCurrent()) { setBusy(''); operation.current = null; } }
  }

  function navigate(path: string, history: 'push' | 'none' = 'push') {
    const next = normalizeRemotePath(path);
    if (!next || next.startsWith('~')) return;
    setEditing(false);
    if (next === cwd) { void loadDirectories(true); return; }
    if (history === 'push' && cwd) { setBack((list) => [...list.slice(-49), cwd]); setForward([]); }
    reveal.current = childOnTheWay(next, cwd);
    setCwd(next);
    // Keep keyboard browsing on the list, unless the user has already moved into a text field.
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
      listRef.current?.focus({ preventScroll: true });
    });
  }

  function goBack() {
    const previous = back[back.length - 1];
    if (!previous) return;
    setBack((list) => list.slice(0, -1));
    setForward((list) => [...list, cwd]);
    navigate(previous, 'none');
  }

  function goForward() {
    const next = forward[forward.length - 1];
    if (!next) return;
    setForward((list) => list.slice(0, -1));
    setBack((list) => [...list, cwd]);
    navigate(next, 'none');
  }

  function startCreate() {
    if (!cwd || busy !== '' || !receiptsReady) return;
    setCreating(true); setFolderName('');
  }

  function togglePin(path: string) {
    const value = normalizeRemotePath(path);
    setPins((list) => {
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      try { localStorage.setItem(pinsKey(targetId), JSON.stringify(next)); } catch { /* optional preference */ }
      return next;
    });
    setFlash({ id: Date.now(), text: pins.includes(value) ? t('home.remote.picker.unpinned', { name: remoteBaseName(value) || '/' }) : t('home.remote.picker.pinned', { name: remoteBaseName(value) || '/' }), failed: false });
  }

  // Call before any other await: WebKit only copies during the click's user activation.
  async function copy(value: string, what: 'path' | 'name') {
    const ok = await writeClipboard(value);
    setFlash({ id: Date.now(), text: ok ? t(what === 'path' ? 'home.remote.picker.copiedPath' : 'home.remote.picker.copiedName', { value }) : t('home.remote.picker.copyFailed'), failed: !ok });
  }

  function pick(path: string) {
    if (!path) return;
    operation.current?.controller.abort();
    onPick(path);
  }

  function openMenu(kind: MenuKind, path: string, x: number, y: number, returnFocus?: HTMLElement | null) {
    setMenu({ kind, path, x, y, returnFocus: returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) });
  }

  function openMenuFromEvent(event: ReactMouseEvent, kind: MenuKind, path: string) {
    event.preventDefault();
    event.stopPropagation();
    openMenu(kind, path, event.clientX, event.clientY, kind === 'folder' || kind === 'blank' ? listRef.current : event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  }

  /** Shift+F10 / the context-menu key opens the menu beside the selected row, or for the folder itself. */
  function openMenuFromKeyboard() {
    const row = selected ? listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`) : null;
    const box = (row ?? listRef.current)?.getBoundingClientRect();
    if (!box) return;
    openMenu(row && selected ? 'folder' : 'blank', row && selected ? selected : cwd, box.left + Math.min(48, box.width / 2), row ? box.bottom : box.top + 8, listRef.current);
  }

  function closeMenu(restoreFocus: boolean) {
    const previous = menu?.returnFocus;
    setMenu(null);
    if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
    else requestAnimationFrame(() => {
      // An action that moved focus (a new-folder field, the path input) keeps it.
      if (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected) (previous?.isConnected ? previous : listRef.current)?.focus({ preventScroll: true });
    });
  }

  useEffect(() => { if (!menu) setMenuBox(null); }, [menu]);
  useLayoutEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    setMenuBox({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - node.offsetWidth - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - node.offsetHeight - 8)),
    });
    node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => { if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setMenu(null); };
    // The picker is a modal dialog: Escape closes the menu first, not the dialog.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); } };
    const close = () => setMenu(null);
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  useEffect(() => { setMenu(null); }, [cwd, open]);

  function menuNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? []];
    if (!items.length) return;
    if (event.key === 'Tab') { event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  function selectAt(index: number) {
    const item = folders[index];
    if (!item) return;
    setSelected(item.path);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  /** Path field: Tab completes a folder name of the folder on screen. */
  function completePath(event: ReactKeyboardEvent<HTMLInputElement>) {
    const slash = pathDraft.lastIndexOf('/');
    if (slash < 0) return;
    const parent = normalizeRemotePath(pathDraft.slice(0, slash) || '/');
    const partial = pathDraft.slice(slash + 1);
    if (parent !== cwd || !partial) return;
    const matches = allFolders.filter((item) => item.name.toLowerCase().startsWith(partial.toLowerCase()));
    if (!matches.length) return;
    event.preventDefault();
    setPathDraft(matches.length === 1 ? matches[0].path + '/' : remoteJoin(cwd, commonPrefix(matches.map((item) => item.name)) || partial));
  }

  async function createFolder() {
    const next = newFolderPath;
    const submitted = folderName.trim();
    if (!target || !next || folderNameInvalid || creationBlocked || !receiptsReady || busy) return;
    const request = begin();
    let receipt: DirectoryReceipt | null = null;
    let dispatched = false;
    let created = false;
    setBusy('mkdir'); setMessage('');
    try {
      receipt = await beginDirectoryReceipt(target, next);
      if (!receipt) { if (request.isCurrent()) setMessage(t('home.remote.receiptLimit')); return; }
      request.controller.signal.throwIfAborted();
      dispatched = true;
      await native.createRemoteDirectory(receipt.target.id, next, { signal: request.controller.signal, targetRevision: receipt.target.updatedAt }, receipt.id);
      created = true;
      await updateDirectoryReceipt(receipt.id, { outcome: 'created' });
      if (!request.isCurrent() || request.controller.signal.aborted) return;
      // A name typed after submitting is a new draft; keep it.
      const untouched = folderNameRef.current.trim() === submitted;
      if (untouched) { setCreating(false); setFolderName(''); }
      const value = await reads.native.listRemoteDirectories(targetId, cwd, { fresh: true, signal: request.controller.signal });
      if (request.isCurrent()) { setListing({ key: request.key, value }); setFailure(null); if (untouched) setSelected(next); }
    } catch (error) {
      if (!created && receipt) {
        const remoteOutcome = (error as { remote?: { outcome?: string } })?.remote?.outcome;
        await updateDirectoryReceipt(receipt.id, { outcome: dispatched && remoteOutcome !== 'failed' ? 'unknown' : 'failed', detail: errorText(error) });
      } else if (request.isCurrent()) setMessage(errorText(error));
    } finally { if (request.isCurrent()) { setBusy(''); operation.current = null; } }
  }

  async function inspectReceipt(receipt: DirectoryReceipt) {
    if (receipt.outcome === 'pending' || receipt.inspection?.state === 'checking' || inspectingIds.current.has(receipt.id)) return;
    inspectingIds.current.add(receipt.id);
    const isCurrent = beginDirectoryInspection(receipt.id);
    const controller = new AbortController();
    inspections.current.add(controller);
    try {
      if (!await updateDirectoryReceipt(receipt.id, { inspection: { state: 'checking', detail: '' } }, isCurrent)) return;
      // Check the persisted host identity before using the original revision for a remote read.
      const original = (await native.listRemoteTargets()).find((item) => item.id === receipt.target.id);
      controller.signal.throwIfAborted();
      if (!original || original.updatedAt !== receipt.target.updatedAt || original.host !== receipt.target.host || original.port !== receipt.target.port || original.user !== receipt.target.user) {
        await updateDirectoryReceipt(receipt.id, { inspection: { state: 'failed', detail: t('home.remote.receiptIdentityChanged') } }, isCurrent);
        return;
      }
      await native.listRemoteDirectories(receipt.target.id, receipt.path, { fresh: true, targetRevision: receipt.target.updatedAt, signal: controller.signal });
      await updateDirectoryReceipt(receipt.id, { inspection: { state: 'exists', detail: t('home.remote.receiptExists') } }, isCurrent);
    } catch (error) {
      await updateDirectoryReceipt(receipt.id, { inspection: { state: missing(error) ? 'missing' : 'failed', detail: missing(error) ? t('home.remote.receiptMissing') : errorText(error) } }, isCurrent);
    } finally { inspections.current.delete(controller); inspectingIds.current.delete(receipt.id); }
  }

  function close() {
    operation.current?.controller.abort();
    operation.current = null;
    onClose();
  }

  function confirm() {
    if (!chosen || (selected === null && failed?.missing)) return;
    pick(chosen);
  }

  function toggleHidden() {
    setShowHidden((value) => {
      try { localStorage.setItem(hiddenKey, String(!value)); } catch { /* optional preference */ }
      return !value;
    });
  }

  function startEdit() {
    setPathDraft(cwd);
    setEditing(true);
  }

  function onListKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLElement && event.target.matches('[role="option"]'))) return;
    const last = folders.length - 1;
    const anchor = folders.findIndex((item) => item.path === cameFrom);
    // Arrow keys start from the folder you came from before anything is selected.
    if (!selected && anchor >= 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); selectAt(anchor); return; }
    const index = folders.findIndex((item) => item.path === selected);
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openMenuFromKeyboard();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      if (!folders.length) return;
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? last
          : event.key === 'ArrowDown' ? Math.min(last, index + 1)
            : event.key === 'ArrowUp' ? Math.max(0, index < 0 ? 0 : index - 1)
              : event.key === 'PageDown' ? Math.min(last, Math.max(0, index) + PAGE)
                : Math.max(0, index - PAGE);
      selectAt(next);
    } else if (event.key === 'Enter' && selected && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigate(selected);
    } else if (event.key === 'Backspace' && cwd !== '/') {
      event.preventDefault();
      navigate(remoteParent(cwd));
    } else if (event.key === 'Escape' && selected) {
      event.preventDefault();
      event.stopPropagation();
      setSelected(null);
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && folders.length) {
      // Type-ahead: typing a name jumps to it; repeating one letter cycles through its folders.
      const now = Date.now();
      const key = event.key.toLowerCase();
      const text = now - typeahead.current.at < 800 ? typeahead.current.text + key : key;
      typeahead.current = { text, at: now };
      const cycle = [...text].every((char) => char === text[0]);
      const needle = cycle ? text[0] : text;
      const start = cycle ? index + 1 : Math.max(0, index);
      const order = [...folders.keys()].map((offset) => (start + offset) % folders.length);
      const hit = order.find((position) => folders[position].name.toLowerCase().startsWith(needle));
      if (hit !== undefined) { event.preventDefault(); selectAt(hit); }
    }
  }

  function onDialogKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (menu) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const editable = isEditableTarget(event.target);
    if (mod && !event.shiftKey && key === 'l') { event.preventDefault(); startEdit(); }
    else if (event.altKey && event.key === 'ArrowUp' && cwd !== '/') { event.preventDefault(); navigate(remoteParent(cwd)); }
    else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
    else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
    else if (event.key === 'F5' || (mod && !event.shiftKey && key === 'r')) { event.preventDefault(); if (busy === '') void loadDirectories(true); }
    else if (editable) return;
    else if (mod && event.shiftKey && key === 'n') { event.preventDefault(); startCreate(); }
    else if (mod && event.shiftKey && key === 'c') { event.preventDefault(); void copy(chosen, 'path'); }
    else if (mod && event.key === 'Enter') { event.preventDefault(); confirm(); }
  }

  // Mouse back/forward buttons walk the browsing history, like a file manager.
  function onDialogMouseUp(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button === 3) { event.preventDefault(); goBack(); }
    else if (event.button === 4) { event.preventDefault(); goForward(); }
  }

  function renderMenu(state: MenuState) {
    const { kind, path } = state;
    const name = remoteBaseName(path) || '/';
    const pinned = pins.includes(path);
    const label = kind === 'blank' ? t('home.remote.picker.folderMenu') : t('home.remote.picker.menu', { name });
    const pinItem = <button type="button" role="menuitem" onClick={() => togglePin(path)}><Icon name="star" size={14} /><span>{pinned ? t('home.remote.picker.unpin') : t('home.remote.picker.pin')}</span></button>;
    const copyPath = <button type="button" role="menuitem" onClick={() => void copy(path, 'path')}><Icon name="copy" size={14} /><span>{kind === 'blank' ? t('home.remote.picker.copyCurrentPath') : t('home.remote.picker.copyPath')}</span>{(kind === 'blank' || kind === 'folder') && <kbd>{modLabel}+Shift+C</kbd>}</button>;
    const divider = (key: string) => <span key={key} className={styles.menuDivider} role="separator" />;
    return <div ref={menuRef} className={`${rowMenuStyles.rowMenuList} ${styles.menu}`} role="menu" aria-label={label} style={menuBox ?? { top: 0, left: -10000 }} onKeyDown={menuNavigate} onContextMenu={(event) => event.preventDefault()} onMouseUp={(event) => event.stopPropagation()} onClick={() => closeMenu(false)}>
      {kind === 'folder' && <>
        <button type="button" role="menuitem" onClick={() => navigate(path)}><Icon name="folder" size={14} /><span>{t('home.remote.picker.menuOpen')}</span><kbd>Enter</kbd></button>
        <button type="button" role="menuitem" onClick={() => pick(path)}><Icon name="check" size={14} /><span>{t('home.remote.picker.menuChoose')}</span><kbd>{modLabel}+Enter</kbd></button>
        <button type="button" role="menuitem" disabled={busy !== '' || !receiptsReady} onClick={() => { navigate(path); setCreating(true); setFolderName(''); }}><Icon name="plus" size={14} /><span>{t('home.remote.picker.newFolderInside')}</span></button>
        {divider('a')}
        {copyPath}
        <button type="button" role="menuitem" onClick={() => void copy(name, 'name')}><Icon name="clipboard" size={14} /><span>{t('home.remote.picker.copyName')}</span></button>
        {divider('b')}
        {pinItem}
      </>}
      {kind === 'crumb' && <>
        {path !== cwd && <button type="button" role="menuitem" onClick={() => navigate(path)}><Icon name="folder" size={14} /><span>{t('home.remote.picker.menuOpen')}</span></button>}
        <button type="button" role="menuitem" disabled={path === cwd && !!failed?.missing} onClick={() => pick(path)}><Icon name="check" size={14} /><span>{t('home.remote.picker.menuChoose')}</span></button>
        {divider('a')}
        {copyPath}
        {pinItem}
        {divider('b')}
        <button type="button" role="menuitem" onClick={startEdit}><Icon name="pencil" size={14} /><span>{t('home.remote.picker.editPath')}</span><kbd>{modLabel}+L</kbd></button>
      </>}
      {kind === 'place' && <>
        <button type="button" role="menuitem" onClick={() => navigate(path)}><Icon name="folder" size={14} /><span>{t('home.remote.picker.menuOpen')}</span></button>
        {divider('a')}
        {copyPath}
        {pinItem}
      </>}
      {kind === 'blank' && <>
        <button type="button" role="menuitem" disabled={!cwd || busy !== '' || !receiptsReady} onClick={startCreate}><Icon name="plus" size={14} /><span>{t('home.remote.picker.newFolder')}</span><kbd>{modLabel}+Shift+N</kbd></button>
        <button type="button" role="menuitem" disabled={busy !== ''} onClick={() => void loadDirectories(true)}><Icon name="refresh" size={14} /><span>{t('home.remote.picker.refresh')}</span><kbd>F5</kbd></button>
        {divider('a')}
        <button type="button" role="menuitem" disabled={!cwd || !!failed?.missing} onClick={() => pick(cwd)}><Icon name="check" size={14} /><span>{t('home.remote.picker.menuChooseCurrent')}</span>{!selected && <kbd>{modLabel}+Enter</kbd>}</button>
        {copyPath}
        {pinItem}
        {divider('b')}
        <button type="button" role="menuitemcheckbox" aria-checked={showHidden} onClick={toggleHidden}><Icon name={showHidden ? 'eye' : 'eyeOff'} size={14} /><span>{t('home.remote.picker.showHidden')}</span>{showHidden && <span className={styles.menuCheck}><Icon name="check" size={14} /></span>}</button>
        <button type="button" role="menuitem" disabled={cwd === '/'} onClick={() => navigate(remoteParent(cwd))}><Icon name="arrowUp" size={14} /><span>{t('home.remote.picker.up')}</span><kbd>Alt+↑</kbd></button>
      </>}
    </div>;
  }

  const loading = busy === 'list' && !shownListing;
  const hostLine = target ? `${target.user}@${target.host}${target.port !== 22 ? `:${target.port}` : ''}` : '';
  const places = target ? [
    { path: remoteStartPath(target), label: t('home.remote.picker.home'), icon: 'home' as const },
    { path: '/', label: t('home.remote.picker.root'), icon: 'server' as const },
  ].filter((item, index, list) => list.findIndex((other) => other.path === item.path) === index) : [];

  return <GuideDialog open={open} title={title ?? t('home.remote.picker.title')} hint={target ? t('home.remote.picker.hint', { host: target.name }) : undefined} wide onClose={close}>
    <div className={styles.picker} onKeyDown={onDialogKey} onMouseUp={onDialogMouseUp}>
      {targets && !target ? <div className={styles.unavailable}><Icon name="globe" size={20} /><span>{t('home.remote.noTargets')}</span></div> : <>
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolButton} aria-label={t('home.remote.picker.back')} title={`${t('home.remote.picker.back')} (Alt+←)`} disabled={!back.length} onClick={goBack}><Icon name="arrowLeft" size={15} /></button>
          <button type="button" className={styles.toolButton} aria-label={t('home.remote.picker.forward')} title={`${t('home.remote.picker.forward')} (Alt+→)`} disabled={!forward.length} onClick={goForward}><Icon name="arrowRight" size={15} /></button>
          <button type="button" className={styles.toolButton} aria-label={t('home.remote.picker.up')} title={`${t('home.remote.picker.up')} (Alt+↑)`} disabled={!cwd || cwd === '/'} onClick={() => navigate(remoteParent(cwd))}><Icon name="arrowUp" size={15} /></button>
          {editing
            ? <form className={styles.pathForm} onSubmit={(event) => { event.preventDefault(); navigate(pathDraft); }}>
              <input ref={pathInput} autoFocus onFocus={(event) => event.currentTarget.select()} className={styles.pathInput} aria-label={t('home.remote.path')} value={pathDraft} spellCheck={false} autoComplete="off" placeholder={t('home.remote.pathPlaceholder')} onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); } else if (event.key === 'Tab' && !event.shiftKey) completePath(event); }} onBlur={() => setEditing(false)} />
              <kbd>Enter</kbd>
            </form>
            : <nav className={styles.crumbs} aria-label={t('home.remote.picker.location')} onClick={(event) => { if (event.target === event.currentTarget) startEdit(); }} onContextMenu={(event) => openMenuFromEvent(event, 'crumb', cwd)}>
              {segments.map((segment, index) => <span key={segment.path} className={styles.crumb}>
                {index > 1 && <Icon name="chevronRight" size={12} />}
                <button type="button" aria-current={index === segments.length - 1 ? 'location' : undefined} title={segment.path} onClick={() => navigate(segment.path)} onContextMenu={(event) => openMenuFromEvent(event, 'crumb', segment.path)}>{index === 0 ? <Icon name="server" size={13} /> : segment.label}</button>
              </span>)}
              <button type="button" className={styles.editPath} aria-label={t('home.remote.picker.editPath')} title={`${t('home.remote.picker.editPath')} (Ctrl+L)`} onClick={startEdit}><Icon name="pencil" size={13} /></button>
            </nav>}
          <button type="button" className={styles.toolButton} data-pin aria-pressed={pins.includes(cwd)} aria-label={pins.includes(cwd) ? t('home.remote.picker.unpinCurrent') : t('home.remote.picker.pinCurrent')} title={pins.includes(cwd) ? t('home.remote.picker.unpinCurrent') : t('home.remote.picker.pinCurrent')} disabled={!cwd} onClick={() => togglePin(cwd)}><Icon name="star" size={15} /></button>
          <button type="button" className={styles.toolButton} aria-label={t('home.remote.refreshDirectories')} title={`${t('home.remote.refreshDirectories')} (F5)`} disabled={!cwd || busy !== ''} onClick={() => void loadDirectories(true)}><Icon name="refresh" size={15} /></button>
          <Button size="sm" className={styles.newFolder} icon={<Icon name="plus" size={14} />} title={`${t('home.remote.picker.newFolder')} (${modLabel}+Shift+N)`} disabled={!cwd || busy !== '' || !receiptsReady} onClick={startCreate}>{t('home.remote.picker.newFolder')}</Button>
        </div>

        <div className={styles.body}>
          <aside className={styles.places} aria-label={t('home.remote.picker.places')}>
            {target && <div className={styles.host}><span className={styles.hostGlyph}><Icon name="globe" size={15} /></span><span className={styles.hostCopy}><strong title={target.name}>{target.name}</strong><small title={hostLine}>{hostLine}</small></span></div>}
            <div className={styles.placeGroup}>
              {places.map((item) => <button key={item.path} type="button" className={styles.place} aria-current={cwd === item.path ? 'location' : undefined} title={item.path} onClick={() => navigate(item.path)} onContextMenu={(event) => openMenuFromEvent(event, 'place', item.path)}><Icon name={item.icon} size={14} /><span>{item.label}</span></button>)}
            </div>
            {pins.length > 0 && <div className={styles.placeGroup} role="group" aria-label={t('home.remote.picker.pins')}>
              <span className={styles.groupLabel} aria-hidden="true">{t('home.remote.picker.pins')}</span>
              {pins.map((path) => <button key={path} type="button" className={styles.place} data-pinned aria-current={cwd === path ? 'location' : undefined} title={path} onClick={() => navigate(path)} onContextMenu={(event) => openMenuFromEvent(event, 'place', path)}><Icon name="star" size={14} /><span className={styles.placeCopy}><span>{remoteBaseName(path) || '/'}</span><small>{path}</small></span></button>)}
            </div>}
            {recent.length > 0 && <div className={styles.placeGroup}>
              <span className={styles.groupLabel}>{t('home.remote.picker.recent')}</span>
              {recent.slice(0, 8).map((item) => <button key={item.id} type="button" className={styles.place} aria-current={cwd === normalizeRemotePath(item.path) ? 'location' : undefined} title={item.path} onClick={() => navigate(item.path)} onContextMenu={(event) => openMenuFromEvent(event, 'place', normalizeRemotePath(item.path))}><Icon name="clock" size={14} /><span className={styles.placeCopy}><span>{item.name}</span><small>{item.path}</small></span></button>)}
            </div>}
          </aside>

          <section className={styles.browser} aria-label={t('home.remote.picker.folders')}>
            <div className={styles.browserHead}>
              <label className={styles.filter} data-field-frame=""><Icon name="search" size={13} /><input aria-label={t('home.remote.picker.filter')} placeholder={t('home.remote.picker.filter')} value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); listRef.current?.focus(); if (folders[0]) setSelected(folders[0].path); } }} /></label>
              <button type="button" className={styles.hiddenToggle} aria-pressed={showHidden} title={t('home.remote.picker.showHidden')} onClick={toggleHidden}><Icon name={showHidden ? 'eye' : 'eyeOff'} size={13} /><span>{t('home.remote.picker.hiddenCount', { count: hiddenCount })}</span></button>
            </div>
            <RemoteReadStatus state={reads} />
            {message && <p className={styles.message} role="status">{message}</p>}
            {failed && <div className={styles.failure} role="status"><Icon name="alert" size={15} /><span>{failed.missing ? t('home.remote.picker.missing', { path: cwd }) : failed.text}</span><Button size="sm" variant="ghost" onClick={() => void loadDirectories(true)}>{t('home.remote.picker.retry')}</Button></div>}
            <div ref={listRef} className={styles.list} role="listbox" tabIndex={0} aria-label={t('home.remote.savedDirectory')} aria-busy={busy === 'list' || undefined} aria-activedescendant={undefined} onKeyDown={onListKey} onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }} onContextMenu={(event) => { if (isEditableTarget(event.target) || (event.target instanceof Element && event.target.closest('form'))) return; setSelected(null); openMenuFromEvent(event, 'blank', cwd); }}>
              {creating && <form className={styles.createRow} onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
                <Icon name="folder" size={16} />
                <input autoFocus aria-label={t('home.remote.picker.folderName')} placeholder={t('home.remote.picker.folderName')} value={folderName} spellCheck={false} autoComplete="off" aria-invalid={folderNameInvalid || undefined} onChange={(event) => { setFolderName(event.target.value); setMessage(''); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCreating(false); } }} />
                <Button size="sm" variant="primary" type="submit" disabled={!newFolderPath || folderNameInvalid || creationBlocked || !receiptsReady || busy !== ''} loading={busy === 'mkdir'}>{busy === 'mkdir' ? t('home.remote.creatingDirectory') : t('home.remote.createDirectory')}</Button>
                <button type="button" className={styles.toolButton} aria-label={t('home.remote.picker.cancelCreate')} disabled={busy === 'mkdir'} onClick={() => setCreating(false)}><Icon name="close" size={14} /></button>
                {(folderNameInvalid || creationBlocked) && <small className={styles.createHint}>{folderNameInvalid ? t('home.remote.picker.invalidName') : t('home.remote.picker.blocked')}</small>}
              </form>}
              {loading && Array.from({ length: 6 }, (_, index) => <div key={index} className={styles.skeleton} aria-hidden="true"><span /><span style={{ width: `${38 + (index * 17) % 40}%` }} /></div>)}
              {folders.map((item, index) => <div key={item.path} id={undefined} role="option" data-index={index} data-path={item.path} data-came-from={item.path === cameFrom || undefined} aria-selected={item.path === selected} className={styles.row} title={item.path} onClick={() => setSelected(item.path === selected ? null : item.path)} onDoubleClick={() => navigate(item.path)} onContextMenu={(event) => { setSelected(item.path); openMenuFromEvent(event, 'folder', item.path); }}>
                <span className={styles.rowGlyph} data-hidden={item.name.startsWith('.') || undefined}><Icon name="folder" size={16} /></span>
                <span className={styles.rowName}>{item.name}</span>
                {pins.includes(item.path) && <span className={styles.rowPin} title={t('home.remote.picker.pins')}><Icon name="star" size={12} /></span>}
                <button type="button" tabIndex={-1} className={styles.rowOpen} aria-label={t('home.remote.picker.rowMenu', { name: item.name })} title={t('home.remote.picker.rowMenu', { name: item.name })} onClick={(event) => { event.stopPropagation(); setSelected(item.path); const box = event.currentTarget.getBoundingClientRect(); openMenu('folder', item.path, box.left, box.bottom + 4, listRef.current); }} onDoubleClick={(event) => event.stopPropagation()}><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></button>
                <button type="button" tabIndex={-1} className={styles.rowOpen} aria-label={t('home.remote.picker.open', { name: item.name })} onClick={(event) => { event.stopPropagation(); navigate(item.path); }}><Icon name="chevronRight" size={14} /></button>
              </div>)}
              {!loading && shownListing && !folders.length && !creating && <div className={styles.empty}><Icon name="folder" size={22} /><strong>{filter.trim() ? t('home.remote.picker.noMatch', { query: filter.trim() }) : t('home.remote.noDirectories')}</strong>{!filter.trim() && hiddenCount > 0 && !showHidden && <button type="button" onClick={toggleHidden}>{t('home.remote.picker.revealHidden', { count: hiddenCount })}</button>}</div>}
            </div>
            {busy !== '' && <div className={styles.progress} aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><span>{busy === 'mkdir' ? t('home.remote.creatingDirectory') : t('home.remote.picker.reading')}</span><Button size="sm" variant="ghost" onClick={() => operation.current?.controller.abort()}>{t('home.remote.cancelOperation')}</Button></div>}
            {flash && <div key={flash.id} className={styles.flash} data-failed={flash.failed || undefined} role="status"><Icon name={flash.failed ? 'alert' : 'check'} size={13} /><span>{flash.text}</span></div>}
            {loaded?.truncated && <small className={styles.note}>{t('home.remote.directoryTruncated')}</small>}
          </section>
        </div>

        {receipts.length > 0 && <section className={styles.receipts} aria-label={t('home.remote.receiptTitle')}>
          <span className={styles.groupLabel}>{t('home.remote.receiptTitle')}</span>
          {receipts.map((receipt) => <article key={receipt.id} className={styles.receipt} data-outcome={receipt.outcome}>
            <span className={styles.receiptDot} aria-hidden="true" />
            <div className={styles.receiptCopy}>
              <code>{receipt.path}</code>
              <small>{receipt.target.name} · {receipt.target.user}@{receipt.target.host}:{receipt.target.port}</small>
              <span>{t(`home.remote.receiptOutcome.${receipt.outcome}`)}{receipt.detail && ` · ${receipt.detail}`}</span>
              {receipt.inspection && <span data-inspection={receipt.inspection.state}>{receipt.inspection.state === 'checking' ? t('home.remote.receiptChecking') : receipt.inspection.detail}</span>}
            </div>
            <Button size="sm" variant="ghost" disabled={receipt.outcome === 'pending' || receipt.inspection?.state === 'checking'} onClick={() => void inspectReceipt(receipt)}>{t('home.remote.receiptInspect')}</Button>
          </article>)}
        </section>}

        <footer className={styles.footer}>
          <div className={styles.selection}>
            <span className={styles.selectionGlyph}><Icon name="folder" size={15} /></span>
            <span className={styles.selectionCopy}><small>{selected ? t('home.remote.picker.selectedFolder') : t('home.remote.picker.currentFolder')}</small><code title={chosen}>{chosen || '—'}</code></span>
          </div>
          <Button onClick={close}>{t('common.dialog.cancel')}</Button>
          <Button variant="primary" data-dialog-save icon={<Icon name="check" size={14} />} disabled={!chosen || (selected === null && !!failed?.missing)} onClick={confirm}>{t('home.remote.picker.choose')}</Button>
        </footer>
        {menu && renderMenu(menu)}
      </>}
    </div>
  </GuideDialog>;
}
