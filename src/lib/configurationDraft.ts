import type { ConfigurationAction, ConfigurationCredential, ConfigurationDraft } from '../types/configuration';
import type { AppliedBinding, Connection, RegisteredCommon, RegisteredProfile } from '../types/native';

/** Last-success identity is independent of the currently saved profile. */
export function configurationApplicationState(profile: RegisteredProfile, binding: AppliedBinding | null | undefined, common: RegisteredCommon | null | undefined) {
  const same = binding?.profileId === profile.id;
  const commonPending = same && profile.inheritCommon && (common
    ? !common.revision || binding?.commonVersion !== common.version || binding?.commonRevision !== common.revision
    : binding?.commonVersion != null || binding?.commonRevision != null);
  const trusted = binding?.appliedProfileAvailable === true && !!binding.appliedSummary
    && binding.appliedSummary.profileVersion === binding.profileVersion;
  const applied = same && trusted && binding?.profileVersion === profile.version
    && !!profile.revision && binding.appliedSummary?.profileRevision === profile.revision && !commonPending;
  return { same, commonPending, trusted, applied };
}

/** The four tones the board's live strip may use; only a trusted binding is green. */
export type ConfigurationLiveTone = 'success' | 'warning' | 'unknown' | 'neutral';
export type ConfigurationLiveState = 'applied' | 'invalid' | 'external' | 'unconfirmed' | 'unapplied' | 'project_unbound';

/**
 * What a read-only comparison of an applied binding against the current native files said.
 * `unchecked` is not a fact about the files: nothing comparable was read, so nothing is claimed.
 */
export type ConfigurationNativeFileState = 'unchecked' | 'unchanged' | 'changed' | 'unknown';

/** Name and copy for one configuration row; `external` and `unconfirmed` never read as in effect. */
export type ConfigurationRowState = 'active' | 'pending' | 'saved' | 'external' | 'unconfirmed';

/**
 * The rows and the board's strip share this judgement, so they cannot disagree about the
 * same record. A file that is no longer what the profile wrote is an external change, and a
 * comparison that could not be read is unconfirmed; neither may be reported as in effect.
 */
export function configurationRowState(
  profile: RegisteredProfile,
  binding: AppliedBinding | null | undefined,
  common: RegisteredCommon | null | undefined,
  file: ConfigurationNativeFileState = 'unchecked',
): ConfigurationRowState {
  const { same, trusted, applied } = configurationApplicationState(profile, binding, common);
  if (applied) {
    if (file === 'changed') return 'external';
    if (file === 'unknown') return 'unconfirmed';
    return 'active';
  }
  // Another saved profile is applied here: this row only has a saved version.
  if (!same) return 'saved';
  // The binding points here but its application record is unreadable, so nothing is confirmed.
  return trusted ? 'pending' : 'unconfirmed';
}

/** What comparing one applied document with the file it wrote can say. */
export type ConfigurationAppliedVerdict = 'unchanged' | 'changed' | 'unknown';

/**
 * Does the current native file still hold what this profile would write? Applying writes the
 * profile's own fields into the existing file and leaves every other key alone, so comparing whole
 * documents would report the CLI's own content (MCP servers, trusted projects, its own fields) as an
 * external change for as long as it exists. Compare only what the profile owns instead: every leaf
 * of the desired document must still sit under the same path with the same value, while the file
 * may hold keys the profile never wrote. A document that cannot be read reliably is `unknown`,
 * never either verdict.
 */
export function configurationAppliedFileState(files: readonly { format: string; current: string; proposedText: string }[]): ConfigurationAppliedVerdict {
  // A comparison that read nothing cannot report the file as still applied.
  if (!files.length) return 'unknown';
  let uncertain = false;
  for (const file of files) {
    const verdict = compareAppliedDocument(file.format, file.current, file.proposedText);
    // A definite mismatch is a fact about that file; an unreadable one never becomes one.
    if (verdict === 'changed') return 'changed';
    if (verdict !== 'unchanged') uncertain = true;
  }
  return uncertain ? 'unknown' : 'unchanged';
}

