import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const style = readFileSync(new URL('src/style.css', root), 'utf8');
const editor = readFileSync(new URL('src/components/CodeEditor.css', root), 'utf8');
const domain = readFileSync(new URL('src/types/domain.ts', root), 'utf8');

const SA98G = {
  blkThrs: 0.022,
  blkClmp: 1.414,
  scaleBoW: 1.14,
  scaleWoB: 1.14,
  loBoWoffset: 0.027,
  loWoBoffset: 0.027,
  loClip: 0.1,
  deltaYmin: 0.0005,
  normBG: 0.56,
  normTXT: 0.57,
  revTXT: 0.62,
  revBG: 0.65,
};

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

function parseColor(value) {
  const modern = value.trim().match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)$/i);
  if (modern) return { rgb: [Number(modern[1]), Number(modern[2]), Number(modern[3])], alpha: Number(modern[4]) / 100 };
  return { rgb: hexBytes(value), alpha: 1 };
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

function y(rgb) {
  const exp = (channel) => (channel / 255) ** 2.4;
  return 0.2126729 * exp(rgb[0]) + 0.7151522 * exp(rgb[1]) + 0.072175 * exp(rgb[2]);
}

function lc(text, bg) {
  let txtY = y(text);
  let bgY = y(bg);
  if (Math.abs(bgY - txtY) < SA98G.deltaYmin) return 0;
  const clamp = (value) => (value > SA98G.blkThrs ? value : value + (SA98G.blkThrs - value) ** SA98G.blkClmp);
  txtY = clamp(txtY);
  bgY = clamp(bgY);
  if (bgY > txtY) {
    const sapc = (bgY ** SA98G.normBG - txtY ** SA98G.normTXT) * SA98G.scaleBoW;
    return (sapc < SA98G.loClip ? 0 : sapc - SA98G.loBoWoffset) * 100;
  }
  const sapc = (bgY ** SA98G.revBG - txtY ** SA98G.revTXT) * SA98G.scaleWoB;
  return (sapc > -SA98G.loClip ? 0 : sapc + SA98G.loWoBoffset) * 100;
}

function absLc(text, bg) {
  return Math.abs(lc(text, bg));
}

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

function atLeast(value, minimum, label) {
  assert.ok(value >= minimum, `${label} |Lc| ${value.toFixed(2)} is below ${minimum}`);
}

function inBand(value, low, high, label) {
  assert.ok(value >= low && value <= high, `${label} |Lc| ${value.toFixed(2)} is outside ${low}–${high}`);
}

const themes = [
  ['light', light, lightCode],
  ['dark', dark, darkCode],
];

test('body text stays inside the reading band on the page and the card', () => {
  for (const [name, theme] of themes) {
    const text = hexBytes(theme.text);
    for (const surface of ['bg', 'surface']) {
      const contrast = absLc(text, hexBytes(theme[surface]));
      inBand(contrast, 75, 90, `${name} --text on --${surface}`);
      assert.ok(wcag(text, hexBytes(theme[surface])) >= 4.5, `${name} --text on --${surface} is below 4.5:1`);
    }
  }
});

test('secondary and description text stay readable and strictly quieter than body text', () => {
  for (const [name, theme] of themes) {
    const card = hexBytes(theme.surface);
    const body = absLc(hexBytes(theme.text), card);
    const secondary = absLc(hexBytes(theme['text-2']), card);
    const description = absLc(hexBytes(theme['text-3']), card);
    assert.ok(body > secondary && secondary > description, `${name} card order ${body.toFixed(2)} > ${secondary.toFixed(2)} > ${description.toFixed(2)}`);
    for (const token of ['text-2', 'text-3']) {
      for (const surface of ['surface', 'sidebar']) {
        atLeast(absLc(hexBytes(theme[token]), hexBytes(theme[surface])), 75, `${name} --${token} on --${surface}`);
      }
    }
  }
});

test('emphasis text and emphasis buttons stay readable, with moss green dominant', () => {
  for (const [name, theme] of themes) {
    const accent = hexBytes(theme.accent);
    assert.ok(accent[1] > accent[0] && accent[1] > accent[2], `${name} accent is not green-dominant`);
    atLeast(absLc(hexBytes(theme['on-accent']), accent), 75, `${name} --on-accent on --accent`);
  }
  atLeast(absLc(hexBytes(dark.accent), hexBytes(dark.surface)), 75, 'dark --accent on --surface');
  assert.equal(light.success, light.accent);
  assert.equal(dark.success, dark.accent);
});

