import type { IBufferCellPosition, IBufferLine, IBufferRange, IDisposable, ILink, Terminal } from '@xterm/xterm';
import { createTerminalLinkCache, mayContainTerminalLink, oscTerminalLink, TERMINAL_LINK_TEXT_LIMIT, terminalPathContinuation, type TerminalLinkMatch } from './terminalLinkDetection';
import styles from './SessionWorkbench.module.css';

export type TerminalLinks = IDisposable & { dismiss: () => void };

type PhysicalLine = { row: number; text: string; columns: number[]; ends: number[] };
const LOGICAL_LINE_LIMIT = 128;
/** Resting the pointer this long on a link shows its hint; sweeping across output shows nothing.
 *  The hint sits in the status bar, off the text, so it can come up sooner than a floating tooltip. */
const HINT_DELAY_MS = 140;
/** A TUI redraw re-creates the link under a still pointer; a leave this short is not a real leave. */
const HINT_GRACE_MS = 160;
/** A link kept through a redraw burst is dropped if it has not been seen for this long. */
const HINT_REDRAW_LIMIT_MS = 1500;

/** The logical line's rows (start, end) when its plain text could hold a link, else null. */
function logicalRows(term: Terminal, bufferLineNumber: number): { first: number; last: number } | null {
  const buffer = term.buffer.active;
  if (!buffer.getLine(bufferLineNumber - 1)) return null;
  let first = bufferLineNumber - 1;
  let walked = 0;
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    if (++walked >= LOGICAL_LINE_LIMIT) return null;
    first -= 1;
  }
  let last = first;
  let text = buffer.getLine(first)?.translateToString(true) ?? '';
  for (let row = first + 1; row < buffer.length && row - first < LOGICAL_LINE_LIMIT; row += 1) {
    const line = buffer.getLine(row);
    if (!line?.isWrapped) break;
    last = row;
    text += line.translateToString(true);
    if (text.length > TERMINAL_LINK_TEXT_LIMIT) return null;
  }
  // OSC 8 links come through xterm's own handler; plain text without a separator,
  // an extension dot or a known filename needs no per-cell read or matching at all.
  return mayContainTerminalLink(text) ? { first, last } : null;
}

function readPhysicalLine(term: Terminal, line: IBufferLine, row: number, trimWrapPadding: boolean, trimStart = false): PhysicalLine {
  let text = '';
  const columns: number[] = [];
  const ends: number[] = [];
  const cell = term.buffer.active.getNullCell();
  // A wide character that does not fit the last column is moved to the next row, and xterm
  // clears the leftover cell to codepoint 0. That cell has no characters; only a real space does.
  let contentLength = 0;
  for (let column = 0; column < term.cols;) {
    const value = line.getCell(column, cell);
    const chars = value?.getChars() ?? '';
    const width = value?.getWidth() || 1;
    for (const char of chars || ' ') {
      text += char;
      for (let index = 0; index < char.length; index += 1) {
        columns.push(column);
        ends.push(column + width);
      }
    }
    if (chars) contentLength = text.length;
    column += width;
  }
  if (trimWrapPadding && contentLength !== text.length) {
    text = text.slice(0, contentLength);
    columns.length = contentLength;
    ends.length = contentLength;
  }
  if (trimStart) {
    const start = text.search(/[^\s\u3000]/u);
    if (start > 0) {
      text = text.slice(start);
      columns.splice(0, start);
      ends.splice(0, start);
    }
  }
  return { row, text, columns, ends };
}

/** A TUI paints its own wrapped rows as separate buffer lines. Extend a row across those
 *  hard wraps when the previous row ends in a path fragment the next row completes. */
const HARD_WRAP_ROW_LIMIT = 3;

