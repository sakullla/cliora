import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import type { WorkbenchTerminalSize } from '../../types/launch';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { native, nativeAvailable } from '../../lib/native';
import { writeClipboard } from '../../lib/clipboard';
import { contrastFloor, terminalTheme, type TerminalTheme } from './terminalTheme';
import { registerTerminalLinks, type TerminalLinks } from './terminalLinks';
import { TerminalScrollbar } from './TerminalScrollbar';
import styles from './SessionWorkbench.module.css';

export type TerminalMatch = { row: number; col: number; length: number };

/** One output event. `offset` is the stream position of its first byte when the host reports it. */
export type OutputChunk = { data: string; offset?: number };

/** Replay from the host: the current contract carries the stream end, older mocks send bare base64. */
export type ReplayPayload = string | { dataBase64: string; endOffset: number; cols?: number; rows?: number };

/**
 * Keep only the bytes of `bytes` (starting at stream `offset`) that lie past `end`.
 * Returns the new stream end alongside. Without offsets nothing can be proven duplicate.
 */
export function bytesPastEnd(bytes: Uint8Array, offset: number | undefined, end: number | null): { bytes: Uint8Array; end: number | null } {
  if (offset === undefined || !Number.isFinite(offset)) return { bytes, end };
  const chunkEnd = offset + bytes.length;
  if (end === null) return { bytes, end: chunkEnd };
  if (chunkEnd <= end) return { bytes: new Uint8Array(), end };
  const kept = offset >= end ? bytes : bytes.subarray(end - offset);
  return { bytes: kept, end: chunkEnd };
}

export type TerminalHandle = {
  size: () => WorkbenchTerminalSize;
  focus: () => void;
  clear: () => void;
  scrollToBottom: () => void;
  selectAll: () => void;
  hasSelection: () => boolean;
  copySelection: () => boolean;
  paste: (text: string) => void;
  readOutput: () => string;
  findMatches: (query: string, caseSensitive?: boolean) => TerminalMatch[];
  revealMatch: (match: TerminalMatch | null) => void;
};

export function encodeBase64(bytes: Uint8Array): string {
  if (!bytes.length) return '';
  // One character at a time copies the whole string on each step. Chunks stay
  // under the argument limit and keep a large paste on the UI thread.
  const chunk = 0x4000;
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, Math.min(index + chunk, bytes.length));
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return btoa(parts.join(''));
}

/** PTY input. Mouse reports are raw bytes; text and SGR reports are UTF-8. */
export function ptyBytes(data: string, binary: boolean): Uint8Array {
  if (!binary) return new TextEncoder().encode(data);
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
  return bytes;
}

const OSC52_LIMIT = 1024 * 1024;

/**
 * Clipboard write from OSC 52 (`c;<base64>`). Queries and empty payloads are ignored
 * so a CLI cannot read the clipboard back.
 */
export function textFromOsc52(payload: string): string | null {
  const split = payload.indexOf(';');
  if (split < 0) return null;
  const kind = payload.slice(0, split);
  const encoded = payload.slice(split + 1).replace(/\s/g, '');
  if (!encoded || encoded === '?' || encoded.length > OSC52_LIMIT) return null;
  if (kind && !/^[cps0-7]+$/.test(kind)) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const text = new TextDecoder().decode(bytes);
    return text || null;
  } catch {
    return null;
  }
}