function compareAppliedDocument(format: string, current: string, proposed: string): ConfigurationAppliedVerdict {
  if (current === proposed) return 'unchanged';
  // A byte-order mark is the editor's, not the profile's content.
  const leftText = stripBom(current);
  const rightText = stripBom(proposed);
  if (leftText === rightText) return 'unchanged';
  if (format === 'json' || format === 'jsonc') {
    const left = parseJson(leftText);
    const right = parseJson(rightText);
    if (!left.ok || !right.ok) return 'unknown';
    return holdsDocument(left.value, right.value) ? 'unchanged' : 'changed';
  }
  const read = format === 'toml' ? tomlShape : format === 'yaml' ? yamlShape : null;
  // An unknown native format is not evidence of an external change.
  if (!read) return 'unknown';
  const left = read(leftText);
  const right = read(rightText);
  if (!left || !right) return 'unknown';
  return holdsShape(left, right) ? 'unchanged' : 'changed';
}

const stripBom = (text: string) => (text.startsWith('\ufeff') ? text.slice(1) : text);

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: text.trim() ? JSON.parse(text) : {} }; } catch { return { ok: false }; }
}

function holdsDocument(current: unknown, proposed: unknown): boolean {
  if (Array.isArray(proposed)) {
    return Array.isArray(current) && current.length === proposed.length && proposed.every((item, index) => holdsDocument(current[index], item));
  }
  if (proposed && typeof proposed === 'object') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    return Object.entries(proposed).every(([key, value]) => Object.hasOwn(current, key) && holdsDocument((current as Record<string, unknown>)[key], value));
  }
  return current === proposed;
}

/**
 * One document's content addressed by path: `leaves` are the values it holds (scalars, arrays and
 * inline tables), `arrays` counts block sequences, and `containers` are the tables it declares.
 * Addressing by path is what keeps `[model] base` from satisfying `[other] base`.
 */
type DocumentShape = { leaves: Map<string, string>; arrays: Map<string, number>; containers: Set<string> };

/** Unit and record separators keep key text from ever spelling a path boundary. */
const pathSeparator = '\u001f';
const itemSeparator = '\u001e';
const itemSegment = (index: number) => `${itemSeparator}${index}`;
const pathKey = (segments: readonly string[]) => segments.join(pathSeparator);

function blankShape(): DocumentShape { return { leaves: new Map(), arrays: new Map(), containers: new Set() }; }

/** Every value the profile owns must remain; extra content in the file is not the profile's. */
function holdsShape(current: DocumentShape, proposed: DocumentShape) {
  for (const [path, value] of proposed.leaves) {
    if (!current.leaves.has(path) || current.leaves.get(path) !== value) return false;
  }
  for (const [path, length] of proposed.arrays) if (current.arrays.get(path) !== length) return false;
  // An empty managed table is content too: the file must still declare it.
  const declared = usedContainers(proposed);
  for (const path of proposed.containers) if (!declared.has(path) && !current.containers.has(path)) return false;
  return true;
}

/** The container paths that own at least one value, so empty declarations can be told apart. */
function usedContainers(shape: DocumentShape) {
  const used = new Set<string>(['']);
  for (const path of [...shape.leaves.keys(), ...shape.arrays.keys()]) {
    let end = path.lastIndexOf(pathSeparator);
    while (end >= 0) {
      used.add(path.slice(0, end));
      end = path.lastIndexOf(pathSeparator, end - 1);
    }
  }
  return used;
}

/** One statement's value with spacing removed outside quoted strings. */
function compactValue(text: string) { return normalizeOutsideQuotes(text, false); }

/** One statement's value with runs of spacing outside quoted strings collapsed to a single space. */
function spacedValue(text: string) { return normalizeOutsideQuotes(text, true); }