test('warning, danger, and info text stay readable on the page and the card', () => {
  const warning = absLc(hexBytes(dark.warning), hexBytes(dark.bg));
  const body = absLc(hexBytes(dark.text), hexBytes(dark.bg));
  atLeast(warning, 75, 'dark --warning on --bg');
  assert.ok(warning <= body, `dark warning |Lc| ${warning.toFixed(2)} exceeds body ${body.toFixed(2)}`);
  for (const [name, theme] of themes) {
    for (const token of ['warning', 'danger', 'info']) {
      for (const surface of ['bg', 'surface']) {
        atLeast(absLc(hexBytes(theme[token]), hexBytes(theme[surface])), 75, `${name} --${token} on --${surface}`);
      }
    }
    for (const token of ['accent', 'warning', 'danger', 'info']) {
      atLeast(absLc(hexBytes(theme[token]), hexBytes(theme[`${token}-soft`])), 75, `${name} --${token} on --${token}-soft`);
    }
  }
});

test('syntax colors stay distinct and readable on the editor surface', () => {
  for (const [name, theme, code] of themes) {
    const surface = hexBytes(theme['surface-2']);
    const colors = [code['code-property'], code['code-string'], code['code-literal']];
    assert.equal(new Set([...colors, theme.text]).size, 4, `${name} syntax colors collide with each other or body text`);
    for (const token of ['code-property', 'code-string', 'code-literal']) {
      atLeast(absLc(hexBytes(code[token]), surface), 75, `${name} --${token} on --surface-2`);
    }
  }
  assert.match(editor, /\.code-comment\s*\{[^}]*color:\s*var\(--text-3\)/);
  assert.equal(editor.includes('--code-comment'), false);
});

