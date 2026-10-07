import i18n from '../i18n';

// Joining punctuation follows the active UI language. Backend message bodies
// stay untouched (R7); Chinese joining matches the pre-i18n formatter.
function english(): boolean {
  return (i18n.resolvedLanguage ?? i18n.language ?? '').toLowerCase().startsWith('en');
}
function terminator(): string {
  return english() ? '.' : '。';
}
function separator(): string {
  return english() ? '. ' : '。';
}
function ended(text: string): boolean {
  return english() ? /[。！？.!?]$/.test(text) : /[。！？]$/.test(text);
}
function stripEnded(text: string): string {
  return english() ? text.replace(/[。！？.!?]+$/u, '').replace(/\s+$/, '') : text.replace(/[。！？\s]+$/, '');
}
function genericMessage(): string {
  return i18n.t('common.nativeError.operationFailed');
}
function genericAction(): string {
  return i18n.t('common.nativeError.retry');
}
function isGenericMessage(text: string): boolean {
  if (text.replace(/[。！？，,\s]/g, '') === '操作失败请重试' || /^操作失败[。！]?$/.test(text) || text === genericMessage()) return true;
  if (!english()) return false;
  const strip = (value: string) => value.replace(/[.!?\s]+$/g, '');
  const generic = strip(genericMessage());
  return generic !== '' && strip(text) === generic;
}
function isGenericAction(text: string): boolean {
  if (/^请重试[。！]?$/.test(text) || text === genericAction()) return true;
  if (!english()) return false;
  const strip = (value: string) => value.replace(/[.!?\s]+$/g, '');
  const generic = strip(genericAction());
  return generic !== '' && strip(text) === generic;
}
function finish(text: string): string {
  return ended(text) ? text : `${text}${terminator()}`;
}

export function formatFailure(error: unknown, objectText: string, nextText: string): string {
  const fallback = `${objectText}${separator()}${nextText}`;
  if (typeof error === 'string') {
    const text = error.trim();
    return !text || isGenericMessage(text) ? fallback : text;
  }
  if (!error || typeof error !== 'object') return fallback;
  const value = error as { message?: unknown; action?: unknown };
  const raw = 'message' in value && value.message != null ? String(value.message).trim() : '';
  const action = typeof value.action === 'string' ? value.action.trim() : '';
  if (!raw || isGenericMessage(raw)) {
    const next = action && !isGenericAction(action) ? action : nextText;
    return `${objectText}${separator()}${finish(next)}`;
  }
  const detail = stripEnded(raw);
  const next = action || nextText;
  const bare = stripEnded(next);
  if (!bare || detail.includes(bare)) return ended(raw) ? raw : `${detail}${terminator()}`;
  return `${detail}${separator()}${finish(next)}`;
}
