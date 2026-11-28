import { useCallback, useContext, useState } from 'react';
import type { AcpSessionSnapshot, AcpToolCall } from '../../../types/acp';
import { acpIsLive, acpTerminal } from '../acpSession.ts';
import type { HighlightRun } from './acpHighlight';
import { AcpSessionContext } from './acpImageCache.ts';

/**
 * What one conversation's view remembers outside its components (R13). The timeline
 * renders only the segments near the viewport and nothing while its pane is hidden, so
 * a segment unmounts often; what the reader opened or folded, where they were reading
 * and the code blocks already highlighted must not live in those components. Everything
 * here is per session and front-end only, and it is dropped when the session is closed
 * (the store's retire), together with its data, queue and pictures.
 */

/** Where the reader was: following the latest output, or a segment and the distance
 *  scrolled into it. */
export type TimelineAnchor = { following: boolean; key: string | null; offset: number };

type SessionCache = {
  /** Open/fold choices by a prefixed item or segment id. */
  memory: Map<string, unknown>;
  /** Highlighted runs by language and source, oldest first. */
  highlights: Map<string, HighlightRun[]>;
  anchor: TimelineAnchor | null;
};

/** A long conversation keeps this many highlighted blocks; older ones highlight again. */
export const HIGHLIGHT_CACHE_LIMIT = 300;

const sessions = new Map<string, SessionCache>();

function cacheOf(sessionId: string): SessionCache {
  let cache = sessions.get(sessionId);
  if (!cache) sessions.set(sessionId, cache = { memory: new Map(), highlights: new Map(), anchor: null });
  return cache;
}

export function readViewMemory<T>(sessionId: string, key: string): T | undefined {
  return sessions.get(sessionId)?.memory.get(key) as T | undefined;
}

export function writeViewMemory(sessionId: string, key: string, value: unknown) {
  cacheOf(sessionId).memory.set(key, value);
}

function highlightKey(code: string, language: string): string {
  return language + '\u0000' + code;
}

export function readHighlight(sessionId: string, code: string, language: string): HighlightRun[] | null {
  return sessions.get(sessionId)?.highlights.get(highlightKey(code, language)) ?? null;
}

export function writeHighlight(sessionId: string, code: string, language: string, runs: HighlightRun[]) {
  const highlights = cacheOf(sessionId).highlights;
  const key = highlightKey(code, language);
  highlights.delete(key);
  highlights.set(key, runs);
  while (highlights.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlights.keys().next().value;
    if (oldest === undefined) break;
    highlights.delete(oldest);
  }
}

export function readTimelineAnchor(sessionId: string): TimelineAnchor | null {
  return sessions.get(sessionId)?.anchor ?? null;
}

export function writeTimelineAnchor(sessionId: string, anchor: TimelineAnchor) {
  cacheOf(sessionId).anchor = anchor;
}

/** The session was closed: everything its view remembered goes with it. */
export function clearAcpRenderCache(sessionId: string) {
  sessions.delete(sessionId);
}

/** Whether anything is still held for a session (tests and measurements). */
export function hasAcpRenderCache(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * Whether an open tool body would draw the same from either snapshot. A body reads
 * only whether the session is live, its directory and, for each terminal the call
 * names, that terminal and whether it was omitted. Output streaming into another
 * call's terminal changes the row's snapshot but not this; a body that compared the
 * whole snapshot would diff its edit again on every line of that output.
 */
export function toolBodySnapshotEqual(call: AcpToolCall, previous: AcpSessionSnapshot, next: AcpSessionSnapshot): boolean {
  if (previous === next) return true;
  if (acpIsLive(previous) !== acpIsLive(next) || previous.directory !== next.directory) return false;
  for (const content of call.content) {
    if (content.type !== 'terminal') continue;
    if (acpTerminal(previous, content.terminalId) !== acpTerminal(next, content.terminalId)) return false;
    const omitted = (snapshot: AcpSessionSnapshot) => (snapshot.omittedTerminalIds ?? []).includes(content.terminalId);
    if (omitted(previous) !== omitted(next)) return false;
  }
  return true;
}

/** Props comparison for a memoized tool body: every prop the same, the snapshot as far
 *  as the body reads it (toolBodySnapshotEqual). */
export function toolBodyPropsEqual<P extends { call: AcpToolCall; snapshot: AcpSessionSnapshot }>(previous: P, next: P): boolean {
  const keys = Object.keys(next) as (keyof P)[];
  if (keys.length !== Object.keys(previous).length) return false;
  for (const key of keys) if (key !== 'snapshot' && !Object.is(previous[key], next[key])) return false;
  return toolBodySnapshotEqual(next.call, previous.snapshot, next.snapshot);
}

/**
 * A piece of view state that outlives the component showing it: the value starts from
 * what this session's view remembered under `key` and every change is remembered.
 */
export function useViewMemory<T>(key: string, fallback: T): [T, (value: T) => void] {
  const sessionId = useContext(AcpSessionContext);
  const [value, setValue] = useState<T>(() => {
    const remembered = readViewMemory<T>(sessionId, key);
    return remembered === undefined ? fallback : remembered;
  });
  const set = useCallback((next: T) => {
    writeViewMemory(sessionId, key, next);
    setValue(next);
  }, [sessionId, key]);
  return [value, set];
}
