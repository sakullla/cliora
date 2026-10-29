/**
 * Copies text from a click handler. Call it before any other `await` in that handler: WebKit (the macOS
 * window) only allows copying while the click's user activation is live and rejects
 * `navigator.clipboard.writeText` in the app's webview, so there the synchronous `copy` command runs first,
 * inside the click. Chromium (WebView2) takes the async clipboard API and keeps the command as fallback.
 */
const webkit = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

export async function writeClipboard(value: string): Promise<boolean> {
  if (webkit && copyWithCommand(value)) return true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the copy command (Chromium) or report failure (WebKit already tried it).
  }
  return !webkit && copyWithCommand(value);
}

function copyWithCommand(value: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  try {
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    // Inside an open modal dialog only the dialog subtree can take focus and a selection.
    (document.querySelector('dialog[open]') ?? document.body).appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    // The command borrows focus; hand it back so a terminal or editor keeps receiving keys.
    previous?.focus({ preventScroll: true });
  }
}
