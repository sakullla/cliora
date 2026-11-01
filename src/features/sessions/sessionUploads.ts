import { useCallback, useRef, useState } from 'react';
import { native } from '../../lib/native';

/** One file of an upload attempt: a dropped local path, or inlined bytes (image paste). */
export type SessionUploadInput = { name: string; localPath?: string; bytesBase64?: string };

export type SessionUploadTask = {
  phase: 'uploading' | 'failed';
  /** Display names, in input order. */
  names: string[];
  /** Files of this attempt that have landed remotely so far. */
  uploaded: number;
  total: number;
  /** Backend failure detail; empty while the attempt is still running. */
  error: string;
};

type SessionUploadAttempt = { sessionId: string; projectId: string; inputs: SessionUploadInput[] };

/** The file name of a dropped path, for the task's progress display. */
export function uploadDisplayName(path: string): string {
  const trimmed = path.trim();
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/**
 * Per-session upload tasks for remote workbench panes. Attempts on one session run in
 * order, one file per native write request, so the pane can show honest n/m progress.
 * A failed attempt keeps its exact inputs for the retry button; a retry is a fresh run
 * of the same inputs and behaves like the first success (paths are handed to
 * `onUploaded` only after every file has landed — a failed attempt never types any
 * path). Upload requests are write-semantics and are never replayed automatically.
 */
export function useSessionUploads(handlers: {
  onUploaded: (sessionId: string, remotePaths: string[]) => void;
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
    if (active.current.has(sessionId)) return;
    const next = queues.current.get(sessionId)?.shift();
    if (!next) return;
    active.current.set(sessionId, next);
    const names = next.inputs.map((input) => input.name);
    const describe = (phase: 'uploading' | 'failed', uploaded: number, error = ''): SessionUploadTask => ({ phase, names, uploaded, total: next.inputs.length, error });
    patch(sessionId, describe('uploading', 0));
    void (async () => {
      const claimed: string[] = [];
      let uploaded = 0;
      try {
        for (const input of next.inputs) {
          // One file per request: the backend records each landed name, and the
          // pane's progress counter follows the transfer instead of guessing.
          const paths = input.bytesBase64 !== undefined
            ? await native.uploadRemoteSessionFileBytes(next.sessionId, next.projectId, input.name, input.bytesBase64)
            : await native.uploadRemoteSessionFiles(next.sessionId, next.projectId, [input.localPath ?? '']);
          claimed.push(...paths);
          uploaded += 1;
          if (active.current.get(sessionId) === next) patch(sessionId, describe('uploading', uploaded));
        }
        active.current.delete(sessionId);
        retryInputs.current.delete(sessionId);
        patch(sessionId, null);
        callbacks.current.onUploaded(next.sessionId, claimed);
      } catch (error) {
        active.current.delete(sessionId);
        retryInputs.current.set(sessionId, next);
        patch(sessionId, describe('failed', uploaded, callbacks.current.formatError(error)));
      }
      pumpRef.current(sessionId);
    })();
  }, [patch]);
  pumpRef.current = pump;

  /** Queue files for a remote pane; later drops on the same session run after this one. */
  const enqueueUpload = useCallback((sessionId: string, projectId: string, inputs: SessionUploadInput[]) => {
    const usable = inputs.filter((input) => (input.localPath ?? '').trim() !== '' || input.bytesBase64 !== undefined);
    if (!usable.length) return;
    retryInputs.current.delete(sessionId);
    const queue = queues.current.get(sessionId) ?? [];
    queue.push({ sessionId, projectId, inputs: usable });
    queues.current.set(sessionId, queue);
    pump(sessionId);
  }, [pump]);

  /** Re-run the last failed attempt of a session with the same inputs. */
  const retryUpload = useCallback((sessionId: string) => {
    const attempt = retryInputs.current.get(sessionId);
    if (!attempt) return;
    retryInputs.current.delete(sessionId);
    const queue = queues.current.get(sessionId) ?? [];
    queue.push(attempt);
    queues.current.set(sessionId, queue);
    pump(sessionId);
  }, [pump]);

  /** Drop a failure report; already-landed files stay on the host for session-end recovery. */
  const dismissUploadFailure = useCallback((sessionId: string) => {
    retryInputs.current.delete(sessionId);
    patch(sessionId, null);
  }, [patch]);

  return { tasks, enqueueUpload, retryUpload, dismissUploadFailure };
}
