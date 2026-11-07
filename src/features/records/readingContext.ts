/**
 * Lightweight reading context of one opened conversation: find, reading options,
 * the current match and where the reader was scrolled. It holds no message text,
 * so a hidden records page can still release the transcript and restore the
 * reading place once the same conversation is read again.
 */
export type ReadingSettings = { query: string; findOpen: boolean; onlyQuestions: boolean; raw: boolean; current: number };
/** Scroll place as the first message under the top edge plus how far into it the reader was. */
export type ReadingPosition = { anchorId: string | null; offset: number; scrollTop: number };
export type ReadingContext = ReadingSettings & { position: ReadingPosition | null };

/** Contexts kept per records page; the oldest read conversation is dropped first. */
export const READING_CONTEXT_LIMIT = 40;

export const readingKey = (host: string, sessionId: string, childPath: readonly string[]) =>
  [host, sessionId, ...childPath].join('\u001f');

export const sessionOfKey = (key: string) => key.split('\u001f')[1] ?? '';

export class ReadingContexts {
  private items = new Map<string, ReadingContext>();

  get(key: string) { return this.items.get(key); }

  update(key: string, patch: Partial<ReadingContext>) {
    const old = this.items.get(key) ?? { query: '', findOpen: false, onlyQuestions: false, raw: false, current: 0, position: null };
    this.items.delete(key);
    this.items.set(key, { ...old, ...patch });
    while (this.items.size > READING_CONTEXT_LIMIT) this.items.delete(this.items.keys().next().value!);
  }

  /** Drops contexts of sessions that a complete (unfiltered) list read no longer contains. */
  retainSessions(host: string, ids: ReadonlySet<string>) {
    for (const key of [...this.items.keys()]) {
      if (key.split('\u001f')[0] === host && !ids.has(sessionOfKey(key))) this.items.delete(key);
    }
  }

  get size() { return this.items.size; }
}

/** Reads the reader place inside `container`; null when nothing readable is laid out. */
export function capturePosition(container: HTMLElement): ReadingPosition | null {
  if (!container.clientHeight) return null;
  const top = container.getBoundingClientRect().top;
  const articles = container.querySelectorAll<HTMLElement>('[data-message-id]');
  if (!articles.length) return null;
  for (const article of articles) {
    const rect = article.getBoundingClientRect();
    if (!rect.height) continue;
    if (rect.bottom > top) return { anchorId: article.dataset.messageId ?? null, offset: top - rect.top, scrollTop: container.scrollTop };
  }
  return { anchorId: null, offset: 0, scrollTop: container.scrollTop };
}

/**
 * Restores a saved place. A message that is still there keeps its place even when
 * earlier content changed; otherwise the old offset is clamped to the current content.
 */
export function restorePosition(container: HTMLElement, position: ReadingPosition) {
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  const anchor = position.anchorId ? container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(position.anchorId)}"]`) : null;
  if (anchor && anchor.getBoundingClientRect().height) {
    const rect = anchor.getBoundingClientRect();
    const offset = Math.min(position.offset, rect.height);
    const target = container.scrollTop + rect.top - container.getBoundingClientRect().top + offset;
    container.scrollTop = Math.min(max, Math.max(0, target));
    return;
  }
  container.scrollTop = Math.min(max, Math.max(0, position.scrollTop));
}
