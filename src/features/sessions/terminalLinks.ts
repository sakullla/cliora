import type { IBufferCellPosition, IBufferLine, IBufferRange, IDisposable, ILink, Terminal } from '@xterm/xterm';
import styles from './SessionWorkbench.module.css';

export type TerminalLinkMatch = { url: string; start: number; end: number };
export type TerminalLinks = IDisposable & { dismiss: () => void };

type PhysicalLine = { row: number; text: string; columns: number[] };

export function validTerminalUrl(value: string): boolean {
  if (value.length > 8192 || /[\p{Cc}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function trimTerminalUrl(value: string): string {
  let result = value.replace(/[.,;:!?，。；：！？]+$/u, '');
  for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const openings = result.split(opening).length - 1;
    let closings = result.split(closing).length - 1;
    while (closings > openings && result.endsWith(closing)) {
      result = result.slice(0, -1);
      closings -= 1;
    }
  }
  return result;
}

export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s\p{Cc}<>"'\\]+/giu)) {
    if (match.index === undefined) continue;
    const url = trimTerminalUrl(match[0]);
    if (validTerminalUrl(url)) matches.push({ url, start: match.index, end: match.index + url.length });
  }
  return matches;
}

function readPhysicalLine(term: Terminal, line: IBufferLine, row: number): PhysicalLine {
  let text = '';
  const columns: number[] = [];
  for (let column = 0; column < term.cols;) {
    const cell = line.getCell(column);
    const chars = cell?.getChars() || ' ';
    for (const char of chars) {
      text += char;
      for (let index = 0; index < char.length; index += 1) columns.push(column);
    }
    column += cell?.getWidth() || 1;
  }
  return { row, text, columns };
}

function readLogicalLines(term: Terminal, bufferLineNumber: number): PhysicalLine[] {
  const buffer = term.buffer.active;
  if (!buffer.getLine(bufferLineNumber - 1)) return [];
  let first = bufferLineNumber - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
  const lines: PhysicalLine[] = [];
  for (let row = first; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line || (row > first && !line.isWrapped)) break;
    lines.push(readPhysicalLine(term, line, row));
  }
  return lines;
}

function linkRange(lines: PhysicalLine[], starts: number[], start: number, end: number): IBufferRange {
  const position = (index: number, endOffset: number): IBufferCellPosition => {
    let row = 0;
    while (row + 1 < lines.length && index >= starts[row] + lines[row].text.length) row += 1;
    return { x: (lines[row].columns[index - starts[row]] ?? 0) + 1 + endOffset, y: lines[row].row + 1 };
  };
  return { start: position(start, 0), end: position(end - 1, 1) };
}

export function registerTerminalLinks(term: Terminal, options: {
  mac: boolean;
  hint: () => string;
  open: (url: string) => Promise<void>;
  onError: (error: unknown) => void;
}): TerminalLinks {
  let disposed = false;
  let current: ILink | null = null;
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
  const activate = (event: MouseEvent, url: string) => {
    if (disposed || event.button !== 0 || !modified(event) || !validTerminalUrl(url)) return;
    event.preventDefault();
    event.stopPropagation();
    tooltip.hidden = true;
    try {
      void options.open(url).catch((error) => { if (!disposed) options.onError(error); });
    } catch (error) {
      options.onError(error);
    }
  };
  const createLink = (url: string, range: IBufferRange): ILink => {
    const link: ILink = {
      range,
      text: url,
      decorations: { pointerCursor: false, underline: false },
      activate: (event) => activate(event, url),
      hover: (event) => hover(event, url, link),
      leave: () => leave(link),
    };
    return link;
  };

  term.options.linkHandler = {
    allowNonHttpProtocols: false,
    activate: (event, url) => activate(event, url),
    hover: (event, url) => hover(event, url),
    leave: () => leave(),
  };
  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const lines = readLogicalLines(term, bufferLineNumber);
      const starts: number[] = [];
      let text = '';
      for (const line of lines) {
        starts.push(text.length);
        text += line.text;
      }
      const links = findTerminalLinks(text).map((match) => createLink(match.url, linkRange(lines, starts, match.start, match.end)));
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
