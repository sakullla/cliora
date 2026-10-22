import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodeFormat } from '../../components/CodeEditor';
import { parseMemory } from '../memory/memoryDocument';
import styles from './DocumentWorkspace.module.css';

const MarkdownView = lazy(() => import('../../components/MarkdownView'));

export type ReadField = { key: string; value: string };
export type ReadModel = { description: string; fields: ReadField[]; sections: ReadField[]; body: string };

const longKeys = /(^|\.)(developer_instructions|instructions|prompt|system_prompt|system|body|content)$/i;

function unescapeBasic(value: string) {
  return value
    .replace(/\\\r?\n[ \t\r\n]*/g, '')
    .replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\([btnfr"\\])/g, (_match, short?: string, long?: string, simple?: string) => {
      if (short || long) return String.fromCodePoint(Number.parseInt(short ?? long ?? '0', 16));
      return ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[simple ?? ''] ?? '';
    });
}

function balanced(value: string) {
  let depth = 0; let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) { if (char === '\\' && quote === '"') index += 1; else if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
  }
  return depth <= 0;
}

/**
 * Reads the simple TOML that native agent definitions use: top-level and
 * table keys with strings, multi-line strings, numbers, booleans and arrays.
 * Anything else returns null and the reader falls back to the source view.
 * Presentation only; the file is always saved exactly as edited.
 */
export function readToml(text: string): ReadField[] | null {
  const fields: ReadField[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let prefix = '';
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const table = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(trimmed);
    if (table) { prefix = `${table[1].replace(/["']/g, '')}.`; continue; }
    const pair = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair) return null;
    const key = prefix + pair[1].replace(/["']/g, '').replace(/\s*\.\s*/g, '.');
    const rest = pair[2];
    let value: string;
    const triple = rest.startsWith('"""') ? '"""' : rest.startsWith("'''") ? "'''" : null;
    if (triple) {
      const first = rest.slice(3);
      const collected: string[] = [];
      let closed = false;
      const end = first.indexOf(triple);
      if (end >= 0) { collected.push(first.slice(0, end)); closed = true; }
      else {
        if (first.length) collected.push(first);
        while (++index < lines.length) {
          const line = lines[index];
          const at = line.indexOf(triple);
          if (at >= 0) { collected.push(line.slice(0, at)); closed = true; break; }
          collected.push(line);
        }
      }
      if (!closed) return null;
      value = collected.join('\n');
      if (triple === '"""') value = unescapeBasic(value);
    } else if (rest.startsWith('"')) {
      const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (!match) return null;
      value = unescapeBasic(match[1]);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) return null;
      value = rest.slice(1, end);
    } else {
      let raw = rest;
      if (/^[[{]/.test(raw)) {
        while (!balanced(raw) && index + 1 < lines.length) raw += `\n${lines[++index]}`;
        if (!balanced(raw)) return null;
      }
      value = raw.replace(/\s+#[^"'\]]*$/, '').trim();
    }
    fields.push({ key, value });
  }
  return fields;
}

/** Splits a document into a description, short fields, long text sections and a Markdown body. */
export function readModel(text: string, format: CodeFormat): ReadModel | null {
  if (format === 'markdown') {
    const parsed = parseMemory('', text);
    const description = parsed.properties.find(item => item.key.toLowerCase() === 'description')?.value.trim() ?? '';
    const rest = parsed.properties.filter(item => !['name', 'description'].includes(item.key.toLowerCase()));
    return { description, fields: rest.filter(item => !item.value.includes('\n')), sections: rest.filter(item => item.value.includes('\n')), body: parsed.body };
  }
  if (format === 'toml') {
    const fields = readToml(text);
    if (!fields) return null;
    const description = fields.find(item => item.key === 'description')?.value.trim() ?? '';
    const rest = fields.filter(item => item.key !== 'name' && item.key !== 'description');
    const long = (item: ReadField) => item.value.includes('\n') || longKeys.test(item.key) || item.value.length > 160;
    return { description, fields: rest.filter(item => !long(item)), sections: rest.filter(long), body: '' };
  }
  return null;
}

/**
 * Rendered view of a Markdown or TOML document. Returns null when the format
 * has no reading view, so callers can show the source instead.
 * Reading stays selectable; editing is the explicit control in the header.
 */
export function DocumentReader({ text, format, label }: { text: string; format: CodeFormat; label: string }) {
  const { t } = useTranslation();
  const model = useMemo(() => readModel(text, format), [text, format]);
  if (!model) return null;
  const empty = !model.description && !model.fields.length && !model.sections.length && !model.body.trim();
  return <div className={styles.body} role="region" aria-label={label} tabIndex={0}>
    <div className={styles.readColumn}>
      {model.description && <p className={styles.lead}>{model.description}</p>}
      {model.fields.length > 0 && <dl className={styles.fieldCard} aria-label={t('common.document.properties')}>{model.fields.map(item => <div key={item.key}><dt>{item.key}</dt><dd>{item.value || '—'}</dd></div>)}</dl>}
      {model.sections.map(item => <section key={item.key} className={styles.section} aria-label={item.key}><span className={styles.sectionLabel}>{item.key}</span><Suspense fallback={<pre className={styles.lead}>{item.value}</pre>}><MarkdownView text={item.value} /></Suspense></section>)}
      {model.body.trim() && <Suspense fallback={<pre className={styles.lead}>{model.body}</pre>}><MarkdownView text={model.body} /></Suspense>}
      {empty && <p className={styles.empty}>{t('common.document.empty')}</p>}
    </div>
  </div>;
}
