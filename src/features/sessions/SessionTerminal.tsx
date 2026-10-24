import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { native } from '../../lib/native';
import { writeClipboard } from '../../lib/clipboard';
import { contrastFloor, terminalTheme, type TerminalTheme } from './terminalTheme';
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
  findMatches: (query: string) => TerminalMatch[];
  revealMatch: (match: TerminalMatch | null) => void;
};

export function encodeBase64(bytes: Uint8Array): string {
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

export type ShortcutAction = 'find' | 'composer' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'newSession' | 'prevSession' | 'nextSession';

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

export type TerminalBridge = {
  writeError: (error: unknown) => void;
  bell: (sessionId: string) => void;
  title: (sessionId: string, title: string) => void;
  outputActive: (sessionId: string, active: boolean) => void;
  outputWritten: (sessionId: string) => void;
  shortcut: (action: ShortcutAction) => void;
  canSwitch: () => boolean;
  scrolled: (sessionId: string, awayFromBottom: boolean) => void;
  copied: () => void;
};

export function SessionTerminal({ sessionId, label, active, running, fontSize, theme, cursorBlink, writers, pending, handles, bridge }: {
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
  const viewportRef = useRef<HTMLElement | null>(null);
  const [, setScrollVersion] = useState(0);
  const activeRef = useRef(active);
  const runningRef = useRef(running);
  const fontSizeRef = useRef(fontSize);
  const themeRef = useRef(theme);
  const wasActiveRef = useRef(active);
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
      lineHeight: 1.5,
      letterSpacing: 0.15,
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
      if (event.type !== 'keydown') return false;
      if (action.kind === 'paste') return false;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === 'send') sendToPty(action.data);
      else if (action.kind === 'copy') copySelection();
      else bridge.current.shortcut(action.action);
      return false;
    });

    // Mouse-tracking CLIs still need native normal-buffer scrollback; an idle alternate
    // screen must never translate the wheel into arrow keys and move its input caret.
    const wheelScrollViewport = (event: WheelEvent) => {
      if (event.deltaY === 0 || event.shiftKey) return;
      const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
      if (!viewport) return;
      let amount = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        amount *= viewport.clientHeight / Math.max(1, term.rows);
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        amount *= viewport.clientHeight;
      }
      if (event.altKey) amount *= 5;
      viewport.scrollTop = Math.max(0, Math.min(viewport.scrollTop + amount, viewport.scrollHeight));
      event.preventDefault();
    };
    term.attachCustomWheelEventHandler((event) => {
      if (term.buffer.active.type !== 'alternate') {
        if (term.modes.mouseTrackingMode === 'none') return true;
        wheelScrollViewport(event);
        return false;
      }
      if (term.modes.mouseTrackingMode !== 'none') return true;
      event.preventDefault();
      return false;
    });

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
    };
    document.addEventListener('scroll', resetAncestorScroll, true);

    const bellSub = term.onBell(() => {
      if (!disposed) bridge.current.bell(sessionId);
    });
    const titleSub = term.onTitleChange((title) => {
      if (!disposed) bridge.current.title(sessionId, title);
    });
    let awayFromBottom = false;
    let scrollUiFrame = 0;
    const reportScroll = () => {
      if (disposed) return;
      if (!scrollUiFrame && activeRef.current) {
        scrollUiFrame = requestAnimationFrame(() => {
          scrollUiFrame = 0;
          if (!disposed) setScrollVersion((version) => version + 1);
        });
      }
      // The DOM viewport also reflects wheel input whose xterm scroll event is suppressed.
      const rowHeight = viewport ? viewport.clientHeight / Math.max(1, term.rows) : 1;
      const remaining = viewport ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight : 0;
      const away = term.buffer.active.type === 'normal' && remaining > Math.max(2, rowHeight);
      if (away === awayFromBottom) return;
      awayFromBottom = away;
      bridge.current.scrolled(sessionId, away);
    };
    const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
    viewportRef.current = viewport ?? null;
    if (viewport) viewport.id = `terminal-viewport-${sessionId}`;
    const scrollToLatest = () => {
      if (disposed) return;
      term.scrollToBottom();
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
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
        } catch { /* The buffer may have changed since this match was found. */ }
      },
    };
    handles.current.set(sessionId, handle);

    const subscription = term.onData((data) => sendToPty(data));
    const fitNow = () => {
      if (disposed || !activeRef.current || node.clientWidth < 8 || node.clientHeight < 8) return;
      try { fit.fit(); } catch { return; }
      if (term.cols < 2 || term.rows < 1) return;
      if (!awayFromBottom) scrollToLatest();
      reportScroll();
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
      requestAnimationFrame(() => {
        fitNow();
        scrollToLatest();
      });
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
      cancelAnimationFrame(scrollUiFrame);
      scrollAreaObserver.disconnect();
      viewport?.removeEventListener('scroll', reportScroll);
      viewportRef.current = null;
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
    term.options.cursorBlink = cursorBlink && active && running;
    term.options.fontSize = fontSize;
    // Hidden terminals can reset their viewport; reveal the latest output on re-entry.
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const fit = fitRef.current;
      const node = host.current;
      if (!fit || !node || node.clientWidth < 8) return;
      try { fit.fit(); } catch { return; }
      if (becameActive) handles.current.get(sessionId)?.scrollToBottom();
      if (term.cols >= 2 && term.rows >= 1 && running) {
        void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
      }
      if (running && !document.querySelector('dialog[open]')) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, running, fontSize, cursorBlink, sessionId, bridge]);

  return <div className={styles.terminalInstance} hidden={!active}>
    <div ref={host} className={styles.terminalHost} aria-label={label} data-blink={cursorBlink || undefined} />
    <TerminalScrollbar terminal={termRef.current} viewport={viewportRef.current} />
  </div>;
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