function normalizeOutsideQuotes(text: string, collapse: boolean) {
  let shown = '';
  let quote = '';
  let spacing = false;
  const next = (index: number) => text[index] ?? '';
  const separate = (upcoming: string) => {
    // Collapsed spacing never pads inside a collection, and a closing bracket keeps its own side.
    if (spacing && collapse && shown && !'[{,'.includes(shown[shown.length - 1]) && !']},'.includes(upcoming)) shown += ' ';
    spacing = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"""' || quote === "'''") {
      const close = quote[0].repeat(3);
      if (char === '\\' && quote === '"""') { shown += char + next(index + 1); index += 1; continue; }
      if (text.startsWith(close, index)) { shown += close; index += 2; quote = ''; continue; }
      shown += char; continue;
    }
    if (quote) {
      shown += char;
      if (char === '\\' && quote === '"') { shown += next(index + 1); index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      separate(char);
      const triple = text.startsWith(char.repeat(3), index);
      quote = triple ? char.repeat(3) : char;
      shown += quote;
      if (triple) index += 2;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') { spacing = true; continue; }
    separate(char);
    // A trailing comma before a closing bracket is presentation, not content.
    if ((char === ']' || char === '}') && shown.endsWith(',')) shown = shown.slice(0, -1);
    shown += char;
  }
  return shown;
}

/**
 * TOML statements with comments removed, one entry each. Arrays, inline tables and multi-line
 * strings stay inside their statement; a document whose strings, brackets or braces do not close
 * is not read at all, because a guess there would be reported as an external change.
 */
function tomlStatements(text: string): string[] | null {
  const statements: string[] = [];
  let statement = '';
  let quote = '';
  let depth = 0;
  const next = (index: number) => text[index] ?? '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"""' || quote === "'''") {
      const close = quote[0].repeat(3);
      if (char === '\\' && quote === '"""') { statement += char + next(index + 1); index += 1; continue; }
      if (text.startsWith(close, index)) { statement += close; index += 2; quote = ''; continue; }
      statement += char;
      continue;
    }
    if (quote) {
      statement += char;
      if (char === '\\' && quote === '"') { statement += next(index + 1); index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '#') { while (index < text.length && text[index] !== '\n') index += 1; index -= 1; continue; }
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), index);
      quote = triple ? char.repeat(3) : char;
      statement += quote;
      if (triple) index += 2;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') { depth -= 1; if (depth < 0) return null; }
    if (char === '\n') {
      if (depth > 0) { statement += ' '; continue; }
      statements.push(statement.trim());
      statement = '';
      continue;
    }
    statement += char;
  }
  if (quote || depth !== 0) return null;
  statements.push(statement.trim());
  return statements.filter(item => item.length > 0);
}

/** The keys and values one document holds, addressed by table and key path. */
function tomlShape(text: string): DocumentShape | null {
  const statements = tomlStatements(text);
  if (!statements) return null;
  const shape = blankShape();
  const indexes = new Map<string, number>();
  let section: string[] = [];
  for (const statement of statements) {
    if (statement.startsWith('[[')) {
      if (!statement.endsWith(']]')) return null;
      const name = tomlKeyPath(statement.slice(2, -2));
      if (!name) return null;
      const key = pathKey(name);
      const index = indexes.get(key) ?? 0;
      indexes.set(key, index + 1);
      section = [...name, itemSegment(index)];
      shape.containers.add(pathKey(section));
      continue;
    }
    if (statement.startsWith('[')) {
      if (!statement.endsWith(']')) return null;
      const name = tomlKeyPath(statement.slice(1, -1));
      if (!name) return null;
      section = name;
      shape.containers.add(pathKey(section));
      continue;
    }
    const assignment = tomlAssignment(statement);
    if (!assignment) return null;
    const key = tomlKeyPath(assignment.key);
    if (!key) return null;
    const path = pathKey([...section, ...key]);
    // The same value declared twice is not a document we can compare.
    if (shape.leaves.has(path)) return null;
    shape.leaves.set(path, compactValue(assignment.value));
  }
  return shape;
}

function tomlAssignment(statement: string) {
  const split = splitOutsideQuotes(statement, '=');
  if (!split) return null;
  const key = split[0].trim();
  const value = split[1].trim();
  return key && value ? { key, value } : null;
}

/** One TOML key path: bare, quoted or dotted segments. */
function tomlKeyPath(text: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  const skipSpace = () => { while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1; };
  while (index < text.length) {
    skipSpace();
    if (index >= text.length) break;
    const char = text[index];
    let part: string;
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      if (close < 0) return null;
      part = text.slice(index + 1, close);
      // Escaped key text is not read back; it would not match its own spelling.
      if (char === '"' && part.includes('\\')) return null;
      index = close + 1;
    } else {
      const start = index;
      while (index < text.length && /[A-Za-z0-9_-]/.test(text[index])) index += 1;
      if (index === start) return null;
      part = text.slice(start, index);
    }
    parts.push(part);
    skipSpace();
    if (index < text.length) {
      if (text[index] !== '.') return null;
      index += 1;
    }
  }
  return parts.length ? parts : null;
}

type YamlLine = { indent: number; text: string };
type YamlNode = { kind: 'scalar'; text: string } | { kind: 'map'; entries: [string, YamlNode][] } | { kind: 'seq'; items: YamlNode[] };

