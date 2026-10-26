import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
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

export type TerminalHandle = {
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
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
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

export type ShortcutAction = 'find' | 'composer' | 'split' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'newSession' | 'prevSession' | 'nextSession';

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
};

/**
 * `active` means the terminal is on screen (one pane, or either pane of a split).
 * `focused` marks the one pane that owns keyboard input.
 */
export function SessionTerminal({ sessionId, label, active, focused = active, running, fontSize, lineHeight = 1.35, theme, cursorBlink, pane, header, overlay, footer, writers, pending, handles, bridge }: {
  sessionId: string;
  label: string;
  active: boolean;
  focused?: boolean;
  running: boolean;
  fontSize: number;
  lineHeight?: number;
  theme: TerminalTheme;
  cursorBlink: boolean;
  pane?: number;
  header?: ReactNode;
  overlay?: ReactNode;
  footer?: ReactNode;
  writers: MutableRefObject<Map<string, (data: string) => void>>;
  pending: MutableRefObject<Map<string, string[]>>;
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
  // The last grid sent to the PTY. A one-row proposal with no real height change is glyph
  // measurement noise; applying it makes a live TUI redraw and the view jumps.
  const fitLockRef = useRef({ cols: 0, rows: 0, height: 0 });
  const webglRef = useRef<WebglAddon | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const userScrollRef = useRef(false);
  const [, setScrollVersion] = useState(0);
  const activeRef = useRef(active);
  const focusedRef = useRef(focused);
  const runningRef = useRef(running);
  const fontSizeRef = useRef(fontSize);
  const lineHeightRef = useRef(lineHeight);
  const themeRef = useRef(theme);
  const wasActiveRef = useRef(active);
  activeRef.current = active;
  focusedRef.current = focused;
  runningRef.current = running;
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
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let imeComposing = false;
    let imeFrame = 0;
    let imeAnchor = '';

    // WebView2 can keep the native IME candidate window at the last textarea
    // position when the terminal is inside a clipped, scrollable workbench.
    // xterm updates this anchor during composition, but a layout/scroll between
    // composition events can leave it stale. Re-anchor the helper to the
    // rendered cursor after xterm has laid out the current frame.
    const syncImeAnchor = () => {
      if (disposed || !imeComposing || !activeRef.current) return;
      cancelAnimationFrame(imeFrame);
      imeFrame = requestAnimationFrame(() => {
        if (disposed || !imeComposing || !activeRef.current) return;
        const textarea = term.textarea;
        const element = term.element;
        const rows = element?.querySelector<HTMLElement>('.xterm-rows');
        const firstRow = rows?.firstElementChild as HTMLElement | null;
        if (!textarea || !element || !firstRow || !term.cols || !term.rows) return;
        const elementBox = element.getBoundingClientRect();
        const rowBox = firstRow.getBoundingClientRect();
        const cellWidth = rowBox.width / term.cols;
        const cellHeight = rowBox.height;
        if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return;
        const cursor = term.buffer.active;
        const left = Math.max(0, rowBox.left - elementBox.left + Math.min(cursor.cursorX, term.cols - 1) * cellWidth);
        const top = Math.max(0, rowBox.top - elementBox.top + Math.min(cursor.cursorY, term.rows - 1) * cellHeight);
        const next = `${Math.round(left)}:${Math.round(top)}:${Math.round(cellWidth)}:${Math.round(cellHeight)}`;
        // Rewriting the textarea on every frame restarts the Windows IME and drops
        // the key that would commit or insert punctuation.
        if (next === imeAnchor) return;
        imeAnchor = next;
        textarea.style.left = `${left}px`;
        textarea.style.top = `${top}px`;
        textarea.style.width = `${Math.max(1, cellWidth)}px`;
        textarea.style.height = `${Math.max(1, cellHeight)}px`;
        textarea.style.lineHeight = `${Math.max(1, cellHeight)}px`;
      });
    };
    const textarea = term.textarea;
    const onCompositionStart = () => { imeComposing = true; syncImeAnchor(); };
    const onCompositionUpdate = () => syncImeAnchor();
    const onCompositionEnd = () => {
      imeComposing = false;
      imeAnchor = '';
      cancelAnimationFrame(imeFrame);
    };
    textarea?.addEventListener('compositionstart', onCompositionStart);
    textarea?.addEventListener('compositionupdate', onCompositionUpdate);
    textarea?.addEventListener('compositionend', onCompositionEnd);
    const cursorSub = term.onCursorMove(syncImeAnchor);
    let acceptLive = false;
    let liveStreaming = false;
    let liveTimer = 0;
    const queued: string[] = [];
    const links = registerTerminalLinks(term, {
      mac: MAC,
      hint: () => linkHintRef.current,
      open: async (url) => {
        if (nativeAvailable) await native.openExternalUrl(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
      },
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

    const sendToPty = (data: string, binary = false) => {
      if (!activeRef.current || !runningRef.current || !data) return;
      if (!binary && (data.includes('\r') || data.includes('\n'))) markLiveOutput();
      void native.writeWorkbenchSession(sessionId, encodeBase64(ptyBytes(data, binary))).catch((error) => bridge.current.writeError(error));
    };

    const copySelection = () => {
      const selected = term.getSelection();
      if (!selected) return false;
      void writeClipboard(selected).then((ok) => { if (ok) bridge.current.copied(); });
      term.clearSelection();
      return true;
    };

    term.attachCustomKeyEventHandler((event) => {
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
      syncImeAnchor();
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
      focus: () => { if (!disposed) term.focus(); },
      clear: () => { if (!disposed) term.clear(); },
      scrollToBottom: scrollToLatest,
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
    const fitNow = () => {
      if (disposed || !activeRef.current || node.clientWidth < 8 || node.clientHeight < 8) return;
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
      if (changed && !awayFromBottom) scrollToLatest();
      reportScroll();
      if (!changed || !runningRef.current) return;
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
      requestAnimationFrame(() => {
        fitNow();
        scrollToLatest();
        if (!disposed) bridge.current.grid(sessionId, term.cols, term.rows);
      });
    }).catch(() => {
      acceptLive = true;
      queued.splice(0).forEach((item) => writeEncoded(item));
      (pending.current.get(sessionId) ?? []).splice(0).forEach((item) => writeEncoded(item));
      pending.current.delete(sessionId);
    });
    return () => {
      disposed = true;
      imeComposing = false;
      cancelAnimationFrame(imeFrame);
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
      textarea?.removeEventListener('compositionstart', onCompositionStart);
      textarea?.removeEventListener('compositionupdate', onCompositionUpdate);
      textarea?.removeEventListener('compositionend', onCompositionEnd);
      observer.disconnect();
      links.dispose();
      linksRef.current = null;
      webglRef.current?.dispose();
      webglRef.current = null;
      // xterm schedules a scroll-area sync while opening; let it finish before disposal.
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
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    // Hidden terminals can reset their viewport; reveal the latest output on re-entry.
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
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
      fitLockRef.current = { cols: 0, rows: 0, height: 0 };
      try { fit.fit(); } catch { return; }
      fitLockRef.current = { cols: term.cols, rows: term.rows, height: node.clientHeight };
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
      if (becameActive) handles.current.get(sessionId)?.scrollToBottom();
      if (term.cols >= 2 && term.rows >= 1 && running) {
        void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
      }
      if (running && focusedRef.current && !document.querySelector('dialog[open]')) term.focus();
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
      if (!document.querySelector('dialog[open]')) termRef.current?.focus();
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

/** Keep the CLI's own title text. Drop only C0 controls so the workbench title stays one line. */
export function cleanTerminalTitle(raw: string): string {
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
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
