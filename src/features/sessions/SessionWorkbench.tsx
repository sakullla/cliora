import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
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
import { modLabel } from '../../lib/shortcut';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon, type IconName } from '../../components/Icon';
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
  selectAll: () => void;
  hasSelection: () => boolean;
  copySelection: () => boolean;
  paste: (text: string) => void;
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

export type TerminalTheme = 'dark' | 'light';
export type TerminalThemePreference = 'auto' | TerminalTheme;

function hexPair(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`;
}

function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 240-colour extended ANSI table (indices 16..255).
 * Dark-first TUIs paint prompt blocks with ANSI 232..238 dark-grey fills and bright 6x6x6 cube accents.
 * Remapping the dark-grey ramp to soft sage surfaces in light mode avoids harsh black highlight bars.
 */
function buildExtendedAnsi(mode: TerminalTheme): string[] {
  const cubeSteps = [0, 95, 135, 175, 215, 255];
  const out: string[] = [];
  for (let rIdx = 0; rIdx < 6; rIdx += 1) {
    for (let gIdx = 0; gIdx < 6; gIdx += 1) {
      for (let bIdx = 0; bIdx < 6; bIdx += 1) {
        let r = cubeSteps[rIdx];
        let g = cubeSteps[gIdx];
        let b = cubeSteps[bIdx];
        if (mode === 'light') {
          const lum = relLuminance(r, g, b);
          if (rIdx === gIdx && gIdx === bIdx && r < 80) {
            r = 228; g = 235; b = 226;
          } else if (lum > 0.34) {
            const scale = Math.min(0.72, (0.34 / lum) ** 0.52);
            r *= scale;
            g *= scale;
            b *= scale;
          }
        }
        out.push(rgbHex(r, g, b));
      }
    }
  }
  if (mode === 'light') {
    out.push(
      '#eef3ec', '#e9efe7', '#e4ebe2', '#dfe7dd', '#dae3d7', '#d4ded1', '#ced9cb', '#c6d2c3',
      '#76847b', '#6d7b72', '#647269', '#5c6960', '#536057', '#4b574f', '#434f47', '#3b463f',
      '#343e38', '#2e3731', '#28312b', '#232b26', '#1f2621', '#1b221e', '#181e1a', '#141a17',
    );
  } else {
    out.push(
      '#111714', '#151c18', '#19221d', '#1e2822', '#232e27', '#28352d', '#2e3c33', '#35443a',
      '#425247', '#4e5f53', '#5a6c60', '#67796d', '#74867a', '#829488', '#90a296', '#9eb0a4',
      '#acbeb2', '#b8cabe', '#c4d6ca', '#d0e1d5', '#dcebe0', '#e6f3ea', '#f0f8f2', '#f8fcf9',
    );
  }
  return out;
}

const DARK_THEME: ITheme = {
  background: '#0b100d',
  foreground: '#e5eee8',
  cursor: '#7be3a7',
  cursorAccent: '#0b100d',
  selectionBackground: '#7be3a745',
  selectionInactiveBackground: '#7be3a722',
  black: '#18211c',
  red: '#ff7b72',
  green: '#7ee2a8',
  yellow: '#ecc97e',
  blue: '#79b8ff',
  magenta: '#d2a8ff',
  cyan: '#76d9c8',
  white: '#d5ded8',
  brightBlack: '#68786e',
  brightRed: '#ffa198',
  brightGreen: '#a8f0c8',
  brightYellow: '#f5da98',
  brightBlue: '#a8d1ff',
  brightMagenta: '#e3c6ff',
  brightCyan: '#a6ecdf',
  brightWhite: '#ffffff',
  extendedAnsi: buildExtendedAnsi('dark'),
};

/** Light palette: "white" and extended 256-colour slots stay readable on a warm light canvas. */
const LIGHT_THEME: ITheme = {
  background: '#f9fbf8',
  foreground: '#18211b',
  cursor: '#0e6b43',
  cursorAccent: '#f9fbf8',
  selectionBackground: '#0e6b432e',
  selectionInactiveBackground: '#0e6b4318',
  black: '#1b231e',
  red: '#b93127',
  green: '#146c43',
  yellow: '#8a5700',
  blue: '#1b5dab',
  magenta: '#8238a0',
  cyan: '#0a7169',
  white: '#54625a',
  brightBlack: '#5c6b62',
  brightRed: '#cf3f34',
  brightGreen: '#198252',
  brightYellow: '#9c6300',
  brightBlue: '#2870c4',
  brightMagenta: '#964ab6',
  brightCyan: '#0f857d',
  brightWhite: '#2b352f',
  extendedAnsi: buildExtendedAnsi('light'),
};

export function terminalTheme(mode: TerminalTheme): ITheme {
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/** Light canvases get a contrast floor so pale true-colour output (syntax, dim hints) stays legible. */
function contrastFloor(mode: TerminalTheme): number {
  return mode === 'light' ? 4.5 : 1.2;
}

/** xterm only disables its own reflow for ConPTY when it knows the Windows build. */
let windowsPtyInfo: { backend: 'conpty'; buildNumber: number } | null | undefined;
async function resolveWindowsPty(): Promise<{ backend: 'conpty'; buildNumber: number } | null> {
  if (windowsPtyInfo !== undefined) return windowsPtyInfo;
  if (!/Windows/i.test(navigator.userAgent)) { windowsPtyInfo = null; return null; }
  let buildNumber = 19045;
  try {
    const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }> } }).userAgentData;
    const version = await data?.getHighEntropyValues?.(['platformVersion']);
    const major = Number((version?.platformVersion ?? '').split('.')[0]);
    if (Number.isFinite(major) && major >= 13) buildNumber = 22621;
  } catch { /* Windows 10 behaviour is the safe default. */ }
  windowsPtyInfo = { backend: 'conpty', buildNumber };
  return windowsPtyInfo;
}

/** Drag-and-drop and context-menu inserts: quote paths that the shell would split. */
export function quoteDroppedPaths(paths: string[]): string {
  return paths
    .filter((path) => path.trim())
    .map((path) => (/[\s"'&()^;|<>]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path))
    .join(' ');
}

type ShortcutAction = 'find' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'newSession' | 'prevSession' | 'nextSession';

/**
 * Keys the workbench owns before xterm sees them. Returns the action, or null to let xterm encode the key.
 * Kept pure so its mapping can be unit-tested without a terminal.
 */
export function terminalKeyAction(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, options: { hasSelection: boolean; canSwitch: boolean; mac: boolean }):
  | { kind: 'send'; data: string }
  | { kind: 'paste' }
  | { kind: 'copy' }
  | { kind: 'shortcut'; action: ShortcutAction }
  | null {
  const { key, ctrlKey, shiftKey, altKey, metaKey } = event;
  const mod = options.mac ? metaKey : ctrlKey;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  // Shift+Enter → LF (Ctrl+J): the newline key Codex, Claude Code and pi all accept, and ConPTY passes through intact.
  if (key === 'Enter' && shiftKey && !ctrlKey && !altKey && !metaKey) return { kind: 'send', data: '\n' };
  // Paste: let the browser raise a real paste event so xterm applies bracketed paste.
  if ((mod && !altKey && lower === 'v') || (shiftKey && !ctrlKey && !altKey && key === 'Insert')) return { kind: 'paste' };
  // Copy: Ctrl+C copies only when text is selected; otherwise it stays an interrupt.
  if (mod && !altKey && lower === 'c' && (shiftKey || options.mac || options.hasSelection)) return { kind: 'copy' };
  if (ctrlKey && !shiftKey && !altKey && key === 'Insert') return { kind: 'copy' };
  if (mod && shiftKey && !altKey && lower === 'f') return { kind: 'shortcut', action: 'find' };
  if (mod && !altKey && (key === '=' || key === '+')) return { kind: 'shortcut', action: 'zoomIn' };
  if (mod && !altKey && !shiftKey && (key === '-' || key === '_')) return { kind: 'shortcut', action: 'zoomOut' };
  if (mod && !altKey && !shiftKey && key === '0') return { kind: 'shortcut', action: 'zoomReset' };
  if (altKey && !ctrlKey && !metaKey && !shiftKey) {
    if (lower === 'n') return { kind: 'shortcut', action: 'newSession' };
    if (options.canSwitch && key === 'ArrowUp') return { kind: 'shortcut', action: 'prevSession' };
    if (options.canSwitch && key === 'ArrowDown') return { kind: 'shortcut', action: 'nextSession' };
  }
  return null;
}

const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

type TerminalBridge = {
  writeError: (error: unknown) => void;
  bell: (sessionId: string) => void;
  title: (sessionId: string, title: string) => void;
  outputActive: (sessionId: string, active: boolean) => void;
  shortcut: (action: ShortcutAction) => void;
  canSwitch: () => boolean;
  scrolled: (sessionId: string, awayFromBottom: boolean) => void;
  size: (sessionId: string, cols: number, rows: number) => void;
  copied: () => void;
};

function SessionTerminal({ sessionId, label, active, running, fontSize, theme, cursorBlink, writers, pending, handles, bridge }: {
  sessionId: string;
  label: string;
  active: boolean;
  running: boolean;
  fontSize: number;
  theme: TerminalTheme;
  cursorBlink: boolean;
  writers: MutableRefObject<Map<string, (data: string) => void>>;
  pending: MutableRefObject<Map<string, string[]>>;
  handles: MutableRefObject<Map<string, TerminalHandle>>;
  bridge: MutableRefObject<TerminalBridge>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const runningRef = useRef(running);
  const fontSizeRef = useRef(fontSize);
  const themeRef = useRef(theme);
  activeRef.current = active;
  runningRef.current = running;
  fontSizeRef.current = fontSize;
  themeRef.current = theme;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: fontSizeRef.current,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      scrollback: 10000,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      macOptionIsMeta: true,
      allowProposedApi: true,
      screenReaderMode: true,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: contrastFloor(themeRef.current),
      theme: terminalTheme(themeRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let acceptLive = false;
    let liveStreaming = false;
    let liveTimer = 0;
    const queued: string[] = [];
    void resolveWindowsPty().then((info) => { if (!disposed && info) term.options.windowsPty = info; });

    // Coalesce PTY bursts into one write per animation frame: TUIs redraw in several chunks and
    // rendering half a frame shows up as flicker. A microtask fallback keeps hidden tabs moving.
    const frameChunks: Uint8Array[] = [];
    let flushScheduled = false;
    let flushFrame = 0;
    let flushTimer = 0;
    const flushWrites = () => {
      flushScheduled = false;
      cancelAnimationFrame(flushFrame);
      window.clearTimeout(flushTimer);
      if (disposed || !frameChunks.length) return;
      const merged = frameChunks.length === 1 ? frameChunks[0] : concatBytes(frameChunks);
      frameChunks.length = 0;
      try { term.write(merged); }
      catch { /* Malformed bytes stay out of the terminal. */ }
    };
    const scheduleWriteBytes = (bytes: Uint8Array) => {
      if (!bytes.length || disposed) return;
      frameChunks.push(bytes);
      if (flushScheduled) return;
      flushScheduled = true;
      if (document.visibilityState === 'visible' && activeRef.current) {
        flushFrame = requestAnimationFrame(flushWrites);
        flushTimer = window.setTimeout(flushWrites, 50);
      } else {
        queueMicrotask(flushWrites);
      }
    };
    const markLiveOutput = () => {
      if (disposed || !runningRef.current) return;
      if (!liveStreaming) {
        liveStreaming = true;
        bridge.current.outputActive(sessionId, true);
      }
      window.clearTimeout(liveTimer);
      liveTimer = window.setTimeout(() => {
        liveStreaming = false;
        if (!disposed) bridge.current.outputActive(sessionId, false);
      }, 1500);
    };
    const writeEncoded = (encoded: string, isLive = false) => {
      if (!encoded || disposed) return;
      try {
        const decoded = decodeBase64(encoded);
        if (isLive && decoded.length > 0) markLiveOutput();
        scheduleWriteBytes(decoded);
      } catch { /* Malformed bytes stay out of the terminal. */ }
    };
    const publish = (encoded: string) => {
      if (acceptLive) writeEncoded(encoded, true);
      else queued.push(encoded);
    };
    writers.current.set(sessionId, publish);

    const sendToPty = (data: string) => {
      if (!activeRef.current || !runningRef.current || !data) return;
      if (data.includes('\r') || data.includes('\n')) markLiveOutput();
      void native.writeWorkbenchSession(sessionId, encodeBase64(new TextEncoder().encode(data))).catch((error) => bridge.current.writeError(error));
    };

    const copySelection = () => {
      const selected = term.getSelection();
      if (!selected) return false;
      void writeClipboard(selected).then((ok) => { if (ok) bridge.current.copied(); });
      term.clearSelection();
      return true;
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.isComposing || event.keyCode === 229) return true;
      const action = terminalKeyAction(event, { hasSelection: term.hasSelection(), canSwitch: bridge.current.canSwitch(), mac: MAC });
      if (!action) return true;
      // Returning false for keypress/keyup too keeps xterm from encoding the same key a second time.
      if (event.type !== 'keydown') return false;
      if (action.kind === 'paste') return false; // No preventDefault: the browser fires `paste` on xterm's textarea.
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === 'send') sendToPty(action.data);
      else if (action.kind === 'copy') copySelection();
      else bridge.current.shortcut(action.action);
      return false;
    });

    // Without mouse reporting xterm turns the wheel into ↑/↓ on the alternate screen, which moves
    // the CLI's input caret or history. Only forward the wheel when the CLI asked for mouse events.
    term.attachCustomWheelEventHandler((event) => {
      if (term.modes.mouseTrackingMode !== 'none') return true;
      if (term.buffer.active.type === 'alternate') {
        event.preventDefault();
        return false;
      }
      return true;
    });

    // Clipboard without text (a screenshot): pass Ctrl+V through like Windows Terminal so the CLI can read the image.
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const text = data.getData('text/plain');
      if (text) return;
      const hasImage = [...data.items].some((item) => item.kind === 'file');
      if (!hasImage) return;
      event.preventDefault();
      event.stopPropagation();
      sendToPty('\x16');
    };
    node.addEventListener('paste', onPaste, true);

    // IME composition moves xterm's hidden textarea to the caret; the browser then scrolls every
    // ancestor to reveal it, sliding the whole window sideways. None of these ancestors should scroll.
    const resetAncestorScroll = (event: Event) => {
      if (!activeRef.current || !node.isConnected || node.offsetParent === null) return;
      const target = event.target === document ? document.scrollingElement : event.target;
      if (!(target instanceof Element) || target === node || !target.contains(node)) return;
      if (target.scrollLeft) target.scrollLeft = 0;
      if (target.scrollTop) target.scrollTop = 0;
    };
    document.addEventListener('scroll', resetAncestorScroll, true);

    const bellSub = term.onBell(() => {
      if (!disposed) bridge.current.bell(sessionId);
    });
    // OSC 0/2: CLIs such as Codex and Claude Code name the current task in the window title.
    const titleSub = term.onTitleChange((title) => {
      if (!disposed) bridge.current.title(sessionId, title);
    });
    let awayFromBottom = false;
    const reportScroll = () => {
      if (disposed) return;
      const buffer = term.buffer.active;
      const away = buffer.type === 'normal' && buffer.viewportY < buffer.baseY - 1;
      if (away === awayFromBottom) return;
      awayFromBottom = away;
      bridge.current.scrolled(sessionId, away);
    };
    const scrollSub = term.onScroll(reportScroll);
    const parsedSub = term.onWriteParsed(reportScroll);

    const handle: TerminalHandle = {
      focus: () => { if (!disposed) term.focus(); },
      clear: () => { if (!disposed) term.clear(); },
      scrollToBottom: () => { if (!disposed) { term.scrollToBottom(); reportScroll(); } },
      selectAll: () => { if (!disposed) term.selectAll(); },
      hasSelection: () => !disposed && term.hasSelection(),
      copySelection: () => !disposed && copySelection(),
      paste: (text: string) => { if (!disposed && runningRef.current && text) term.paste(text); },
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

    const subscription = term.onData((data) => sendToPty(data));
    const fitNow = () => {
      if (disposed || !activeRef.current || node.clientWidth < 8 || node.clientHeight < 8) return;
      try { fit.fit(); } catch { return; }
      if (term.cols < 2 || term.rows < 1) return;
      bridge.current.size(sessionId, term.cols, term.rows);
      if (!runningRef.current) return;
      void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
    };
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitNow);
    });
    observer.observe(node);
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
      queued.splice(0).forEach((item) => writeEncoded(item));
      (pending.current.get(sessionId) ?? []).splice(0).forEach((item) => writeEncoded(item));
      pending.current.delete(sessionId);
    });
    return () => {
      disposed = true;
      window.clearTimeout(liveTimer);
      flushWrites();
      cancelAnimationFrame(resizeFrame);
      if (writers.current.get(sessionId) === publish) writers.current.delete(sessionId);
      if (handles.current.get(sessionId) === handle) handles.current.delete(sessionId);
      node.removeEventListener('paste', onPaste, true);
      document.removeEventListener('scroll', resetAncestorScroll, true);
      bellSub.dispose();
      titleSub.dispose();
      scrollSub.dispose();
      parsedSub.dispose();
      subscription.dispose();
      observer.disconnect();
      // xterm 5.5 schedules `setTimeout(syncScrollArea)` while opening; disposing in the same tick
      // makes that timer read a torn-down renderer. Dispose after it has run.
      window.setTimeout(() => term.dispose(), 0);
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, writers, pending, handles, bridge]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme);
    term.options.minimumContrastRatio = contrastFloor(theme);
  }, [theme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !active || !running;
    term.options.cursorBlink = cursorBlink && active && running;
    term.options.fontSize = fontSize;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const fit = fitRef.current;
      const node = host.current;
      if (!fit || !node || node.clientWidth < 8) return;
      try { fit.fit(); } catch { return; }
      if (term.cols >= 2 && term.rows >= 1) {
        bridge.current.size(sessionId, term.cols, term.rows);
        if (running) void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
      }
      if (running && !document.querySelector('dialog[open]')) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, running, fontSize, cursorBlink, sessionId, bridge]);

  return <div ref={host} className={styles.terminalHost} hidden={!active} aria-label={label} data-blink={cursorBlink || undefined} />;
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

function readStoredTerminalTheme(): TerminalThemePreference {
  try {
    const raw = localStorage.getItem('cliora:workbench-terminal-theme');
    if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  } catch { /* ignore */ }
  return 'auto';
}

function readStoredCursorBlink(): boolean {
  try { return localStorage.getItem('cliora:workbench-cursor-blink') !== 'false'; }
  catch { return true; }
}

function currentAppTheme(): TerminalTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

type MenuState =
  | { kind: 'session'; sessionId: string; x: number; y: number }
  | { kind: 'terminal'; sessionId: string; x: number; y: number; hasSelection: boolean };

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

  const [railWidth, setRailWidth] = useState<number>(readStoredRailWidth);
  const [focusMode, setFocusMode] = useState(false);
  const [railFilter, setRailFilter] = useState<RailFilter>('all');
  const [railSearch, setRailSearch] = useState('');
  const [fontSize, setFontSize] = useState<number>(readStoredFontSize);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(readStoredSoundEnabled);
  const [themePreference, setThemePreference] = useState<TerminalThemePreference>(readStoredTerminalTheme);
  const [appTheme, setAppTheme] = useState<TerminalTheme>(currentAppTheme);
  const [cursorBlink, setCursorBlink] = useState<boolean>(readStoredCursorBlink);
  const terminalMode: TerminalTheme = themePreference === 'auto' ? appTheme : themePreference;

  const [attentionIds, setAttentionIds] = useState<Set<string>>(() => new Set());
  const [activeOutputIds, setActiveOutputIds] = useState<Set<string>>(() => new Set());
  const [scrolledIds, setScrolledIds] = useState<Set<string>>(() => new Set());
  const [sizes, setSizes] = useState<Map<string, { cols: number; rows: number }>>(() => new Map());
  const [titles, setTitles] = useState<Map<string, string>>(() => new Map());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [launchToolId, setLaunchToolId] = useState('');
  const [workspaceValue, setWorkspaceValue] = useState('__home');
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  const [resumeLatest, setResumeLatest] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [launchingNew, setLaunchingNew] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<TerminalMatch[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [copiedState, setCopiedState] = useState<'path' | 'output' | 'selection' | 'empty' | null>(null);
  const copyTimerRef = useRef<number>(0);

  const firstSeenAt = useRef(new Map<string, number>());
  const [clock, setClock] = useState(() => Date.now());

  const writers = useRef(new Map<string, (data: string) => void>());
  const pending = useRef(new Map<string, string[]>());
  const handles = useRef(new Map<string, TerminalHandle>());

  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

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

  function flashCopied(state: 'path' | 'output' | 'selection' | 'empty') {
    window.clearTimeout(copyTimerRef.current);
    setCopiedState(state);
    copyTimerRef.current = window.setTimeout(() => setCopiedState(null), 1600);
  }

  const updateFontSize = useCallback((nextSize: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, nextSize));
    setFontSize(clamped);
    try { localStorage.setItem('cliora:workbench-font-size', String(clamped)); } catch { /* ignore */ }
  }, []);

  function openFind() {
    setFindOpen(true);
    requestAnimationFrame(() => { findInputRef.current?.focus(); findInputRef.current?.select(); });
  }

  // One bridge object for every terminal; refreshed each render so callbacks see current state.
  const bridge = useRef<TerminalBridge>(null as unknown as TerminalBridge);
  bridge.current = {
    writeError: (error) => setActionError(formatFailure(error, t('sessions.writeFailed'), t('sessions.retry'))),
    bell: (id) => {
      if (soundEnabledRef.current) playWorkbenchChime('bell');
      if (id === selectedIdRef.current && document.hasFocus()) return;
      setAttentionIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    title: (id, raw) => {
      const title = cleanTerminalTitle(raw);
      setTitles((prev) => {
        if ((prev.get(id) ?? '') === title) return prev;
        const next = new Map(prev);
        if (title) next.set(id, title);
        else next.delete(id);
        return next;
      });
    },
    outputActive: (id, isActive) => {
      setActiveOutputIds((prev) => {
        if (prev.has(id) === isActive) return prev;
        const next = new Set(prev);
        if (isActive) next.add(id);
        else next.delete(id);
        return next;
      });
      if (!isActive && id !== selectedIdRef.current) {
        setAttentionIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }
    },
    shortcut: (action) => {
      if (action === 'find') openFind();
      else if (action === 'zoomIn') updateFontSize(fontSize + 1);
      else if (action === 'zoomOut') updateFontSize(fontSize - 1);
      else if (action === 'zoomReset') updateFontSize(DEFAULT_FONT_SIZE);
      else if (action === 'newSession') { if (terminalTools.length) openNewSessionDialog(); }
      else stepSession(action === 'nextSession' ? 1 : -1);
    },
    canSwitch: () => filteredSessions.length > 1,
    scrolled: (id, away) => setScrolledIds((prev) => {
      if (prev.has(id) === away) return prev;
      const next = new Set(prev);
      if (away) next.add(id); else next.delete(id);
      return next;
    }),
    size: (id, cols, rows) => setSizes((prev) => {
      const old = prev.get(id);
      if (old && old.cols === cols && old.rows === rows) return prev;
      const next = new Map(prev);
      next.set(id, { cols, rows });
      return next;
    }),
    copied: () => flashCopied('selection'),
  };

  useEffect(() => {
    if (focusSessionId) setSelectedId(focusSessionId);
  }, [focusSessionId, focusToken]);

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
    const observer = new MutationObserver(() => setAppTheme(currentAppTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => { window.clearTimeout(copyTimerRef.current); }, []);

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
      setActiveOutputIds((prev) => {
        if (!prev.has(event.payload.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(event.payload.sessionId);
        return next;
      });
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
        if (!firstSeenAt.current.has(item.id)) firstSeenAt.current.set(item.id, item.startedAt ?? now);
      }
      setSessions(next);
      setProjects(Array.isArray(listedProjects) ? listedProjects : []);
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
    if (!selectedLaunchTool?.yoloAvailable && launchMode === 'yolo') setLaunchMode('normal');
    if (!selectedLaunchTool?.resumeLatestAvailable && resumeLatest) setResumeLatest(false);
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

  const toggleCursorBlink = useCallback(() => {
    setCursorBlink((prev) => {
      const next = !prev;
      try { localStorage.setItem('cliora:workbench-cursor-blink', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const cycleTerminalTheme = useCallback(() => {
    setThemePreference((prev) => {
      const next: TerminalThemePreference = prev === 'auto' ? 'dark' : prev === 'dark' ? 'light' : 'auto';
      try { localStorage.setItem('cliora:workbench-terminal-theme', next); } catch { /* ignore */ }
      return next;
    });
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
    document.body.dataset.resizing = 'col';
    const onMove = (moveEvent: PointerEvent) => updateRailWidth(startW + (moveEvent.clientX - startX));
    const onUp = () => {
      delete document.body.dataset.resizing;
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

  function forgetSession(id: string) {
    firstSeenAt.current.delete(id);
    setTitles((prev) => { if (!prev.has(id)) return prev; const next = new Map(prev); next.delete(id); return next; });
    setActiveOutputIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    setScrolledIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
  }

  function sessionTone(session: WorkbenchSession): 'live' | 'idle' | 'bell' | 'error' | 'ended' {
    if (!session.running) {
      return session.exitCode != null && session.exitCode !== 0 ? 'error' : 'ended';
    }
    if (attentionIds.has(session.id)) return 'bell';
    if (activeOutputIds.has(session.id)) return 'live';
    return 'idle';
  }

  async function endSession(session: WorkbenchSession) {
    if (busy) return;
    setBusy(session.id);
    setActionError('');
    try {
      await native.closeWorkbenchSession(session.id);
      forgetSession(session.id);
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
        forgetSession(session.id);
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
          forgetSession(session.id);
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
      bridge.current.writeError(error);
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
    if (await writeClipboard(value)) flashCopied('path');
  }

  async function copyTerminalOutput(session: WorkbenchSession) {
    const text = handles.current.get(session.id)?.readOutput() ?? '';
    if (!text.trim()) { flashCopied('empty'); return; }
    if (await writeClipboard(text)) flashCopied('output');
  }

  async function pasteIntoSession(session: WorkbenchSession) {
    const handle = handles.current.get(session.id);
    if (!handle || !session.running) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) handle.paste(text);
      handle.focus();
    } catch {
      setNotice(t('sessions.pasteFailed', { shortcut: `${modLabel}+V` }));
      handle.focus();
    }
  }

  function stepFindMatch(delta: -1 | 1) {
    if (!findMatches.length || !selectedId) return;
    const next = (findIndex + delta + findMatches.length) % findMatches.length;
    setFindIndex(next);
    handles.current.get(selectedId)?.revealMatch(findMatches[next] ?? null);
  }

  function closeFind() {
    setFindOpen(false);
    if (selectedId) handles.current.get(selectedId)?.focus();
  }

  const selected = sessions.find((item) => item.id === selectedId) ?? null;
  const showEmpty = !loading && !sessions.length;
  const runningCount = sessions.filter((item) => item.running).length;
  const endedCount = sessions.length - runningCount;
  const selectedSize = selected ? sizes.get(selected.id) : undefined;

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

  function stepSession(step: 1 | -1) {
    if (filteredSessions.length < 2) return;
    setSelectedId((current) => {
      const index = filteredSessions.findIndex((item) => item.id === current);
      return filteredSessions[(index + step + filteredSessions.length) % filteredSessions.length].id;
    });
  }

  // Context menus (session row and terminal surface): placed at the pointer, kept inside the window.
  useEffect(() => { if (!menu) setMenuBox(null); }, [menu]);
  useLayoutEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - node.offsetWidth - 8));
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - node.offsetHeight - 8));
    setMenuBox({ top, left });
    node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const current = menu;
      setMenu(null);
      if (current.kind === 'session') document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(current.sessionId)}"]`)?.focus();
      else handles.current.get(current.sessionId)?.focus();
    };
    const close = () => setMenu(null);
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
  }, [menu]);

  function openRowMenu(session: WorkbenchSession, x: number, y: number) {
    setSelectedId(session.id);
    setMenu({ kind: 'session', sessionId: session.id, x, y });
  }

  function menuNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
    if (!items.length) return;
    if (event.key === 'Tab') { event.preventDefault(); setMenu(null); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  const availableProjects = useMemo(() => projects.filter((item) => item.available && item.path), [projects]);

  // Alt+↑/↓ and Alt+N outside the terminal (the terminal routes them through its key handler).
  useEffect(() => {
    if (!active || newDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((MAC ? event.metaKey : event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f' && selectedIdRef.current) {
        event.preventDefault();
        openFind();
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (editing) return;
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        if (filteredSessions.length < 2) return;
        event.preventDefault();
        stepSession(step);
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

  // Files dropped on the terminal become quoted paths, the same text a terminal would insert.
  const dropTargetRef = useRef<{ id: string | null; running: boolean }>({ id: null, running: false });
  dropTargetRef.current = { id: selected?.id ?? null, running: !!selected?.running };
  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    let stop: (() => void) | null = null;
    const inside = (position: { x: number; y: number } | undefined) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !position) return false;
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    try {
      void getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        const target = dropTargetRef.current;
        const accept = !!target.id && target.running && !document.querySelector('dialog[open]');
        if (payload.type === 'leave') { setDropActive(false); return; }
        if (payload.type === 'enter' || payload.type === 'over') { setDropActive(accept && inside(payload.position)); return; }
        if (payload.type === 'drop') {
          setDropActive(false);
          if (!accept || !inside(payload.position) || !target.id) return;
          const text = quoteDroppedPaths(payload.paths ?? []);
          const handle = handles.current.get(target.id);
          if (text && handle) { handle.paste(text); handle.focus(); }
        }
      }).then((unlisten) => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    } catch { /* Not running inside a Tauri webview. */ }
    return () => { alive = false; stop?.(); setDropActive(false); };
  }, [active]);

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

  const themeLabel = themePreference === 'auto' ? t('sessions.termThemeAuto') : themePreference === 'dark' ? t('sessions.termThemeDark') : t('sessions.termThemeLight');
  const themeGlyph: IconName = themePreference === 'auto' ? 'monitor' : themePreference === 'dark' ? 'moon' : 'sun';

  return <div className={styles.root} data-focus-mode={focusMode || undefined} data-empty={(showEmpty && !listError) || undefined} data-term-theme={terminalMode}>
    {listError && <div className={styles.banner} role="alert">
      <div className={styles.bannerCopy}>
        <strong>{t('sessions.listFailed')}</strong>
        <p>{listError}</p>
      </div>
      <button type="button" className={styles.ghostButton} onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</button>
    </div>}

    <div className={styles.layout} style={{ '--rail-w': railWidth + 'px' } as React.CSSProperties}>
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
              aria-label={t('sessions.newSession')}
              title={t('sessions.newSession') + ' (Alt+N)'}
              onClick={() => openNewSessionDialog()}
            >
              <Icon name="plus" size={14} />
              <span>{t('sessions.newSessionShort')}</span>
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
              <Icon name="close" size={11} />
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
            const isSelected = session.id === selectedId;
            const hasBell = attentionIds.has(session.id);
            const tone = sessionTone(session);
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
                  <ToolIcon toolId={session.toolId} size={20} />
                  <span className={styles.sessionStateDot} data-tone={tone} aria-hidden="true" />
                </span>
                <span className={styles.sessionBody}>
                  <span className={styles.sessionTop}>
                    <strong>{title || name}</strong>
                    <span className={styles.sessionTime} data-tone={tone}>
                      {session.running ? (elapsed || t('sessions.running')) : t('sessions.ended')}
                    </span>
                  </span>
                  <span className={styles.sessionSub}>
                    <span className={styles.sessionPlace}>{title ? name + ' \u00b7 ' + place : place}</span>
                    <span className={styles.sessionBadges}>
                      {hasBell && <span className={styles.attentionTag}>
                        <span className={styles.attentionDot} aria-hidden="true" />
                        {t('sessions.bellBadge')}
                      </span>}
                      {!session.running && session.exitCode != null && session.exitCode !== 0 && <span className={styles.exitTag}>
                        {t('sessions.exitCode', { code: session.exitCode })}
                      </span>}
                      <span className={styles.modeTag} data-mode={session.mode}>{modeLabel(session.mode)}</span>
                    </span>
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
          const title = taskTitle(selected);
          const tone = sessionTone(selected);
          const isOutputting = activeOutputIds.has(selected.id);
          return <div className={styles.stageBar}>
            <button
              type="button"
              className={styles.focusBtn}
              aria-pressed={focusMode}
              aria-label={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')}
              title={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')}
              onClick={() => setFocusMode((current) => !current)}
            >
              <Icon name={focusMode ? 'sidebarOpen' : 'sidebarClose'} size={16} />
            </button>

            <span className={styles.stageIcon} data-tone={tone}><ToolIcon toolId={selected.toolId} size={20} /></span>

            <div className={styles.identityText}>
              <span className={styles.identityMain}>
                <strong title={title ? toolName(selected) + ' \u00b7 ' + title : undefined}>
                  {title ? <>{toolName(selected)}<span className={styles.identityTitle}>{title}</span></> : toolName(selected)}
                </strong>
              </span>
              <span className={styles.identityMeta}>
                <span className={styles.statusChip} data-tone={tone}>
                  <span className={styles.statusDot} aria-hidden="true" />
                  {selected.running
                    ? (isOutputting
                      ? (elapsed ? t('sessions.stateWorking') + ' · ' + elapsed : t('sessions.stateWorking'))
                      : (elapsed ? t('sessions.stateIdle') + ' · ' + elapsed : t('sessions.stateIdle')))
                    : t('sessions.ended') + (selected.exitCode != null ? ' · ' + t('sessions.exitCode', { code: selected.exitCode }) : '')}
                </span>
                <span className={styles.modeChip} data-mode={selected.mode}>{modeLabel(selected.mode)}</span>
                <button
                  type="button"
                  className={styles.pathChip}
                  title={selected.directory ? displayPath(selected.directory) + ' · ' + t('sessions.copyPath') : placeOf(selected)}
                  onClick={() => void copySessionPath(selected)}
                >
                  <Icon name={copiedState === 'path' ? 'check' : 'folder'} size={12} />
                  <span>{copiedState === 'path' ? t('sessions.pathCopied') : placeOf(selected)}</span>
                </button>
              </span>
            </div>

            <div className={styles.stageActions}>
              <div className={styles.toolbarGroup}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-pressed={findOpen}
                  aria-label={t('sessions.findOutput')}
                  title={`${t('sessions.findOutput')} (${modLabel}+Shift+F)`}
                  onClick={() => { if (findOpen) closeFind(); else openFind(); }}
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
                    else handles.current.get(selected.id)?.focus();
                  }}
                >
                  <Icon name="pencil" size={15} />
                </button>}

                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={t('sessions.copyOutput')}
                  title={copiedState === 'output' ? t('sessions.outputCopied') : t('sessions.copyOutput')}
                  onClick={() => void copyTerminalOutput(selected)}
                >
                  <Icon name={copiedState === 'output' ? 'check' : 'copy'} size={15} />
                </button>

                <RowMenu label={t('common.models.more')} className={styles.iconBtn}>
                  <button role="menuitem" onClick={() => void copyTerminalOutput(selected)}>
                    <Icon name="copy" size={14} />{copiedState === 'output' ? t('sessions.outputCopied') : t('sessions.copyOutput')}
                  </button>
                  {selected.directory && <button role="menuitem" onClick={() => void copySessionPath(selected)}>
                    <Icon name="folder" size={14} />{t('sessions.copyPath')}
                  </button>}
                  {selected.projectId && <button role="menuitem" onClick={() => void native.openProjectDirectory(selected.projectId!).catch(() => {})}>
                    <Icon name="arrowRight" size={14} />{t('sessions.openFolder')}
                  </button>}
                  <span className={styles.menuDivider} role="separator" />
                  <button role="menuitem" disabled={!!busy} onClick={() => void restartOrCloneSession(selected, !selected.running)}>
                    <Icon name={selected.running ? 'plus' : 'refresh'} size={14} />{selected.running ? t('sessions.cloneSession') : t('sessions.restartSession')}
                  </button>
                  {selected.running && <button role="menuitem" onClick={() => void sendToSession(selected, '\x03')}>
                    <Icon name="alert" size={14} />{t('sessions.sendInterrupt')}
                  </button>}
                  <button role="menuitem" onClick={() => handles.current.get(selected.id)?.clear()}>
                    <Icon name="trash" size={14} />{t('sessions.clearScreen')}
                  </button>
                  <span className={styles.menuDivider} role="separator" />
                  <button role="menuitem" onClick={toggleCursorBlink}>
                    <Icon name="terminal" size={14} />{cursorBlink ? t('sessions.cursorBlinkOn') : t('sessions.cursorBlinkOff')}
                  </button>
                  <button role="menuitem" onClick={toggleSound}>
                    <Icon name="info" size={14} />{soundEnabled ? t('sessions.soundNotifyOn') : t('sessions.soundNotifyOff')}
                  </button>
                </RowMenu>
              </div>

              {!selected.running && <button
                type="button"
                className={styles.restartBtn}
                disabled={!!busy}
                title={t('sessions.restartSession')}
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

        {selected && !selected.running && <div className={styles.endedStrip}>
          <Icon name="lock" size={12} />
          <span><strong>{t('sessions.sessionEndedBanner')}</strong> · {t('sessions.endedHintShort')}</span>
        </div>}

        <div
          ref={canvasRef}
          className={styles.canvas}
          hidden={!sessions.length}
          data-drop={dropActive || undefined}
          onContextMenu={(event) => {
            if (!selected) return;
            event.preventDefault();
            const handle = handles.current.get(selected.id);
            setMenu({ kind: 'terminal', sessionId: selected.id, x: event.clientX, y: event.clientY, hasSelection: !!handle?.hasSelection() });
          }}
        >
          {sessions.map((session) => (
            <SessionTerminal
              key={session.id}
              sessionId={session.id}
              label={t('sessions.terminalLabel', { tool: toolName(session) })}
              active={session.id === selectedId}
              running={session.running}
              fontSize={fontSize}
              theme={terminalMode}
              cursorBlink={cursorBlink}
              writers={writers}
              pending={pending}
              handles={handles}
              bridge={bridge}
            />
          ))}

          {selected && findOpen && <div className={styles.findBar} role="search">
            <div className={styles.findField}>
              <Icon name="search" size={13} />
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
                    event.stopPropagation();
                    closeFind();
                  }
                }}
              />
              <span className={styles.findCount} data-empty={(findQuery.trim() && !findMatches.length) || undefined}>
                {!findQuery.trim()
                  ? ''
                  : findMatches.length > 0
                    ? t('sessions.findMatchCount', { current: findIndex + 1, total: findMatches.length })
                    : t('sessions.findNoMatch')}
              </span>
            </div>
            <button type="button" className={styles.iconBtn} disabled={!findMatches.length} aria-label={t('sessions.findPrev')} title={t('sessions.findPrev') + ' (Shift+Enter)'} onClick={() => stepFindMatch(-1)}>
              <Icon name="chevronLeft" size={14} />
            </button>
            <button type="button" className={styles.iconBtn} disabled={!findMatches.length} aria-label={t('sessions.findNext')} title={t('sessions.findNext') + ' (Enter)'} onClick={() => stepFindMatch(1)}>
              <Icon name="chevronRight" size={14} />
            </button>
            <button type="button" className={styles.iconBtn} aria-label={t('common.dialog.close')} title={t('common.dialog.close') + ' (Esc)'} onClick={closeFind}>
              <Icon name="close" size={14} />
            </button>
          </div>}

          {selected && scrolledIds.has(selected.id) && <button
            type="button"
            className={styles.jumpBottom}
            onClick={() => { const handle = handles.current.get(selected.id); handle?.scrollToBottom(); handle?.focus(); }}
          >
            <Icon name="arrowDown" size={13} />
            <span>{t('sessions.jumpToBottom')}</span>
          </button>}

          {copiedState === 'selection' && <div className={styles.toastPill} role="status">
            <Icon name="check" size={13} /><span>{t('sessions.selectionCopied')}</span>
          </div>}

          {dropActive && selected && <div className={styles.dropOverlay} aria-hidden="true">
            <div className={styles.dropCard}>
              <Icon name="upload" size={22} />
              <strong>{t('sessions.dropHint')}</strong>
              <span>{t('sessions.dropHintDetail', { tool: toolName(selected) })}</span>
            </div>
          </div>}
        </div>

        {selected && selected.running && composerOpen && <div className={styles.composerDrawer} aria-label={t('sessions.composerTitle')}>
          <div className={styles.composerTop}>
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
            <span className={styles.composerHint}>{t('sessions.composerHint')}</span>
          </div>
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
            <button type="button" className={`button primary ${styles.sendBtn}`} onClick={() => void submitComposer()}>
              <Icon name="arrowRight" size={14} />
              <span>{t('sessions.sendInput')}</span>
            </button>
          </div>
        </div>}

        {selected && <div className={styles.statusBar} onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
          <span className={styles.statusHints}>
            <span><kbd>Shift+Enter</kbd>{t('sessions.hintNewline')}</span>
            <span><kbd>{modLabel}+V</kbd>{t('sessions.hintPaste')}</span>
            <span data-optional><kbd>{modLabel}+C</kbd>{t('sessions.hintCopy')}</span>
            <span data-optional><kbd>{modLabel}+Shift+F</kbd>{t('sessions.hintFind')}</span>
          </span>
          <span className={styles.statusSpacer} />
          {selectedSize && <span className={styles.statusMeta} title={t('sessions.terminalSizeTitle')}>{selectedSize.cols}×{selectedSize.rows}</span>}
          <div className={styles.fontStepper} role="group" aria-label={t('sessions.fontSize')}>
            <button type="button" disabled={fontSize <= MIN_FONT_SIZE} aria-label={t('sessions.fontSizeDown')} title={`${t('sessions.fontSizeDown')} (${modLabel}+-)`} onClick={() => updateFontSize(fontSize - 1)}>
              <span aria-hidden="true">A−</span>
            </button>
            <button type="button" className={styles.fontValue} title={t('sessions.fontSizeReset', { size: DEFAULT_FONT_SIZE }) + ` (${modLabel}+0)`} aria-label={t('sessions.fontSizeReset', { size: DEFAULT_FONT_SIZE })} onClick={() => updateFontSize(DEFAULT_FONT_SIZE)}>
              {fontSize}
            </button>
            <button type="button" disabled={fontSize >= MAX_FONT_SIZE} aria-label={t('sessions.fontSizeUp')} title={`${t('sessions.fontSizeUp')} (${modLabel}+=)`} onClick={() => updateFontSize(fontSize + 1)}>
              <span aria-hidden="true">A+</span>
            </button>
          </div>
          <button type="button" className={styles.statusBtn} title={t('sessions.termThemeTitle', { mode: themeLabel })} aria-label={t('sessions.termThemeTitle', { mode: themeLabel })} onClick={cycleTerminalTheme}>
            <Icon name={themeGlyph} size={13} />
            <span>{themeLabel}</span>
          </button>
        </div>}

        {loading && !sessions.length && <p className={styles.loading}>{t('sessions.loading')}</p>}

        {showEmpty && !listError && <div className={styles.empty}>
          <div className={styles.emptyHero}>
            <span className={styles.emptyGlyph} aria-hidden="true">
              <span className={styles.emptyGlyphDots}><i /><i /><i /></span>
              <Icon name="terminal" size={26} />
            </span>
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
            <div className={styles.toolGrid}>
              {terminalTools.slice(0, QUICK_TOOL_LIMIT).map((tool) => <button
                key={tool.id}
                type="button"
                className={styles.toolChip}
                title={t('sessions.quickToolTitle', { name: tool.name })}
                onClick={() => openNewSessionDialog({ toolId: tool.id })}
              >
                <ToolIcon toolId={tool.id} size={20} />
                <span className={styles.toolChipName}>{tool.name}</span>
                <Icon name="play" size={11} />
              </button>)}
              {terminalTools.length > QUICK_TOOL_LIMIT && <button
                type="button"
                className={styles.toolChip}
                data-more
                onClick={() => openNewSessionDialog()}
              >
                <span className={styles.toolChipName}>{t('sessions.moreTools', { count: terminalTools.length - QUICK_TOOL_LIMIT })}</span>
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

    {menu && (() => {
      const session = sessions.find((item) => item.id === menu.sessionId);
      if (!session) return null;
      const name = toolName(session);
      const handle = handles.current.get(session.id);
      return createPortal(<div
        ref={menuRef}
        className={`${rowMenuStyles.rowMenuList} ${styles.contextMenu}`}
        role="menu"
        aria-label={menu.kind === 'session' ? t('sessions.sessionMenu', { name }) : t('sessions.terminalMenu')}
        style={menuBox ?? { top: 0, left: -10000 }}
        onKeyDown={menuNavigate}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => setMenu(null)}
      >
        {menu.kind === 'terminal' ? <>
          <button role="menuitem" disabled={!menu.hasSelection} onClick={() => { handle?.copySelection(); handle?.focus(); }}>
            <Icon name="copy" size={14} /><span>{t('sessions.copySelection')}</span><kbd>{modLabel}+C</kbd>
          </button>
          <button role="menuitem" disabled={!session.running} onClick={() => void pasteIntoSession(session)}>
            <Icon name="clipboard" size={14} /><span>{t('sessions.pasteClipboard')}</span><kbd>{modLabel}+V</kbd>
          </button>
          <button role="menuitem" onClick={() => handle?.selectAll()}>
            <Icon name="check" size={14} /><span>{t('sessions.selectAll')}</span>
          </button>
          <span className={styles.menuDivider} role="separator" />
          <button role="menuitem" onClick={openFind}>
            <Icon name="search" size={14} /><span>{t('sessions.findOutput')}</span><kbd>{modLabel}+Shift+F</kbd>
          </button>
          <button role="menuitem" onClick={() => void copyTerminalOutput(session)}>
            <Icon name="clipboard" size={14} /><span>{t('sessions.copyOutput')}</span>
          </button>
          <button role="menuitem" onClick={() => { handle?.clear(); handle?.focus(); }}>
            <Icon name="trash" size={14} /><span>{t('sessions.clearScreen')}</span>
          </button>
        </> : <>
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
        </>}
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