/** Parse shell integration's OSC 7 or OSC 1337 current-directory value. */
export function terminalWorkingDirectory(payload: string): string | null {
  const value = payload.trim().replace(/^CurrentDir=/i, '').trim();
  if (!value) return null;
  const windows = /Windows/i.test(navigator.userAgent || navigator.platform);
  try {
    if (/^file:/i.test(value)) {
      // URL preserves UNC hosts and percent-decoded path separators.
      const uri = new URL(value);
      if (uri.protocol.toLowerCase() !== 'file:') return null;
      if (uri.username || uri.password || uri.port || uri.search || uri.hash) return null;
      let path = decodeURIComponent(uri.pathname);
      if (uri.hostname && uri.hostname.toLowerCase() !== 'localhost' && !/^[a-z]:$/i.test(uri.hostname)) path = `//${uri.hostname}${path}`;
      else if (/^[a-z]:$/i.test(uri.hostname)) path = `${uri.hostname}${path}`;
      if (windows && /^\/[a-z]:/i.test(path)) path = path.slice(1);
      return windows ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/');
    }
    if (windows && /^[a-z]:[\\/]/i.test(value)) return value.replace(/\//g, '\\');
    if (!windows && value.startsWith('/')) return value;
  } catch { /* Malformed shell metadata is ignored. */ }
  return null;
}

/** Leave composition and IME-process keys to xterm. Shortcuts must not swallow them. */
export function terminalYieldsToIme(event: { isComposing?: boolean; keyCode?: number; key?: string }): boolean {
  return !!event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Unidentified';
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

export type ShortcutAction = 'find' | 'composer' | 'split' | 'rail' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'newSession' | 'prevSession' | 'nextSession';

/** Keys the workbench owns before xterm sees them. Null lets xterm encode the key. */
export function terminalKeyAction(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, options: { hasSelection: boolean; canSwitch: boolean; mac: boolean }):
  | { kind: 'send'; data: string }
  | { kind: 'paste' }
  | { kind: 'copy' }
  | { kind: 'shortcut'; action: ShortcutAction }
  | null {
  const { key, ctrlKey, shiftKey, altKey, metaKey } = event;
  const mod = options.mac ? metaKey : ctrlKey;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  // Shift+Enter sends a line feed; ConPTY passes Ctrl+J through intact.
  if (key === 'Enter' && shiftKey && !ctrlKey && !altKey && !metaKey) return { kind: 'send', data: '\n' };
  if ((mod && !altKey && lower === 'v') || (shiftKey && !ctrlKey && !altKey && key === 'Insert')) return { kind: 'paste' };
  if (mod && !altKey && lower === 'c' && (shiftKey || options.mac || options.hasSelection)) return { kind: 'copy' };
  if (ctrlKey && !shiftKey && !altKey && key === 'Insert') return { kind: 'copy' };
  if (mod && shiftKey && !altKey && lower === 'f') return { kind: 'shortcut', action: 'find' };
  if (mod && shiftKey && !altKey && lower === 'm') return { kind: 'shortcut', action: 'composer' };
  // Ctrl+Shift+D would otherwise reach the CLI as Ctrl+D (EOF); the workbench owns it for split view.
  if (mod && shiftKey && !altKey && lower === 'd') return { kind: 'shortcut', action: 'split' };
  if (mod && shiftKey && !altKey && lower === 'b') return { kind: 'shortcut', action: 'rail' };
  if (ctrlKey && !altKey && !metaKey && key === 'Tab') {
    if (!options.canSwitch) return null;
    return { kind: 'shortcut', action: shiftKey ? 'prevSession' : 'nextSession' };
  }
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

/** A replay of a session younger than this still answers its device queries: the CLI may be waiting. */
const FRESH_SESSION_MS = 10_000;

/**
 * Swallow the device queries inside replayed history while `replaying` is set. xterm answers
 * DA, DSR, DECRQM, XTVERSION, DECRQSS and OSC colour queries through onData, which the
 * workbench forwards to the PTY; for history those answers arrive as typed text.
 */
export function guardReplayReplies(term: Terminal): { replaying: boolean; dispose: () => void } {
  const state = { replaying: false, dispose: () => {} };
  const swallow = () => state.replaying;
  const query = (data: string) => state.replaying && data.split(';').some((part) => part.trim() === '?');
  const reportOps = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);
  const parser = term.parser;
  const handlers = [
    parser.registerCsiHandler({ final: 'c' }, swallow),
    parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow),
    parser.registerCsiHandler({ prefix: '=', final: 'c' }, swallow),
    parser.registerCsiHandler({ final: 'n' }, swallow),
    parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow),
    parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow),
    parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow),
    parser.registerCsiHandler({ prefix: '>', final: 'q' }, swallow),
    parser.registerCsiHandler({ prefix: '?', final: 'u' }, swallow),
    parser.registerCsiHandler({ final: 't' }, (params) => state.replaying && reportOps.has(Number(params[0]))),
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow),
    parser.registerOscHandler(4, query),
    parser.registerOscHandler(10, query),
    parser.registerOscHandler(11, query),
    parser.registerOscHandler(12, query),
  ];
  state.dispose = () => handlers.forEach((handler) => handler.dispose());
  return state;
}

type XtermCore = {
  _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } };
  _syncTextArea?: () => void;
  _compositionHelper?: { updateCompositionElements?: (dontRecurse?: boolean) => void };
  coreService?: { isCursorHidden?: boolean };
};

export type ImeAnchor = {
  /** Re-place now, re-reading where input lands (also scans for a TUI-drawn cursor). */
  refresh: () => void;
  /** Re-place on the next frame; cheap enough for every render or scroll. */
  schedule: () => void;
  /** Re-place for the current composition text without moving its anchor. */
  place: () => void;
  compositionStart: () => void;
  compositionEnd: () => void;
  dispose: () => void;
};

const clampInt = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(value)));

/**
 * Owns xterm's helper textarea and composition view placement. Both sit inside `.xterm-screen`,
 * so cell coordinates map directly to CSS pixels.
 */
