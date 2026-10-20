/**
 * Display helpers for memory entries. Memory files are Markdown, optionally
 * with a leading YAML frontmatter block (`name`, `description`, `type`, and
 * nested `metadata`). Parsing here is presentation only: the file text is
 * always saved back exactly as edited.
 */

export type MemoryProperty = { key: string; value: string };

export type ParsedMemory = {
  /** Human title: frontmatter `name`, else the entry id, humanized. */
  title: string;
  description: string;
  /** Lower-case `type` (top level or `metadata.type`), when present. */
  type: string | null;
  /** ISO timestamp from `metadata.modified`/`modified`/`updated`, when present. */
  modified: string | null;
  /** Markdown body after the frontmatter block. */
  body: string;
  /** Body for reading: a leading `# Heading` already used as the title is dropped. */
  displayBody: string;
  /** First readable body line, stripped of Markdown markers. */
  excerpt: string;
  properties: MemoryProperty[];
  hasFrontmatter: boolean;
};

const frontmatterPattern = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) as string; } catch { return text.slice(1, -1); }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** A small, forgiving reader for the flat and one-level nested maps memory files use. */
function readFrontmatter(block: string): MemoryProperty[] {
  const properties: MemoryProperty[] = [];
  const lines = block.split(/\r?\n/);
  let parent: { key: string; indent: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(\s*)([^:#\s][^:]*?):(?:\s+(.*)|\s*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    let value = (match[3] ?? '').trim();
    if (parent && indent <= parent.indent) parent = null;
    if (!value) {
      parent = { key, indent };
      continue;
    }
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const folded = value.startsWith('>');
      const collected: string[] = [];
      while (index + 1 < lines.length && (lines[index + 1].trim() === '' || /^\s/.test(lines[index + 1]) && lines[index + 1].search(/\S/) > indent)) {
        index += 1;
        collected.push(lines[index].trim());
      }
      value = folded ? collected.filter(Boolean).join(' ') : collected.join('\n').trim();
    } else value = unquote(value);
    properties.push({ key: parent ? `${parent.key}.${key}` : key, value });
  }
  return properties;
}

/** `project_rillight_playback` → `Project rillight playback`; other names stay as written. */
export function humanize(value: string): string {
  const text = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text) || !/[_-]/.test(text)) return text;
  const spaced = text.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function excerptOf(body: string, title: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(```|~~~|---|\*\*\*|<!--)/.test(line)) continue;
    const plain = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain && plain.toLocaleLowerCase() !== title.toLocaleLowerCase()) return plain;
  }
  return '';
}

export function parseMemory(id: string, text: string): ParsedMemory {
  const match = frontmatterPattern.exec(text);
  const properties = match ? readFrontmatter(match[1]) : [];
  const body = match ? text.slice(match[0].length) : text.replace(/^\uFEFF/, '');
  const find = (...keys: string[]) => keys.map(key => properties.find(item => item.key.toLowerCase() === key)?.value.trim()).find(Boolean) ?? null;
  const name = find('name', 'title');
  const type = find('type', 'metadata.type');
  const trimmed = body.replace(/^(?:[ \t]*\r?\n)+/, '');
  // Without a frontmatter name, a leading level-one heading is the title.
  const heading = name ? null : /^#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(trimmed);
  const title = heading ? heading[1].trim() : humanize(name || id) || id;
  return {
    title,
    description: find('description', 'summary') ?? '',
    type: type ? type.toLowerCase() : null,
    modified: find('metadata.modified', 'modified', 'updated', 'metadata.updated'),
    body: trimmed,
    displayBody: heading ? trimmed.slice(heading[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') : trimmed,
    excerpt: excerptOf(trimmed, title),
    properties,
    hasFrontmatter: !!match,
  };
}

/** Store labels are either a name (全局, a slug) or a path; paths show their last segment first. */
export function storeLabelParts(label: string): { name: string; path: string } {
  if (!/[\\/]/.test(label)) return { name: label, path: '' };
  const segments = label.split(/[\\/]+/).filter(Boolean);
  return { name: segments.at(-1) ?? label, path: label };
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function relativeTime(value: string | null, language: string): { text: string; absolute: string; time: number } | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const locale = language.startsWith('en') ? 'en-US' : 'zh-CN';
  const absolute = new Date(time).toLocaleString(locale);
  const delta = Math.round((time - Date.now()) / 1000);
  const span = Math.abs(delta);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (span < 45) return { text: format.format(0, 'second'), absolute, time };
  if (span < 3600) return { text: format.format(Math.round(delta / 60), 'minute'), absolute, time };
  if (span < 86400) return { text: format.format(Math.round(delta / 3600), 'hour'), absolute, time };
  if (span < 86400 * 30) return { text: format.format(Math.round(delta / 86400), 'day'), absolute, time };
  return { text: new Date(time).toLocaleDateString(locale), absolute, time };
}

/** Frontmatter skeleton for new entries, offered only when the CLI's existing entries use one. */
export function createTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n`;
}
