import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const modules = ['common', 'home', 'tools', 'library', 'records', 'settings', 'sessions'];
const languages = ['zh', 'en'];

function moduleFrom(source) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const bundles = {};
for (const language of languages) {
  bundles[language] = {};
  for (const name of modules) {
    const source = readFileSync(new URL(`src/i18n/locales/${language}/${name}.ts`, root), 'utf8');
    bundles[language][name] = (await moduleFrom(source)).default;
  }
}

function leafPaths(node, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') paths.push(...leafPaths(value, path));
    else paths.push(path);
  }
  return paths;
}

function resolve(bundle, key) {
  let node = bundle;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

// i18next resolves `t('a.b', { count })` through the plural forms `a.b_one` / `a.b_other`.
function hasLeaf(bundle, key) {
  if (typeof resolve(bundle, key) === 'string') return true;
  return ['zero', 'one', 'two', 'few', 'many', 'other'].some((form) => typeof resolve(bundle, `${key}_${form}`) === 'string');
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

const srcRoot = new URL('src/', root);
const references = [];
for (const file of sourceFiles(srcRoot)) {
  if (file.href.includes('/src/i18n/locales/')) continue;
  const text = readFileSync(file, 'utf8');
  const where = (index) => `${file.href.slice(root.href.length)}:${text.slice(0, index).split('\n').length}`;
  for (const match of text.matchAll(/\bt\(\s*(['"])([^'"\n]+)\1/g)) {
    // `t('a.b.' + value)` names a prefix object, like a template key.
    const key = match[2];
    if (key.endsWith('.')) references.push({ kind: 'prefix', key: key.slice(0, -1), at: where(match.index) });
    else references.push({ kind: 'literal', key, at: where(match.index) });
  }
  for (const match of text.matchAll(/\bi18nKey=(['"])([^'"\n]+)\1/g)) references.push({ kind: 'literal', key: match[2], at: where(match.index) });
  for (const match of text.matchAll(/\bt\(\s*`([^`]*)`/g)) {
    const template = match[1];
    const dynamic = template.indexOf('${');
    if (dynamic === -1) {
      references.push({ kind: 'literal', key: template, at: where(match.index) });
      continue;
    }
    const prefix = template.slice(0, dynamic).replace(/\.[^.]*$/, '');
    if (prefix) references.push({ kind: 'prefix', key: prefix, at: where(match.index) });
  }
}

test('zh and en declare the same key paths in all seven modules', () => {
  const gaps = [];
  for (const name of modules) {
    const zh = new Set(leafPaths(bundles.zh[name]));
    const en = new Set(leafPaths(bundles.en[name]));
    for (const path of zh) if (!en.has(path)) gaps.push(`en is missing ${name}.${path}`);
    for (const path of en) if (!zh.has(path)) gaps.push(`zh is missing ${name}.${path}`);
  }
  assert.deepEqual(gaps, []);
});

test('the source scan finds the translation calls it checks', () => {
  assert.ok(references.filter((item) => item.kind === 'literal').length > 100, 'literal t() keys were not found');
  assert.ok(references.some((item) => item.kind === 'prefix'), 'template t() keys were not found');
});

test('every status badge label exists in both languages', async () => {
  const source = readFileSync(new URL('src/lib/statusTone.ts', root), 'utf8');
  const { statusTable } = await moduleFrom(source);
  const missing = [];
  for (const [domain, states] of Object.entries(statusTable)) {
    for (const [state, { labelKey }] of Object.entries(states)) {
      for (const language of languages) if (!hasLeaf(bundles[language], labelKey)) missing.push(`${language}: ${domain}.${state} -> ${labelKey}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every literal key used in src exists in both languages', () => {
  const missing = [];
  for (const { kind, key, at } of references) {
    for (const language of languages) {
      const bundle = bundles[language];
      if (kind === 'literal') {
        if (!hasLeaf(bundle, key)) missing.push(`${language}: ${key} (${at})`);
      } else {
        const node = resolve(bundle, key);
        if (!node || typeof node !== 'object') missing.push(`${language}: ${key}.* (${at})`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
