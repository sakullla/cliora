import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Literal rules for colors, corner radii and spacing (02 ADR-1). Files whose first line is the
// pending marker have not been moved onto the tokens yet and are skipped.
const root = new URL('../../', import.meta.url);
const PENDING = '/* style-tokens: pending */';

// Files this rule already covers; they must never carry the pending marker.
const migrated = [
  /^src\/styles\/(?!pages\/)[^/]+\.css$/,
  /^src\/components\/ui\/.+\.css$/,
  /^src\/components\/(CodeEditor\.css|MarkdownView\.module\.css|RowMenu\.module\.css|FilterSelect\.module\.css)$/,
];

const namedColors = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));

function cssFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...cssFiles(path));
    else if (entry.name.endsWith('.css')) files.push(path.href.slice(root.href.length));
  }
  return files.sort();
}

function isPending(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].trim() === PENDING;
}

// Split on a separator outside quotes and parentheses.
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && separator.test(char)) {
      parts.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), offset: start });
  return parts;
}

/** Declarations of every innermost block, with their line numbers. */
export function declarations(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const list = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const bodyStart = block.index + 1;
    for (const part of splitTop(block[1], /;/)) {
      const colon = part.text.indexOf(':');
      if (colon === -1) continue;
      const property = part.text.slice(0, colon).trim().toLowerCase();
      const value = part.text.slice(colon + 1).trim();
      if (!property || !value) continue;
      const leading = part.text.length - part.text.trimStart().length;
      const line = text.slice(0, bodyStart + part.offset + leading).split('\n').length;
      list.push({ property, value, line });
    }
  }
  return list;
}

const stripImportant = (value) => value.replace(/!\s*important\s*$/i, '').trim();
const isVar = (part) => /^var\(\s*--[\w-]+\s*\)$/.test(part);

function colorIssue(file, property, value) {
  if (/^(-webkit-)?mask(-|$)/.test(property)) return null;
  if (property.startsWith('--')) {
    if (file === 'src/styles/tokens.css' || file === 'src/components/CodeEditor.css') return null;
    if (file.endsWith('/SessionWorkbench.module.css') && /^--(term|wb)-/.test(property)) return null;
  }
  const bare = value
    .replace(/url\((?:[^()'"]|'[^']*'|"[^"]*")*\)/gi, 'url()')
    .replace(/'[^']*'|"[^"]*"/g, "''");
  if (/#[0-9a-f]{3,8}\b/i.test(bare)) return 'hex color';
  if (/(^|[^\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(bare)) return 'color function';
  for (const word of bare.matchAll(/(^|[^\w-])([a-z]+)(?![\w-])/gi)) {
    if (namedColors.has(word[2].toLowerCase())) return `named color ${word[2]}`;
  }
  return null;
}

function radiusIssue(property, value) {
  if (!/^border(-[a-z]+)*-radius$/.test(property)) return null;
  const parts = splitTop(stripImportant(value), /[\s/]/).map((part) => part.text).filter(Boolean);
  const ok = parts.every((part) => part === '0' || part === '50%' || part === 'inherit' || /^var\(\s*--[\w-]*radius[\w-]*\s*\)$/.test(part));
  return ok ? null : 'radius literal';
}

function calcAllowed(part) {
  const inner = part.slice(5, -1)
    .replace(/var\(\s*--[\w-]+\s*\)/g, ' ')
    .replace(/(^|[^\w.])-?\d+(\.\d+)?%/g, '$1 ')
    .replace(/(^|[\s(*/+])-1(?=[\s)]|$)/g, '$1 ')
    .replace(/[\s()*/+-]/g, '');
  return inner === '';
}

function spacingIssue(property, value) {
  if (!/^(padding|margin)(-[a-z]+)*$/.test(property) && !/^(gap|row-gap|column-gap)$/.test(property)) return null;
  const parts = splitTop(stripImportant(value), /\s/).map((part) => part.text).filter(Boolean);
  const ok = parts.every((part) => ['0', 'auto', '1px', 'inherit', 'initial', 'unset'].includes(part)
    || /^\d+(\.\d+)?%$/.test(part)
    || isVar(part)
    || (/^calc\(.*\)$/.test(part) && calcAllowed(part)));
  return ok ? null : 'spacing literal';
}

export function violations(file, css) {
  const found = [];
  for (const { property, value, line } of declarations(css)) {
    const issue = colorIssue(file, property, value) ?? radiusIssue(property, value) ?? spacingIssue(property, value);
    if (issue) found.push(`${file}:${line} ${property}: ${value} (${issue})`);
  }
  return found;
}

const files = cssFiles(new URL('src/', root));

test('the rules reject literals and accept tokens', () => {
  const bad = [
    '.a { color: #fff; }',
    '.a { background: rgb(0 0 0 / 20%); }',
    '.a { border-color: white; }',
    '.a { box-shadow: 0 1px 2px rgb(0 0 0 / 22%); }',
    '.a { border-radius: 6px; }',
    '.a { border-top-left-radius: 99px; }',
    '.a { padding: 0 13px; }',
    '.a { margin-top: -4px; }',
    '.a { gap: 8px; }',
    '.a { column-gap: 1em; }',
    '.a { margin: calc(var(--space-2) + 3px); }',
  ];
  for (const css of bad) assert.equal(violations('src/x.css', css).length, 1, css);
  const good = [
    '.a { color: var(--text); background: transparent; border-color: currentColor; fill: inherit; }',
    '.a { background: color-mix(in srgb, var(--accent) 12%, transparent); }',
    '.a { -webkit-mask: url("data:image/svg+xml,%3Csvg stroke=\'black\' fill=\'%23fff\'/%3E") center / contain no-repeat; }',
    '.a { border-radius: var(--radius-sm); border-radius: 0 0 var(--radius) var(--radius); border-radius: 50%; border-radius: inherit; }',
    '.a { padding: 0 var(--space-3); margin: 0 auto; gap: var(--space-1) var(--space-2); padding: 1px; margin: 100%; }',
    '.a { margin: calc(var(--space-2) * -1); padding-top: calc(var(--titlebar-h) + var(--space-4)); margin-left: calc(50% - var(--space-2)); }',
    '.a { top: 13px; inset: 0 4px; width: 12px; }',
  ];
  for (const css of good) assert.deepEqual(violations('src/x.css', css), [], css);
  assert.deepEqual(violations('src/styles/tokens.css', ':root { --bg: #f7f8f6; --shadow-xs: 0 1px 1px rgb(16 24 20 / 4%); }'), []);
  assert.equal(violations('src/x.css', ':root { --bg: #f7f8f6; }').length, 1);
  assert.deepEqual(violations('src/features/sessions/SessionWorkbench.module.css', '.t { --term-bg: #000; --wb-line: rgb(1 2 3); }'), []);
  assert.equal(violations('src/features/sessions/SessionWorkbench.module.css', '.t { --other: #000; }').length, 1);
});

test('migrated stylesheets carry no pending marker', () => {
  const covered = files.filter((file) => migrated.some((pattern) => pattern.test(file)));
  assert.ok(covered.includes('src/styles/tokens.css'), 'src/styles/tokens.css is missing');
  for (const file of covered) assert.equal(isPending(readFileSync(new URL(file, root), 'utf8')), false, `${file} is marked pending`);
});

test('stylesheets outside the pending set use tokens for colors, radii and spacing', () => {
  const found = [];
  for (const file of files) {
    const css = readFileSync(new URL(file, root), 'utf8');
    if (isPending(css)) continue;
    found.push(...violations(file, css));
  }
  assert.deepEqual(found, []);
});
