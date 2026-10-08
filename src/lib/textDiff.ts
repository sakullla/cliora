/** Line and word diffs for the file comparison. Config files are usually almost
 *  the same, so the edit script stays short. */

export type DiffOp = 'equal' | 'delete' | 'insert';
export type DiffPiece = { op: DiffOp; text: string };
export type DiffLine = { op: DiffOp; text: string; pieces?: DiffPiece[] };
export type DiffRow =
  | { kind: 'skip'; count: number }
  | { kind: DiffOp; text: string; pieces?: DiffPiece[] };
export type FieldChange = { path: string; kind: 'change' | 'add' | 'remove'; before?: string; after?: string };

const CONTEXT = 2;
const CHANGE_LIMIT = 8;

export function splitLines(text: string) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  return markEdits(myers(splitLines(before), splitLines(after)));
}

export function compareText(before: string, after: string, format: string) {
  const shown = displayText(before, after, format);
  const lines = diffLines(shown.before, shown.after);
  const found = (format === 'json' || format === 'jsonc' ? jsonChanges(before, after) : null) ?? assignmentChanges(before, after);
  const removed = lines.filter(line => line.op === 'delete').length;
  const added = lines.filter(line => line.op === 'insert').length;
  return {
    rows: diffRows(lines),
    changes: found.slice(0, CHANGE_LIMIT),
    hidden: Math.max(0, found.length - CHANGE_LIMIT),
    removed,
    added,
    same: removed + added === 0,
    whitespaceOnly: removed + added > 0 && normalize(before) === normalize(after),
  };
}

function displayText(before: string, after: string, format: string) {
  if (format !== 'json' && format !== 'jsonc') return { before, after };
  try {
    const left = before.trim() ? `${JSON.stringify(JSON.parse(before), null, 2)}\n` : before;
    const right = after.trim() ? `${JSON.stringify(JSON.parse(after), null, 2)}\n` : after;
    return { before: left, after: right };
  } catch {
    return { before, after };
  }
}

function normalize(text: string) {
  return text.split('\n').map(line => line.trimEnd()).join('\n').trim();
}

export function diffRows(lines: DiffLine[]): DiffRow[] {
  if (!lines.length) return [];
  const changed = lines.flatMap((line, index) => line.op === 'equal' ? [] : [index]);
  if (!changed.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(lines.length, index + CONTEXT + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const rows: DiffRow[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) rows.push({ kind: 'skip', count: start - cursor });
    for (let index = start; index < end; index += 1) {
      const line = lines[index];
      rows.push({ kind: line.op, text: line.text, pieces: line.pieces });
    }
    cursor = end;
  }
  if (cursor < lines.length) rows.push({ kind: 'skip', count: lines.length - cursor });
  return rows;
}

function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map(text => ({ op: 'insert', text }));
  if (!m) return a.map(text => ({ op: 'delete', text }));
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0));
      let x = down ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return a.map((text): DiffLine => ({ op: 'delete', text })).concat(b.map((text): DiffLine => ({ op: 'insert', text })));
}

function backtrack(trace: Array<Map<number, number>>, a: string[], b: string[], d: number): DiffLine[] {
  let x = a.length;
  let y = b.length;
  const result: DiffLine[] = [];
  for (let depth = d; depth >= 0; depth -= 1) {
    const v = trace[depth];
    const k = x - y;
    const down = k === -depth || (k !== depth && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0));
    const previous = down ? k + 1 : k - 1;
    const previousX = v.get(previous) ?? 0;
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      result.push({ op: 'equal', text: a[x] });
    }
    if (depth === 0) break;
    if (down) {
      y -= 1;
      result.push({ op: 'insert', text: b[y] });
    } else {
      x -= 1;
      result.push({ op: 'delete', text: a[x] });
    }
  }
  return result.reverse();
}

function markEdits(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].op !== 'delete') { out.push(lines[index]); index += 1; continue; }
    let endDelete = index;
    while (endDelete < lines.length && lines[endDelete].op === 'delete') endDelete += 1;
    let endInsert = endDelete;
    while (endInsert < lines.length && lines[endInsert].op === 'insert') endInsert += 1;
    const removed = lines.slice(index, endDelete);
    const added = lines.slice(endDelete, endInsert);
    const pairs = Math.min(removed.length, added.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      const left = wordPieces(removed[pair].text, added[pair].text);
      if (left) {
        out.push({ op: 'delete', text: removed[pair].text, pieces: left.before });
        out.push({ op: 'insert', text: added[pair].text, pieces: left.after });
      } else {
        out.push(removed[pair], added[pair]);
      }
    }
    for (let extra = pairs; extra < removed.length; extra += 1) out.push(removed[extra]);
    for (let extra = pairs; extra < added.length; extra += 1) out.push(added[extra]);
    index = endInsert;
  }
  return out;
}

