import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';

/**
 * How the native window frame is drawn. macOS keeps its traffic lights over the app (Overlay);
 * Windows and Linux run undecorated (see `src-tauri/src/lib.rs`) and the app draws the caption
 * buttons. Null in the browser preview, where there is no window to control.
 */
export type WindowChrome = 'macos' | 'windows' | 'linux';

export function detectWindowChrome(): WindowChrome | null {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__;
  if (!internals?.metadata) return null;
  const agent = navigator.userAgent;
  if (/Mac/i.test(agent)) return 'macos';
  if (/Windows/i.test(agent)) return 'windows';
  if (/Linux|X11|CrOS/i.test(agent)) return 'linux';
  return null;
}

/** Tracks the maximized state so the middle button can offer Restore and the frame can drop its edge. */
export function useWindowMaximized(enabled: boolean): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const read = () => { void appWindow.isMaximized().then((value) => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    read();
    void appWindow.onResized(read).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [enabled]);
  return maximized;
}

/** Glyphs follow the platform: thin Fluent-style strokes on Windows, the GNOME/Adwaita set on Linux. */
function Glyph({ name, chrome }: { name: 'minimize' | 'maximize' | 'restore' | 'close'; chrome: WindowChrome }) {
  const size = chrome === 'linux' ? 12 : 10;
  const common = { width: size, height: size, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: chrome === 'linux' ? 1.4 : 1, 'aria-hidden': true } as const;
  if (name === 'minimize') return <svg {...common}><path d="M0 5.5h10" /></svg>;
  if (name === 'maximize') return <svg {...common}><rect x=".5" y=".5" width="9" height="9" rx={chrome === 'linux' ? 1 : 0} /></svg>;
  if (name === 'restore') return <svg {...common}><rect x=".5" y="2.5" width="7" height="7" /><path d="M2.5 2.5V.5h7v7h-2" /></svg>;
  return <svg {...common}><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>;
}

/**
 * Minimize, maximize/restore and close for an undecorated window. Close goes through the normal
 * close request, so the tray keeps the window the same way the native button did.
 * The buttons stay out of the Tab order, as native caption buttons do; the keyboard keeps the
 * system shortcuts (Alt+F4, Win+arrows).
 */
export function WindowControls({ chrome, maximized }: { chrome: WindowChrome; maximized: boolean }) {
  const { t } = useTranslation();
  if (chrome === 'macos') return null;
  const run = (action: (win: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
    try { void action(getCurrentWindow()).catch(() => {}); } catch { void 0; }
  };
  const toggleLabel = maximized ? t('common.shell.windowRestore') : t('common.shell.windowMaximize');
  return <div className="window-controls" data-chrome={chrome} data-tauri-drag-region="false" role="group" aria-label={t('common.shell.windowControls')}>
    <button type="button" className="window-control" tabIndex={-1} aria-label={t('common.shell.windowMinimize')} title={t('common.shell.windowMinimize')} onClick={run((win) => win.minimize())}><Glyph name="minimize" chrome={chrome} /></button>
    <button type="button" className="window-control" tabIndex={-1} aria-label={toggleLabel} title={toggleLabel} onClick={run((win) => win.toggleMaximize())}><Glyph name={maximized ? 'restore' : 'maximize'} chrome={chrome} /></button>
    <button type="button" className="window-control" data-action="close" tabIndex={-1} aria-label={t('common.shell.windowClose')} title={t('common.shell.windowClose')} onClick={run((win) => win.close())}><Glyph name="close" chrome={chrome} /></button>
  </div>;
}