function readLogicalLines(term: Terminal, bufferLineNumber: number): PhysicalLine[] {
  const buffer = term.buffer.active;
  const rows = logicalRows(term, bufferLineNumber);
  if (!rows) return [];
  const parts: Array<{ row: number; trimStart: boolean }> = [];
  for (let row = rows.first; row <= rows.last; row += 1) {
    parts.push({ row, trimStart: false });
  }
  const readPart = (part: { row: number; trimStart: boolean }) => {
    const line = buffer.getLine(part.row);
    return line ? readPhysicalLine(term, line, part.row, true, part.trimStart) : null;
  };
  // Look above the first row only when the join completes a path; a complete link or prose
  // line never matches, so the scan stops at the real start of the painted line.
  for (let count = 0; count < HARD_WRAP_ROW_LIMIT && parts[0].row > 0; count += 1) {
    const current = readPart(parts[0]);
    const line = buffer.getLine(parts[0].row - 1);
    const previous = line ? readPhysicalLine(term, line, parts[0].row - 1, true) : null;
    if (!current || !previous || !terminalPathContinuation(previous.text, current.text)) break;
    parts.unshift({ row: previous.row, trimStart: false });
    parts[1].trimStart = true;
  }
  const lines: PhysicalLine[] = [];
  let length = 0;
  for (const part of parts) {
    if (lines.length >= LOGICAL_LINE_LIMIT || length + term.cols > TERMINAL_LINK_TEXT_LIMIT) return [];
    const physical = readPart(part);
    if (!physical) break;
    length += physical.text.length;
    if (length > TERMINAL_LINK_TEXT_LIMIT) return [];
    lines.push(physical);
  }
  // A path can also continue below this row when the pointer is on the first painted row.
  let text = lines.map(line => line.text).join('');
  for (let count = 0; count < HARD_WRAP_ROW_LIMIT && lines.length > 0 && lines.length < LOGICAL_LINE_LIMIT; count += 1) {
    const row = lines[lines.length - 1].row + 1;
    const line = buffer.getLine(row);
    const next = line ? readPhysicalLine(term, line, row, true, true) : null;
    if (!next || !terminalPathContinuation(text, next.text)) break;
    length += next.text.length;
    if (length > TERMINAL_LINK_TEXT_LIMIT) return [];
    lines.push(next);
    text += next.text;
  }
  return lines;
}

function linkRange(lines: PhysicalLine[], starts: number[], start: number, end: number): IBufferRange {
  const position = (index: number, end: boolean): IBufferCellPosition => {
    let row = 0;
    while (row + 1 < lines.length && index >= starts[row] + lines[row].text.length) row += 1;
    const offset = index - starts[row];
    return { x: end ? lines[row].ends[offset] : lines[row].columns[offset] + 1, y: lines[row].row + 1 };
  };
  return { start: position(start, false), end: position(end - 1, true) };
}

