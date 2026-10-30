import type { IBufferCellPosition, IBufferLine, IBufferRange, IDisposable, ILink, Terminal } from '@xterm/xterm';
import { createTerminalLinkCache, oscTerminalLink, TERMINAL_LINK_TEXT_LIMIT, type TerminalLinkMatch } from './terminalLinkDetection';
import styles from './SessionWorkbench.module.css';

export type TerminalLinks = IDisposable & { dismiss: () => void };

type PhysicalLine = { row: number; text: string; columns: number[]; ends: number[] };
const LOGICAL_LINE_LIMIT = 128;

function readPhysicalLine(term: Terminal, line: IBufferLine, row: number): PhysicalLine {
  let text = '';
  const columns: number[] = [];
  const ends: number[] = [];
  const cell = term.buffer.active.getNullCell();
  for (let column = 0; column < term.cols;) {
    const value = line.getCell(column, cell);
    const chars = value?.getChars() || ' ';
    const width = value?.getWidth() || 1;
    for (const char of chars) {
      text += char;
      for (let index = 0; index < char.length; index += 1) {
        columns.push(column);
        ends.push(column + width);
      }
    }
    column += width;
  }
  return { row, text, columns, ends };
}

function readLogicalLines(term: Terminal, bufferLineNumber: number): PhysicalLine[] {
  const buffer = term.buffer.active;
  if (!buffer.getLine(bufferLineNumber - 1)) return [];
  let first = bufferLineNumber - 1;
  let walked = 0;
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    if (++walked >= LOGICAL_LINE_LIMIT) return [];
    first -= 1;
  }
  const lines: PhysicalLine[] = [];
  let length = 0;
  for (let row = first; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line || (row > first && !line.isWrapped)) break;
    if (lines.length >= LOGICAL_LINE_LIMIT || length + term.cols > TERMINAL_LINK_TEXT_LIMIT) return [];
    const physical = readPhysicalLine(term, line, row);
    length += physical.text.length;
    if (length > TERMINAL_LINK_TEXT_LIMIT) return [];
    lines.push(physical);
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

  const modified = (event: MouseEvent | KeyboardEvent) => options.mac ? event.metaKey : event.ctrlKey;
  const decorate = (active: boolean) => {
    if (!current?.decorations) return;
    current.decorations.pointerCursor = active;
    current.decorations.underline = active;
  };
  const dismiss = () => {
    decorate(false);
    tooltip.hidden = true;
  };
  const showHint = (event: MouseEvent, url: string) => {
    action.textContent = options.hint();
    target.textContent = url;
    tooltip.hidden = false;
    const left = Math.min(Math.max(8, event.clientX + 14), Math.max(8, window.innerWidth - tooltip.offsetWidth - 8));
    const above = event.clientY - tooltip.offsetHeight - 12;
    const top = above >= 8 ? above : Math.min(event.clientY + 20, Math.max(8, window.innerHeight - tooltip.offsetHeight - 8));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  };
  const hover = (event: MouseEvent, url: string, link?: ILink) => {
    if (disposed) return;
    current = link ?? null;
    decorate(modified(event));
    showHint(event, url);
  };
  const leave = (link?: ILink) => {
    if (link && current !== link) return;
    current = null;
    tooltip.hidden = true;
  };
  const activate = (event: MouseEvent, target: Target) => {
    if (disposed || event.button !== 0 || !modified(event)) return;
    event.preventDefault();
    event.stopPropagation();
    tooltip.hidden = true;
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
        else dismiss();
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
      else dismiss();
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
