import i18n from '../i18n';

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

export function searchShortcutHint() {
  return i18n.t('common.shortcuts.searchHint', { mod: modLabel });
}
export function saveShortcutHint() {
  return i18n.t('common.shortcuts.saveHint', { mod: modLabel });
}
