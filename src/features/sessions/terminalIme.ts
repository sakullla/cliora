import type { Terminal } from '@xterm/xterm';

/**
 * Workbench terminal IME ownership: one composition transaction decides what is
 * committed, and one anchor decides where the helper textarea (and with it the
 * system candidate window) sits. Both depend on xterm 6.0 private members; the
 * bridge is installed completely or not at all.
 */

type CompositionHelperInternals = {
  isComposing?: boolean;
  _isComposing?: boolean;
  _isSendingComposition?: boolean;
  _compositionView?: { classList?: { remove?: (name: string) => void } };
  compositionstart?: () => void;
  compositionupdate?: (event: Pick<CompositionEvent, 'data'>) => void;
  compositionend?: () => void;
  keydown?: (event: KeyboardEvent) => boolean;
  updateCompositionElements?: (dontRecurse?: boolean) => void;
};

type XtermCore = {
  _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } };
  _syncTextArea?: () => void;
  _compositionHelper?: CompositionHelperInternals;
  coreService?: { isCursorHidden?: boolean };
};

export type ImeBridgeStatus = { ok: true; missing: [] } | { ok: false; missing: string[] };

/** Check every xterm internal the IME bridge replaces or reads before touching any of them. */
export function inspectImeBridge(core: unknown): ImeBridgeStatus {
  const value = core as XtermCore | undefined;
  const missing: string[] = [];
  if (!value || typeof value !== 'object') return { ok: false, missing: ['_core'] };
  if (typeof value._syncTextArea !== 'function') missing.push('_syncTextArea');
  const helper = value._compositionHelper;
  if (!helper || typeof helper !== 'object') missing.push('_compositionHelper');
  else {
    for (const name of ['compositionstart', 'compositionupdate', 'compositionend', 'keydown', 'updateCompositionElements'] as const) {
      if (typeof helper[name] !== 'function') missing.push(`_compositionHelper.${name}`);
    }
    if (typeof helper._isComposing !== 'boolean') missing.push('_compositionHelper._isComposing');
    if (typeof helper._isSendingComposition !== 'boolean') missing.push('_compositionHelper._isSendingComposition');
    if (typeof helper._compositionView?.classList?.remove !== 'function') missing.push('_compositionHelper._compositionView');
  }
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}

export type ImeCell = { col: number; row: number };
export type ImePlacement = { left: number; top: number; width: number; height: number };

const clampInt = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(value)));

/**
 * Pixel placement for the helper textarea, or null while the layout cannot hold a
 * real anchor (hidden, zero height, unmeasured cells). The result always lies inside
 * the visible screen, so a grid that shrank under a held anchor is clamped back in.
 */
export function imePlacement(at: ImeCell, grid: { cols: number; rows: number }, cell: { width: number; height: number } | null,
  screen: { width: number; height: number }, width?: number): ImePlacement | null {
  if (!cell || !(cell.width > 0) || !(cell.height > 0)) return null;
  if (!(grid.cols > 0) || !(grid.rows > 0)) return null;
  if (!(screen.width >= cell.width) || !(screen.height >= cell.height)) return null;
  const col = clampInt(at.col, 0, grid.cols - 1);
  const row = clampInt(at.row, 0, grid.rows - 1);
  const boxWidth = Math.max(1, Math.min(width ?? cell.width, screen.width));
  const left = Math.max(0, Math.min(col * cell.width, screen.width - boxWidth));
  const top = Math.max(0, Math.min(row * cell.height, screen.height - cell.height));
  return { left, top, width: boxWidth, height: cell.height };
}

