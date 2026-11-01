import { useCallback, useRef, useState } from 'react';
import { native } from '../../lib/native';

/** One file of an attempt: a dropped local path, or inlined clipboard bytes.
    A paste image encodes lazily through `encodeBytes` so a decode or PNG conversion
    failure fails the attempt — and its retry — exactly like a transfer error. */
export type SessionUploadInput = { name: string; localPath?: string; bytesBase64?: string; encodeBytes?: () => Promise<string> };

export type SessionUploadTask = {
  phase: 'uploading' | 'failed';
  /** Display names, in input order. */
  names: string[];
  /** Files confirmed ready for this attempt so far. */
  uploaded: number;
  total: number;
  /** Backend failure detail; empty while the attempt is still running. */
  error: string;
};

type SessionUploadAttempt = { sessionId: string; projectId: string | null; inputs: SessionUploadInput[]; claimed: string[]; completed: number };

/** The file name of a dropped path, for the task's progress display. */
export function uploadDisplayName(path: string): string {
  const trimmed = path.trim();
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/**
 * Per-session attachment tasks for workbench panes. Attempts on one session run in
 * order, with remote batches sharing one SFTP connection. Local clipboard bytes are
 * staged for the session; local dropped paths are used directly. Progress counts only
 * confirmed files; failed attempts pause the queue and retain completed batches.
 * A failed attempt keeps its inputs and confirmed paths for the retry button;
 * a retry resumes at the first unconfirmed batch (paths are handed to
 * `onUploaded` only after every file has landed — a failed attempt never types any
 * path). Upload requests are write-semantics and are never replayed automatically.
 */
export function useSessionUploads(handlers: {
  onUploaded: (sessionId: string, remotePaths: string[]) => Promise<void>;
  formatError: (error: unknown) => string;
}) {
  const [tasks, setTasks] = useState<Record<string, SessionUploadTask>>({});
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  const queues = useRef(new Map<string, SessionUploadAttempt[]>());
  const active = useRef(new Map<string, SessionUploadAttempt>());
  const retryInputs = useRef(new Map<string, SessionUploadAttempt>());

  const patch = useCallback((sessionId: string, task: SessionUploadTask | null) => {
    setTasks((current) => {
      if (!task) return Object.hasOwn(current, sessionId) ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== sessionId)) : current;
      return { ...current, [sessionId]: task };
    });
  }, []);

  const pumpRef = useRef<(sessionId: string) => void>(() => {});
  const pump = useCallback((sessionId: string) => {
    if (active.current.has(sessionId) || retryInputs.current.has(sessionId)) return;
    const next = queues.current.get(sessionId)?.shift();
    if (!next) return;
    active.current.set(sessionId, next);
    const names = next.inputs.map((input) => input.name);
    const describe = (phase: 'uploading' | 'failed', uploaded: number, error = ''): SessionUploadTask => ({ phase, names, uploaded, total: next.inputs.length, error });
    patch(sessionId, describe('uploading', next.completed));
    void (async () => {
      try {
        while (next.completed < next.inputs.length) {
          const inline = !next.inputs[next.completed].localPath;
          const batch: SessionUploadInput[] = [];
          let encodedSize = 0;
          for (const input of next.inputs.slice(next.completed, next.completed + 8)) {
            if ((!input.localPath) !== inline) break;
            if (inline && input.bytesBase64 === undefined) input.bytesBase64 = await input.encodeBytes!();
            const size = input.bytesBase64?.length ?? 0;
            if (batch.length && encodedSize + size > 16 * 1024 * 1024) break;
            batch.push(input);
            encodedSize += size;
          }
          const files = batch.map((input) => ({ name: input.name, bytesBase64: input.bytesBase64! }));
          const paths = !next.projectId
            ? inline ? await native.stageSessionPasteFiles(next.sessionId, files) : batch.map((input) => input.localPath!)
            : inline
              ? await native.uploadRemoteSessionByteFiles(next.sessionId, next.projectId, files)
              : await native.uploadRemoteSessionFiles(next.sessionId, next.projectId, batch.map((input) => input.localPath!));
          if (paths.length !== batch.length) throw new Error('Incomplete upload result');
          next.claimed.push(...paths);
          next.completed += batch.length;
          patch(sessionId, describe('uploading', next.completed));
        }
        // Retain confirmed paths until the PTY write succeeds. A delivery retry
        // must not upload the files again or silently lose a hidden pane's paste.
        await callbacks.current.onUploaded(next.sessionId, next.claimed);
        active.current.delete(sessionId);
        retryInputs.current.delete(sessionId);
        patch(sessionId, null);
      } catch (error) {
        active.current.delete(sessionId);
        retryInputs.current.set(sessionId, next);
        patch(sessionId, describe('failed', next.completed, callbacks.current.formatError(error)));
      }
      pumpRef.current(sessionId);
    })();
  }, [patch]);
  pumpRef.current = pump;

  /** Queue files for a pane; later drops on the same session run after this one. */
  const enqueueUpload = useCallback((sessionId: string, projectId: string | null, inputs: SessionUploadInput[]) => {
    const usable = inputs.filter((input) => (input.localPath ?? '').trim() !== '' || input.bytesBase64 !== undefined || input.encodeBytes !== undefined);
    if (!usable.length) return;
    const queue = queues.current.get(sessionId) ?? [];
    queue.push({ sessionId, projectId, inputs: usable, claimed: [], completed: 0 });
    queues.current.set(sessionId, queue);
    pump(sessionId);
  }, [pump]);

  /** Re-run the last failed attempt of a session with the same inputs. */
  const retryUpload = useCallback((sessionId: string) => {
    const attempt = retryInputs.current.get(sessionId);
    if (!attempt) return;
    retryInputs.current.delete(sessionId);
    const queue = queues.current.get(sessionId) ?? [];
    queue.unshift(attempt);
    queues.current.set(sessionId, queue);
    pump(sessionId);
  }, [pump]);

  /** Drop a failure report; already-landed files stay on the host for session-end recovery. */
  const dismissUploadFailure = useCallback((sessionId: string) => {
    retryInputs.current.delete(sessionId);
    patch(sessionId, null);
    pump(sessionId);
  }, [patch, pump]);

  return { tasks, enqueueUpload, retryUpload, dismissUploadFailure };
}
