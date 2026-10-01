export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modLabel = isMac ? '⌘' : 'Ctrl';
export const modAria = isMac ? 'Meta' : 'Control';

export function withMod(event: KeyboardEvent | { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export const searchShortcutHint = `${modLabel}+F 或 / 定位搜索，Esc 清空`;
export const saveShortcutHint = `保存（${modLabel}+S）`;
