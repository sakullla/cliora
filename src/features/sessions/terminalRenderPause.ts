import type { Terminal } from '@xterm/xterm';

type SelectionPoint = [number, number] | undefined;
type SelectionArgs = [start: SelectionPoint, end: SelectionPoint, columnSelectMode: boolean];
type SelectionRedraw = (...args: SelectionArgs) => void;
type RenderServiceLike = { handleSelectionChanged: SelectionRedraw };

/**
 * Hold xterm's selection redraw while a pane is hidden.
 *
 * Verified against @xterm/xterm 6.0.0. Every scroll, including each line feed
 * that scrolls output, calls SelectionService.refresh (CoreBrowserTerminal.ts,
 * `Event.any(this._onScroll.event, this._inputHandler.onScroll)`). Its frame
 * calls RenderService.handleSelectionChanged, which forwards to the renderer
 * without checking the visibility pause that guards refreshRows
 * (RenderService.ts). The DOM renderer then redraws every row, and in a
 * display:none pane WidthCache cannot keep a zero width, so each cell forces a
 * layout. This wrapper keeps only the latest selection while paused and hands
 * it to the renderer once on resume. Parsing, protocol replies, the selection
 * model and every other render path are unchanged.
 *
 * The public API has no hook for this. The private service lookup lives here,
 * and the wrapper stays inert when that shape is missing, leaving xterm's
 * default behaviour intact.
 */
export class TerminalRenderPause {
  private readonly service: RenderServiceLike | null;
  private readonly original: SelectionRedraw | null;
  private readonly ownProperty: boolean;
  private paused = false;
  private pending: SelectionArgs | null = null;
  private disposed = false;

  constructor(terminal: Terminal) {
    const service = (terminal as unknown as { _core?: { _renderService?: unknown } })._core?._renderService;
    const candidate = service && typeof (service as RenderServiceLike).handleSelectionChanged === 'function'
      ? service as RenderServiceLike
      : null;
    this.service = candidate;
    this.ownProperty = !!candidate && Object.prototype.hasOwnProperty.call(candidate, 'handleSelectionChanged');
    this.original = candidate ? candidate.handleSelectionChanged : null;
    if (!candidate || !this.original) return;
    const original = this.original;
    candidate.handleSelectionChanged = (...args: SelectionArgs) => {
      if (this.paused) {
        this.pending = args;
        return;
      }
      original.apply(candidate, args);
    };
  }

  /** Whether this xterm build exposed the service the pause relies on. */
  get supported(): boolean { return this.service !== null; }

  get isPaused(): boolean { return this.paused; }

  pause(): void {
    if (this.disposed || !this.service) return;
    this.paused = true;
  }

  /** Apply the latest selection held while hidden, as one redraw. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.flush();
  }

  private flush(): void {
    const args = this.pending;
    this.pending = null;
    if (args && this.service && this.original) this.original.apply(this.service, args);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paused = false;
    this.pending = null;
    const service = this.service;
    if (!service || !this.original) return;
    if (this.ownProperty) service.handleSelectionChanged = this.original;
    else Reflect.deleteProperty(service, 'handleSelectionChanged');
  }
}