/** The input cell the TUI drew itself: one isolated blinking cell, else one isolated inverse cell. */
function drawnCursor(term: Terminal): ImeCell | null {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const side = buffer.getNullCell();
  let inverse: ImeCell | null = null;
  let blink: ImeCell | null = null;
  let inverseCount = 0;
  let blinkCount = 0;
  for (let row = term.rows - 1; row >= 0 && (inverseCount < 2 || blinkCount < 2); row -= 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    for (let col = 0; col < term.cols; col += 1) {
      const current = line.getCell(col, cell);
      if (!current) continue;
      const blinking = current.isBlink() !== 0;
      const marked = current.isInverse() !== 0;
      if (!blinking && !marked) continue;
      const left = col > 0 ? line.getCell(col - 1, side) : null;
      const leftBlink = !!left?.isBlink();
      const leftInverse = !!left?.isInverse();
      const right = col + 1 < term.cols ? line.getCell(col + 1, side) : null;
      if (blinking && !leftBlink && !right?.isBlink()) {
        blinkCount += 1;
        if (blinkCount === 1) blink = { col, row };
      }
      if (marked && !leftInverse && !right?.isInverse()) {
        inverseCount += 1;
        if (inverseCount === 1) inverse = { col, row };
      }
    }
  }
  if (blinkCount === 1) return blink;
  if (inverseCount === 1) return inverse;
  return null;
}

export type TerminalIme = {
  /** Whether xterm's internals matched; otherwise xterm's own IME handling is left untouched. */
  readonly status: ImeBridgeStatus;
  /** Re-place now, re-reading where input lands (also scans for a TUI-drawn cursor). */
  refresh: () => void;
  /** Re-place on the next frame; writes only when the placement really changes. */
  schedule: () => void;
  /** A composition is open on this terminal. */
  composing: () => boolean;
  /** Leaving the screen, losing input ownership: drop an unconfirmed composition, never send it later. */
  deactivate: () => void;
  dispose: () => void;
};

type Transaction = {
  /** Textarea offset where this composition's text begins. */
  start: number;
  state: 'composing' | 'ended';
  /** Text sent for this composition; null while the commit has not been observed. */
  committed: string | null;
  /** compositionend.data, only used to tell a cancel from a commit that the textarea has not shown yet. */
  endData: string;
};

/**
 * Composition transactions and helper-textarea placement for one workbench terminal.
 *
 * One composition sends its text exactly once, from the first event that shows the
 * committed text (normally compositionend). Keys pressed during the composition belong
 * to the IME and are never sent. A trailing insertText that repeats the commit before
 * any other keystroke is the same composition reported again and is absorbed once;
 * a new composition is always a new transaction, so a word confirmed twice is sent twice.
 * No decision depends on a timer.
 */
