import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const style = readFileSync(new URL('src/style.css', root), 'utf8');
const editor = readFileSync(new URL('src/components/CodeEditor.css', root), 'utf8');
const domain = readFileSync(new URL('src/types/domain.ts', root), 'utf8');
const tauriConfig = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));

function block(css, header) {
  const start = css.indexOf(header);
  assert.notEqual(start, -1, header);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  assert.fail(`unclosed ${header}`);
}

function variables(css, header) {
  const body = block(css, header);
  const vars = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[match[1]] = match[2].trim();
  return vars;
}

function hexBytes(value) {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  assert.ok(match, value);
  const digits = match[1].length === 3 ? match[1].replace(/./g, (char) => char + char) : match[1];
  return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16));
}

function stroke(value) {
  const match = value.match(/stroke='%23([0-9a-f]{6})'/i);
  assert.ok(match, value);
  return `#${match[1].toLowerCase()}`;
}

function declaredColor(css, pattern) {
  const match = css.match(pattern);
  assert.ok(match, pattern);
  return match[1].toLowerCase();
}

const light = variables(style, ':root {');
const dark = variables(style, ':root[data-theme="dark"] {');
const lightCode = variables(editor, '.code-editor {');
const darkCode = variables(editor, ':root[data-theme="dark"] .code-editor {');

function composite(foreground, background, alpha) {
  return foreground.map((channel, index) => {
    const mixed = channel * alpha + background[index] * (1 - alpha);
    return Math.min(255, Math.max(0, Math.round(mixed)));
  });
}