test('danger buttons and icon strokes follow the new text colors', () => {
  const lightInk = declaredColor(style, /\.confirmation-actions \.destructive[^{]*\{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/);
  const darkInk = declaredColor(style, /:root\[data-theme="dark"\] \.confirmation-actions \.destructive\s*\{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/);
  assert.equal(lightInk, '#fff');
  const darkInkRgb = hexBytes(darkInk);
  assert.ok(Math.max(...darkInkRgb) <= 80, `dark danger label ${darkInk} is not a dark ink`);
  atLeast(absLc(hexBytes('#ffffff'), hexBytes(light.danger)), 75, 'light danger button');
  atLeast(absLc(darkInkRgb, hexBytes(dark.danger)), 75, 'dark danger button');
  assert.equal(stroke(light.chevron), light['text-2']);
  assert.equal(stroke(light['search-icon']), light['text-3']);
  assert.equal(stroke(dark.chevron), dark['text-2']);
  assert.equal(stroke(dark['search-icon']), dark['text-3']);
});

test('surfaces, charts, font stacks, and theme count stay put', () => {
  const unchanged = {
    light: {
      bg: '#f6f5f2',
      sidebar: '#f0eee9',
      surface: '#fffcf8',
      'surface-2': '#f4f2ed',
      'surface-3': '#ebe8e2',
      'chart-input': '#4a78a8',
      'chart-output': '#3f8659',
      'chart-read': '#bd8a33',
      'chart-write': '#8266a8',
    },
    dark: {
      bg: '#141615',
      sidebar: '#191c1a',
      surface: '#1e221f',
      'surface-2': '#252a26',
      'surface-3': '#2e342f',
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

test('body text on the translucent selection stays inside the reading band', () => {
  assert.deepEqual(composite([46, 86, 68], [244, 242, 237], 0.1), [224, 226, 220]);
  for (const [name, theme] of themes) {
    const ring = parseColor(theme['accent-ring']);
    const text = hexBytes(theme.text);
    for (const surface of ['bg', 'surface', 'surface-2']) {
      const mixed = composite(ring.rgb, hexBytes(theme[surface]), ring.alpha);
      const body = absLc(text, mixed);
      inBand(body, 75, 90, `${name} --text on selection over --${surface}`);
      if (name === 'light') {
        for (const token of ['text-2', 'text-3', 'accent']) {
          const contrast = absLc(hexBytes(theme[token]), mixed);
          atLeast(contrast, 75, `light --${token} on selection over --${surface}`);
          assert.ok(contrast < body, `light --${token} on selection over --${surface} |Lc| ${contrast.toFixed(2)} is not below body ${body.toFixed(2)}`);
        }
      }
    }
  }
});

test('encoded selection composite keeps text readable on the third surface and soft status backgrounds', () => {
  const distance = (left, right) => Math.hypot(...left.map((channel, index) => channel - right[index]));
  const shift = (mixed, background) => Math.max(...mixed.map((channel, index) => Math.abs(channel - background[index])));
  for (const [name, theme] of themes) {
    const ring = parseColor(theme['accent-ring']);
    const accent = hexBytes(theme.accent);
    const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'].map((token) => hexBytes(theme[token]));
    const nearest = Math.min(...surfaces.map((surface) => distance(ring.rgb, surface)));
    assert.ok(nearest < distance(ring.rgb, accent), `${name} selection source stays near the surfaces`);
  }
  const lightRing = parseColor(light['accent-ring']);
  const lightSurface = hexBytes(light['surface-3']);
  const lightSurfaceMix = composite(lightRing.rgb, lightSurface, lightRing.alpha);
  assert.ok(shift(lightSurfaceMix, lightSurface) >= 8, 'light selection tint on --surface-3');
  for (const token of ['text', 'text-2', 'text-3']) {
    atLeast(absLc(hexBytes(light[token]), lightSurfaceMix), 75, `light --${token} on selection over --surface-3`);
  }
  for (const token of ['accent', 'danger', 'warning', 'info']) {
    const background = hexBytes(light[`${token}-soft`]);
    const mixed = composite(lightRing.rgb, background, lightRing.alpha);
    assert.ok(shift(mixed, background) >= 8, `light selection tint on --${token}-soft`);
    atLeast(absLc(hexBytes(light[token]), mixed), 75, `light --${token} on selection over --${token}-soft`);
  }
  const darkRing = parseColor(dark['accent-ring']);
  for (const token of ['accent', 'warning', 'info']) {
    const background = hexBytes(dark[`${token}-soft`]);
    const mixed = composite(darkRing.rgb, background, darkRing.alpha);
    assert.ok(shift(mixed, background) >= 8, `dark selection tint on --${token}-soft`);
    atLeast(absLc(hexBytes(dark[token]), mixed), 75, `dark --${token} on selection over --${token}-soft`);
  }
});

test('description text stays readable on the third surface', () => {
  for (const [name, theme] of themes) {
    atLeast(absLc(hexBytes(theme['text-3']), hexBytes(theme['surface-3'])), 75, `${name} --text-3 on --surface-3`);
  }
});

test('comments, syntax colors, and secondary text stay readable on selection and the cursor line', () => {
  const declared = editor.match(/\.cm-activeLine\s*\{[^}]*color-mix\(in srgb, var\(--accent\) ([\d.]+)%/);
  assert.ok(declared, 'cursor line accent mix');
  const cursorAlpha = Number(declared[1]) / 100;
  for (const [name, theme, code] of themes) {
    const ring = parseColor(theme['accent-ring']);
    const surface = hexBytes(theme['surface-2']);
    const selected = composite(ring.rgb, surface, ring.alpha);
    const cursorLine = composite(hexBytes(theme.accent), surface, cursorAlpha);
    if (name === 'dark') atLeast(absLc(hexBytes(theme.accent), selected), 75, 'dark --accent on selection over --surface-2');
    const samples = [
      ['text-2', hexBytes(theme['text-2'])],
      ['text-3', hexBytes(theme['text-3'])],
      ['code-property', hexBytes(code['code-property'])],
      ['code-string', hexBytes(code['code-string'])],
      ['code-literal', hexBytes(code['code-literal'])],
    ];
    for (const [token, rgb] of samples) {
      atLeast(absLc(rgb, selected), 75, `${name} --${token} on selection over --surface-2`);
      atLeast(absLc(rgb, cursorLine), 75, `${name} --${token} on the cursor line`);
    }
  }
});
