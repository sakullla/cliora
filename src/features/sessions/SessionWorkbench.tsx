import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { navigateChoices } from '../../lib/choiceNavigation';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { RowMenu } from '../../components/RowMenu';
import rowMenuStyles from '../../components/RowMenu.module.css';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import type { LaunchMode, LaunchRequest, LaunchResult, LaunchSettings, Project, WorkbenchSession } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { LibraryItem } from '../../types/library';
import type { AdapterDescriptor } from '../../types/native';
import styles from './SessionWorkbench.module.css';

export type WorkbenchRetry =
  | { kind: 'launch'; request: LaunchRequest }
  | { kind: 'resume'; id: string; mode: LaunchMode };

export type WorkbenchFailure = { detail: string; retry: WorkbenchRetry };

type TerminalMatch = { row: number; col: number; length: number };

type TerminalHandle = {
  focus: () => void;
  clear: () => void;
  scrollToBottom: () => void;
  readOutput: () => string;
  findMatches: (query: string) => TerminalMatch[];
  revealMatch: (match: TerminalMatch | null) => void;
};

type RailFilter = 'all' | 'running' | 'ended';

const DEFAULT_RAIL_WIDTH = 292;
const MIN_RAIL_WIDTH = 236;
const MAX_RAIL_WIDTH = 404;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const QUICK_TOOL_LIMIT = 6;

export function workbenchSessionId(result: LaunchResult): string | null {
  return result.status === 'session_started' && result.sessionId ? result.sessionId : null;
}

/** Desktop launches never become workbench sessions. Only an explicit workbench preference routes a failure onto this page. */
export async function failedInWorkbench(desktop = false): Promise<boolean> {
  if (desktop || !nativeAvailable) return false;
  try { return (await native.getLaunchSettings()).selected === 'workbench'; }
  catch { return false; }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** Bytes from output events that the replay snapshot does not already contain. */
function queuedAfterSnapshot(snapshot: Uint8Array, queue: Uint8Array): Uint8Array {
  if (snapshot.length > queue.length) return new Uint8Array();
  for (let index = 0; index < snapshot.length; index += 1) {
    if (queue[index] !== snapshot[index]) return queue;
  }
  return queue.subarray(snapshot.length);
}

function readTheme(host?: HTMLElement | null): ITheme {
  const css = getComputedStyle(host ?? document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    background: pick('--wb-terminal-bg', pick('--bg', dark ? '#0a0f0c' : '#f5f7f3')),
    foreground: pick('--text', dark ? '#eef4ef' : '#111813'),
    cursor: pick('--accent', dark ? '#7be3a7' : '#0e6b43'),
    cursorAccent: pick('--wb-terminal-bg', pick('--bg', dark ? '#0a0f0c' : '#f5f7f3')),
    selectionBackground: pick('--selection', dark ? '#173557' : '#d0e4fa'),
    black: dark ? '#1a241e' : '#1c2420',
    red: dark ? '#f0a8a0' : '#a62f2a',
    green: dark ? '#7be3a7' : '#0e6b43',
    yellow: dark ? '#eed294' : '#8a5a00',
    blue: dark ? '#9ec4ea' : '#245c8c',
    magenta: dark ? '#d2b6ea' : '#6d4d86',
    cyan: dark ? '#8fd0c4' : '#0b6b62',
    white: dark ? '#eef4ef' : '#f7faf6',
    brightBlack: pick('--text-3', '#5b665e'),
    brightRed: dark ? '#ffc7c1' : '#c44740',
    brightGreen: dark ? '#b9f6d2' : '#2f9d6b',
    brightYellow: dark ? '#ffe3a8' : '#a56b00',
    brightBlue: dark ? '#c5dff6' : '#3c7cb3',
    brightMagenta: dark ? '#e6d2f6' : '#8a68a6',
    brightCyan: dark ? '#c6efe6' : '#1a8f84',
    brightWhite: dark ? '#ffffff' : '#111813',
  };
}

const TITLE_LIMIT = 80;

/** CLIs put spinners and status glyphs in front of the task title; keep only the words. */
export function cleanTerminalTitle(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[\s\u2800-\u28ff\u2700-\u27bf\u2600-\u26ff\u00b7\u2022\u25cf\u25cb\u25d0-\u25d3*\-\u2010-\u2015\u2731-\u273d]+/u, '')
    .trim();
  return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT - 1).trimEnd() + '\u2026' : text;
}

function monoFont(): string {
  const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return stack || 'Consolas, monospace';
}

function readStoredFontSize(): number {
  try {
    const raw = Number(localStorage.getItem('cliora:workbench-font-size'));
    if (Number.isInteger(raw) && raw >= MIN_FONT_SIZE && raw <= MAX_FONT_SIZE) return raw;
  } catch { /* ignore */ }
  return DEFAULT_FONT_SIZE;
}

function readStoredRailWidth(): number {
  try {
    const raw = Number(localStorage.getItem('cliora:workbench-rail-width'));
    if (Number.isFinite(raw) && raw >= MIN_RAIL_WIDTH && raw <= MAX_RAIL_WIDTH) return Math.round(raw);
  } catch { /* ignore */ }
  return DEFAULT_RAIL_WIDTH;
}

function readStoredSoundEnabled(): boolean {
  try {
    return localStorage.getItem('cliora:workbench-sound') !== 'false';
  } catch {
    return true;
  }
}

let sharedAudioCtx: AudioContext | null = null;
let lastChimeAt = 0;

function playWorkbenchChime(kind: 'bell' | 'exit') {
  const now = performance.now();
  if (now - lastChimeAt < 350) return;
  lastChimeAt = now;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    if (sharedAudioCtx.state === 'suspended') void sharedAudioCtx.resume().catch(() => {});
    const t0 = sharedAudioCtx.currentTime;
    const osc = sharedAudioCtx.createOscillator();
    const gain = sharedAudioCtx.createGain();
    osc.type = 'sine';
    if (kind === 'bell') {
      osc.frequency.setValueAtTime(587.33, t0); // D5
      osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.09); // A5
    } else {
      osc.frequency.setValueAtTime(523.25, t0); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, t0 + 0.11); // E5
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(gain);
    gain.connect(sharedAudioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.23);
  } catch { /* Audio unavailable in headless or restricted context */ }
}

