import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastFloor, generateExtendedAnsi, terminalTheme } from '../../src/features/sessions/terminalTheme.ts';

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_SLOTS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightBlack', 'foreground'];
const ACCENTS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

/** APCA 0.0.98G lightness contrast (|Lc|), which WCAG 2 overstates on dark canvases. */
function apca(text, background) {
  const y = (hex) => {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255) ** 2.4);
    const v = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    return v < 0.022 ? v + (0.022 - v) ** 1.414 : v;
  };
  const t = y(text);
  const bg = y(background);
  const s = bg > t ? (bg ** 0.56 - t ** 0.57) * 1.14 : (bg ** 0.65 - t ** 0.62) * 1.14;
  return Math.abs(s) < 0.1 ? 0 : Math.abs(s) * 100 - 2.7;
}

/** OKLCH lightness of a hex colour. */
function oklchL(hex) {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

for (const mode of ['dark', 'light']) {
  test(`${mode} terminal text meets APCA targets and each tier shares one OKLCH lightness`, () => {
    const theme = terminalTheme(mode);
    const minimum = mode === 'dark' ? { accent: 60, hint: 45 } : { accent: 70, hint: 70 };
    for (const slot of [...ACCENTS, ...ACCENTS.map((name) => `bright${name[0].toUpperCase()}${name.slice(1)}`)]) {
      assert.ok(apca(theme[slot], theme.background) >= minimum.accent, `${mode}.${slot} Lc ${apca(theme[slot], theme.background).toFixed(1)}`);
    }
    assert.ok(apca(theme.brightBlack, theme.background) >= minimum.hint, `${mode}.brightBlack Lc ${apca(theme.brightBlack, theme.background).toFixed(1)}`);
    // Ink stays below glare on the dark canvas.
    if (mode === 'dark') assert.ok(apca(theme.foreground, theme.background) < 95);
    for (const tier of [ACCENTS, ACCENTS.map((name) => `bright${name[0].toUpperCase()}${name.slice(1)}`)]) {
      const lightness = tier.map((slot) => oklchL(theme[slot]));
      assert.ok(Math.max(...lightness) - Math.min(...lightness) < 0.01, `${mode} tier lightness ${lightness.map((v) => v.toFixed(3)).join(', ')}`);
    }
  });
}

for (const mode of ['dark', 'light']) {
  test(`${mode} terminal accents and secondary text are readable without the contrast floor`, () => {
    const theme = terminalTheme(mode);
    for (const slot of TEXT_SLOTS) {
      assert.ok(contrast(theme[slot], theme.background) >= 4.5, `${mode}.${slot} ${theme[slot]} is ${contrast(theme[slot], theme.background).toFixed(2)}:1`);
    }
    assert.equal(contrastFloor(mode), 4.5);
  });

  test(`${mode} 256-colour palette is generated from the canvas, hues and ink`, () => {
    const theme = terminalTheme(mode);
    const ext = theme.extendedAnsi;
    assert.equal(ext.length, 240);
    assert.ok(ext.every((c) => /^#[0-9a-f]{6}$/.test(c)));
    // Cube corners: 16 is the canvas, 196/46/21 are the theme hues, 231 is the ink.
    assert.ok(contrast(ext[0], theme.background) < 1.02);
    assert.ok(contrast(ext[231 - 16], theme.foreground) < 1.02);
    assert.ok(contrast(ext[196 - 16], theme.red) < 1.02);
    assert.ok(contrast(ext[46 - 16], theme.green) < 1.02);
    assert.ok(contrast(ext[21 - 16], theme.blue) < 1.02);
    // The grey ramp moves monotonically from canvas to ink.
    const ramp = ext.slice(232 - 16).map(luminance);
    const step = mode === 'dark' ? (a, b) => b > a : (a, b) => b < a;
    for (let i = 1; i < ramp.length; i += 1) assert.ok(step(ramp[i - 1], ramp[i]), `${mode} ramp ${232 + i}`);
  });
}

test('dark-first TUI fills stay faint tints on the light canvas', () => {
  const light = terminalTheme('light').extendedAnsi;
  // 235 prompt bars and 22/52 diff rows must not become dark bands on paper.
  for (const index of [233, 234, 235, 236, 22, 52]) {
    assert.ok(luminance(light[index - 16]) > 0.55, `light ${index} ${light[index - 16]}`);
  }
  const dark = terminalTheme('dark').extendedAnsi;
  for (const index of [233, 234, 235, 236, 22, 52]) {
    assert.ok(luminance(dark[index - 16]) < 0.05, `dark ${index} ${dark[index - 16]}`);
  }
});

test('palette generation is deterministic for an arbitrary theme', () => {
  const hues = ['#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff'];
  assert.deepEqual(generateExtendedAnsi(hues, '#000000', '#ffffff'), generateExtendedAnsi(hues, '#000000', '#ffffff'));
  assert.equal(generateExtendedAnsi(hues, '#000000', '#ffffff')[0], '#000000');
  assert.equal(generateExtendedAnsi(hues, '#000000', '#ffffff')[215], '#ffffff');
});