export function registerTerminalLinks(term: Terminal, options: {
  mac: boolean;
  hint: () => string;
  open: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<void>;
  onError: (error: unknown) => void;
  /** Where the hint docks while shown, like a browser's link status bubble: it never covers the
   *  output being read. Without a host it floats beside the pointer. */
  hintHost?: () => HTMLElement | null;
}): TerminalLinks {
  let disposed = false;
  let current: ILink | null = null;
  const matchesFor = createTerminalLinkCache();
  type Target = Pick<TerminalLinkMatch, 'kind' | 'value'>;
  const targetsForLine = (row: number) => {
    const lines = readLogicalLines(term, row);
    const starts: number[] = [];
    let text = '';
    for (const line of lines) {
      starts.push(text.length);
      text += line.text;
    }
    return matchesFor(text)
      .filter(match => match.kind === 'url' || options.openPath)
      .map(match => ({ target: match, range: linkRange(lines, starts, match.start, match.end) }));
  };
  const currentTarget = (range: IBufferRange) => targetsForLine(range.start.y).find(item =>
    item.range.start.x === range.start.x && item.range.start.y === range.start.y
    && item.range.end.x === range.end.x && item.range.end.y === range.end.y)?.target;
  const tooltip = document.createElement('div');
  tooltip.className = `xterm-hover ${styles.terminalLinkHint}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const action = document.createElement('span');
  const target = document.createElement('code');
  tooltip.append(action, target);
  term.element?.appendChild(tooltip);
  /** Dock the shown hint in the host; park it back in this terminal when hidden, so a host shared
   *  by split panes and background sessions only ever holds the hint that is up. */
  const dock = (show: boolean) => {
    const host = show ? options.hintHost?.() : null;
    if (host) {
      if (tooltip.parentElement !== host) host.appendChild(tooltip);
      tooltip.dataset.docked = 'true';
      tooltip.style.removeProperty('left');
      tooltip.style.removeProperty('top');
    } else {
      delete tooltip.dataset.docked;
      if (!show && term.element && tooltip.parentElement !== term.element) term.element.appendChild(tooltip);
    }
  };

  const modified = (event: MouseEvent | KeyboardEvent) => options.mac ? event.metaKey : event.ctrlKey;
  // Hovering underlines the link, as in VS Code; the pointer cursor waits for Ctrl/⌘ because a
  // plain click selects text and only a modified click opens.
  const decorate = (modifier: boolean) => {
    if (!current?.decorations) return;
    current.decorations.pointerCursor = modifier;
    current.decorations.underline = true;
  };
  const undecorate = () => {
    if (!current?.decorations) return;
    current.decorations.pointerCursor = false;
    current.decorations.underline = false;
  };
  // The hint shows once the pointer rests on a link, stays put while the same target is
  // re-created by redraws, and hides only after a real leave. Showing and hiding on every
  // xterm hover/leave pair made it flicker under a streaming CLI.
  let shown = '';
  // Text links can be re-read from the buffer; OSC 8 links only exist in xterm's handler.
  let shownFromText = false;
  /** When the shown text link was last seen under the pointer; redraws only count once it stays gone. */
  let shownSeenAt = 0;
  let outputSerial = 0;
  let pointerMovedAt = 0;
  let pendingFromText = false;
  let pending = '';
  let showTimer = 0;
  let hideTimer = 0;
  const pointer = { x: 0, y: 0 };
  const hideNow = () => {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
    shown = '';
    pending = '';
    tooltip.hidden = true;
    dock(false);
  };
  const dismiss = () => {
    undecorate();
    hideNow();
  };
  const place = () => {
    if (tooltip.dataset.docked) return;
    const left = Math.min(Math.max(8, pointer.x + 14), Math.max(8, window.innerWidth - tooltip.offsetWidth - 8));
    const above = pointer.y - tooltip.offsetHeight - 12;
    const top = above >= 8 ? above : Math.min(pointer.y + 20, Math.max(8, window.innerHeight - tooltip.offsetHeight - 8));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  };
  const showHint = (url: string) => {
    showTimer = 0;
    pending = '';
    if (disposed) return;
    action.textContent = options.hint();
    target.textContent = url;
    target.title = url;
    dock(true);
    tooltip.hidden = false;
    shown = url;
    shownFromText = pendingFromText;
    shownSeenAt = performance.now();
    place();
  };
  const hover = (event: MouseEvent, url: string, link?: ILink) => {
    if (disposed) return;
    current = link ?? null;
    decorate(modified(event));
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!tooltip.hidden) {
      // Same target: cancel any pending hide. Another target: a half-painted redraw can
      // briefly offer a shorter link, so swap only once the row has settled.
      if (shown === url) { shownSeenAt = performance.now(); window.clearTimeout(hideTimer); hideTimer = 0; }
      else if (link && shownFromText) scheduleSettle();
      else { pendingFromText = !!link; showHint(url); }
      return;
    }
    if (pending === url && showTimer) return;
    window.clearTimeout(showTimer);
    pending = url;
    pendingFromText = !!link;
    showTimer = window.setTimeout(() => showHint(url), HINT_DELAY_MS);
  };
  const leave = (link?: ILink) => {
    if (link && current !== link) return;
    undecorate();
    current = null;
    // A redraw re-creates the row under a still pointer and xterm only re-hovers on the
    // next mouse move. Keep a pending show while the same text is still there.
    if (pending && showTimer && stillUnder(pending)) return;
    window.clearTimeout(showTimer);
    showTimer = 0;
    pending = '';
    if (!tooltip.hidden) scheduleSettle();
  };
  /** After a short grace, show what is really under the pointer now: keep, swap or hide. */
  function scheduleSettle(delay = HINT_GRACE_MS) {
    if (hideTimer) return;
    const serial = outputSerial;
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      if (disposed || tooltip.hidden) return;
      if (!shownFromText) { if (!current) hideNow(); return; }
      const under = targetUnder();
      if (under && under === shown) { shownSeenAt = performance.now(); return; }
      // A CLI repaints a row in pieces. While output keeps arriving under a pointer that has not
      // moved, the link is mid-redraw, not gone; decide after a window with no output or a move.
      // Counting writes, not wall time, keeps a stalled event loop from reading a half-painted row as cleared.
      const now = performance.now();
      const redrawing = pointerMovedAt <= shownSeenAt && outputSerial !== serial && now - shownSeenAt < HINT_REDRAW_LIMIT_MS;
      if (redrawing || now - shownSeenAt < HINT_GRACE_MS) { scheduleSettle(HINT_GRACE_MS); return; }
      if (under) { pendingFromText = true; showHint(under); }
      else hideNow();
    }, delay);
  }
  /** The buffer cell under the pointer, or null when it is outside the terminal screen. */
  const cellAt = (): IBufferCellPosition | null => {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen || !term.cols || !term.rows) return null;
    const box = screen.getBoundingClientRect();
    if (pointer.x < box.left || pointer.x >= box.right || pointer.y < box.top || pointer.y >= box.bottom) return null;
    return {
      x: Math.floor((pointer.x - box.left) / (box.width / term.cols)) + 1,
      y: Math.floor((pointer.y - box.top) / (box.height / term.rows)) + term.buffer.active.viewportY + 1,
    };
  };
  const contains = (range: IBufferRange, cell: IBufferCellPosition) => {
    const after = cell.y > range.start.y || (cell.y === range.start.y && cell.x >= range.start.x);
    const before = cell.y < range.end.y || (cell.y === range.end.y && cell.x <= range.end.x);
    return after && before;
  };
  function stillUnder(value: string): boolean {
    return targetUnder() === value;
  }
  /** The link text under the pointer in the current buffer, or null. */
  function targetUnder(): string | null {
    const cell = cellAt();
    if (!cell) return null;
    return targetsForLine(cell.y).find((item) => contains(item.range, cell))?.target.value ?? null;
  }
  /** Output can move or remove the link under a still pointer; re-check once it settles. */
  const recheck = () => {
    if (disposed || tooltip.hidden || !shown || !shownFromText) return;
    if (targetUnder() === shown) shownSeenAt = performance.now();
    else scheduleSettle();
  };
  const trackPointer = (event: MouseEvent) => {
    if (event.clientX !== pointer.x || event.clientY !== pointer.y) pointerMovedAt = performance.now();
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    recheck();
  };
  const written = term.onWriteParsed(() => { outputSerial++; recheck(); });
  term.element?.addEventListener('mousemove', trackPointer, { passive: true });
  term.element?.addEventListener('mouseleave', dismiss);
  const activate = (event: MouseEvent, target: Target) => {
    if (disposed || event.button !== 0 || !modified(event)) return;
    event.preventDefault();
    event.stopPropagation();
    hideNow();
    try {
      const request = target.kind === 'url' ? options.open(target.value) : options.openPath?.(target.value);
      void request?.catch((error) => { if (!disposed) options.onError(error); });
    } catch (error) {
      options.onError(error);
    }
  };
  const createLink = (target: Target, range: IBufferRange): ILink => {
    const link: ILink = {
      range,
      text: target.value,
      decorations: { pointerCursor: false, underline: false },
      activate: (event) => {
        if (disposed || event.button !== 0 || !modified(event)) return;
        // xterm can retain a provider reply after the mouse leaves and a TUI
        // rewrites that row. Never open its old target without checking the buffer.
        const latest = currentTarget(range);
        if (latest) activate(event, latest);
        else dismiss();
      },
      hover: (event) => {
        const latest = currentTarget(range);
        if (latest) hover(event, latest.value, link);
        // A row caught mid-redraw: let the settle check decide instead of hiding at once.
        else { current = link; leave(link); }
      },
      leave: () => leave(link),
    };
    return link;
  };

  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, url) => {
      const target = oscTerminalLink(url);
      if (target) activate(event, target);
    },
    hover: (event, url) => {
      const target = oscTerminalLink(url);
      if (target && (target.kind === 'url' || options.openPath)) hover(event, url);
      else leave();
    },
    leave: () => leave(),
  };
  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const links = targetsForLine(bufferLineNumber).map(({ target, range }) => createLink(target, range));
      callback(links.length ? links : undefined);
    },
  });
  const onModifier = (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta') decorate(modified(event));
  };
  window.addEventListener('keydown', onModifier, true);
  window.addEventListener('keyup', onModifier, true);
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);
  window.addEventListener('scroll', dismiss, true);
  document.addEventListener('visibilitychange', dismiss);

  return {
    dismiss,
    dispose() {
      if (disposed) return;
      disposed = true;
      current = null;
      hideNow();
      written.dispose();
      term.element?.removeEventListener('mousemove', trackPointer);
      term.element?.removeEventListener('mouseleave', dismiss);
      provider.dispose();
      tooltip.remove();
      window.removeEventListener('keydown', onModifier, true);
      window.removeEventListener('keyup', onModifier, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('visibilitychange', dismiss);
    },
  };
}