function formatDuration(startedAt: number | undefined, now: number): string {
  if (!startedAt || startedAt <= 0 || now < startedAt) return '';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function SessionTerminal({ sessionId, active, running, fontSize, writers, pending, handles, onWriteError, onBell, onTitle }: {
  sessionId: string;
  active: boolean;
  running: boolean;
  fontSize: number;
  writers: MutableRefObject<Map<string, (data: string) => void>>;
  pending: MutableRefObject<Map<string, string[]>>;
  handles: MutableRefObject<Map<string, TerminalHandle>>;
  onWriteError: MutableRefObject<(error: unknown) => void>;
  onBell: MutableRefObject<(sessionId: string) => void>;
  onTitle: MutableRefObject<(sessionId: string, title: string) => void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const runningRef = useRef(running);
  const fontSizeRef = useRef(fontSize);
  activeRef.current = active;
  runningRef.current = running;
  fontSizeRef.current = fontSize;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: fontSizeRef.current,
      lineHeight: 1.26,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      macOptionIsMeta: true,
      allowProposedApi: true,
      screenReaderMode: true,
      theme: readTheme(node),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let acceptLive = false;
    const queued: string[] = [];

    // High-throughput rAF batching: coalesce bursts of PTY chunks into 1 write per animation frame
    const frameChunks: Uint8Array[] = [];
    let flushFrameId = 0;
    const flushWrites = () => {
      flushFrameId = 0;
      if (disposed || !frameChunks.length) return;
      const merged = frameChunks.length === 1 ? frameChunks[0] : concatBytes(frameChunks);
      frameChunks.length = 0;
      try { term.write(merged); }
      catch { /* Malformed bytes stay out of the terminal. */ }
    };
    const scheduleWriteBytes = (bytes: Uint8Array) => {
      if (!bytes.length || disposed) return;
      frameChunks.push(bytes);
      // In hidden background tabs or microtask tests, flush on microtask if rAF is throttled,
      // otherwise coalesce within the current microtask/frame window.
      if (!flushFrameId) {
        flushFrameId = 1;
        queueMicrotask(flushWrites);
      }
    };
    const writeEncoded = (encoded: string) => {
      if (!encoded || disposed) return;
      try { scheduleWriteBytes(decodeBase64(encoded)); }
      catch { /* Malformed bytes stay out of the terminal. */ }
    };
    const publish = (encoded: string) => {
      if (acceptLive) writeEncoded(encoded);
      else queued.push(encoded);
    };
    writers.current.set(sessionId, publish);

    const bellSub = term.onBell(() => {
      if (!disposed) onBell.current(sessionId);
    });
    // OSC 0/2: CLIs such as Codex and Claude Code name the current task in the window title.
    const titleSub = term.onTitleChange((title) => {
      if (!disposed) onTitle.current(sessionId, title);
    });

    const handle: TerminalHandle = {
      focus: () => { if (!disposed) term.focus(); },
      clear: () => { if (!disposed) term.clear(); },
      scrollToBottom: () => { if (!disposed) term.scrollToBottom(); },
      readOutput: () => {
        if (disposed) return '';
        if (term.hasSelection()) {
          const selected = term.getSelection().trim();
          if (selected) return selected;
        }
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let row = 0; row < buffer.length; row += 1) {
          const line = buffer.getLine(row);
          if (line) lines.push(line.translateToString(true));
        }
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        return lines.join('\n');
      },
      findMatches: (query: string) => {
        const needle = query.trim().toLowerCase();
        if (disposed || !needle) return [];
        const buffer = term.buffer.active;
        const found: TerminalMatch[] = [];
        for (let row = 0; row < buffer.length; row += 1) {
          const line = buffer.getLine(row);
          if (!line) continue;
          const text = line.translateToString(true).toLowerCase();
          let start = 0;
          while (start <= text.length - needle.length) {
            const index = text.indexOf(needle, start);
            if (index < 0) break;
            found.push({ row, col: index, length: needle.length });
            start = index + Math.max(1, needle.length);
          }
        }
        return found;
      },
      revealMatch: (match: TerminalMatch | null) => {
        if (disposed) return;
        if (!match) {
          term.clearSelection();
          return;
        }
        try {
          term.select(match.col, match.row, match.length);
          term.scrollToLine(Math.max(0, match.row - 3));
        } catch { /* ignore out-of-bounds buffer selection */ }
      },
    };
    handles.current.set(sessionId, handle);

    const subscription = term.onData((data) => {
      if (!activeRef.current || !runningRef.current) return;
      void native.writeWorkbenchSession(sessionId, encodeBase64(new TextEncoder().encode(data))).catch((error) => onWriteError.current(error));
    });
    const fitNow = () => {
      if (disposed || !activeRef.current || node.clientWidth < 8 || node.clientHeight < 8) return;
      try { fit.fit(); } catch { return; }
      if (!runningRef.current || term.cols < 2 || term.rows < 1) return;
      void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
    };
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(node);
    const themeObserver = new MutationObserver(() => { term.options.theme = readTheme(node); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void native.replayWorkbenchSession(sessionId).then((encoded) => {
      if (disposed) return;
      let snapshot = new Uint8Array(0);
      try { snapshot = Uint8Array.from(decodeBase64(typeof encoded === 'string' ? encoded : '')); }
      catch { snapshot = new Uint8Array(0); }
      const earlier = (pending.current.get(sessionId) ?? []).splice(0);
      pending.current.delete(sessionId);
      const arrived = queued.splice(0);
      const queuedBytes = concatBytes([...earlier, ...arrived].flatMap((part) => {
        try { return [decodeBase64(part)]; }
        catch { return []; }
      }));
      const suffix = queuedAfterSnapshot(snapshot, queuedBytes);
      acceptLive = true;
      try {
        if (snapshot.length) term.write(snapshot);
        if (suffix.length) term.write(suffix);
      } catch { /* Malformed bytes stay out of the terminal. */ }
      requestAnimationFrame(fitNow);
    }).catch(() => {
      acceptLive = true;
      queued.splice(0).forEach(writeEncoded);
      (pending.current.get(sessionId) ?? []).splice(0).forEach(writeEncoded);
      pending.current.delete(sessionId);
    });
    return () => {
      disposed = true;
      if (writers.current.get(sessionId) === publish) writers.current.delete(sessionId);
      if (handles.current.get(sessionId) === handle) handles.current.delete(sessionId);
      bellSub.dispose();
      titleSub.dispose();
      subscription.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      // xterm 5.5 schedules `setTimeout(syncScrollArea)` while opening; disposing in the same tick
      // makes that timer read a torn-down renderer. Dispose after it has run.
      window.setTimeout(() => term.dispose(), 0);
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, writers, pending, handles, onWriteError, onBell, onTitle]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !active || !running;
    term.options.cursorBlink = active && running;
    term.options.fontSize = fontSize;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const fit = fitRef.current;
      const node = host.current;
      if (!fit || !node || node.clientWidth < 8) return;
      try { fit.fit(); } catch { return; }
      if (running && term.cols >= 2 && term.rows >= 1) void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
      if (running) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, running, fontSize, sessionId]);

  return <div ref={host} className={styles.terminalHost} hidden={!active} />;
}

export function SessionWorkbench({ active, tools, focusSessionId, focusToken, failure, onFailure, onOpenHome }: {
  active: boolean;
  tools: AdapterDescriptor[];
  focusSessionId: string | null;
  focusToken: number;
  failure: WorkbenchFailure | null;
  onFailure: (failure: WorkbenchFailure | null) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [libraryPrompts, setLibraryPrompts] = useState<LibraryItem[]>([]);
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusSessionId);
  const [loading, setLoading] = useState(nativeAvailable);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [reload, setReload] = useState(0);

  // Clean Workbench UI state
  const [railWidth, setRailWidth] = useState<number>(readStoredRailWidth);
  const [focusMode, setFocusMode] = useState(false);
  const [railFilter, setRailFilter] = useState<RailFilter>('all');
  const [railSearch, setRailSearch] = useState('');
  const [fontSize, setFontSize] = useState<number>(readStoredFontSize);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(readStoredSoundEnabled);

  // Per-session attention (BEL) state
  const [attentionIds, setAttentionIds] = useState<Set<string>>(() => new Set());
  // Titles the CLIs set through OSC 0/2, keyed by session.
  const [titles, setTitles] = useState<Map<string, string>>(() => new Map());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuBox, setContextMenuBox] = useState<{ top: number; left: number } | null>(null);

  // New Session Modal (GuideDialog) state — supports 40+ CLIs cleanly via searchable FilterSelect
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [launchToolId, setLaunchToolId] = useState('');
  const [workspaceValue, setWorkspaceValue] = useState('__home');
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  const [resumeLatest, setResumeLatest] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [launchingNew, setLaunchingNew] = useState(false);
  const [dialogError, setDialogError] = useState('');

  // Terminal Search bar state
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<TerminalMatch[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Collapsible Quick Input / Library Prompt Drawer (hidden by default so terminal gets 100% height)
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [copiedState, setCopiedState] = useState<'path' | 'output' | 'empty' | null>(null);
  const copyTimerRef = useRef<number>(0);

  // Session timestamps for elapsed duration
  const firstSeenAt = useRef(new Map<string, number>());
  const [clock, setClock] = useState(() => Date.now());

  const writers = useRef(new Map<string, (data: string) => void>());
  const pending = useRef(new Map<string, string[]>());
  const handles = useRef(new Map<string, TerminalHandle>());
  const writeError = useRef<(error: unknown) => void>(() => {});
  writeError.current = (error) => setActionError(formatFailure(error, t('sessions.writeFailed'), t('sessions.retry')));

  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const onBellRef = useRef<(id: string) => void>(() => {});
  onBellRef.current = (id: string) => {
    if (soundEnabledRef.current) playWorkbenchChime('bell');
    if (id !== selectedIdRef.current) {
      setAttentionIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  };

  const onTitleRef = useRef<(id: string, title: string) => void>(() => {});
  onTitleRef.current = (id: string, raw: string) => {
    const title = cleanTerminalTitle(raw);
    setTitles((prev) => {
      if ((prev.get(id) ?? '') === title) return prev;
      const next = new Map(prev);
      if (title) next.set(id, title);
      else next.delete(id);
      return next;
    });
  };

  const terminalTools = useMemo(
    () => tools.filter((item) => item.launchForm !== 'desktop' && item.launch?.state !== 'unsupported'),
    [tools],
  );
  const effectiveLaunchToolId = useMemo(
    () => (terminalTools.some((item) => item.id === launchToolId) ? launchToolId : terminalTools[0]?.id ?? ''),
    [terminalTools, launchToolId],
  );
  const selectedLaunchTool = useMemo(
    () => terminalTools.find((item) => item.id === effectiveLaunchToolId) ?? null,
    [terminalTools, effectiveLaunchToolId],
  );

  useEffect(() => {
    if (focusSessionId) setSelectedId(focusSessionId);
  }, [focusSessionId, focusToken]);

  // Clear attention badge when selecting a session
  useEffect(() => {
    if (!selectedId) return;
    setAttentionIds((prev) => {
      if (!prev.has(selectedId)) return prev;
      const next = new Set(prev);
      next.delete(selectedId);
      return next;
    });
  }, [selectedId]);

  useEffect(() => {
    return () => { window.clearTimeout(copyTimerRef.current); };
  }, []);

  useEffect(() => {
    if (!active || !sessions.some((item) => item.running)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active, sessions]);

  useEffect(() => {
    if (!nativeAvailable) { setLoading(false); return; }
    let alive = true;
    const stops: Array<() => void> = [];
    const push = (sessionId: string, data: string) => {
      const write = writers.current.get(sessionId);
      if (write) write(data);
      else {
        const queued = pending.current.get(sessionId) ?? [];
        queued.push(data);
        pending.current.set(sessionId, queued);
      }
    };
    void listen<{ sessionId: string; dataBase64: string }>('cliora:session-output', (event) => {
      if (alive) push(event.payload.sessionId, event.payload.dataBase64);
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void listen<{ sessionId: string; exitCode: number | null }>('cliora:session-exit', (event) => {
      if (!alive) return;
      if (soundEnabledRef.current) playWorkbenchChime('exit');
      setSessions((current) => current.map((item) => item.id === event.payload.sessionId ? { ...item, running: false, exitCode: event.payload.exitCode ?? null } : item));
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    return () => { alive = false; stops.forEach((stop) => { void Promise.resolve(stop()).catch(() => {}); }); };
  }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    setLoading(true);
    void Promise.all([
      native.listWorkbenchSessions(),
      native.listProjects().catch(() => [] as Project[]),
      native.listLibraryItems('prompt', null, '').catch(() => [] as LibraryItem[]),
      native.getLaunchSettings().catch(() => null),
    ]).then(([listed, listedProjects, prompts, settings]) => {
      if (!alive) return;
      const next = Array.isArray(listed) ? listed : [];
      const now = Date.now();
      for (const item of next) {
        if (!firstSeenAt.current.has(item.id)) {
          firstSeenAt.current.set(item.id, item.startedAt ?? now);
        }
      }
      setSessions(next);
      const validProjects = Array.isArray(listedProjects) ? listedProjects : [];
      setProjects(validProjects);
      setLibraryPrompts(Array.isArray(prompts) ? prompts : []);
      if (settings) setLaunchSettings(settings);
      setListError('');
      setSelectedId((current) => {
        if (focusSessionId && next.some((item) => item.id === focusSessionId)) return focusSessionId;
        if (current && next.some((item) => item.id === current)) return current;
        return next.find((item) => item.running)?.id ?? next[0]?.id ?? null;
      });
      for (const session of next) {
        const queued = pending.current.get(session.id);
        const write = writers.current.get(session.id);
        if (queued?.length && write) {
          queued.splice(0).forEach(write);
          pending.current.delete(session.id);
        }
      }
    }).catch((value) => {
      if (alive) setListError(formatFailure(value, t('sessions.listFailed'), t('sessions.listNext')));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, focusToken, focusSessionId, reload, t]);

  useEffect(() => {
    if (!selectedLaunchTool?.yoloAvailable && launchMode === 'yolo') {
      setLaunchMode('normal');
    }
    if (!selectedLaunchTool?.resumeLatestAvailable && resumeLatest) {
      setResumeLatest(false);
    }
  }, [selectedLaunchTool, launchMode, resumeLatest]);

  useEffect(() => {
    if (!findOpen || !selectedId || !findQuery.trim()) {
      setFindMatches([]);
      setFindIndex(0);
      if (selectedId) handles.current.get(selectedId)?.revealMatch(null);
      return;
    }
    const handle = handles.current.get(selectedId);
    if (!handle) return;
    const matches = handle.findMatches(findQuery);
    setFindMatches(matches);
    setFindIndex(0);
    handle.revealMatch(matches[0] ?? null);
  }, [findOpen, findQuery, selectedId]);

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem('cliora:workbench-sound', String(next)); } catch { /* ignore */ }
      if (next) playWorkbenchChime('bell');
      return next;
    });
  }, []);

  const updateFontSize = useCallback((nextSize: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, nextSize));
    setFontSize(clamped);
    try { localStorage.setItem('cliora:workbench-font-size', String(clamped)); } catch { /* ignore */ }
  }, []);

  const updateRailWidth = useCallback((nextWidth: number) => {
    const clamped = Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, Math.round(nextWidth)));
    setRailWidth(clamped);
    try { localStorage.setItem('cliora:workbench-rail-width', String(clamped)); } catch { /* ignore */ }
  }, []);

  function startRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = railWidth;
    const onMove = (moveEvent: PointerEvent) => {
      updateRailWidth(startW + (moveEvent.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function placeOf(session: WorkbenchSession): string {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    if (project?.name) return project.name;
    if (session.directory) return shortPath(displayPath(session.directory));
    return t('sessions.placeUnknown');
  }

  function toolName(session: WorkbenchSession): string {
    return tools.find((item) => item.id === session.toolId)?.name ?? session.toolId;
  }

  /** The task title the CLI reported, unless it only repeats the tool name. */
  function taskTitle(session: WorkbenchSession): string {
    const title = titles.get(session.id) ?? '';
    const name = toolName(session);
    return title && title.toLowerCase() !== name.toLowerCase() ? title : '';
  }

  function modeLabel(mode: LaunchMode): string {
    return mode === 'yolo' ? t('sessions.modeYolo') : t('sessions.modeNormal');
  }

  async function endSession(session: WorkbenchSession) {
    if (busy) return;
    setBusy(session.id);
    setActionError('');
    try {
      await native.closeWorkbenchSession(session.id);
      firstSeenAt.current.delete(session.id);
      setTitles((prev) => { if (!prev.has(session.id)) return prev; const next = new Map(prev); next.delete(session.id); return next; });
      const rest = sessions.filter((item) => item.id !== session.id);
      setSessions(rest);
      setSelectedId((current) => current === session.id ? (rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null) : current);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally { setBusy(''); }
  }

  async function clearEndedSessions() {
    const ended = sessions.filter((item) => !item.running);
    if (!ended.length || busy) return;
    setBusy('__clear_ended');
    setActionError('');
    try {
      const closedIds = new Set<string>();
      for (const session of ended) {
        await native.closeWorkbenchSession(session.id);
        closedIds.add(session.id);
        firstSeenAt.current.delete(session.id);
      }
      const rest = sessions.filter((item) => !closedIds.has(item.id));
      setSessions(rest);
      if (railFilter === 'ended') setRailFilter('all');
      setSelectedId((current) => (current && closedIds.has(current)) ? (rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null) : current);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally { setBusy(''); }
  }

  async function retry() {
    if (!failure || retrying) return;
    setRetrying(true);
    setNotice('');
    setActionError('');
    try {
      const result = failure.retry.kind === 'launch'
        ? await native.launchCli(failure.retry.request)
        : await native.resumeHistorySession(failure.retry.id, failure.retry.mode);
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      onFailure(null);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      onFailure({ ...failure, detail: formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')) });
    } finally { setRetrying(false); }
  }

  function openNewSessionDialog(prefill?: { toolId?: string; projectId?: string }) {
    setDialogError('');
    if (prefill?.projectId) {
      const project = projects.find((item) => item.id === prefill.projectId);
      setWorkspaceValue('project:' + prefill.projectId);
      if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) {
        setLaunchToolId(project.preferredTool);
      }
    }
    if (prefill?.toolId && terminalTools.some((item) => item.id === prefill.toolId)) setLaunchToolId(prefill.toolId);
    if (prefill) setLaunchMode(preferredLaunchMode(launchSettings, prefill.projectId ? 'project' : 'cli', !!selectedLaunchTool?.yoloAvailable));
    setNewDialogOpen(true);
  }

  async function pickCustomWorkspaceFolder() {
    try {
      const picked = await open({ directory: true, multiple: false, title: t('sessions.pickFolder') });
      if (typeof picked === 'string' && picked.trim()) {
        const clean = picked.trim();
        setCustomFolderPath(clean);
        setWorkspaceValue(`custom:${clean}`);
      }
    } catch { /* ignore dialog cancellation */ }
  }

  async function launchFromDialog() {
    if (!effectiveLaunchToolId || launchingNew) return;
    setLaunchingNew(true);
    setDialogError('');
    setActionError('');
    setNotice('');
    try {
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
      }
      const projectId = workspaceValue.startsWith('project:') ? workspaceValue.slice('project:'.length) : null;
      const directory = workspaceValue.startsWith('custom:') ? workspaceValue.slice('custom:'.length) : null;
      const promptText = initialPrompt.trim() || null;
      const request: LaunchRequest = {
        toolId: effectiveLaunchToolId,
        projectId,
        sessionId: null,
        mode: selectedLaunchTool?.yoloAvailable ? launchMode : 'normal',
        directory,
        ...(promptText ? { initialPrompt: promptText } : {}),
        ...(resumeLatest && selectedLaunchTool?.resumeLatestAvailable ? { resumeLatest: true } : {}),
      };
      const result = await native.launchCli(request);
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setNewDialogOpen(false);
        setInitialPrompt('');
        setRailFilter('all');
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      setNewDialogOpen(false);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      setDialogError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally {
      setLaunchingNew(false);
    }
  }

  async function restartOrCloneSession(session: WorkbenchSession, replaceEnded: boolean) {
    if (busy) return;
    setBusy(replaceEnded ? `restart:${session.id}` : `clone:${session.id}`);
    setActionError('');
    setNotice('');
    try {
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
      }
      const request: LaunchRequest = {
        toolId: session.toolId,
        projectId: session.projectId,
        sessionId: null,
        mode: session.mode,
        directory: session.directory || null,
      };
      const result = await native.launchCli(request);
      const opened = workbenchSessionId(result);
      if (opened) {
        if (replaceEnded && !session.running) {
          await native.closeWorkbenchSession(session.id).catch(() => {});
          firstSeenAt.current.delete(session.id);
        }
        onFailure(null);
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally {
      setBusy('');
    }
  }

  async function sendToSession(session: WorkbenchSession, rawText: string) {
    if (!session.running || !rawText) return;
    setActionError('');
    try {
      await native.writeWorkbenchSession(session.id, encodeBase64(new TextEncoder().encode(rawText)));
      handles.current.get(session.id)?.focus();
    } catch (error) {
      writeError.current(error);
    }
  }

  async function submitComposer() {
    if (!selected || !selected.running) return;
    const text = composerText.trim();
    if (!text) {
      await sendToSession(selected, '\r');
      return;
    }
    setComposerText('');
    await sendToSession(selected, `${text}\r`);
  }

  async function copySessionPath(session: WorkbenchSession) {
    const value = session.directory ? displayPath(session.directory) : '';
    if (!value) return;
    const ok = await writeClipboard(value);
    if (!ok) return;
    window.clearTimeout(copyTimerRef.current);
    setCopiedState('path');
    copyTimerRef.current = window.setTimeout(() => setCopiedState(null), 1600);
  }

  async function copyTerminalOutput(session: WorkbenchSession) {
    const text = handles.current.get(session.id)?.readOutput() ?? '';
    window.clearTimeout(copyTimerRef.current);
    if (!text.trim()) {
      setCopiedState('empty');
      copyTimerRef.current = window.setTimeout(() => setCopiedState(null), 1600);
      return;
    }
    const ok = await writeClipboard(text);
    if (!ok) return;
    setCopiedState('output');
    copyTimerRef.current = window.setTimeout(() => setCopiedState(null), 1600);
  }

  function stepFindMatch(delta: -1 | 1) {
    if (!findMatches.length || !selectedId) return;
    const next = (findIndex + delta + findMatches.length) % findMatches.length;
    setFindIndex(next);
    handles.current.get(selectedId)?.revealMatch(findMatches[next] ?? null);
  }

  const selected = sessions.find((item) => item.id === selectedId) ?? null;
  const showEmpty = !loading && !sessions.length;
  const runningCount = sessions.filter((item) => item.running).length;
  const endedCount = sessions.length - runningCount;

  const filteredSessions = useMemo(() => {
    const query = railSearch.trim().toLowerCase();
    return sessions.filter((session) => {
      if (railFilter === 'running' && !session.running) return false;
      if (railFilter === 'ended' && session.running) return false;
      if (!query) return true;
      const name = toolName(session).toLowerCase();
      const title = (titles.get(session.id) ?? '').toLowerCase();
      const place = placeOf(session).toLowerCase();
      const dir = (session.directory ?? '').toLowerCase();
      return name.includes(query) || title.includes(query) || place.includes(query) || dir.includes(query);
    });
  }, [sessions, railFilter, railSearch, projects, tools, titles]);

  // Right-click menu on a session row: placed at the pointer, kept inside the window.
  useEffect(() => { if (!contextMenu) setContextMenuBox(null); }, [contextMenu]);
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const menu = contextMenuRef.current;
    if (!menu) return;
    const left = Math.max(8, Math.min(contextMenu.x, window.innerWidth - menu.offsetWidth - 8));
    const top = Math.max(8, Math.min(contextMenu.y, window.innerHeight - menu.offsetHeight - 8));
    setContextMenuBox({ top, left });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [contextMenu]);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return;
      setContextMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const id = contextMenu.sessionId;
      setContextMenu(null);
      document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)?.focus();
    };
    const close = () => setContextMenu(null);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  function openRowMenu(session: WorkbenchSession, x: number, y: number) {
    setSelectedId(session.id);
    setContextMenu({ sessionId: session.id, x, y });
  }

  function contextMenuNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
    if (!items.length) return;
    if (event.key === 'Tab') { event.preventDefault(); setContextMenu(null); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  const availableProjects = useMemo(
    () => projects.filter((item) => item.available && item.path),
    [projects],
  );

  // Power-user switching without taking focus away from the terminal.
  useEffect(() => {
    if (!active || newDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // The terminal keeps its own Alt handling; text fields keep word-wise caret movement.
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editing = !!target && (target.tagName === 'INPUT' || target.isContentEditable
        || (target.tagName === 'TEXTAREA' && !target.classList.contains('xterm-helper-textarea')));
      if (editing) return;
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        if (filteredSessions.length < 2) return;
        event.preventDefault();
        setSelectedId((current) => {
          const index = filteredSessions.findIndex((item) => item.id === current);
          return filteredSessions[(index + step + filteredSessions.length) % filteredSessions.length].id;
        });
        return;
      }
      if (event.key.toLowerCase() === 'n' && terminalTools.length > 0) {
        event.preventDefault();
        openNewSessionDialog();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, newDialogOpen, filteredSessions, terminalTools]);

  // Searchable options for 40+ CLIs and Projects
  // Same picker as the home page: icon + name, searchable by name.
  const cliSelectOptions = useMemo<FilterSelectOption[]>(() => toolOptions(terminalTools), [terminalTools]);

  const workspaceSelectOptions = useMemo<FilterSelectOption[]>(() => {
    const list: FilterSelectOption[] = [
      { value: '__home', label: t('sessions.workspaceHome'), icon: <Icon name="home" size={14} /> },
      ...availableProjects.map((project) => ({
        value: `project:${project.id}`,
        label: project.name,
        detail: project.path ? shortPath(displayPath(project.path)) : undefined,
        icon: <Icon name="folder" size={14} />,
      })),
    ];
    if (customFolderPath) {
      list.push({
        value: `custom:${customFolderPath}`,
        label: shortPath(displayPath(customFolderPath)),
        detail: displayPath(customFolderPath),
        icon: <Icon name="folder" size={14} />,
      });
    }
    return list;
  }, [availableProjects, customFolderPath, t]);

  return <div className={styles.root} data-focus-mode={focusMode || undefined} data-empty={(showEmpty && !listError) || undefined}>
    {listError && <div className={styles.banner} role="alert">
      <div className={styles.bannerCopy}>
        <strong>{t('sessions.listFailed')}</strong>
        <p>{listError}</p>
      </div>
      <button type="button" className={styles.ghostButton} onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</button>
    </div>}

    <div
      className={styles.layout}
      style={{ '--rail-w': railWidth + 'px' } as React.CSSProperties}
    >
      <aside className={styles.rail} aria-label={t('sessions.listLabel')}>
        <div className={styles.railHead}>
          <div className={styles.railTitleRow}>
            <span className={styles.railTitle}>{t('sessions.listLabel')}</span>
            <span className={styles.railCountBadge} data-live={runningCount > 0 || undefined}>
              <span className={styles.liveDot} data-live={runningCount > 0 || undefined} aria-hidden="true" />
              {runningCount > 0 ? t('sessions.runningCount', { count: runningCount }) : t('sessions.totalCount', { count: sessions.length })}
            </span>
            {terminalTools.length > 0 && <button
              type="button"
              className={styles.newSessionBtn}
              title={t('sessions.newSession')}
              onClick={() => openNewSessionDialog()}
            >
              <Icon name="plus" size={14} />
              <span>{t('sessions.newSession')}</span>
            </button>}
          </div>

          {sessions.length > 1 && <div className={styles.railSearchField}>
            <Icon name="search" size={13} />
            <input
              type="search"
              value={railSearch}
              placeholder={t('sessions.searchPlaceholder')}
              aria-label={t('sessions.searchPlaceholder')}
              onChange={(event) => setRailSearch(event.target.value)}
            />
            {railSearch && <button type="button" className={styles.railSearchClear} aria-label={t('sessions.clearFilter')} title={t('sessions.clearFilter')} onClick={() => setRailSearch('')}>
              <Icon name="close" size={12} />
            </button>}
          </div>}

          {sessions.length > 1 && <div className={styles.segmented} role="group" aria-label={t('sessions.filterLabel')}>
            <button type="button" aria-pressed={railFilter === 'all'} onClick={() => setRailFilter('all')}>
              <span>{t('sessions.filterAll')}</span><em>{sessions.length}</em>
            </button>
            <button type="button" aria-pressed={railFilter === 'running'} onClick={() => setRailFilter('running')}>
              <span>{t('sessions.filterRunning')}</span><em>{runningCount}</em>
            </button>
            {endedCount > 0 && <button type="button" aria-pressed={railFilter === 'ended'} onClick={() => setRailFilter('ended')}>
              <span>{t('sessions.filterEnded')}</span><em>{endedCount}</em>
            </button>}
          </div>}
        </div>

        <div className={styles.list} role="tablist" aria-label={t('sessions.listLabel')} title={t('sessions.shortcutsHint')} onKeyDown={navigateChoices}>
          {filteredSessions.map((session) => {
            const name = toolName(session);
            const title = taskTitle(session);
            const place = placeOf(session);
            const mode = modeLabel(session.mode);
            const isSelected = session.id === selectedId;
            const hasBell = attentionIds.has(session.id);
            const elapsed = formatDuration(session.startedAt ?? firstSeenAt.current.get(session.id), clock);
            return <div
              key={session.id}
              className={styles.row}
              data-running={session.running || undefined}
              data-attention={hasBell || undefined}
              data-selected={isSelected || undefined}
            >
              <button
                type="button"
                role="tab"
                data-session-id={session.id}
                className={styles.session}
                aria-selected={isSelected}
                aria-haspopup="menu"
                title={[title, displayPath(session.directory || place)].filter(Boolean).join('\n')}
                onClick={() => setSelectedId(session.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openRowMenu(session, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openRowMenu(session, rect.left + 24, rect.bottom - 6);
                  }
                }}
              >
                <span className={styles.sessionIconWrap}>
                  <ToolIcon toolId={session.toolId} size={24} />
                  <span className={styles.sessionStateDot} data-tone={hasBell ? 'bell' : session.running ? 'live' : 'ended'} aria-hidden="true" />
                </span>
                <span className={styles.sessionBody}>
                  <span className={styles.sessionTop}>
                    <strong>{title || name}</strong>
                    <span className={styles.sessionTime} data-tone={session.running ? 'live' : 'ended'}>
                      {session.running ? (elapsed || t('sessions.running')) : t('sessions.ended')}
                    </span>
                  </span>
                  <span className={styles.sessionPlace}>{title ? name + ' \u00b7 ' + place : place}</span>
                  <span className={styles.sessionMeta}>
                    <span className={styles.modeTag} data-mode={session.mode}>{mode}</span>
                    {hasBell && <span className={styles.attentionTag}>
                      <span className={styles.attentionDot} aria-hidden="true" />
                      {t('sessions.bellBadge')}
                    </span>}
                    {!session.running && session.exitCode != null && <span className={styles.exitTag}>
                      {t('sessions.exitCode', { code: session.exitCode })}
                    </span>}
                  </span>
                </span>
              </button>
              {!session.running && <button
                type="button"
                tabIndex={-1}
                className={styles.rowRemove}
                aria-label={t('sessions.removeSession') + '：' + name}
                title={t('sessions.removeSession')}
                disabled={!!busy}
                onClick={() => void endSession(session)}
              >
                <Icon name="close" size={12} />
              </button>}
            </div>;
          })}
          {sessions.length > 0 && filteredSessions.length === 0 && <div className={styles.railNoMatch}>
            <p>{t('sessions.noFilterMatch')}</p>
            <button type="button" className={styles.ghostButton} onClick={() => { setRailFilter('all'); setRailSearch(''); }}>
              {t('sessions.clearFilter')}
            </button>
          </div>}
        </div>

        {sessions.length > 0 && <div className={styles.railFoot}>
          <span className={styles.railSummary}>
            <span className={styles.summaryDot} data-live={runningCount > 0 || undefined} aria-hidden="true" />
            {t('sessions.summary', { running: runningCount, ended: endedCount })}
          </span>
          {endedCount > 0 && <button
            type="button"
            className={styles.clearEndedBtn}
            disabled={!!busy}
            title={t('sessions.clearEndedTitle')}
            onClick={() => void clearEndedSessions()}
          >
            <Icon name="trash" size={12} />
            <span>{t('sessions.clearEnded')}</span>
          </button>}
        </div>}
      </aside>

      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sessions.resizeRail')}
        title={t('sessions.resizeRail')}
        tabIndex={0}
        onPointerDown={startRailResize}
        onDoubleClick={() => updateRailWidth(DEFAULT_RAIL_WIDTH)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); updateRailWidth(railWidth - 16); }
          if (event.key === 'ArrowRight') { event.preventDefault(); updateRailWidth(railWidth + 16); }
        }}
      />

      <section className={styles.stage} aria-label={t('sessions.stageLabel')}>
        {failure && <div className={styles.banner} role="alert">
          <div className={styles.bannerCopy}>
            <strong>{t('sessions.launchFailed')}</strong>
            <p>{failure.detail}</p>
            <p>{t('sessions.failureHint')}</p>
          </div>
          <div className={styles.bannerActions}>
            <button type="button" className="button primary" onClick={() => void retry()} disabled={retrying}>
              <Icon name="refresh" size={14} />
              <span>{retrying ? t('sessions.loading') : t('sessions.retry')}</span>
            </button>
            <button type="button" className={styles.ghostButton} onClick={() => onFailure(null)}>
              {t('sessions.dismissBanner')}
            </button>
          </div>
        </div>}

        {actionError && <div className={styles.banner} role="alert">
          <div className={styles.bannerCopy}><p>{actionError}</p></div>
          <button type="button" className={styles.ghostButton} onClick={() => setActionError('')} aria-label={t('common.dismissError')}>
            <Icon name="close" size={14} />
          </button>
        </div>}

        {notice && <div className={styles.banner} data-tone="status" role="status">
          <div className={styles.bannerCopy}><p>{notice}</p></div>
          <button type="button" className={styles.ghostButton} onClick={() => setNotice('')} aria-label={t('common.dismissError')}>
            <Icon name="close" size={14} />
          </button>
        </div>}

        {selected && (() => {
          const elapsed = formatDuration(selected.startedAt ?? firstSeenAt.current.get(selected.id), clock);
          return <div className={styles.stageBar}>
            <button
              type="button"
              className={styles.focusBtn}
              aria-pressed={focusMode}
              aria-label={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')}
              title={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')}
              onClick={() => setFocusMode((current) => !current)}
            >
              <Icon name={focusMode ? 'sidebarOpen' : 'sidebarClose'} size={15} />
            </button>
            <span className={styles.stageDivider} aria-hidden="true" />

            <ToolIcon toolId={selected.toolId} size={22} />

            <div className={styles.identityText}>
              <span className={styles.identityMain}>
                <strong title={taskTitle(selected) ? toolName(selected) + ' \u00b7 ' + taskTitle(selected) : undefined}>
                  {taskTitle(selected) ? <>{toolName(selected)}<span className={styles.identityTitle}>{taskTitle(selected)}</span></> : toolName(selected)}
                </strong>
                <span className={styles.statusChip} data-tone={selected.running ? 'live' : 'ended'}>
                  <span className={styles.statusDot} aria-hidden="true" />
                  {selected.running
                    ? (elapsed ? t('sessions.running') + ' ' + elapsed : t('sessions.running'))
                    : t('sessions.ended') + (selected.exitCode != null ? ' · ' + t('sessions.exitCode', { code: selected.exitCode }) : '')}
                </span>
                <span className={styles.modeChip} data-mode={selected.mode}>{modeLabel(selected.mode)}</span>
              </span>
              <button
                type="button"
                className={styles.pathChip}
                title={selected.directory ? displayPath(selected.directory) + ' · ' + t('sessions.copyPath') : placeOf(selected)}
                onClick={() => void copySessionPath(selected)}
              >
                <Icon name={copiedState === 'path' ? 'check' : 'folder'} size={12} />
                <span>{copiedState === 'path' ? t('sessions.pathCopied') : placeOf(selected)}</span>
              </button>
            </div>

            <div className={styles.stageActions}>
              <div className={styles.toolbarGroup}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-pressed={findOpen}
                  aria-label={t('sessions.findOutput')}
                  title={t('sessions.findOutput')}
                  onClick={() => {
                    const next = !findOpen;
                    setFindOpen(next);
                    if (next) requestAnimationFrame(() => findInputRef.current?.focus());
                  }}
                >
                  <Icon name="search" size={15} />
                </button>

                {selected.running && <button
                  type="button"
                  className={styles.iconBtn}
                  aria-pressed={composerOpen}
                  aria-label={composerOpen ? t('sessions.composerClose') : t('sessions.composerToggle')}
                  title={composerOpen ? t('sessions.composerClose') : t('sessions.composerToggle')}
                  onClick={() => {
                    const next = !composerOpen;
                    setComposerOpen(next);
                    if (next) requestAnimationFrame(() => composerInputRef.current?.focus());
                  }}
                >
                  <Icon name="library" size={15} />
                </button>}

                <RowMenu label={t('common.models.more')}>
                  <button role="menuitem" onClick={() => void copyTerminalOutput(selected)}>
                    {copiedState === 'output' ? t('sessions.outputCopied') : t('sessions.copyOutput')}
                  </button>
                  {selected.directory && <button role="menuitem" onClick={() => void copySessionPath(selected)}>
                    {t('sessions.copyPath')}
                  </button>}
                  {selected.projectId && <button role="menuitem" onClick={() => void native.openProjectDirectory(selected.projectId!).catch(() => {})}>
                    {t('sessions.openFolder')}
                  </button>}
                  <button role="menuitem" disabled={!!busy} onClick={() => void restartOrCloneSession(selected, !selected.running)}>
                    {selected.running ? t('sessions.cloneSession') : t('sessions.restartSession')}
                  </button>
                  {selected.running && <button role="menuitem" onClick={() => void sendToSession(selected, '\x03')}>
                    {t('sessions.sendInterrupt')}
                  </button>}
                  <button role="menuitem" onClick={() => handles.current.get(selected.id)?.clear()}>
                    {t('sessions.clearScreen')}
                  </button>
                  <button role="menuitem" onClick={() => { handles.current.get(selected.id)?.scrollToBottom(); handles.current.get(selected.id)?.focus(); }}>
                    {t('sessions.scrollToBottom')}
                  </button>
                  <button role="menuitem" disabled={fontSize <= MIN_FONT_SIZE} onClick={() => updateFontSize(fontSize - 1)}>
                    {t('sessions.fontSizeDown')} ({fontSize}px)
                  </button>
                  <button role="menuitem" disabled={fontSize >= MAX_FONT_SIZE} onClick={() => updateFontSize(fontSize + 1)}>
                    {t('sessions.fontSizeUp')} ({fontSize}px)
                  </button>
                  {fontSize !== DEFAULT_FONT_SIZE && <button role="menuitem" onClick={() => updateFontSize(DEFAULT_FONT_SIZE)}>
                    {t('sessions.fontSizeReset', { size: DEFAULT_FONT_SIZE })}
                  </button>}
                  <button role="menuitem" onClick={toggleSound}>
                    {soundEnabled ? t('sessions.soundNotifyOn') : t('sessions.soundNotifyOff')}
                  </button>
                </RowMenu>
              </div>

              <span className={styles.stageDivider} aria-hidden="true" />

              {!selected.running && <button
                type="button"
                className={styles.restartBtn}
                disabled={!!busy}
                onClick={() => void restartOrCloneSession(selected, true)}
              >
                <Icon name="refresh" size={13} />
                <span>{busy === 'restart:' + selected.id ? t('sessions.restarting') : t('sessions.restartSession')}</span>
              </button>}

              <button
                type="button"
                className={styles.endBtn}
                onClick={() => void endSession(selected)}
                disabled={!!busy}
                aria-label={selected.running ? t('sessions.end') : t('sessions.closeTab')}
                title={selected.running ? t('sessions.end') : t('sessions.closeTab')}
              >
                <Icon name="close" size={13} />
                <span>{busy === selected.id ? t('sessions.ending') : selected.running ? t('sessions.endShort') : t('sessions.closeTabShort')}</span>
              </button>
            </div>
          </div>;
        })()}

        {selected && findOpen && <div className={styles.findBar}>
          <span className={styles.findLabel}><Icon name="search" size={13} />{t('sessions.findOutput')}</span>
          <div className={styles.findField}>
            <input
              ref={findInputRef}
              type="search"
              value={findQuery}
              placeholder={t('sessions.findPlaceholder')}
              aria-label={t('sessions.findPlaceholder')}
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  stepFindMatch(event.shiftKey ? -1 : 1);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setFindOpen(false);
                  handles.current.get(selected.id)?.focus();
                }
              }}
            />
          </div>
          <span className={styles.findCount} data-empty={findQuery.trim() && !findMatches.length || undefined}>
            {!findQuery.trim()
              ? ''
              : findMatches.length > 0
                ? t('sessions.findMatchCount', { current: findIndex + 1, total: findMatches.length })
                : t('sessions.findNoMatch')}
          </span>
          <button
            type="button"
            className={styles.iconBtn}
            disabled={!findMatches.length}
            aria-label={t('sessions.findPrev')}
            title={t('sessions.findPrev')}
            onClick={() => stepFindMatch(-1)}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            disabled={!findMatches.length}
            aria-label={t('sessions.findNext')}
            title={t('sessions.findNext')}
            onClick={() => stepFindMatch(1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('common.dialog.close')}
            onClick={() => {
              setFindOpen(false);
              handles.current.get(selected.id)?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>}

        {selected && !selected.running && <div className={styles.endedStrip}>
          <Icon name="lock" size={12} />
          <span><strong>{t('sessions.sessionEndedBanner')}</strong> · {t('sessions.endedHintShort')}</span>
        </div>}

        <div className={styles.canvas} hidden={!sessions.length}>
          <div className={styles.terminalStage}>
            {sessions.map((session) => (
              <SessionTerminal
                key={session.id}
                sessionId={session.id}
                active={session.id === selectedId}
                running={session.running}
                fontSize={fontSize}
                writers={writers}
                pending={pending}
                handles={handles}
                onWriteError={writeError}
                onBell={onBellRef}
                onTitle={onTitleRef}
              />
            ))}
          </div>
        </div>

        {selected && selected.running && composerOpen && <div className={styles.composerDrawer} aria-label={t('sessions.composerTitle')}>
          {libraryPrompts.length > 0 && <div className={styles.composerPrompts}>
            <span className={styles.composerPromptLabel}><Icon name="library" size={12} />{t('sessions.pickLibraryPrompt')}</span>
            <div className={styles.composerPromptList}>
              {libraryPrompts.map((prompt) => (
                <button
                  key={prompt.id}
                  type="button"
                  className={styles.promptPill}
                  title={prompt.body}
                  onClick={() => setComposerText((prev) => prev ? prev + '\n' + prompt.body : prompt.body)}
                >
                  {prompt.title}
                </button>
              ))}
            </div>
          </div>}
          <div className={styles.composerInputRow}>
            <textarea
              ref={composerInputRef}
              rows={2}
              className={styles.composerTextarea}
              value={composerText}
              placeholder={t('sessions.composerPlaceholder', { tool: toolName(selected) })}
              aria-label={t('sessions.composerPlaceholder', { tool: toolName(selected) })}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitComposer();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setComposerOpen(false);
                  handles.current.get(selected.id)?.focus();
                }
              }}
            />
            <button
              type="button"
              className="button primary"
              onClick={() => void submitComposer()}
            >
              <Icon name="arrowRight" size={14} />
              <span>{t('sessions.sendInput')}</span>
            </button>
          </div>
          <span className={styles.composerHint}>{t('sessions.composerHint')}</span>
        </div>}

        {loading && !sessions.length && <p className={styles.loading}>{t('sessions.loading')}</p>}

        {showEmpty && !listError && <div className={styles.empty}>
          <div className={styles.emptyHero}>
            <span className={styles.emptyGlyph} aria-hidden="true"><Icon name="terminal" size={24} /></span>
            <h2>{t('sessions.emptyTitle')}</h2>
            <p>{t('sessions.emptyDetail')}</p>
            <div className={styles.emptyActions}>
              {terminalTools.length > 0 && <button type="button" className="button primary" onClick={() => openNewSessionDialog()}>
                <Icon name="plus" size={14} />
                <span>{t('sessions.newSession')}</span>
              </button>}
              <button type="button" className={terminalTools.length > 0 ? 'button' : 'button primary'} onClick={onOpenHome}>
                <span>{t('sessions.openHome')}</span>
                <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </div>

          {terminalTools.length > 0 && <div className={styles.emptyRecents}>
            <span className={styles.emptySectionLabel}>{t('sessions.quickTools')}</span>
            <div className={styles.toolChips}>
              {terminalTools.slice(0, QUICK_TOOL_LIMIT).map((tool) => <button
                key={tool.id}
                type="button"
                className={styles.toolChip}
                title={t('sessions.quickToolTitle', { name: tool.name })}
                onClick={() => openNewSessionDialog({ toolId: tool.id })}
              >
                <ToolIcon toolId={tool.id} size={18} />
                <span>{tool.name}</span>
              </button>)}
              {terminalTools.length > QUICK_TOOL_LIMIT && <button
                type="button"
                className={styles.toolChip}
                data-more
                onClick={() => openNewSessionDialog()}
              >
                <span>{t('sessions.moreTools', { count: terminalTools.length - QUICK_TOOL_LIMIT })}</span>
              </button>}
            </div>
          </div>}

          {availableProjects.length > 0 && terminalTools.length > 0 && <div className={styles.emptyRecents}>
            <span className={styles.emptySectionLabel}>{t('sessions.recentProjects')}</span>
            <div className={styles.recentsGrid}>
              {availableProjects.slice(0, 4).map((project) => {
                const toolId = project.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)
                  ? project.preferredTool
                  : terminalTools[0]?.id;
                return <button
                  key={project.id}
                  type="button"
                  className={styles.recentCard}
                  onClick={() => openNewSessionDialog({ projectId: project.id, toolId: project.preferredTool ?? undefined })}
                >
                  {toolId ? <ToolIcon toolId={toolId} size={22} /> : <Icon name="folder" size={18} />}
                  <span className={styles.recentCopy}>
                    <strong>{project.name}</strong>
                    <small>{project.path ? shortPath(displayPath(project.path)) : t('sessions.placeUnknown')}</small>
                  </span>
                  <span className={styles.recentAction} aria-hidden="true"><Icon name="play" size={12} /></span>
                </button>;
              })}
            </div>
          </div>}

          <span className={styles.shortcutsHint} aria-label={t('sessions.shortcutsHint')}>
            <kbd>Alt</kbd><kbd>↑</kbd><kbd>↓</kbd><span>{t('sessions.shortcutSwitch')}</span>
            <span className={styles.shortcutSep} aria-hidden="true">·</span>
            <kbd>Alt</kbd><kbd>N</kbd><span>{t('sessions.shortcutNew')}</span>
          </span>
        </div>}
      </section>
    </div>

    {contextMenu && (() => {
      const session = sessions.find((item) => item.id === contextMenu.sessionId);
      if (!session) return null;
      const name = toolName(session);
      return createPortal(<div
        ref={contextMenuRef}
        className={rowMenuStyles.rowMenuList}
        role="menu"
        aria-label={t('sessions.sessionMenu', { name })}
        style={contextMenuBox ?? { top: 0, left: -10000 }}
        onKeyDown={contextMenuNavigate}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => setContextMenu(null)}
      >
        {session.running && <button role="menuitem" onClick={() => void sendToSession(session, '\x03')}>
          {t('sessions.sendInterrupt')}
        </button>}
        <button role="menuitem" disabled={!!busy} onClick={() => void restartOrCloneSession(session, !session.running)}>
          {session.running ? t('sessions.cloneSession') : t('sessions.restartSession')}
        </button>
        <button role="menuitem" onClick={() => void copyTerminalOutput(session)}>
          {t('sessions.copyOutput')}
        </button>
        {session.directory && <button role="menuitem" onClick={() => void copySessionPath(session)}>
          {t('sessions.copyPath')}
        </button>}
        {session.projectId && <button role="menuitem" onClick={() => void native.openProjectDirectory(session.projectId!).catch(() => {})}>
          {t('sessions.openFolder')}
        </button>}
        <button role="menuitem" data-danger="true" disabled={!!busy} onClick={() => void endSession(session)}>
          {session.running ? t('sessions.end') : t('sessions.removeSession')}
        </button>
      </div>, document.body);
    })()}

    <GuideDialog
      open={newDialogOpen}
      title={t('sessions.newSessionDialogTitle')}
      hint={t('sessions.newSessionDialogHint')}
      onClose={() => setNewDialogOpen(false)}
    >
      <div className={styles.dialogForm}>
        {dialogError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{dialogError}</p></div></div>}

        <div className={styles.dialogField}>
          <span className={styles.fieldLabel}>{t('sessions.pickToolLabel')}</span>
          <FilterSelect
            label={t('sessions.pickToolLabel')}
            value={effectiveLaunchToolId}
            options={cliSelectOptions}
            placeholder={t('home.launcher.pickTool')}
            searchLabel={t('sessions.searchCliTool')}
            onChange={(value) => {
              setLaunchToolId(value);
              const nextTool = terminalTools.find((item) => item.id === value);
              const nextMode = preferredLaunchMode(
                launchSettings,
                workspaceValue.startsWith('project:') ? 'project' : 'cli',
                !!nextTool?.yoloAvailable,
              );
              setLaunchMode(nextMode);
            }}
          />
        </div>

        <div className={styles.dialogField}>
          <span className={styles.fieldLabel}>{t('sessions.pickWorkspaceLabel')}</span>
          <FilterSelect
            label={t('sessions.pickWorkspaceLabel')}
            value={workspaceValue}
            options={workspaceSelectOptions}
            searchable
            searchLabel={t('sessions.searchWorkspace')}
            onPickFolder={() => void pickCustomWorkspaceFolder()}
            pickFolderLabel={t('sessions.pickFolder')}
            onChange={(value) => {
              setWorkspaceValue(value);
              if (value.startsWith('project:')) {
                const projId = value.slice('project:'.length);
                const proj = availableProjects.find((item) => item.id === projId);
                if (proj?.preferredTool && terminalTools.some((item) => item.id === proj.preferredTool)) {
                  setLaunchToolId(proj.preferredTool);
                }
              }
            }}
          />
        </div>

        <div className={styles.dialogField}>
          <span className={styles.fieldLabel}>{t('sessions.launchModeLabel')}</span>
          <div className={styles.modeCards} role="radiogroup" aria-label={t('sessions.launchModeLabel')}>
            <button
              type="button"
              role="radio"
              aria-checked={launchMode === 'normal'}
              className={styles.modeCard}
              onClick={() => setLaunchMode('normal')}
            >
              <span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="shield" size={15} /></span>
              <span className={styles.modeCardCopy}>
                <strong>{t('sessions.modeNormal')}</strong>
                <small>{t('sessions.modeNormalDesc')}</small>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={launchMode === 'yolo'}
              disabled={!selectedLaunchTool?.yoloAvailable}
              title={!selectedLaunchTool?.yoloAvailable ? t('sessions.yoloUnsupported') : undefined}
              className={styles.modeCard}
              onClick={() => setLaunchMode('yolo')}
            >
              <span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="sparkle" size={15} /></span>
              <span className={styles.modeCardCopy}>
                <strong>{t('sessions.modeYolo')}</strong>
                <small>{selectedLaunchTool?.yoloAvailable ? t('sessions.modeYoloDesc') : t('sessions.yoloUnsupported')}</small>
              </span>
            </button>
          </div>
          {selectedLaunchTool?.resumeLatestAvailable && <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={resumeLatest}
              onChange={(event) => setResumeLatest(event.target.checked)}
            />
            <span>{t('sessions.resumeLatest')}</span>
          </label>}
        </div>

        <div className={styles.dialogField}>
          <span className={styles.fieldLabel}>{t('sessions.initialPromptLabel')}</span>
          <textarea
            rows={3}
            className={styles.dialogTextarea}
            value={initialPrompt}
            placeholder={t('sessions.initialPromptPlaceholder')}
            aria-label={t('sessions.initialPromptLabel')}
            onChange={(event) => setInitialPrompt(event.target.value)}
          />
          {libraryPrompts.length > 0 && <div className={styles.dialogPrompts}>
            <span className={styles.composerPromptLabel}><Icon name="library" size={12} />{t('sessions.pickLibraryPrompt')}</span>
            {libraryPrompts.slice(0, 6).map((prompt) => (
              <button
                key={prompt.id}
                type="button"
                className={styles.promptPill}
                title={prompt.body}
                onClick={() => setInitialPrompt(prompt.body)}
              >
                {prompt.title}
              </button>
            ))}
          </div>}
        </div>

        <div className={styles.dialogSummary}>
          {effectiveLaunchToolId && <ToolIcon toolId={effectiveLaunchToolId} size={20} />}
          <span>
            {t('sessions.launchSummary', {
              tool: selectedLaunchTool?.name ?? '',
              place: workspaceValue.startsWith('project:')
                ? availableProjects.find((item) => 'project:' + item.id === workspaceValue)?.name ?? t('sessions.workspaceHome')
                : workspaceValue.startsWith('custom:')
                  ? shortPath(displayPath(workspaceValue.slice('custom:'.length)))
                  : t('sessions.workspaceHome'),
              mode: modeLabel(launchMode),
            })}
          </span>
        </div>

        <div className={styles.dialogActions}>
          <button type="button" className="button" onClick={() => setNewDialogOpen(false)}>
            {t('common.dialog.cancel')}
          </button>
          <button
            type="button"
            className="button primary"
            data-dialog-save
            disabled={launchingNew || !effectiveLaunchToolId}
            onClick={() => void launchFromDialog()}
          >
            <Icon name="play" size={14} />
            <span>{launchingNew ? t('sessions.startingSession') : t('sessions.startInWorkbench')}</span>
          </button>
        </div>
      </div>
    </GuideDialog>
  </div>;
}