/** The values and containers one YAML document holds, addressed by key and item path. */
function yamlShape(text: string): DocumentShape | null {
  const lines = yamlLines(text);
  if (!lines) return null;
  const cursor = { index: 0 };
  const root = lines.length ? yamlNode(lines, cursor, lines[0].indent) : { kind: 'map' as const, entries: [] as [string, YamlNode][] };
  if (!root) return null;
  if (cursor.index !== lines.length) return null;
  const shape = blankShape();
  return yamlFlatten(root, [], shape) ? shape : null;
}

function yamlLines(text: string): YamlLine[] | null {
  const lines: YamlLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const indent = line.length - line.replace(/^[ \t]*/, '').length;
    // A tab cannot indent a YAML mapping, so this file is not one we read back.
    if (line.slice(0, indent).includes('\t')) return null;
    const content = stripYamlComment(line.slice(indent)).trimEnd();
    if (!content) continue;
    lines.push({ indent, text: content });
  }
  return lines;
}

/** A YAML comment starts at a `#` that opens the line or follows a space. */
function stripYamlComment(content: string) {
  let quote = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (quote === "'" && char === "'" && content[index + 1] === "'") { index += 1; continue; }
      if (quote === '"' && char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || content[index - 1] === ' ' || content[index - 1] === '\t')) return content.slice(0, index);
  }
  return content;
}

function isYamlSeqEntry(text: string) { return text === '-' || text.startsWith('- ') || text.startsWith('-\t'); }

function yamlNode(lines: YamlLine[], cursor: { index: number }, indent: number): YamlNode | null {
  const line = lines[cursor.index];
  if (!line || line.indent !== indent) return null;
  if (isYamlSeqEntry(line.text)) return yamlSeq(lines, cursor, indent);
  if (yamlKeySplit(line.text)) return yamlMap(lines, cursor, indent);
  // A lone scalar: the document root or a sequence item reaching the end of its line.
  cursor.index += 1;
  return yamlValue(line.text, lines, cursor, indent);
}

function yamlMap(lines: YamlLine[], cursor: { index: number }, indent: number): YamlNode | null {
  const entries: [string, YamlNode][] = [];
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (line.indent < indent) break;
    if (line.indent > indent) return null;
    if (isYamlSeqEntry(line.text)) return null;
    const split = yamlKeySplit(line.text);
    if (!split) return null;
    const key = yamlKey(split.key);
    if (key === null) return null;
    cursor.index += 1;
    const rest = split.value.trim();
    let node: YamlNode | null;
    if (!rest) {
      node = cursor.index < lines.length && lines[cursor.index].indent > indent
        ? yamlNode(lines, cursor, lines[cursor.index].indent)
        : { kind: 'scalar', text: 'null' };
    } else node = yamlValue(rest, lines, cursor, indent);
    if (!node) return null;
    entries.push([key, node]);
  }
  return { kind: 'map', entries };
}

function yamlSeq(lines: YamlLine[], cursor: { index: number }, indent: number): YamlNode | null {
  const items: YamlNode[] = [];
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (line.indent < indent) break;
    if (line.indent > indent) return null;
    if (!isYamlSeqEntry(line.text)) return null;
    const after = line.text.slice(1);
    const content = after.replace(/^[ \t]*/, '');
    if (!content) {
      cursor.index += 1;
      const nested = cursor.index < lines.length && lines[cursor.index].indent > indent
        ? yamlNode(lines, cursor, lines[cursor.index].indent)
        : { kind: 'scalar' as const, text: 'null' };
      if (!nested) return null;
      items.push(nested);
      continue;
    }
    // An inline item owns the block that starts where its own text starts.
    const column = indent + 1 + (after.length - content.length);
    lines[cursor.index] = { indent: column, text: content };
    const item = yamlNode(lines, cursor, column);
    if (!item) return null;
    items.push(item);
  }
  return { kind: 'seq', items };
}

function yamlValue(text: string, lines: YamlLine[], cursor: { index: number }, indent: number): YamlNode | null {
  // Block scalars, anchors and tags carry their value across lines; do not guess at them.
  if (/^[|>]/.test(text) || text.startsWith('&') || text.startsWith('!')) return null;
  if (text.startsWith('[') || text.startsWith('{')) return yamlFlow(text, lines, cursor, indent);
  if ((text.startsWith('"') || text.startsWith("'")) && !yamlQuotedClosed(text)) return null;
  // Anything indented under a plain value is a folded scalar we cannot read back.
  if (cursor.index < lines.length && lines[cursor.index].indent > indent) return null;
  return { kind: 'scalar', text: spacedValue(text) };
}

