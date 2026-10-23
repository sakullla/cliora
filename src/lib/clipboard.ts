export async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // The desktop webview can reject the async clipboard API even on a click.
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    // The fallback borrows focus; hand it back so a terminal or editor keeps receiving keys.
    previous?.focus({ preventScroll: true });
    return copied;
  } catch {
    previous?.focus({ preventScroll: true });
    return false;
  }
}
