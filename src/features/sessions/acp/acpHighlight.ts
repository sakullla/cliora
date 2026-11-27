import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { classHighlighter, highlightCode } from '@lezer/highlight';

/**
 * Static highlighting for code blocks in agent replies. Loaded on demand: only a
 * reply that holds a fenced block with one of these languages pays for it. The
 * result is a list of text runs with lezer's stable `tok-*` classes, which the
 * conversation styles with terminal tokens; nothing is evaluated.
 */
type Loader = () => Promise<StreamParser<unknown>>;

const loaders: Record<string, Loader> = {
  javascript: () => import('@codemirror/legacy-modes/mode/javascript').then((mode) => mode.javascript),
  typescript: () => import('@codemirror/legacy-modes/mode/javascript').then((mode) => mode.typescript),
  json: () => import('@codemirror/legacy-modes/mode/javascript').then((mode) => mode.json),
  rust: () => import('@codemirror/legacy-modes/mode/rust').then((mode) => mode.rust),
  python: () => import('@codemirror/legacy-modes/mode/python').then((mode) => mode.python),
  shell: () => import('@codemirror/legacy-modes/mode/shell').then((mode) => mode.shell),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then((mode) => mode.toml),
  yaml: () => import('@codemirror/legacy-modes/mode/yaml').then((mode) => mode.yaml),
  go: () => import('@codemirror/legacy-modes/mode/go').then((mode) => mode.go),
  css: () => import('@codemirror/legacy-modes/mode/css').then((mode) => mode.css),
  html: () => import('@codemirror/legacy-modes/mode/xml').then((mode) => mode.html),
  sql: () => import('@codemirror/legacy-modes/mode/sql').then((mode) => mode.standardSQL),
};

const aliases: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', typescript: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  rs: 'rust', rust: 'rust',
  py: 'python', python: 'python', python3: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', shellsession: 'shell',
  toml: 'toml',
  yml: 'yaml', yaml: 'yaml',
  go: 'go', golang: 'go',
  css: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  sql: 'sql',
};

/** Longer blocks stay plain: highlighting is a reading aid, not worth a stall. */
const HIGHLIGHT_LIMIT = 40_000;

export type HighlightRun = { text: string; className: string };

/** The canonical language a fence names, or null when it stays plain text. */
export function highlightLanguage(language: string | null): string | null {
  if (!language) return null;
  return aliases[language.trim().toLowerCase()] ?? null;
}

const languages = new Map<string, Promise<StreamLanguage<unknown>>>();

function languageOf(name: string): Promise<StreamLanguage<unknown>> {
  let found = languages.get(name);
  if (!found) {
    found = loaders[name]().then((parser) => StreamLanguage.define(parser));
    languages.set(name, found);
  }
  return found;
}

/** Highlighted runs for one block; null when the language is not one of the
 *  supported ones or the block is too long. */
export async function highlight(code: string, language: string | null): Promise<HighlightRun[] | null> {
  const name = highlightLanguage(language);
  if (!name || code.length > HIGHLIGHT_LIMIT) return null;
  const parser = (await languageOf(name)).parser;
  const tree = parser.parse(code);
  const runs: HighlightRun[] = [];
  highlightCode(code, tree, classHighlighter, (text, className) => {
    const last = runs[runs.length - 1];
    if (last && last.className === className) last.text += text;
    else runs.push({ text, className });
  }, () => {
    const last = runs[runs.length - 1];
    if (last && last.className === '') last.text += '\n';
    else runs.push({ text: '\n', className: '' });
  });
  return runs;
}
