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
 * The palettes are generated, not hand-picked: a few OKLCH inputs per mode (canvas, ink, one
 * lightness and chroma per ANSI tier, fixed hue angles) produce every slot, the way Linear derives a
 * whole theme from base, accent and contrast. OKLCH is perceptually uniform, so one lightness per
 * tier keeps blue from reading darker than green (the "dimidium" problem). Chroma is reduced only as
 * far as each hue needs to stay inside sRGB.
 *
 * Targets come from APCA rather than WCAG 2 alone, because WCAG 2 overstates contrast on dark
 * canvases (an accent at 8.5:1 can sit at APCA Lc 58). Dark: accents ≥ Lc 60 (content text), hints
 * ≥ Lc 45, ink kept just under Lc 95 to avoid glare. Light: every text slot ≥ Lc 70.
 * Bright hues turn a few degrees from normal ones so the two tiers stay distinct (as Dimidium does).
 * Hue angles: red 25, yellow 82, green 150 (the app's pine accent), cyan 195, blue 255, magenta 322.
 */
type Oklch = readonly [number, number, number];

function oklchToLinear([l, c, h]: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH to sRGB hex, keeping lightness and hue and lowering chroma until the colour fits sRGB. */
export function oklchHex(color: Oklch): string {
  const [l, c, h] = color;
  let chroma = c;
  if (!inGamut(oklchToLinear([l, c, h]))) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear([l, mid, h]))) lo = mid; else hi = mid;
    }
    chroma = lo;
  }
  return toHex(oklchToLinear([l, chroma, h]).map((v) => {
    const x = Math.max(0, Math.min(1, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  }) as Rgb);
}

const HUE_ANGLES = [25, 150, 82, 255, 322, 195] as const;
const BRIGHT_HUE_TURN = 6;
const NEUTRAL_HUE = 160;

type PaletteSpec = {
  /** Canvas and cursor are the app's own `--term-bg` and `--accent`, so the chrome matches. */
  canvas: string;
  ink: Oklch;
  /** `black`: a raised surface on dark, the ink on light. */
  black: Oklch;
  /** `white`/`brightWhite` and `brightBlack` (hints, comments, timestamps). */
  white: Oklch;
  brightWhite: Oklch;
  hint: Oklch;
  normal: { l: number; c: number };
  bright: { l: number; c: number };
  cursor: string;
  /** Selection alpha (hex byte) for focused and unfocused panes. */
  selection: readonly [string, string];
};

function generateTheme(spec: PaletteSpec): ITheme {
  const tier = ({ l, c }: { l: number; c: number }, turn: number) =>
    HUE_ANGLES.map((h) => oklchHex([l, c, (h + turn) % 360])) as unknown as AnsiHues;
  const hues = tier(spec.normal, 0);
  const bright = tier(spec.bright, BRIGHT_HUE_TURN);
  const background = spec.canvas;
  const foreground = oklchHex(spec.ink);
  const cursor = spec.cursor;
  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: `${cursor}${spec.selection[0]}`,
    selectionInactiveBackground: `${cursor}${spec.selection[1]}`,
    black: oklchHex(spec.black),
    red: hues[0], green: hues[1], yellow: hues[2], blue: hues[3], magenta: hues[4], cyan: hues[5],
    white: oklchHex(spec.white),
    brightBlack: oklchHex(spec.hint),
    brightRed: bright[0], brightGreen: bright[1], brightYellow: bright[2], brightBlue: bright[3], brightMagenta: bright[4], brightCyan: bright[5],
    brightWhite: oklchHex(spec.brightWhite),
    extendedAnsi: generateExtendedAnsi(hues, background, foreground),
  };
}

const DARK_THEME = generateTheme({
  canvas: '#0c0f0e',
  ink: [0.93, 0.008, NEUTRAL_HUE],
  // Raised surface, so `black` fills (status bars, badges) stay visible on the canvas.
  black: [0.25, 0.012, NEUTRAL_HUE],
  white: [0.83, 0.012, NEUTRAL_HUE],
  brightWhite: [0.96, 0.006, NEUTRAL_HUE],
  hint: [0.67, 0.019, NEUTRAL_HUE],
  normal: { l: 0.8, c: 0.125 },
  bright: { l: 0.89, c: 0.085 },
  cursor: '#52c788',
  selection: ['4d', '24'],
});

/**
 * Light palette on a paper canvas. `white` and `brightWhite` stay greys (GitHub Light convention) so
 * `white` text stays readable and `47`/`107` fills still look like fills; black is the ink.
 */
const LIGHT_THEME = generateTheme({
  canvas: '#ffffff',
  ink: [0.22, 0.015, 157],
  black: [0.22, 0.015, 157],
  white: [0.54, 0.019, NEUTRAL_HUE],
  brightWhite: [0.66, 0.017, NEUTRAL_HUE],
  hint: [0.49, 0.021, NEUTRAL_HUE],
  normal: { l: 0.5, c: 0.15 },
  bright: { l: 0.545, c: 0.17 },
  cursor: '#1d7a52',
  selection: ['30', '16'],
});

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