export function createImeAnchor(term: Terminal, available: () => boolean): ImeAnchor {
  const core = (term as unknown as { _core?: XtermCore })._core;
  let composing = false;
  let anchor: { col: number; row: number } | null = null;
  let applied = '';
  let frame = 0;
  let disposed = false;

  const cellSize = () => {
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (cell?.width && cell.height && cell.width > 0 && cell.height > 0) return { width: cell.width, height: cell.height };
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !term.cols || !term.rows || screen.clientWidth < 8) return null;
    return { width: screen.clientWidth / term.cols, height: screen.clientHeight / term.rows };
  };

  // Agents built on Ink hide the real cursor and draw their own as one inverse cell. When the
  // real cursor is hidden and exactly one such cell is on screen, input lands there.
  const drawnCursor = (): { col: number; row: number } | null => {
    const buffer = term.buffer.active;
    const cell = buffer.getNullCell();
    let found: { col: number; row: number } | null = null;
    for (let row = term.rows - 1; row >= 0; row -= 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;
      for (let col = 0; col < term.cols; col += 1) {
        if (!line.getCell(col, cell)?.isInverse()) continue;
        const next = line.getCell(col + 1, cell);
        if (found || (next && next.isInverse() && col + 1 < term.cols)) return null;
        found = { col, row };
      }
    }
    return found;
  };

  const inputCell = (scan: boolean) => {
    const buffer = term.buffer.active;
    if (scan && core?.coreService?.isCursorHidden) {
      const drawn = drawnCursor();
      if (drawn) return drawn;
    }
    return {
      col: clampInt(buffer.cursorX, 0, Math.max(0, term.cols - 1)),
      row: clampInt(buffer.baseY + buffer.cursorY - buffer.viewportY, 0, Math.max(0, term.rows - 1)),
    };
  };

  const apply = (scan: boolean) => {
    if (disposed || !available()) return;
    const textarea = term.textarea;
    const cell = cellSize();
    if (!textarea || !cell) return;
    if (composing && !anchor) anchor = inputCell(true);
    const at = composing && anchor ? anchor : inputCell(scan);
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    const screenWidth = screen?.clientWidth || term.cols * cell.width;
    let left = at.col * cell.width;
    const top = at.row * cell.height;
    let width = cell.width;
    if (composing) {
      const view = term.element?.querySelector<HTMLElement>('.composition-view');
      if (view) {
        view.style.height = `${cell.height}px`;
        view.style.lineHeight = `${cell.height}px`;
        view.style.fontFamily = String(term.options.fontFamily ?? '');
        view.style.fontSize = `${term.options.fontSize ?? 14}px`;
        // Long composition text near the right edge would run past the clip and vanish.
        const viewWidth = view.offsetWidth;
        left = Math.max(0, Math.min(left, screenWidth - viewWidth));
        view.style.left = `${left}px`;
        view.style.top = `${top}px`;
        width = Math.max(1, viewWidth);
      }
    }
    const key = `${Math.round(left)}:${Math.round(top)}:${Math.round(width)}:${Math.round(cell.height)}`;
    // Rewriting the textarea on every frame restarts the Windows IME and drops the key
    // that would commit or insert punctuation, so only real moves are written.
    if (key === applied) return;
    applied = key;
    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    textarea.style.width = `${width}px`;
    textarea.style.height = `${cell.height}px`;
    textarea.style.lineHeight = `${cell.height}px`;
    textarea.style.fontSize = `${term.options.fontSize ?? 14}px`;
    textarea.style.zIndex = '-5';
  };

  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; apply(true); });
  };

  // xterm calls these on cursor moves and on every render; route both through one placement.
  if (core && typeof core._syncTextArea === 'function') core._syncTextArea = () => { if (!composing) schedule(); };
  const helper = core?._compositionHelper;
  if (helper && typeof helper.updateCompositionElements === 'function') helper.updateCompositionElements = () => { if (composing) apply(false); };

  return {
    refresh: () => { if (!composing) applied = ''; apply(true); },
    schedule,
    place: () => apply(false),
    compositionStart: () => {
      // Typing reads the prompt, not the history: bring the input row back into view first.
      const buffer = term.buffer.active;
      if (buffer.viewportY < buffer.baseY) term.scrollToBottom();
      composing = true;
      anchor = null;
      applied = '';
      apply(true);
    },
    compositionEnd: () => {
      composing = false;
      anchor = null;
      schedule();
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
    },
  };
}

// Keep the browser-side terminal buffer bounded. The native replay remains the
// source of truth when an ended session is mounted again.
const TERMINAL_SCROLLBACK = 6000;

export type TerminalBridge = {
  writeError: (error: unknown) => void;
  linkError: (error: unknown) => void;
  bell: (sessionId: string) => void;
  title: (sessionId: string, title: string) => void;
  outputActive: (sessionId: string, active: boolean) => void;
  outputWritten: (sessionId: string) => void;
  shortcut: (action: ShortcutAction) => void;
  canSwitch: () => boolean;
  scrolled: (sessionId: string, awayFromBottom: boolean) => void;
  copied: () => void;
  grid: (sessionId: string, cols: number, rows: number) => void;
  directory: (sessionId: string, directory: string) => void;
};

/**
 * `active` means the terminal is on screen (one pane, or either pane of a split).
 * `focused` marks the one pane that owns keyboard input.
 */