function wcag(text, bg) {
  const linear = (channel) => {
    const encoded = channel / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  const lighter = Math.max(luminance(text), luminance(bg));
  const darker = Math.min(luminance(text), luminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function ratioAtLeast(value, minimum, label) {
  assert.ok(value >= minimum, `${label} contrast ${value.toFixed(2)} is below ${minimum}:1`);
}

const themes = [
  ['light', light, lightCode],
  ['dark', dark, darkCode],
];
const surfaces = ['bg', 'sidebar', 'surface', 'surface-2', 'surface-3'];
const reading = ['text', 'text-2', 'text-3'];

test('body, secondary, and description text stay at WCAG 4.5:1 on every page surface', () => {
  for (const [name, theme] of themes) {
    for (const token of reading) {
      for (const surface of surfaces) {
        ratioAtLeast(wcag(hexBytes(theme[token]), hexBytes(theme[surface])), 4.5, `${name} --${token} on --${surface}`);
      }
    }
  }
});

test('body, secondary, and description text stay at WCAG 4.5:1 on the opaque selection', () => {
  for (const [name, theme] of themes) {
    const selection = hexBytes(theme.selection);
    for (const token of reading) {
      ratioAtLeast(wcag(hexBytes(theme[token]), selection), 4.5, `${name} --${token} on --selection`);
    }
  }
});

test('emphasis and status text stay at WCAG 4.5:1 on their backgrounds', () => {
  for (const [name, theme] of themes) {
    ratioAtLeast(wcag(hexBytes(theme['on-accent']), hexBytes(theme.accent)), 4.5, `${name} --on-accent on --accent`);
    for (const token of ['accent', 'success', 'warning', 'danger', 'info']) {
      ratioAtLeast(wcag(hexBytes(theme[token]), hexBytes(theme[`${token}-soft`])), 4.5, `${name} --${token} on --${token}-soft`);
    }
    for (const token of ['warning', 'danger', 'info']) {
      for (const surface of ['bg', 'surface']) {
        ratioAtLeast(wcag(hexBytes(theme[token]), hexBytes(theme[surface])), 4.5, `${name} --${token} on --${surface}`);
      }
    }
    ratioAtLeast(wcag(hexBytes(theme.warning), hexBytes(theme['surface-3'])), 4.5, `${name} --warning on --surface-3`);
  }
  ratioAtLeast(wcag(hexBytes(light.warning), hexBytes(light['accent-soft'])), 4.5, 'light --warning on --accent-soft');
  ratioAtLeast(wcag(hexBytes(dark.accent), hexBytes(dark.surface)), 4.5, 'dark --accent on --surface');
});

test('syntax colors stay distinct and at WCAG 4.5:1 on the editor surface', () => {
  for (const [name, theme, code] of themes) {
    const surface = hexBytes(theme['surface-2']);
    const colors = [code['code-property'], code['code-string'], code['code-literal']];
    assert.equal(new Set([...colors, theme.text]).size, 4, `${name} syntax colors collide with each other or body text`);
    for (const token of ['code-property', 'code-string', 'code-literal']) {
      ratioAtLeast(wcag(hexBytes(code[token]), surface), 4.5, `${name} --${token} on --surface-2`);
    }
  }
  assert.match(editor, /\.code-comment\s*\{[^}]*color:\s*var\(--text-3\)/);
  assert.equal(editor.includes('--code-comment'), false);
});

test('danger buttons and icon strokes follow the text colors', () => {
  const lightInk = declaredColor(style, /\.confirmation-actions \.destructive[^{]*\{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/);
  const darkInk = declaredColor(style, /:root\[data-theme="dark"\] \.confirmation-actions \.destructive\s*\{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/);
  assert.equal(lightInk, '#fff');
  const darkInkRgb = hexBytes(darkInk);
  assert.ok(Math.max(...darkInkRgb) <= 80, `dark danger label ${darkInk} is not a dark ink`);
  ratioAtLeast(wcag(hexBytes('#ffffff'), hexBytes(light.danger)), 4.5, 'light danger button');
  ratioAtLeast(wcag(darkInkRgb, hexBytes(dark.danger)), 4.5, 'dark danger button');
  assert.equal(stroke(light.chevron), light['text-2']);
  assert.equal(stroke(light['search-icon']), light['text-3']);
  assert.equal(stroke(dark.chevron), dark['text-2']);
  assert.equal(stroke(dark['search-icon']), dark['text-3']);
});

test('charts, font stacks, and theme count stay put', () => {
  const unchanged = {
    light: {
      'chart-input': '#4a78a8',
      'chart-output': '#3f8659',
      'chart-read': '#bd8a33',
      'chart-write': '#8266a8',
    },
    dark: {
      'chart-input': '#7fb0e0',
      'chart-output': '#8fb59a',
      'chart-read': '#e0b96a',
      'chart-write': '#b5a1e0',
    },
  };
  for (const [token, value] of Object.entries(unchanged.light)) assert.equal(light[token], value, `light --${token}`);
  for (const [token, value] of Object.entries(unchanged.dark)) assert.equal(dark[token], value, `dark --${token}`);
  assert.equal(light['font-sans'], '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif');
  assert.equal(light['font-mono'], '"Cascadia Code", "JetBrains Mono", Consolas, "SF Mono", "SFMono-Regular", Menlo, monospace');
  assert.match(style, /font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;/);
  assert.match(domain, /export type Theme = 'system' \| 'light' \| 'dark';/);
});

test('static window background matches the declared light page background', () => {
  const background = tauriConfig.app.windows[0].backgroundColor;
  assert.equal(String(background).toLowerCase(), light.bg.toLowerCase());
});

test('error paths and active line numbers stay readable on their resting tints', () => {
  const declaredMix = (css, pattern) => {
    const match = css.match(pattern);
    assert.ok(match, pattern);
    return Number(match[1]) / 100;
  };
  const dangerMix = declaredMix(style, /\.error-banner code\s*\{[^}]*color-mix\(in srgb, var\(--danger\) ([\d.]+)%/);
  const gutterMix = declaredMix(editor, /\.cm-activeLineGutter\s*\{[^}]*color-mix\(in srgb, var\(--accent\) ([\d.]+)%/);
  assert.match(style, /\.error-banner code\s*\{[^}]*color:\s*var\(--text-2\)/);
  assert.match(editor, /\.cm-activeLineGutter\s*\{[^}]*color:\s*var\(--text-2\)/);
  for (const [name, theme] of themes) {
    const path = composite(hexBytes(theme.danger), hexBytes(theme['danger-soft']), dangerMix);
    ratioAtLeast(wcag(hexBytes(theme['text-2']), path), 4.5, `${name} --text-2 on the error path`);
    const gutter = composite(hexBytes(theme.accent), hexBytes(theme['surface-2']), gutterMix);
    ratioAtLeast(wcag(hexBytes(theme['text-2']), gutter), 4.5, `${name} --text-2 on the active line number`);
  }
});

test('toast icons stay readable on their resting tint', () => {
  const declaredMix = (pattern) => {
    const match = style.match(pattern);
    assert.ok(match, pattern);
    return Number(match[1]) / 100;
  };
  const surfaceMix = declaredMix(/\.toast\s*\{[^}]*color-mix\(in srgb, var\(--surface\) ([\d.]+)%/);
  const toneMix = declaredMix(/\.toast-icon\s*\{[^}]*color-mix\(in srgb, var\(--toast-tone\) ([\d.]+)%/);
  assert.match(style, /\.toast-icon\s*\{[^}]*color:\s*var\(--toast-tone\)/);
  for (const [name, theme] of themes) {
    for (const backdrop of ['bg', 'surface', 'surface-2', 'surface-3']) {
      const toast = composite(hexBytes(theme.surface), hexBytes(theme[backdrop]), surfaceMix);
      for (const tone of ['accent', 'danger', 'warning', 'info']) {
        const icon = composite(hexBytes(theme[tone]), toast, toneMix);
        ratioAtLeast(wcag(hexBytes(theme[tone]), icon), 4.5, `${name} --${tone} on the toast icon over --${backdrop}`);
      }
    }
  }
});

test('conflict diff marks keep body text readable at rest', () => {
  const compare = readFileSync(new URL('src/components/configuration/ConflictCompare.module.css', root), 'utf8');
  const declaredMix = (kind, token) => {
    const match = compare.match(new RegExp(String.raw`\.row\[data-kind='${kind}'\] mark \{[^}]*color-mix\(in srgb, var\(--${token}\) ([\d.]+)%`));
    assert.ok(match, `${kind} mark mix`);
    return Number(match[1]) / 100;
  };
  const marks = [
    ['delete', 'danger'],
    ['insert', 'accent'],
  ];
  const resting = {};
  for (const [name, theme] of themes) {
    const text = hexBytes(theme.text);
    for (const [kind, token] of marks) {
      const row = hexBytes(theme[`${token}-soft`]);
      const rest = composite(hexBytes(theme[token]), row, declaredMix(kind, token));
      if (name === 'light') resting[kind] = rest;
      ratioAtLeast(wcag(text, rest), 4.5, `${name} --text on the ${kind} mark`);
    }
  }
  assert.ok(
    resting.delete[0] - resting.delete[1] > resting.insert[0] - resting.insert[1],
    'deletion and insertion marks stay distinguishable',
  );
});

test('comments, syntax colors, and secondary text stay readable on the cursor line', () => {
  const declared = editor.match(/\.cm-activeLine\s*\{[^}]*color-mix\(in srgb, var\(--accent\) ([\d.]+)%/);
  assert.ok(declared, 'cursor line accent mix');
  const cursorAlpha = Number(declared[1]) / 100;
  for (const [name, theme, code] of themes) {
    const surface = hexBytes(theme['surface-2']);
    const cursorLine = composite(hexBytes(theme.accent), surface, cursorAlpha);
    const samples = [
      ['text-2', hexBytes(theme['text-2'])],
      ['text-3', hexBytes(theme['text-3'])],
      ['code-property', hexBytes(code['code-property'])],
      ['code-string', hexBytes(code['code-string'])],
      ['code-literal', hexBytes(code['code-literal'])],
    ];
    for (const [token, rgb] of samples) {
      ratioAtLeast(wcag(rgb, cursorLine), 4.5, `${name} --${token} on the cursor line`);
    }
  }
});
