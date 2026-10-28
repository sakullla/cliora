import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const entry = new URL('src/style.css', root);

/** Relative paths (from the repository root) of the stylesheets src/style.css imports, in cascade order. */
export function styleImports() {
  const text = readFileSync(entry, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?\s*;/g)]
    .map((match) => new URL(match[1], entry).href.slice(root.href.length));
}

/** The application stylesheet as the browser receives it: every @import of src/style.css concatenated in order. */
export function styleSource() {
  const own = readFileSync(entry, 'utf8').replace(/@import\s+[^;]+;/g, '');
  return [...styleImports().map((path) => readFileSync(new URL(path, root), 'utf8')), own].join('\n');
}