export function SessionTerminal({ sessionId, label, active, focused = active, running, remote = false, startedAt, fontSize, lineHeight = 1.35, theme, cursorBlink, pane, header, overlay, footer, writers, pending, handles, bridge }: {
  sessionId: string;
  /** Start time (ms). A replay of a session this young still answers its device queries. */
  startedAt?: number;
  label: string;
  active: boolean;
  focused?: boolean;
  running: boolean;
  /** A remote PTY pays a round trip for every resize, so layout storms are collapsed. */
  remote?: boolean;
  fontSize: number;
  lineHeight?: number;
  theme: TerminalTheme;
  cursorBlink: boolean;
  pane?: number;
  header?: ReactNode;
  overlay?: ReactNode;
  footer?: ReactNode;
  writers: MutableRefObject<Map<string, (chunk: OutputChunk) => void>>;
  pending: MutableRefObject<Map<string, OutputChunk[]>>;
  handles: MutableRefObject<Map<string, TerminalHandle>>;
  bridge: MutableRefObject<TerminalBridge>;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const linksRef = useRef<TerminalLinks | null>(null);
  const linkHintRef = useRef('');
  linkHintRef.current = t('sessions.openLinkHint', { modifier: MAC ? '⌘' : 'Ctrl' });
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fitNowRef = useRef<(() => void) | null>(null);
  // The last grid sent to the PTY. A one-row proposal with no real height change is glyph
  // measurement noise; applying it makes a live TUI redraw and the view jumps.
  const fitLockRef = useRef({ cols: 0, rows: 0, height: 0 });
  // The grid the PTY last received. Switching back to a session must not re-send an
  // unchanged grid: the CLI treats every resize as a reason to redraw.
  const ptyGridRef = useRef({ cols: 0, rows: 0 });
  const webglRef = useRef<WebglAddon | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const userScrollRef = useRef(false);
  const [, setScrollVersion] = useState(0);
  const imeRef = useRef<ImeAnchor | null>(null);
  const startedAtRef = useRef(startedAt);
  startedAtRef.current = startedAt;
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  const runningRef = useRef(running);
  const remoteRef = useRef(remote);
  const fontSizeRef = useRef(fontSize);
  const lineHeightRef = useRef(lineHeight);
  const themeRef = useRef(theme);
  activeRef.current = active;
  focusedRef.current = focused;
  runningRef.current = running;
  remoteRef.current = remote;
  fontSizeRef.current = fontSize;
  lineHeightRef.current = lineHeight;
  themeRef.current = theme;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: fontSizeRef.current,
      lineHeight: lineHeightRef.current,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      disableStdin: !runningRef.current,
      scrollback: TERMINAL_SCROLLBACK,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      macOptionIsMeta: true,
      allowProposedApi: true,
      // Screen reader mode drops insertText. A Chinese IME can then commit letters
      // but never digits, punctuation, space, or Enter. Automation still reads the
      // accessibility tree, so keep the mode only there.
      screenReaderMode: navigator.webdriver === true,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: contrastFloor(themeRef.current),
      theme: terminalTheme(themeRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    if (term.textarea) term.textarea.disabled = !activeRef.current || !runningRef.current;
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;

    // The IME candidate window follows xterm's hidden textarea. xterm only moves it
    // when the cursor moves, so a terminal that was hidden, replayed, or scrolled
    // keeps a stale spot (or its initial -9999em), and a TUI redraw that parks the
    // cursor elsewhere drags the candidate window along mid-composition. One owner
    // places the textarea: it follows the input cell, stays inside the screen, and
    // holds still for the whole composition.
    const ime = createImeAnchor(term, () => !disposed && activeRef.current);
    const textarea = term.textarea;
    const onCompositionStart = () => ime.compositionStart();
    const onCompositionUpdate = () => ime.place();
    const onCompositionEnd = () => ime.compositionEnd();
    const onTextareaFocus = () => ime.refresh();
    textarea?.addEventListener('compositionstart', onCompositionStart);
    textarea?.addEventListener('compositionupdate', onCompositionUpdate);
    textarea?.addEventListener('compositionend', onCompositionEnd);
    textarea?.addEventListener('focus', onTextareaFocus);
    imeRef.current = ime;
    const cursorSub = term.onCursorMove(() => ime.schedule());
    let acceptLive = false;
    let replayReady = false;
    let liveStreaming = false;
    let liveTimer = 0;
    // Stream offset past the newest byte already written. Live events and the replay
    // overlap around mount; offsets let each byte reach xterm exactly once.
    let streamEnd: number | null = null;
    const queued: OutputChunk[] = [];
    const links = registerTerminalLinks(term, {
      mac: MAC,
      hint: () => linkHintRef.current,
      open: async (url) => {
        if (nativeAvailable) await native.openExternalUrl(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
      },
      openPath: nativeAvailable ? (path) => native.openWorkbenchPath(sessionId, path) : undefined,
      onError: (error) => bridge.current.linkError(error),
    });
    linksRef.current = links;
    void resolveWindowsPty().then((info) => { if (!disposed && info) term.options.windowsPty = info; });

    // Batch output bursts into one write per frame; hidden sessions continue on a microtask.
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
        // A hidden session still has to parse output, but a burst can share one
        // write instead of a microtask per chunk.
        flushTimer = window.setTimeout(flushWrites, 16);
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
    const writeChunk = (chunk: OutputChunk, isLive = false) => {
      if (!chunk.data || disposed) return;
      try {
        const fresh = bytesPastEnd(decodeBase64(chunk.data), chunk.offset, streamEnd);
        streamEnd = fresh.end;
        if (isLive && fresh.bytes.length > 0) markLiveOutput();
        scheduleWriteBytes(fresh.bytes);
      } catch { /* Malformed bytes stay out of the terminal. */ }
    };
    const publish = (chunk: OutputChunk) => {
      if (acceptLive) writeChunk(chunk, true);
      else queued.push(chunk);
    };
    writers.current.set(sessionId, publish);

    const pendingInput: Uint8Array[] = [];
    let inputScheduled = false;
    const flushInput = () => {
      inputScheduled = false;
      if (disposed || !pendingInput.length) return;
      const merged = pendingInput.length === 1 ? pendingInput[0] : concatBytes(pendingInput);
      pendingInput.length = 0;
      void native.writeWorkbenchSession(sessionId, encodeBase64(merged)).catch((error) => bridge.current.writeError(error));
    };
    const sendToPty = (data: string, binary = false) => {
      // xterm also emits device/cursor replies here. Hidden live terminals must
      // answer them; the textarea and key/paste handlers gate user input.
      // A microtask merges a paste or a burst of reports into one PTY write
      // without holding a single key or a cursor reply for a frame.
      if (!runningRef.current || !data) return;
      if (!binary && (data.includes('\r') || data.includes('\n'))) markLiveOutput();
      pendingInput.push(ptyBytes(data, binary));
      if (inputScheduled) return;
      inputScheduled = true;
      queueMicrotask(flushInput);
    };

    const copySelection = () => {
      const selected = term.getSelection();
      if (!selected) return false;
      void writeClipboard(selected).then((ok) => { if (ok) bridge.current.copied(); });
      term.clearSelection();
      return true;
    };

    term.attachCustomKeyEventHandler((event) => {
      if (!activeRef.current) return false;
      if (terminalYieldsToIme(event)) return true;
      const action = terminalKeyAction(event, { hasSelection: term.hasSelection(), canSwitch: bridge.current.canSwitch(), mac: MAC });
      if (!action) return true;
      if (event.type !== 'keydown') return false;
      if (action.kind === 'paste') return false;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === 'send') sendToPty(action.data);
      else if (action.kind === 'copy') copySelection();
      else bridge.current.shortcut(action.action);
      return false;
    });

    // Shift+wheel reads normal-buffer scrollback. Scroll by whole rows. Writing
    // scrollTop up to scrollHeight lands in the unused host pixels, and the next
    // redraw rounds onto another row and paints the previous frame on top.
    const wheelScrollViewport = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
      if (!viewport) return;
      userScrollRef.current = true;
      const rowHeight = viewport.clientHeight / Math.max(1, term.rows);
      let amount = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) amount *= rowHeight;
      else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) amount *= viewport.clientHeight;
      if (event.altKey) amount *= 5;
      const lines = amount / Math.max(1, rowHeight);
      const steps = Math.trunc(lines) || (amount > 0 ? 1 : -1);
      term.scrollLines(steps);
      event.preventDefault();
    };

    // An image-only clipboard stays available to the CLI through Ctrl+V.
    const onPaste = (event: ClipboardEvent) => {
      if (!activeRef.current) { event.preventDefault(); event.stopPropagation(); return; }
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

    // Keep the IME helper's caret positioning from scrolling the window or any ancestor.
    const resetAncestorScroll = (event: Event) => {
      if (!activeRef.current || !node.isConnected || node.offsetParent === null) return;
      const target = event.target === document ? document.scrollingElement : event.target;
      if (!(target instanceof Element) || target === node || !target.contains(node)) return;
      if (target.scrollLeft) target.scrollLeft = 0;
      if (target.scrollTop) target.scrollTop = 0;
      ime.schedule();
    };
    document.addEventListener('scroll', resetAncestorScroll, true);

    const bellSub = term.onBell(() => {
      if (!disposed) bridge.current.bell(sessionId);
    });
    const titleSub = term.onTitleChange((title) => {
      if (!disposed) bridge.current.title(sessionId, title);
    });
    const gridSub = term.onResize(({ cols, rows }) => {
      if (!disposed) bridge.current.grid(sessionId, cols, rows);
    });
    let awayFromBottom = false;
    let followFrame = 0;
    let scrollUiFrame = 0;
    const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
    viewportRef.current = viewport ?? null;
    if (viewport) viewport.id = `terminal-viewport-${sessionId}`;
    const isAwayFromBottom = () => {
      const rowHeight = viewport ? viewport.clientHeight / Math.max(1, term.rows) : 1;
      const remaining = viewport ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight : 0;
      const buffer = term.buffer.active;
      return buffer.type === 'normal'
        && remaining > Math.max(2, rowHeight);
    };
    // Grok and other fullscreen TUIs enable mouse-wheel reporting and scroll their own
    // transcript. Taking that wheel moves xterm's viewport instead, so the view opens a
    // blank gap and the CLI never receives the scroll. Shift+wheel still reads the
    // normal-buffer scrollback. An alternate screen without wheel reporting must not
    // turn the wheel into arrow keys.
    term.attachCustomWheelEventHandler((event) => {
      if (event.deltaY === 0) return true;
      const alternate = term.buffer.active.type === 'alternate';
      const mode = term.modes.mouseTrackingMode;
      const appOwnsWheel = mode === 'vt200' || mode === 'drag' || mode === 'any';
      if (!alternate && event.shiftKey) {
        wheelScrollViewport(event);
        return false;
      }
      if (appOwnsWheel) {
        if (!alternate && userScrollRef.current && isAwayFromBottom()) {
          wheelScrollViewport(event);
          return false;
        }
        return true;
      }
      if (!alternate) {
        userScrollRef.current = true;
        return true;
      }
      event.preventDefault();
      return false;
    });
    const reportScroll = () => {
      if (disposed) return;
      ime.schedule();
      if (!scrollUiFrame && activeRef.current) {
        scrollUiFrame = requestAnimationFrame(() => {
          scrollUiFrame = 0;
          if (!disposed) setScrollVersion((version) => version + 1);
        });
      }
      // The DOM viewport also reflects wheel input whose xterm scroll event is suppressed.
      // `viewportY/baseY` is xterm's authoritative scroll position. The DOM
      // viewport can lag one frame behind it (especially with WebGL and a
      // mouse-tracking CLI), so use both signals before deciding to follow
      // incoming output.
      const away = userScrollRef.current && isAwayFromBottom();
      if (away) scheduleRepaint();
      if (away === awayFromBottom) return;
      awayFromBottom = away;
      if (away) node.dataset.scrollAway = 'true';
      else delete node.dataset.scrollAway;
      bridge.current.scrolled(sessionId, away);
    };
    let repaintTimer = 0;
    const scheduleRepaint = () => {
      window.clearTimeout(repaintTimer);
      repaintTimer = window.setTimeout(() => {
        if (!disposed) term.refresh(0, Math.max(0, term.rows - 1));
      }, 40);
    };
    const pinViewport = () => {
      if (!viewport || term.buffer.active.type !== 'normal') return;
      const deviceCell = (term as unknown as { _core?: { _renderService?: { dimensions?: { device?: { cell?: { height?: number } } } } } })._core
        ?._renderService?.dimensions?.device?.cell?.height ?? 0;
      const rowHeight = deviceCell > 0 ? deviceCell / (window.devicePixelRatio || 1) : 0;
      if (rowHeight <= 0) return;
      // Match xterm's own scroll offset. scrollHeight is taller than the buffer by the
      // unused host pixels, and writing that max makes the viewport round to another row,
      // scroll up, then snap back on the next agent redraw.
      const top = term.buffer.active.baseY * rowHeight;
      if (Math.abs(viewport.scrollTop - top) <= 0.5) return;
      viewport.scrollTop = top;
    };
    const scrollToLatest = () => {
      if (disposed) return;
      userScrollRef.current = false;
      term.scrollToBottom();
      pinViewport();
      cancelAnimationFrame(followFrame);
      const applyLatest = () => {
        followFrame = 0;
        if (disposed || userScrollRef.current) return;
        term.scrollToBottom();
        pinViewport();
        reportScroll();
      };
      followFrame = requestAnimationFrame(applyLatest);
      reportScroll();
    };
    // xterm updates scroll-area height in a deferred frame; that actual change
    // is the safe point to follow output, without interrupting history reading.
    const scrollAreaObserver = new ResizeObserver(() => {
      if (disposed || !activeRef.current || awayFromBottom) return;
      scrollToLatest();
    });
    const scrollArea = viewport?.firstElementChild;
    if (scrollArea instanceof Element) scrollAreaObserver.observe(scrollArea);
    viewport?.addEventListener('scroll', reportScroll);
    const scrollSub = term.onScroll(reportScroll);
    const parsedSub = term.onWriteParsed(() => {
      if (activeRef.current && !awayFromBottom) scrollToLatest();
      reportScroll();
      bridge.current.outputWritten(sessionId);
    });

    const handle: TerminalHandle = {
      size: () => ({ cols: term.cols, rows: term.rows }),
      focus: () => { if (!disposed) term.focus(); },
      clear: () => { if (!disposed) term.clear(); },
      scrollToBottom: scrollToLatest,
      selectAll: () => { if (!disposed) term.selectAll(); },
      hasSelection: () => !disposed && term.hasSelection(),
      copySelection: () => !disposed && copySelection(),
      paste: (text: string) => { if (!disposed && activeRef.current && runningRef.current && text) term.paste(text); },
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
      findMatches: (query: string, caseSensitive = false) => {
        const trimmed = query.trim();
        const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
        if (disposed || !needle) return [];
        const buffer = term.buffer.active;
        const found: TerminalMatch[] = [];
        for (let row = 0; row < buffer.length; row += 1) {
          const line = buffer.getLine(row);
          if (!line) continue;
          const raw = line.translateToString(true);
          const text = caseSensitive ? raw : raw.toLowerCase();
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
        } catch { /* The buffer may have changed since this match was found. */ }
      },
    };
    handles.current.set(sessionId, handle);

    const subscription = term.onData((data) => sendToPty(data));
    // xterm emits legacy mouse reports through onBinary. Those bytes are not UTF-8:
    // a column past 95 is 128 or higher, and encoding it as text makes the click
    // and the wheel look like a different sequence, so the CLI ignores both.
    const binarySubscription = term.onBinary((data) => sendToPty(data, true));
    // Claude Code copies with OSC 52. xterm does not apply that sequence itself.
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const text = textFromOsc52(data);
      if (text) void writeClipboard(text).then((ok) => { if (ok && !disposed) bridge.current.copied(); });
      return true;
    });
    let reportedDirectory = '';
    const reportDirectory = (data: string) => {
      const directory = terminalWorkingDirectory(data);
      if (!directory || directory === reportedDirectory) return true;
      reportedDirectory = directory;
      bridge.current.directory(sessionId, directory);
      return true;
    };
    const replies = guardReplayReplies(term);
    const osc7 = term.parser.registerOscHandler(7, reportDirectory);
    const osc1337 = term.parser.registerOscHandler(1337, reportDirectory);
    const layoutAvailable = () => {
      const workbench = node.closest<HTMLElement>('[data-term-theme]');
      return node.clientWidth >= 8 && node.clientHeight >= 8 && (!workbench || workbench.clientHeight >= 8);
    };
    let gridTimer = 0;
    let gridPending: { cols: number; rows: number } | null = null;
    const flushGrid = () => {
      gridTimer = 0;
      const next = gridPending;
      gridPending = null;
      if (!next || disposed || !runningRef.current) return;
      if (ptyGridRef.current.cols === next.cols && ptyGridRef.current.rows === next.rows) return;
      ptyGridRef.current = next;
      void native.resizeWorkbenchSession(sessionId, next.cols, next.rows).catch(() => {});
    };
    const scheduleGrid = (cols: number, rows: number) => {
      if (!runningRef.current) return;
      if (ptyGridRef.current.cols === cols && ptyGridRef.current.rows === rows) {
        gridPending = null;
        window.clearTimeout(gridTimer);
        gridTimer = 0;
        return;
      }
      if (!remoteRef.current) {
        ptyGridRef.current = { cols, rows };
        void native.resizeWorkbenchSession(sessionId, cols, rows).catch(() => {});
        return;
      }
      // The local grid is already the fitted size. The remote CLI only needs the
      // size that survives the layout pass. Repeating that size must not postpone it.
      if (gridPending && gridPending.cols === cols && gridPending.rows === rows) return;
      gridPending = { cols, rows };
      window.clearTimeout(gridTimer);
      gridTimer = window.setTimeout(flushGrid, 100);
    };
    const fitNow = () => {
      if (disposed || !replayReady || !activeRef.current || !layoutAvailable()) return;
      const dims = fit.proposeDimensions();
      if (!dims) return;
      const height = node.clientHeight;
      const locked = fitLockRef.current;
      // Glyph measurement can move the proposed grid by one row while the host
      // height is unchanged. Applying that resize makes CodeBuddy redraw its agent
      // panel, which measures again and the whole view bounces.
      const rowFlicker = locked.rows > 0
        && dims.cols === locked.cols
        && Math.abs(dims.rows - locked.rows) === 1
        && Math.abs(height - locked.height) < 8;
      if (rowFlicker) return;
      const changed = term.cols !== dims.cols || term.rows !== dims.rows;
      if (changed) {
        const core = (term as unknown as { _core?: { _renderService?: { clear?: () => void } } })._core;
        try { core?._renderService?.clear?.(); } catch { /* The renderer can already be gone. */ }
        try { term.resize(dims.cols, dims.rows); } catch { return; }
        fitLockRef.current = { cols: term.cols, rows: term.rows, height };
      } else if (locked.rows === 0) {
        fitLockRef.current = { cols: term.cols, rows: term.rows, height };
      }
      if (term.cols < 2 || term.rows < 1) return;
      if (changed) ime.schedule();
      if (changed && !awayFromBottom) scrollToLatest();
      reportScroll();
      scheduleGrid(term.cols, term.rows);
    };
    fitNowRef.current = fitNow;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitNow);
    });
    observer.observe(node);
    void native.replayWorkbenchSession(sessionId).then(async (payload: ReplayPayload) => {
      // The canvas has a minimum height even while the containing workbench
      // has no allocated space. Wait for that layout before interpreting legacy
      // replay: ConPTY cannot reflow history parsed into that temporary grid.
      while (!disposed && activeRef.current && !layoutAvailable()) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (disposed) return;
      // Interpret cursor-addressed replay at the host's grid, including when
      // this session mounts hidden. Fitting an 80-column replay later cannot
      // undo cursor movements that have already overwritten the wrong rows.
      if (typeof payload === 'object' && payload.cols && payload.rows) {
        term.resize(payload.cols, payload.rows);
        ptyGridRef.current = { cols: payload.cols, rows: payload.rows };
      } else {
        // Legacy bridges have no recorded grid. Measure before replay, as
        // parsing their entire history at the default size then expanding it
        // leaves blank rows with ConPTY's no-reflow behaviour.
        replayReady = true;
        fitNow();
      }
      const encoded = typeof payload === 'string' ? payload : typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : '';
      const replayEnd = typeof payload === 'object' && payload && Number.isFinite(payload.endOffset) ? payload.endOffset : null;
      let snapshot = new Uint8Array(0);
      try { snapshot = Uint8Array.from(decodeBase64(encoded)); }
      catch { snapshot = new Uint8Array(0); }
      const earlier = (pending.current.get(sessionId) ?? []).splice(0);
      pending.current.delete(sessionId);
      const arrived = queued.splice(0);
      const chunks = [...earlier, ...arrived];
      let suffix: Uint8Array;
      if (replayEnd !== null && chunks.every((chunk) => chunk.offset !== undefined)) {
        // The host numbers every byte, so the overlap with the replay is exact.
        streamEnd = replayEnd;
        suffix = concatBytes(chunks.flatMap((chunk) => {
          try {
            const fresh = bytesPastEnd(decodeBase64(chunk.data), chunk.offset, streamEnd);
            streamEnd = fresh.end;
            return [fresh.bytes];
          } catch { return []; }
        }));
      } else {
        const queuedBytes = concatBytes(chunks.flatMap((chunk) => {
          try { return [decodeBase64(chunk.data)]; }
          catch { return []; }
        }));
        suffix = queuedAfterSnapshot(snapshot, queuedBytes);
        streamEnd = null;
      }
      acceptLive = true;
      const finishReplay = () => {
        replies.replaying = false;
        if (disposed) return;
        replayReady = true;
        fitNow();
        scrollToLatest();
        ime.refresh();
        bridge.current.grid(sessionId, term.cols, term.rows);
      };
      try {
        // The snapshot is history. Its device queries were asked long ago, and
        // answering them now types `[?1;2c]10;rgb:…` into the CLI's prompt. A
        // session that only just started may still be waiting, so it is answered.
        const started = startedAtRef.current ?? 0;
        replies.replaying = snapshot.length > 0 && !(started > 0 && Date.now() - started < FRESH_SESSION_MS);
        if (snapshot.length && suffix.length) {
          term.write(snapshot, () => { replies.replaying = false; });
          term.write(suffix, finishReplay);
        } else if (snapshot.length || suffix.length) {
          term.write(snapshot.length ? snapshot : suffix, finishReplay);
        } else finishReplay();
      } catch { finishReplay(); }
    }).catch(() => {
      if (disposed) return;
      acceptLive = true;
      replayReady = true;
      fitNow();
      (pending.current.get(sessionId) ?? []).splice(0).forEach((item) => writeChunk(item));
      queued.splice(0).forEach((item) => writeChunk(item));
      pending.current.delete(sessionId);
    });
    return () => {
      flushInput();
      window.clearTimeout(gridTimer);
      disposed = true;
      ime.dispose();
      if (imeRef.current === ime) imeRef.current = null;
      replies.dispose();
      window.clearTimeout(repaintTimer);
      window.clearTimeout(liveTimer);
      flushWrites();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(scrollUiFrame);
      cancelAnimationFrame(followFrame);
      scrollAreaObserver.disconnect();
      viewport?.removeEventListener('scroll', reportScroll);
      viewportRef.current = null;
      if (writers.current.get(sessionId) === publish) writers.current.delete(sessionId);
      if (handles.current.get(sessionId) === handle) handles.current.delete(sessionId);
      node.removeEventListener('paste', onPaste, true);
      document.removeEventListener('scroll', resetAncestorScroll, true);
      bellSub.dispose();
      titleSub.dispose();
      gridSub.dispose();
      scrollSub.dispose();
      parsedSub.dispose();
      cursorSub.dispose();
      subscription.dispose();
      binarySubscription.dispose();
      osc52.dispose();
      osc7.dispose();
      osc1337.dispose();
      textarea?.removeEventListener('compositionstart', onCompositionStart);
      textarea?.removeEventListener('compositionupdate', onCompositionUpdate);
      textarea?.removeEventListener('compositionend', onCompositionEnd);
      textarea?.removeEventListener('focus', onTextareaFocus);
      observer.disconnect();
      links.dispose();
      linksRef.current = null;
      webglRef.current?.dispose();
      webglRef.current = null;
      // xterm schedules a scroll-area sync while opening; let it finish before disposal.
      window.setTimeout(() => term.dispose(), 0);
      termRef.current = null;
      fitRef.current = null;
      fitNowRef.current = null;
    };
  }, [sessionId, writers, pending, handles, bridge]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme);
    term.options.minimumContrastRatio = contrastFloor(theme);
  }, [theme]);

  useLayoutEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // disableStdin suppresses protocol replies as well as keyboard events.
    // A hidden live CLI must still receive DSR/DA responses from its own buffer.
    term.options.disableStdin = !running;
    if (term.textarea) term.textarea.disabled = !active || !running;
  }, [active, running]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize !== fontSize || term.options.lineHeight !== lineHeight) {
      fitLockRef.current = { cols: 0, rows: 0, height: 0 };
    }
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    // A reattached transport preserves its last native grid. Forget the sent
    // size while disconnected so a view that changed dimensions can refresh it.
    if (!running) ptyGridRef.current = { cols: 0, rows: 0 };
    if (!active) {
      linksRef.current?.dismiss();
      // Only one terminal renders at a time; releasing the GPU context on exit
      // keeps many mounted sessions within the browser's WebGL context budget.
      webglRef.current?.dispose();
      webglRef.current = null;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const fit = fitRef.current;
      const node = host.current;
      if (!fit || !node || node.clientWidth < 8) return;
      // Use the same stable-grid guard as ResizeObserver. Resetting its lock
      // on every reveal reintroduced one-row oscillation and duplicate TUI lines.
      fitNowRef.current?.();
      // Test automation locates glyphs through the DOM rows; keep that renderer
      // under webdriver so coordinates stay measurable. Everyone else gets WebGL.
      if (!webglRef.current && navigator.webdriver !== true) {
        try {
          const addon = new WebglAddon();
          addon.onContextLoss(() => {
            addon.dispose();
            if (webglRef.current === addon) webglRef.current = null;
          });
          term.loadAddon(addon);
          webglRef.current = addon;
        } catch { /* No WebGL here: the DOM renderer stays. */ }
      }
      // A terminal that was hidden kept its IME anchor from before; place it on the input cell now.
      imeRef.current?.refresh();
      // Keyboard navigation in the session rail deliberately keeps focus on
      // the selected tab while React swaps the active terminal. Do not steal
      // it during that render; direct terminal activation still focuses here.
      const railTabFocused = document.activeElement?.matches('[role="tab"][data-session-id]');
      if (running && focusedRef.current && !railTabFocused && !document.querySelector('dialog[open]')) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, running, fontSize, lineHeight, sessionId, bridge]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.cursorBlink = cursorBlink && focused && running;
  }, [cursorBlink, focused, running]);

  // In a split, moving focus between two visible panes does not change `active`.
  const wasFocusedRef = useRef(focused);
  useEffect(() => {
    const gained = focused && !wasFocusedRef.current;
    wasFocusedRef.current = focused;
    if (!gained || !active || !running) return;
    const frame = requestAnimationFrame(() => {
      const railTabFocused = document.activeElement?.matches('[role="tab"][data-session-id]');
      if (!railTabFocused && !document.querySelector('dialog[open]')) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focused, active, running]);

  const placement: CSSProperties | undefined = pane != null && pane >= 0 ? { gridColumn: pane + 1, gridRow: 1 } : undefined;
  return <div className={styles.terminalInstance} hidden={!active} style={placement} data-pane-session={sessionId} data-focused={(active && focused) || undefined} data-running={running || undefined}>
    {header}
    <div className={styles.terminalBody}>
      <div ref={host} className={styles.terminalHost} aria-label={label} data-blink={cursorBlink || undefined} />
      <TerminalScrollbar terminal={termRef.current} viewport={viewportRef.current} onUserScroll={() => { userScrollRef.current = true; }} />
      {overlay}
    </div>
    {footer}
  </div>;
}

const TITLE_LIMIT = 80;

/** Keep the CLI's own title text, including its leading spinner frame. Only C0 controls
    are dropped so the title stays on one line. */
export function cleanTerminalTitle(raw: string): string {
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  // A title made only of spinner frames is activity, not a name; keep the tool-name fallback.
  if (!text.replace(/[\u2800-\u28ff\s]/g, '')) return '';
  return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT - 1).trimEnd() + '\u2026' : text;
}

function monoFont(): string {
  const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  // xterm's DOM renderer uses this stack for every cell.  Explicit emoji
  // fallbacks keep colour/combined emoji readable on Windows WebView2 while
  // retaining the monospace metrics for ordinary CLI text.
  return stack
    ? `${stack}, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"`
    : 'Consolas, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", monospace';
}
