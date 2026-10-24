import type { ITheme } from '@xterm/xterm';

export type TerminalTheme = 'dark' | 'light';
export type TerminalThemePreference = 'auto' | TerminalTheme;

function hexPair(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`;
}

function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 240-colour extended ANSI table (indices 16..255).
 * Dark-first TUIs paint prompt blocks with ANSI 232..238 dark-grey fills and bright 6x6x6 cube accents.
 * Remapping the dark-grey ramp to soft sage surfaces in light mode avoids harsh black highlight bars.
 */
function buildExtendedAnsi(mode: TerminalTheme): string[] {
  const cubeSteps = [0, 95, 135, 175, 215, 255];
  const out: string[] = [];
  for (let rIdx = 0; rIdx < 6; rIdx += 1) {
    for (let gIdx = 0; gIdx < 6; gIdx += 1) {
      for (let bIdx = 0; bIdx < 6; bIdx += 1) {
        let r = cubeSteps[rIdx];
        let g = cubeSteps[gIdx];
        let b = cubeSteps[bIdx];
        if (mode === 'light') {
          const lum = relLuminance(r, g, b);
          if (rIdx === gIdx && gIdx === bIdx && r < 80) {
            r = 228; g = 235; b = 226;
          } else if (lum > 0.34) {
            const scale = Math.min(0.72, (0.34 / lum) ** 0.52);
            r *= scale;
            g *= scale;
            b *= scale;
          }
        }
        out.push(rgbHex(r, g, b));
      }
    }
  }
  if (mode === 'light') {
    out.push(
      '#eef3ec', '#e9efe7', '#e4ebe2', '#dfe7dd', '#dae3d7', '#d4ded1', '#ced9cb', '#c6d2c3',
      '#76847b', '#6d7b72', '#647269', '#5c6960', '#536057', '#4b574f', '#434f47', '#3b463f',
      '#343e38', '#2e3731', '#28312b', '#232b26', '#1f2621', '#1b221e', '#181e1a', '#141a17',
    );
  } else {
    out.push(
      '#121313', '#161717', '#1a1b1b', '#1e1f1f', '#222323', '#262727', '#2a2b2b', '#2e2f2f',
      '#3a3b3b', '#464747', '#525353', '#5e5f5f', '#6a6b6b', '#767777', '#828383', '#8e8f8f',
      '#9a9b9b', '#a6a7a7', '#b2b3b3', '#bebfbf', '#cacbcb', '#d6d7d7', '#e2e3e3', '#eeeeee',
    );
  }
  return out;
}

const DARK_THEME: ITheme = {
  background: '#0c1110',
  foreground: '#eef3ef',
  cursor: '#7ce3a8',
  cursorAccent: '#0c1110',
  selectionBackground: '#7ce3a855',
  selectionInactiveBackground: '#7ce3a828',
  black: '#18201c',
  red: '#f38a84',
  green: '#82dba8',
  yellow: '#e5c07b',
  blue: '#8bb8f7',
  magenta: '#c9a7eb',
  cyan: '#74cfc4',
  white: '#d8e0db',
  brightBlack: '#7f8b84',
  brightRed: '#f7aaa5',
  brightGreen: '#a4e8c2',
  brightYellow: '#edd39a',
  brightBlue: '#b3cff9',
  brightMagenta: '#dcc2f2',
  brightCyan: '#9edfd7',
  brightWhite: '#ffffff',
  extendedAnsi: buildExtendedAnsi('dark'),
};

/** Light palette: "white" and extended 256-colour slots stay readable on a warm light canvas. */
const LIGHT_THEME: ITheme = {
  background: '#fbfcfa',
  foreground: '#17211c',
  cursor: '#0f7a48',
  cursorAccent: '#fbfcfa',
  selectionBackground: '#0f7a4838',
  selectionInactiveBackground: '#0f7a4818',
  black: '#17211c',
  red: '#b42318',
  green: '#0e6b40',
  yellow: '#8a5300',
  blue: '#1856a3',
  magenta: '#7a2f98',
  cyan: '#0a6b64',
  white: '#3a4740',
  brightBlack: '#55635b',
  brightRed: '#c43228',
  brightGreen: '#147a48',
  brightYellow: '#946000',
  brightBlue: '#1f68bc',
  brightMagenta: '#8d3eae',
  brightCyan: '#0b736c',
  brightWhite: '#1c241f',
  extendedAnsi: buildExtendedAnsi('light'),
};

export function terminalTheme(mode: TerminalTheme): ITheme {
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/** Light canvases get a contrast floor so pale true-colour output (syntax, dim hints) stays legible. */
export function contrastFloor(mode: TerminalTheme): number {
  return mode === 'light' ? 4.5 : 3;
}
