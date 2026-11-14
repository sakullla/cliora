import { useSyncExternalStore } from 'react';

export type TerminalThemePreference = 'auto' | 'dark' | 'light';
export type TerminalDensity = 'compact' | 'standard' | 'relaxed';

export const TERMINAL_FONT_SIZE_MIN = 12;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_LINE_HEIGHT: Record<TerminalDensity, number> = { compact: 1.2, standard: 1.35, relaxed: 1.5 };

export interface TerminalPreferences {
  fontSize: number;
  theme: TerminalThemePreference;
  density: TerminalDensity;
  cursorBlink: boolean;
  soundEnabled: boolean;
}

const FONT_SIZE_KEY = 'cliora:workbench-font-size';
const THEME_KEY = 'cliora:workbench-terminal-theme';
const DENSITY_KEY = 'cliora:workbench-density';
const CURSOR_BLINK_KEY = 'cliora:workbench-cursor-blink';
const SOUND_KEY = 'cliora:workbench-sound';

function read(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ }
}

function clampFontSize(raw: unknown): number {
  const size = Number(raw);
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.max(TERMINAL_FONT_SIZE_MIN, Math.min(TERMINAL_FONT_SIZE_MAX, Math.round(size)));
}

function readAll(): TerminalPreferences {
  const storedSize = read(FONT_SIZE_KEY);
  const size = Number(storedSize);
  const theme = read(THEME_KEY);
  const density = read(DENSITY_KEY);
  return {
    fontSize: storedSize !== null && Number.isInteger(size) && size >= TERMINAL_FONT_SIZE_MIN && size <= TERMINAL_FONT_SIZE_MAX ? size : TERMINAL_FONT_SIZE_DEFAULT,
    theme: theme === 'dark' || theme === 'light' ? theme : 'auto',
    density: density === 'compact' || density === 'relaxed' ? density : 'standard',
    cursorBlink: read(CURSOR_BLINK_KEY) !== 'false',
    soundEnabled: read(SOUND_KEY) !== 'false',
  };
}

let snapshot = readAll();
const listeners = new Set<() => void>();

function commit(next: TerminalPreferences) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeTerminalPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getTerminalPreferences(): TerminalPreferences {
  return snapshot;
}

/** One immutable snapshot per change, so a single hook can feed the workbench and the settings pane. */
export function useTerminalPreferences(): TerminalPreferences {
  return useSyncExternalStore(subscribeTerminalPreferences, getTerminalPreferences, getTerminalPreferences);
}

export function setTerminalFontSize(size: number) {
  const fontSize = clampFontSize(size);
  write(FONT_SIZE_KEY, String(fontSize));
  if (fontSize !== snapshot.fontSize) commit({ ...snapshot, fontSize });
}

export function setTerminalThemePreference(theme: TerminalThemePreference) {
  write(THEME_KEY, theme);
  if (theme !== snapshot.theme) commit({ ...snapshot, theme });
}

export function setTerminalDensity(density: TerminalDensity) {
  write(DENSITY_KEY, density);
  if (density !== snapshot.density) commit({ ...snapshot, density });
}

export function setTerminalCursorBlink(cursorBlink: boolean) {
  write(CURSOR_BLINK_KEY, String(cursorBlink));
  if (cursorBlink !== snapshot.cursorBlink) commit({ ...snapshot, cursorBlink });
}

export function setTerminalSoundEnabled(soundEnabled: boolean) {
  write(SOUND_KEY, String(soundEnabled));
  if (soundEnabled !== snapshot.soundEnabled) commit({ ...snapshot, soundEnabled });
}

// Another window (or a direct localStorage write elsewhere) keeps every subscriber in step.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && ![FONT_SIZE_KEY, THEME_KEY, DENSITY_KEY, CURSOR_BLINK_KEY, SOUND_KEY].includes(event.key)) return;
    const next = readAll();
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) commit(next);
  });
}
