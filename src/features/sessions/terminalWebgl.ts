import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

type WebglRendererAddon = ITerminalAddon & {
  onContextLoss: (listener: () => void) => IDisposable;
};

/** Own the renderer through public APIs, including its cursor timers. */
export class TerminalWebglLifecycle {
  private addon: WebglRendererAddon | null = null;
  private contextLoss: IDisposable | null = null;
  private unavailable = false;
  private closed = false;

  constructor(private readonly terminal: Terminal, private readonly createAddon: () => WebglRendererAddon) {}

  activate(): boolean {
    if (this.closed || this.unavailable) return false;
    if (this.addon) return true;
    const blink = this.terminal.options.cursorBlink;
    const focused = this.terminal.textarea === this.terminal.element?.ownerDocument.activeElement;
    try {
      // A constructor can fail before the addon owns its renderer. Do not
      // start a cursor timer while that renderer is only partly initialized.
      this.terminal.options.cursorBlink = false;
      const addon = this.createAddon();
      this.addon = addon;
      this.contextLoss = addon.onContextLoss(() => {
        if (this.addon === addon) this.release();
      });
      this.terminal.loadAddon(addon);
      return true;
    } catch {
      this.unavailable = true;
      this.release(false);
      return false;
    } finally {
      this.terminal.options.cursorBlink = blink;
      if (this.unavailable && focused && !this.closed) this.terminal.focus();
    }
  }

  release(restoreBlink = true): void {
    const blink = this.terminal.options.cursorBlink;
    const focused = this.terminal.textarea === this.terminal.element?.ownerDocument.activeElement;
    const addon = this.addon;
    const contextLoss = this.contextLoss;
    this.addon = null;
    this.contextLoss = null;
    try {
      // DECSET 12 can override cursorBlink in xterm 6. Blur pauses that
      // manager through the current renderer before it is detached.
      if (focused) this.terminal.blur();
      // This must also run after a failed activation with no current addon.
      this.terminal.options.cursorBlink = false;
    } finally {
      try {
        contextLoss?.dispose();
      } finally {
        try {
          addon?.dispose();
        } finally {
          if (restoreBlink && !this.closed) {
            this.terminal.options.cursorBlink = blink;
            if (focused) this.terminal.focus();
          }
        }
      }
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.release(false);
  }
}