function yamlFlow(text: string, lines: YamlLine[], cursor: { index: number }, indent: number): YamlNode | null {
  let collected = text;
  let depth = yamlFlowDepth(collected);
  while (depth !== 0) {
    const line = lines[cursor.index];
    // A collection closed from outside its own indentation is one we do not read back.
    if (!line || depth === null || line.indent <= indent) return null;
    cursor.index += 1;
    collected += ` ${line.text}`;
    depth = yamlFlowDepth(collected);
  }
  return { kind: 'scalar', text: spacedValue(collected) };
}

/** How many brackets a flow collection still leaves open; `null` when its quotes do not close. */
function yamlFlowDepth(text: string): number | null {
  let depth = 0;
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === "'" && char === "'" && text[index + 1] === "'") { index += 1; continue; }
      if (quote === '"' && char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
  }
  return quote || depth < 0 ? null : depth;
}

function yamlQuotedClosed(text: string) {
  const quote = text[0];
  for (let index = 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') { index += 1; continue; }
    if (text[index] === quote) return true;
  }
  return false;
}

/** A mapping key at the first `:` that ends the key, outside a quoted or plain URL colon. */
function yamlKeySplit(text: string): { key: string; value: string } | null {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === "'" && char === "'" && text[index + 1] === "'") { index += 1; continue; }
      if (quote === '"' && char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ':' && (index + 1 === text.length || text[index + 1] === ' ' || text[index + 1] === '\t')) {
      return { key: text.slice(0, index).trim(), value: text.slice(index + 1) };
    }
  }
  return null;
}

/** A mapping key's own text: quoting is presentation, the key is what it stands for. */
function yamlKey(text: string) {
  if (!text) return null;
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text;
  const close = text.indexOf(quote, 1);
  if (close < 0) return null;
  const key = text.slice(1, close);
  // Escaped key text is not read back: it would not match its own spelling.
  return quote === '"' && key.includes('\\') ? null : key;
}

function yamlFlatten(node: YamlNode, segments: string[], shape: DocumentShape): boolean {
  if (node.kind === 'map') {
    const path = pathKey(segments);
    if (shape.containers.has(path)) return false;
    shape.containers.add(path);
    return node.entries.every(([key, child]) => yamlFlatten(child, [...segments, key], shape));
  }
  if (node.kind === 'seq') {
    const path = pathKey(segments);
    if (shape.containers.has(path)) return false;
    shape.containers.add(path);
    shape.arrays.set(path, node.items.length);
    return node.items.every((child, index) => yamlFlatten(child, [...segments, itemSegment(index)], shape));
  }
  const path = pathKey(segments);
  if (shape.leaves.has(path)) return false;
  shape.leaves.set(path, node.text);
  return true;
}

/** First `separator` outside quoted strings, so a quoted key's own text never splits a statement. */
function splitOutsideQuotes(text: string, separator: string): [string, string] | null {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === separator) return [text.slice(0, index), text.slice(index + 1)];
  }
  return null;
}

/**
 * What the board may state about this exact scope. It reuses the row judgement so the
 * strip and the rows cannot disagree, and it never claims more than the facts support:
 * a remote target carries no binding, a stale binding is "no longer in effect", and an
 * applied profile whose native file changed outside Cliora is never shown as in effect.
 */
export function configurationLiveState(
  binding: AppliedBinding | null | undefined,
  profiles: readonly RegisteredProfile[],
  common: RegisteredCommon | null | undefined,
  scope: 'global' | 'project',
  remote: boolean,
  file: ConfigurationNativeFileState = 'unchecked',
): { tone: ConfigurationLiveTone; state: ConfigurationLiveState; profile: RegisteredProfile | null } {
  // A remote target's tool store has no binding, so nothing here is readable as a fact.
  if (remote) return { tone: 'unknown', state: 'unconfirmed', profile: null };
  if (!binding) return {
    tone: 'neutral',
    state: scope === 'project' ? 'project_unbound' : 'unapplied',
    profile: null,
  };
  const profile = profiles.find(item => item.id === binding.profileId) ?? null;
  if (profile && configurationApplicationState(profile, binding, common).applied) {
    if (file === 'changed') return { tone: 'warning', state: 'external', profile };
    // A comparison that failed says nothing about the files; it does not read as broken either.
    if (file === 'unknown') return { tone: 'unknown', state: 'unconfirmed', profile };
    return { tone: 'success', state: 'applied', profile };
  }
  return { tone: 'warning', state: 'invalid', profile };
}