export function createTerminalIme(term: Terminal, options: {
  /** The terminal is on screen. */
  available: () => boolean;
  /** This terminal currently owns keyboard input (visible and focused textarea). */
  ownsInput: () => boolean;
  /** Element containing the terminal; capture listeners run before xterm's own. */
  host: HTMLElement;
}): TerminalIme {
  const core = (term as unknown as { _core?: XtermCore })._core;
  const status = inspectImeBridge(core);
  const textarea = term.textarea;
  if (!status.ok || !core || !textarea) {
    const missing = status.ok ? ['textarea'] : status.missing;
    options.host.dataset.imeBridge = 'unsupported';
    console.warn(`Workbench IME bridge not installed; xterm internals changed: ${missing.join(', ')}`);
    const noop = () => {};
    return { status: { ok: false, missing }, refresh: noop, schedule: noop, composing: () => false, deactivate: noop, dispose: noop };
  }
  options.host.dataset.imeBridge = 'ready';
  const helper = core._compositionHelper as Required<CompositionHelperInternals>;
  let disposed = false;
  let txn: Transaction | null = null;

  // ---------- placement ----------
  let anchor: ImeCell | null = null;
  let lastConfirmed: ImeCell | null = null;
  let applied = '';
  let frame = 0;
  const composingNow = () => txn?.state === 'composing';

  const cellSize = () => {
    const cell = core._renderService?.dimensions?.css?.cell;
    if (cell?.width && cell.height && cell.width > 0 && cell.height > 0) return { width: cell.width, height: cell.height };
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !term.cols || !term.rows || screen.clientWidth < 8) return null;
    return { width: screen.clientWidth / term.cols, height: screen.clientHeight / term.rows };
  };

  const inputCell = (scan: boolean): ImeCell => {
    const buffer = term.buffer.active;
    const hardware = {
      col: clampInt(buffer.cursorX, 0, Math.max(0, term.cols - 1)),
      row: clampInt(buffer.baseY + buffer.cursorY - buffer.viewportY, 0, Math.max(0, term.rows - 1)),
    };
    if (!core.coreService?.isCursorHidden) {
      lastConfirmed = hardware;
      return hardware;
    }
    // A full-screen CLI hid the hardware cursor and parks it anywhere, often 0,0.
    const drawn = scan ? drawnCursor(term) : null;
    if (drawn) {
      lastConfirmed = drawn;
      return drawn;
    }
    // No unique drawn cursor: keep the last input point this session confirmed.
    return lastConfirmed ?? hardware;
  };

  const apply = (scan: boolean) => {
    if (disposed || !options.available()) return;
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    // A hidden or collapsed terminal has no real input point. Writing one there is
    // what sends the candidate window to the window origin; wait for a valid layout.
    if (!screen || !textarea.isConnected || textarea.getClientRects().length === 0) { applied = ''; return; }
    const cell = cellSize();
    if (composingNow() && !anchor) anchor = inputCell(true);
    const at = composingNow() && anchor ? anchor : inputCell(scan);
    // The terminal element is the visible clip; the screen keeps its old size until fit runs.
    const element = term.element;
    const clipWidth = typeof element?.clientWidth === 'number' ? element.clientWidth : screen.clientWidth;
    const clipHeight = typeof element?.clientHeight === 'number' ? element.clientHeight : screen.clientHeight;
    const bounds = { width: Math.min(screen.clientWidth, clipWidth), height: Math.min(screen.clientHeight, clipHeight) };
    let width: number | undefined;
    const view = composingNow() ? term.element?.querySelector<HTMLElement>('.composition-view') : null;
    if (view && cell) {
      view.style.height = `${cell.height}px`;
      view.style.lineHeight = `${cell.height}px`;
      view.style.fontFamily = String(term.options.fontFamily ?? '');
      view.style.fontSize = `${term.options.fontSize ?? 14}px`;
      width = view.offsetWidth || undefined;
    }
    const placed = imePlacement(at, { cols: term.cols, rows: term.rows }, cell, bounds, width);
    if (!placed) { applied = ''; return; }
    if (view) {
      // Long composition text near the right edge stays inside the clip.
      view.style.left = `${placed.left}px`;
      view.style.top = `${placed.top}px`;
    }
    const key = `${Math.round(placed.left)}:${Math.round(placed.top)}:${Math.round(placed.width)}:${Math.round(placed.height)}`;
    // Rewriting the textarea on every frame restarts the Windows IME and drops the key
    // that would commit or insert punctuation, so only real moves are written.
    if (key === applied) return;
    applied = key;
    textarea.style.left = `${placed.left}px`;
    textarea.style.top = `${placed.top}px`;
    textarea.style.width = `${placed.width}px`;
    textarea.style.height = `${placed.height}px`;
    textarea.style.lineHeight = `${placed.height}px`;
    textarea.style.fontSize = `${term.options.fontSize ?? 14}px`;
    // WebView2 puts the candidate window at the window origin when this field is
    // opacity:0 or z-index:-5. Keep it on the input cell, with the text itself invisible.
    textarea.style.opacity = '1';
    textarea.style.color = 'transparent';
    textarea.style.caretColor = 'transparent';
    textarea.style.backgroundColor = 'transparent';
    textarea.style.zIndex = '1';
  };

  const schedule = () => {
    if (disposed || frame || !options.available()) return;
    frame = requestAnimationFrame(() => { frame = 0; apply(true); });
  };

  // ---------- composition transactions ----------
  const releaseHelper = () => {
    helper._isComposing = false;
    helper._isSendingComposition = false;
    helper._compositionView.classList?.remove?.('active');
  };
  const endPlacement = () => {
    anchor = null;
    schedule();
  };
  const commit = (current: Transaction, text: string) => {
    current.committed = text;
    // Public input path: onData, disableStdin and scroll-on-input behave like typing.
    term.input(text, true);
  };
  const cancel = () => {
    if (!txn) return;
    const wasComposing = txn.state === 'composing';
    txn = null;
    if (wasComposing) {
      releaseHelper();
      endPlacement();
    }
  };

  const originalStart = helper.compositionstart.bind(helper);
  const originalUpdate = helper.compositionupdate.bind(helper);
  const originalKeydown = helper.keydown.bind(helper);

  helper.compositionstart = () => {
    originalStart();
    txn = { start: textarea.value.length, state: 'composing', committed: null, endData: '' };
    // Typing reads the prompt, not the history: bring the input row back into view first.
    const buffer = term.buffer.active;
    if (buffer.viewportY < buffer.baseY) term.scrollToBottom();
    anchor = null;
    applied = '';
    apply(true);
  };
  helper.compositionupdate = (event) => {
    originalUpdate(event);
    apply(false);
  };
  helper.compositionend = () => {
    const current = txn;
    releaseHelper();
    if (!current || current.state !== 'composing') {
      // Already cancelled by blur or deactivation; nothing is sent afterwards.
      endPlacement();
      return;
    }
    if (!options.ownsInput()) {
      // Focus left before the IME finished: unconfirmed text stays out of every session.
      txn = null;
      endPlacement();
      return;
    }
    current.state = 'ended';
    const text = textarea.value.substring(current.start);
    if (text) commit(current, text);
    else if (!current.endData) txn = null; // Escape or an emptied composition.
    endPlacement();
  };
  helper.keydown = (event: KeyboardEvent) => {
    if (txn?.state === 'composing' || helper._isComposing) {
      // Space, Enter or a candidate digit confirm the candidate inside the IME. The
      // commit arrives as compositionend; sending here too produced 升级升级.
      return false;
    }
    return originalKeydown(event);
  };
  helper.updateCompositionElements = () => { if (composingNow()) apply(false); };
  // xterm calls this on cursor moves and renders; route it through the one placement.
  core._syncTextArea = () => { if (!composingNow()) schedule(); };

  const onCompositionEndData = (event: Event) => {
    if (event.target !== textarea || txn?.state !== 'composing') return;
    txn.endData = (event as CompositionEvent).data ?? '';
  };
  const onKeydown = (event: Event) => {
    // Any further keystroke closes an ended composition: later insertText is new input.
    if (event.target === textarea && txn?.state === 'ended') txn = null;
  };
  const onInput = (event: Event) => {
    const input = event as InputEvent;
    if (input.target !== textarea || input.inputType !== 'insertText') return;
    if (!options.ownsInput()) {
      // A hidden, ended or unfocused terminal never turns a late insertText into PTY input.
      event.stopImmediatePropagation();
      return;
    }
    const current = txn;
    if (current?.state === 'composing' || input.isComposing) {
      // Composition text belongs to the transaction; keep xterm's direct insertText sender out.
      event.stopImmediatePropagation();
      return;
    }
    if (current?.state !== 'ended') return;
    if (current.committed === null) {
      // compositionend reported a commit the textarea had not shown yet; this event shows it.
      txn = null;
      event.stopImmediatePropagation();
      const text = textarea.value.substring(current.start) || input.data || '';
      if (text && options.ownsInput()) commit(current, text);
      return;
    }
    txn = null;
    // WebView2 can report the committed text once more as insertText, in the same or a
    // later turn. Only that one repeat of this composition's own commit is absorbed.
    if (input.data === current.committed) event.stopImmediatePropagation();
  };
  const onBlur = () => cancel();
  const onFocus = () => { if (!composingNow()) applied = ''; apply(true); };

  options.host.addEventListener('compositionend', onCompositionEndData, true);
  options.host.addEventListener('keydown', onKeydown, true);
  options.host.addEventListener('input', onInput, true);
  textarea.addEventListener('blur', onBlur);
  textarea.addEventListener('focus', onFocus);

  return {
    status,
    refresh: () => { if (!composingNow()) applied = ''; apply(true); },
    schedule,
    composing: composingNow,
    deactivate: cancel,
    dispose: () => {
      if (disposed) return;
      cancel();
      disposed = true;
      cancelAnimationFrame(frame);
      options.host.removeEventListener('compositionend', onCompositionEndData, true);
      options.host.removeEventListener('keydown', onKeydown, true);
      options.host.removeEventListener('input', onInput, true);
      textarea.removeEventListener('blur', onBlur);
      textarea.removeEventListener('focus', onFocus);
    },
  };
}