function wordPieces(before: string, after: string): { before: DiffPiece[]; after: DiffPiece[] } | null {
  const left = tokens(before);
  const right = tokens(after);
  const script = myers(left, right);
  const equal = script.filter(piece => piece.op === 'equal').reduce((sum, piece) => sum + piece.text.length, 0);
  const longest = Math.max(before.length, after.length, 1);
  if (equal / longest < 0.34 && assignment(before)?.key !== assignment(after)?.key) return null;
  return {
    before: script.filter(piece => piece.op !== 'insert'),
    after: script.filter(piece => piece.op !== 'delete'),
  };
}

function tokens(text: string) {
  return text.match(/\s+|"[^"]*"|'[^']*'|[^\s"']+/g) ?? [text];
}

function assignment(line: string) {
  const match = line.match(/^\s*(?:([\w.-]+)|"((?:\\.|[^"])*)")\s*[:=]\s*(.*)$/);
  if (!match) return null;
  return { key: match[1] || match[2], value: match[3].replace(/,\s*$/, '').trim() };
}

function assignmentChanges(before: string, after: string): FieldChange[] {
  const left = fieldsOf(before);
  const right = fieldsOf(after);
  const used = new Set<number>();
  const changes: FieldChange[] = [];
  for (const item of left) {
    const match = right.findIndex((other, index) => !used.has(index) && other.section === item.section && other.key === item.key);
    if (match < 0) changes.push({ path: qualify(item.section, item.key), kind: 'remove', before: clip(item.value) });
    else {
      used.add(match);
      if (item.value !== right[match].value) changes.push({ path: qualify(item.section, item.key), kind: 'change', before: clip(item.value), after: clip(right[match].value) });
    }
  }
  right.forEach((item, index) => {
    if (!used.has(index)) changes.push({ path: qualify(item.section, item.key), kind: 'add', after: clip(item.value) });
  });
  return changes;
}

function fieldsOf(text: string) {
  let section = '';
  const items: Array<{ section: string; key: string; value: string }> = [];
  for (const line of splitLines(text)) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (table) { section = table[1].trim(); continue; }
    const field = assignment(line);
    if (field) items.push({ section, key: field.key, value: field.value });
  }
  return items;
}

function qualify(section: string, key: string) {
  return section ? `${section}.${key}` : key;
}

function jsonChanges(before: string, after: string): FieldChange[] | null {
  const leftText = before.trim();
  const rightText = after.trim();
  if (!leftText && !rightText) return [];
  if ((leftText && !leftText.startsWith('{') && !leftText.startsWith('[')) || (rightText && !rightText.startsWith('{') && !rightText.startsWith('['))) return null;
  try {
    const left = leftText ? JSON.parse(leftText) as unknown : undefined;
    const right = rightText ? JSON.parse(rightText) as unknown : undefined;
    const changes: FieldChange[] = [];
    walk(left, right, '', changes);
    return changes;
  } catch {
    return null;
  }
}

function walk(before: unknown, after: unknown, path: string, out: FieldChange[]) {
  if (same(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
      const next = path ? `${path}.${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(before, key)) out.push({ path: next, kind: 'add', after: preview(after[key]) });
      else if (!Object.prototype.hasOwnProperty.call(after, key)) out.push({ path: next, kind: 'remove', before: preview(before[key]) });
      else walk(before[key], after[key], next, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count; index += 1) {
      const next = `${path}[${index}]`;
      if (index >= before.length) out.push({ path: next, kind: 'add', after: preview(after[index]) });
      else if (index >= after.length) out.push({ path: next, kind: 'remove', before: preview(before[index]) });
      else walk(before[index], after[index], next, out);
    }
    return;
  }
  out.push({ path, kind: 'change', before: preview(before), after: preview(after) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function same(before: unknown, after: unknown) {
  return Object.is(before, after) || JSON.stringify(before) === JSON.stringify(after);
}

function preview(value: unknown) {
  if (typeof value === 'string') return clip(JSON.stringify(value));
  if (value == null) return String(value);
  return clip(JSON.stringify(value));
}

function clip(text: string) {
  return text.length > 96 ? `${text.slice(0, 93)}…` : text;
}
