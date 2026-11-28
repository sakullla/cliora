import { createContext } from 'react';
import type { AcpTimelineItem } from '../../../types/acp';

/**
 * The pictures a person sent, kept in front-end memory only (R12). The snapshot still
 * carries no image data: a sent image is bound, as a Blob URL, to the user message the
 * host published for its prompt, and the session's URLs are revoked when it is closed.
 * After a restart, a restore or a replay there is nothing here and the message shows a
 * named placeholder instead.
 */

export type CachedImage = {
  url: string;
  /** The file name, or null for a pasted picture without one. */
  name: string | null;
};

export type SentImage = { name: string; mimeType: string; dataBase64: string };

type Expectation = { before: Set<string>; images: SentImage[] };

const EMPTY: readonly CachedImage[] = Object.freeze([]);
const bound = new Map<string, Map<string, readonly CachedImage[]>>();
const expected = new Map<string, Expectation[]>();
const listeners = new Set<() => void>();

/** The session id of the conversation rendering a message. */
export const AcpSessionContext = createContext<string>('');

function notify() {
  for (const listener of [...listeners]) listener();
}

export function subscribeAcpImages(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readAcpImages(sessionId: string, messageId: string): readonly CachedImage[] {
  return bound.get(sessionId)?.get(messageId) ?? EMPTY;
}

/** A pasted picture's name is its media type or nothing: only a real file name names it. */
export function imageFileName(name: string | null | undefined): string | null {
  const value = (name ?? '').trim();
  if (!value || value === 'image' || /^image\/[\w.+-]+$/i.test(value)) return null;
  return value;
}

/** The ids of the person's own messages, taken before a prompt is sent. */
export function userMessageIds(timeline: readonly AcpTimelineItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of timeline) if (item.kind === 'message' && item.role === 'user' && !item.subagent) ids.add(item.id);
  return ids;
}

/** A prompt with images was accepted: its pictures belong to the next new user message
 *  with image attachments. Only one prompt is in flight at a time, so the match is unique. */
export function expectAcpImages(sessionId: string, before: Set<string>, images: SentImage[]) {
  if (!sessionId || !images.length) return;
  const list = expected.get(sessionId) ?? [];
  list.push({ before, images });
  expected.set(sessionId, list);
}

function blobUrl(image: SentImage): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    const binary = atob(image.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
  } catch {
    return null;
  }
}

/** Binds waiting pictures to the user messages the host has published meanwhile. */
export function bindAcpImages(sessionId: string, timeline: readonly AcpTimelineItem[]) {
  const list = expected.get(sessionId);
  if (!list?.length) return;
  let changed = false;
  const messages = bound.get(sessionId) ?? new Map<string, readonly CachedImage[]>();
  while (list.length) {
    const next = list[0];
    const target = timeline.find((item) => item.kind === 'message' && item.role === 'user' && !item.subagent
      && !next.before.has(item.id) && !messages.has(item.id)
      && !!item.attachments?.some((attachment) => attachment.type === 'image'));
    if (!target) break;
    list.shift();
    const images: CachedImage[] = [];
    for (const image of next.images) {
      const url = blobUrl(image);
      if (url) images.push({ url, name: imageFileName(image.name) });
    }
    if (images.length) {
      messages.set(target.id, images);
      changed = true;
    }
  }
  if (!list.length) expected.delete(sessionId);
  if (changed) {
    bound.set(sessionId, messages);
    notify();
  }
}

/** The session was closed: its URLs are revoked and its pictures forgotten. */
export function releaseAcpImages(sessionId: string) {
  expected.delete(sessionId);
  const messages = bound.get(sessionId);
  if (!messages) return;
  bound.delete(sessionId);
  for (const images of messages.values()) for (const image of images) URL.revokeObjectURL(image.url);
  notify();
}
