import type { ITheme } from '@xterm/xterm';

export type TerminalTheme = 'dark' | 'light';
export type TerminalThemePreference = 'auto' | TerminalTheme;

type Rgb = [number, number, number];
type Lab = [number, number, number];

/** ANSI 1..6 in palette order: red, green, yellow, blue, magenta, cyan. */
type AnsiHues = readonly [string, string, string, string, string, string];

function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  const pair = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

const D65: Rgb = [0.95047, 1, 1.08883];

function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const xyz = [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
  const [fx, fy, fz] = xyz.map((v, i) => {
    const t = v / D65[i];
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  });
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb([l, a, b]: Lab): Rgb {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const [x, y, z] = [fx, fy, fz].map((f, i) => {
    const t = f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27);
    return t * D65[i];
  });
  const lin = [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
  return lin.map((v) => {
    const c = Math.max(0, Math.min(1, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  }) as Rgb;
}

function lerpLab(t: number, from: Lab, to: Lab): Lab {
  return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1]), from[2] + t * (to[2] - from[2])];
}

/**
 * Builds ANSI 16..255 from the theme instead of xterm's fixed defaults.
 *
 * The 6x6x6 cube is a trilinear blend in CIELAB whose corners are the canvas background, the six
 * normal hues and the foreground; 232..255 runs from background to foreground. This is the
 * "harmonious" palette generation Ghostty, kitty and iTerm2 adopted
 * (https://gist.github.com/jake-stewart/0a8ea46159a7da2c808e5be2177e1783, public domain).
 * Low cube steps therefore stay near the canvas: dark-first TUIs that paint 22/52 diff rows or a
 * 235 prompt bar get faint tints on paper rather than black bars, and the same indices stay deep on
 * the dark canvas.
 */
export function generateExtendedAnsi(hues: AnsiHues, background: string, foreground: string): string[] {
  const corners = [background, ...hues, foreground].map((hex) => rgbToLab(parseHex(hex)));
  const out: string[] = [];
  for (let r = 0; r < 6; r += 1) {
    const c0 = lerpLab(r / 5, corners[0], corners[1]);
    const c1 = lerpLab(r / 5, corners[2], corners[3]);
    const c2 = lerpLab(r / 5, corners[4], corners[5]);
    const c3 = lerpLab(r / 5, corners[6], corners[7]);
    for (let g = 0; g < 6; g += 1) {
      const c4 = lerpLab(g / 5, c0, c1);
      const c5 = lerpLab(g / 5, c2, c3);
      for (let b = 0; b < 6; b += 1) out.push(toHex(labToRgb(lerpLab(b / 5, c4, c5))));
    }
  }
  for (let i = 0; i < 24; i += 1) out.push(toHex(labToRgb(lerpLab((i + 1) / 25, corners[0], corners[7]))));
  return out;
}

/*
 * Both palettes keep the six hues at one OKLCH lightness per tier, so blue no longer reads darker
 * than green and every accent clears WCAG 4.5:1 on its own canvas without the contrast floor.
 * Hue angles: red 25, yellow 80, green 152 (the app's pine accent), cyan 192, blue 255, magenta 318.
 * Dark: normal L 0.76, bright L 0.86. Light: normal L 0.50, bright L 0.545 with more chroma.
 */
function buildTheme(base: Omit<ITheme, 'extendedAnsi'>, hues: AnsiHues): ITheme {
  return { ...base, extendedAnsi: generateExtendedAnsi(hues, base.background!, base.foreground!) };
}

const DARK_HUES = ['#f4928a', '#72c78b', '#d7a956', '#7cb4fc', '#d198e3', '#55c6c2'] as const;

const DARK_THEME = buildTheme({
  background: '#0c0f0e',
  foreground: '#edf2ef',
  cursor: '#52c788',
  cursorAccent: '#0c0f0e',
  selectionBackground: '#52c7884d',
  selectionInactiveBackground: '#52c78824',
  // Raised surface, so `black` fills (status bars, badges) stay visible on the canvas.
  black: '#1c2420',
  red: DARK_HUES[0],
  green: DARK_HUES[1],
  yellow: DARK_HUES[2],
  blue: DARK_HUES[3],
  magenta: DARK_HUES[4],
  cyan: DARK_HUES[5],
  white: '#c9d3cd',
  // Secondary text (hints, comments, timestamps) at 5.5:1.
  brightBlack: '#7d8c83',
  brightRed: '#ffbfb8',
  brightGreen: '#a7e2b6',
  brightYellow: '#edcc94',
  brightBlue: '#b3d4fe',
  brightMagenta: '#e9c0f6',
  brightCyan: '#98e1dd',
  brightWhite: '#f6faf7',
}, DARK_HUES);

const LIGHT_HUES = ['#a83634', '#05773b', '#825b00', '#1762b6', '#854299', '#08726f'] as const;

/**
 * Light palette on a paper canvas. `white` and `brightWhite` stay greys (GitHub Light convention) so
 * `white` text stays readable and `47`/`107` fills still look like fills; black is the ink.
 */
const LIGHT_THEME = buildTheme({
  background: '#ffffff',
  foreground: '#141c17',
  cursor: '#1d7a52',
  cursorAccent: '#ffffff',
  selectionBackground: '#1d7a5230',
  selectionInactiveBackground: '#1d7a5216',
  black: '#141c17',
  red: LIGHT_HUES[0],
  green: LIGHT_HUES[1],
  yellow: LIGHT_HUES[2],
  blue: LIGHT_HUES[3],
  magenta: LIGHT_HUES[4],
  cyan: LIGHT_HUES[5],
  white: '#65726b',
  brightBlack: '#57655d',
  brightRed: '#bf3a39',
  brightGreen: '#058644',
  brightYellow: '#926701',
  brightBlue: '#136ed0',
  brightMagenta: '#9848af',
  brightCyan: '#08817e',
  brightWhite: '#8b978f',
}, LIGHT_HUES);

export function terminalTheme(mode: TerminalTheme): ITheme {
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/**
 * Contrast floor applied by xterm to every foreground, matching VS Code's terminal default (4.5).
 * It rescues pale true-colour output on paper and dark-blue syntax on the dark canvas; xterm halves
 * it for dim text so faint hints stay faint.
 */
export function contrastFloor(_mode: TerminalTheme): number {
  return 4.5;
}
