/**
 * Command phases (OSC 133) and program progress (OSC 9;4) as one per-session state.
 *
 * Both sequences describe the program that printed them, never the AI task: a clean command exit is
 * not a delivered task, a progress error is not a crashed session, and a full bar is not approval
 * waiting. The workbench projects this state next to the shared task state instead of inside it.
 *
 * https://iterm2.com/documentation-escape-codes.html (OSC 133)
 * https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences (OSC 9;4)
 */

export type CommandPhase = 'prompt' | 'input' | 'running' | 'finished';

export type ProgressKind = 'normal' | 'error' | 'indeterminate' | 'warning';

export type TerminalProgress = {
  kind: ProgressKind;
  /** 0..100 when the program reported one; null for a bar without a position. */
  percent: number | null;
};

/** What the terminal knows about the command cycle of one session. */
export type TerminalCommandState = {
  phase: CommandPhase;
  /** Exit code of the command that just ended; null while unknown or when nothing ran. */
  exitCode: number | null;
  /** A D marker ended a command that actually started executing. */
  finished: boolean;
  progress: TerminalProgress | null;
};

/** A terminal that has printed no marker yet: no command, no program progress. */
export const idleCommandState: TerminalCommandState = Object.freeze({
  phase: 'prompt' as CommandPhase,
  exitCode: null,
  finished: false,
  progress: null,
});

export type CommandMarker =
  | { kind: 'prompt' }
  | { kind: 'input' }
  | { kind: 'executing' }
  | { kind: 'finished'; exitCode: number | null };

const MAX_EXIT_CODE = 255;

/** A three-digit parameter is the only shape a real exit code takes; anything else is unknown. */
function exitCodeOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const code = Number(text);
  return code <= MAX_EXIT_CODE ? code : null;
}

/**
 * The OSC 133 payload after the sequence number: `A`, `B`, `C`, `D;1`, `A;cl=m`.
 * Shell-integration parameters (and the `133;P` / `133;$` extensions) are not command facts.
 */
export function parseCommandMarker(payload: string): CommandMarker | null {
  const parts = payload.split(';');
  switch ((parts[0] ?? '').trim()) {
    case 'A': return { kind: 'prompt' };
    case 'B': return { kind: 'input' };
    case 'C': return { kind: 'executing' };
    case 'D': return { kind: 'finished', exitCode: exitCodeOf(parts[1]) };
    default: return null;
  }
}

const CLEARED: Pick<TerminalCommandState, 'phase' | 'finished' | 'exitCode'> = {
  phase: 'prompt',
  finished: false,
  exitCode: null,
};

/**
 * A marker only ever moves the cycle forward. A late `B` never turns an executing command back into
 * an editable prompt, and a `D` that no `C` preceded clears the mark instead of recording a result:
 * an abandoned input line and an orphan end marker both must not claim a command succeeded.
 */
export function applyCommandMarker(state: TerminalCommandState, marker: CommandMarker): TerminalCommandState {
  switch (marker.kind) {
    case 'prompt':
      // A new prompt owns the cycle: the previous result is no longer the current one.
      return state.phase === 'prompt' && !state.finished && state.exitCode === null ? state : { ...state, ...CLEARED };
    case 'input':
      // A late B after C or D must not turn an executing or finished command back into an editable line.
      return state.phase === 'prompt' ? { ...state, phase: 'input' } : state;
    case 'executing':
      // C alone is enough: a shell without B still starts executing.
      return state.phase === 'running' ? state : { ...state, phase: 'running' };
    case 'finished':
      if (state.phase === 'running') return { ...state, phase: 'finished', finished: true, exitCode: marker.exitCode };
      // A repeated end marker adds no fact, and an end without C clears the mark.
      return state.phase === 'finished' ? state : { ...state, ...CLEARED };
  }
}

export type ProgressUpdate = { kind: 'clear' } | { kind: 'set'; progress: TerminalProgress };

const PROGRESS_KINDS: Record<string, ProgressKind> = {
  '1': 'normal',
  '2': 'error',
  '3': 'indeterminate',
  '4': 'warning',
};

/**
 * OSC 9 also carries notifications (`9;Build finished`); only `9;4;<state>[;<percent>]` is progress.
 * An unknown state or an out-of-range percentage returns null so the reported bar stays as it was
 * rather than inventing a position.
 */
export function parseProgressReport(payload: string): ProgressUpdate | null {
  const parts = payload.split(';');
  if ((parts[0] ?? '').trim() !== '4') return null;
  const state = (parts[1] ?? '').trim();
  if (state === '0') return { kind: 'clear' };
  const kind = PROGRESS_KINDS[state];
  if (!kind) return null;
  const percentText = (parts[2] ?? '').trim();
  let percent: number | null = null;
  if (percentText) {
    if (!/^\d{1,3}$/.test(percentText)) return null;
    const value = Number(percentText);
    if (value > 100) return null;
    percent = value;
  }
  // State 1 is a determined bar; without a readable percentage it would claim a position.
  if (kind === 'normal' && percent === null) return null;
  if (kind === 'indeterminate') return { kind: 'set', progress: { kind, percent: null } };
  return { kind: 'set', progress: { kind, percent } };
}

/** Only state 0 clears a bar: a finished command must not silently rewrite the program's own report. */
export function applyProgressReport(state: TerminalCommandState, update: ProgressUpdate): TerminalCommandState {
  if (update.kind === 'clear') return state.progress === null ? state : { ...state, progress: null };
  const current = state.progress;
  if (current && current.kind === update.progress.kind && current.percent === update.progress.percent) return state;
  return { ...state, progress: update.progress };
}

/** Identity of a state, so a repaint of the same bytes publishes nothing new. */
export function commandStateKey(state: TerminalCommandState): string {
  const progress = state.progress ? `${state.progress.kind}:${state.progress.percent ?? ''}` : '';
  return `${state.phase}|${state.exitCode ?? ''}|${state.finished ? 1 : 0}|${progress}`;
}

export type CommandHint = {
  /** i18n key of the visible and accessible wording. */
  key: string;
  params?: Record<string, number>;
  /** A semantic slot for styling; the wording never depends on colour alone. */
  tone: 'progress' | 'error' | 'warning' | 'indeterminate' | 'failed' | 'running' | 'unknown';
};

/**
 * What the user needs to be told, if anything. A successful command and a plain prompt stay quiet:
 * only progress, a failure, an unknown result or an executing command earn room.
 */
export function commandHint(state: TerminalCommandState | null): CommandHint | null {
  if (!state) return null;
  const progress = state.progress;
  if (progress) {
    if (progress.kind === 'normal') return { key: 'sessions.commandProgress', params: { percent: progress.percent ?? 0 }, tone: 'progress' };
    if (progress.kind === 'indeterminate') return { key: 'sessions.commandProgressIndeterminate', tone: 'indeterminate' };
    if (progress.kind === 'warning') return { key: 'sessions.commandProgressWarning', tone: 'warning' };
    return { key: 'sessions.commandProgressError', tone: 'error' };
  }
  if (state.phase === 'finished') {
    if (state.exitCode === null) return { key: 'sessions.commandResultUnknown', tone: 'unknown' };
    if (state.exitCode !== 0) return { key: 'sessions.commandExit', params: { code: state.exitCode }, tone: 'failed' };
    return null;
  }
  if (state.phase === 'running') return { key: 'sessions.commandRunning', tone: 'running' };
  return null;
}