/** Opaque API refs can be restored only for the same connection identity. */
export const configurationConnectionIdentity = (connection: Connection | null) => connection ? JSON.stringify([connection.providerId, connection.interfaceFormat, connection.baseUrl]) : '';

export type ConfigurationApiBuffer = { credential: Extract<ConfigurationCredential, { source: 'api_key' }>; input: string; replacing: boolean };
export const configurationCredentialIdentity = (draft: ConfigurationDraft) => configurationConnectionIdentity(draft.draftConnection ?? draft.profile.connection) || draft.nativeCredentialTarget?.identity || '';

/** Browsing a new connection cannot reassign an existing ref or unfinished key. */
export function rememberConfigurationApiBuffer(buffers: Map<string, ConfigurationApiBuffer>, credentialIdentity: string, credential: ConfigurationApiBuffer['credential'], inputIdentity: string, input: string, replacing: boolean) {
  const previous = buffers.get(credentialIdentity);
  buffers.set(credentialIdentity, {
    credential,
    input: inputIdentity === credentialIdentity ? input : previous?.input ?? '',
    replacing: inputIdentity === credentialIdentity ? replacing : previous?.replacing ?? false,
  });
  if (inputIdentity !== credentialIdentity) buffers.set(inputIdentity, { credential: buffers.get(inputIdentity)?.credential ?? { source: 'api_key', secretRef: null }, input, replacing });
}

/** Query results belong to both the document and the independent request generation. */
export function configurationRequestMatches(current: ConfigurationDraft, started: ConfigurationDraft, result: { sessionId: string; revision: number; requestGeneration: number }) {
  return current.sessionId === started.sessionId && current.revision === started.revision
    && current.requestGeneration === started.requestGeneration && result.sessionId === started.sessionId
    && result.revision === started.revision && result.requestGeneration === (started.requestGeneration ?? 0);
}

/** Text replacements and form actions share one order and consume the latest accepted draft. */
export function createConfigurationSession(initial: ConfigurationDraft) {
  let draft = initial;
  let closed = false;
  let epoch = 0;
  let sequence = Promise.resolve();
  let requestId = 0;
  const invalidFields = new Set<string>();
  const pending = new Set<number>();
  const enqueue = (request: (current: ConfigurationDraft) => Promise<ConfigurationDraft>): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    const token = ++requestId;
    const requestEpoch = epoch;
    pending.add(token);
    let accepted = false;
    const operation = sequence.then(async () => {
      if (closed || requestEpoch !== epoch) return;
      const base = draft;
      const next = await request(base);
      if (closed || requestEpoch !== epoch || next.sessionId !== base.sessionId || next.revision <= base.revision) return;
      draft = next;
      accepted = true;
    });
    sequence = operation.catch(() => {});
    return operation.then(() => accepted).finally(() => { pending.delete(token); });
  };
  return {
    get draft() { return draft; },
    get pending() { return pending.size > 0; },
    get canSubmit() { return !closed && pending.size === 0 && draft.issues.length === 0 && invalidFields.size === 0; },
    /** A successful save can update persisted identity without editing the document. */
    acceptSaved(next: ConfigurationDraft) {
      if (closed || pending.size || next.sessionId !== draft.sessionId || next.revision < draft.revision) return false;
      draft = next; return true;
    },
    setFieldValidity(field: string, valid: boolean) { if (valid) invalidFields.delete(field); else invalidFields.add(field); },
    isFieldValid(field: string) { return !invalidFields.has(field); },
    /** Opaque validity keys, surfaced so the dialog can name what blocks saving. */
    get invalidFields(): readonly string[] { return [...invalidFields]; },
    invalidate() { epoch += 1; pending.clear(); sequence = Promise.resolve(); },
    close() { closed = true; epoch += 1; pending.clear(); },
    edit: enqueue,
    update: enqueue,
  };
}

export function configurationAction(operation: string, target: unknown, field: string | null = null, value: unknown = null): ConfigurationAction {
  return { version: 1, operation, target, field, value };
}
