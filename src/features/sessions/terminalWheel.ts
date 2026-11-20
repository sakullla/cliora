import { TERMINAL_SCROLL_MULTIPLIER, type TerminalScrollSpeed } from '../../lib/terminalPreferences';

/** Cap per-event TUI wheel bursts so a fast flick feels crisp without flooding a remote PTY. */
export const MAX_APP_WHEEL_STEPS = 6;
/** Reset fractional wheel remainder after an idle pause so the next scroll starts cleanly. */
const WHEEL_IDLE_RESET_MS = 250;
/** Target pixel distance per TUI wheel step at standard sensitivity (1x). */
const APP_WHEEL_PIXELS_PER_STEP = 32;

export interface WheelAccumulatorState {
  remainder: number;
  lastDirection: number;
  lastTimestamp: number;
}

export function createWheelAccumulator(): WheelAccumulatorState {
  return { remainder: 0, lastDirection: 0, lastTimestamp: 0 };
}

export function resetWheelAccumulator(state: WheelAccumulatorState): void {
  state.remainder = 0;
  state.lastDirection = 0;
  state.lastTimestamp = 0;
}

export type WheelInput = {
  deltaY: number;
  deltaMode: number;
  altKey?: boolean;
};

/**
 * Convert a browser WheelEvent into discrete mouse-wheel report steps for a mouse-tracking TUI
 * (Codex, Claude Code, Grok, tmux, etc.).
 *
 * Unlike xterm's built-in `consumeWheelEvent`, this does not attenuate trackpad deltas (< 50px)
 * by 0.3x and preserves magnitude above 1 step so both mouse wheels and trackpads scroll briskly.
 */
export function computeAppWheelSteps(
  state: WheelAccumulatorState,
  event: WheelInput,
  options: { rowHeight: number; rows: number; speed: TerminalScrollSpeed; now?: number },
): { direction: -1 | 1; steps: number } | null {
  if (!event.deltaY) return null;
  const now = options.now ?? performance.now();
  const direction: -1 | 1 = event.deltaY < 0 ? -1 : 1;
  if ((state.lastDirection && state.lastDirection !== direction) || (state.lastTimestamp && now - state.lastTimestamp > WHEEL_IDLE_RESET_MS)) {
    state.remainder = 0;
  }
  state.lastDirection = direction;
  state.lastTimestamp = now;

  const multiplier = TERMINAL_SCROLL_MULTIPLIER[options.speed] ?? TERMINAL_SCROLL_MULTIPLIER.standard;
  const boost = event.altKey ? 2.5 : 1;
  const absDelta = Math.abs(event.deltaY);

  let rawSteps: number;
  if (event.deltaMode === 1 /* DOM_DELTA_LINE */) {
    rawSteps = absDelta * 0.85 * multiplier * boost;
  } else if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) {
    rawSteps = Math.max(3, Math.round(options.rows * 0.45)) * absDelta * multiplier;
  } else {
    // DOM_DELTA_PIXEL: mouse wheels usually emit ~100-120px per notch, trackpads emit 2-40px per frame.
    const unit = Math.max(18, Math.min(APP_WHEEL_PIXELS_PER_STEP, options.rowHeight * 1.65));
    rawSteps = (absDelta / unit) * multiplier * boost;
  }

  state.remainder += rawSteps;
  const steps = Math.min(MAX_APP_WHEEL_STEPS, Math.floor(state.remainder));
  if (steps <= 0) return null;
  state.remainder = Math.min(state.remainder - steps, 0.99);
  return { direction, steps };
}

/**
 * Convert a browser WheelEvent into whole scrollback lines for normal-buffer scrolling.
 */
export function computeViewportWheelLines(
  state: WheelAccumulatorState,
  event: WheelInput,
  options: { rowHeight: number; viewportHeight: number; speed: TerminalScrollSpeed; now?: number },
): number {
  if (!event.deltaY) return 0;
  const now = options.now ?? performance.now();
  const direction = event.deltaY < 0 ? -1 : 1;
  if ((state.lastDirection && state.lastDirection !== direction) || (state.lastTimestamp && now - state.lastTimestamp > WHEEL_IDLE_RESET_MS)) {
    state.remainder = 0;
  }
  state.lastDirection = direction;
  state.lastTimestamp = now;

  const rowHeight = Math.max(1, options.rowHeight);
  const multiplier = TERMINAL_SCROLL_MULTIPLIER[options.speed] ?? TERMINAL_SCROLL_MULTIPLIER.standard;
  let amount = event.deltaY;
  if (event.deltaMode === 1 /* DOM_DELTA_LINE */) amount *= rowHeight * 1.2;
  else if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) amount *= Math.max(rowHeight, options.viewportHeight);
  if (event.altKey) amount *= 3;

  const lines = (Math.abs(amount) / rowHeight) * multiplier;
  state.remainder += lines;
  const whole = Math.floor(state.remainder);
  if (whole <= 0) {
    // Discrete wheel clicks (deltaMode !== pixel or large pixel notch) always move at least 1 line.
    if (event.deltaMode !== 0 || Math.abs(event.deltaY) >= 40) {
      state.remainder = 0;
      return direction;
    }
    return 0;
  }
  state.remainder = Math.min(state.remainder - whole, 0.99);
  return direction * whole;
}
