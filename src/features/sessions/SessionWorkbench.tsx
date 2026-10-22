import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { displayPath, shortPath } from '../../lib/paths';
import { ToolIcon } from '../../components/ToolIcon';
import type { LaunchMode, LaunchRequest, LaunchResult, Project, WorkbenchSession } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import styles from './SessionWorkbench.module.css';

export type WorkbenchRetry =
  | { kind: 'launch'; request: LaunchRequest }
  | { kind: 'resume'; id: string; mode: LaunchMode };

export type WorkbenchFailure = { detail: string; retry: WorkbenchRetry };

export function workbenchSessionId(result: LaunchResult): string | null {
  return result.status === 'session_started' && result.sessionId ? result.sessionId : null;
}

/** Desktop launches never become workbench sessions. Only an explicit workbench preference routes a failure onto this page. */
export async function failedInWorkbench(desktop = false): Promise<boolean> {
  if (desktop || !nativeAvailable) return false;
  try { return (await native.getLaunchSettings()).selected === 'workbench'; }
  catch { return false; }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** Bytes from output events that the replay snapshot does not already contain. */
function queuedAfterSnapshot(snapshot: Uint8Array, queue: Uint8Array): Uint8Array {
  if (snapshot.length > queue.length) return new Uint8Array();
  for (let index = 0; index < snapshot.length; index += 1) {
    if (queue[index] !== snapshot[index]) return queue;
  }
  return queue.subarray(snapshot.length);
}

function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    background: pick('--bg', dark ? '#0a0f0c' : '#f5f7f3'),
    foreground: pick('--text', dark ? '#eef4ef' : '#111813'),
    cursor: pick('--accent', dark ? '#7be3a7' : '#0e6b43'),
    cursorAccent: pick('--bg', dark ? '#0a0f0c' : '#f5f7f3'),
    selectionBackground: pick('--selection', dark ? '#173557' : '#d0e4fa'),
    black: dark ? '#1a241e' : '#1c2420',
    red: dark ? '#f0a8a0' : '#a62f2a',
    green: dark ? '#7be3a7' : '#0e6b43',
    yellow: dark ? '#eed294' : '#8a5a00',
    blue: dark ? '#9ec4ea' : '#245c8c',
    magenta: dark ? '#d2b6ea' : '#6d4d86',
    cyan: dark ? '#8fd0c4' : '#0b6b62',
    white: dark ? '#eef4ef' : '#f7faf6',
    brightBlack: pick('--text-3', '#5b665e'),
    brightRed: dark ? '#ffc7c1' : '#c44740',
    brightGreen: dark ? '#b9f6d2' : '#2f9d6b',
    brightYellow: dark ? '#ffe3a8' : '#a56b00',
    brightBlue: dark ? '#c5dff6' : '#3c7cb3',
    brightMagenta: dark ? '#e6d2f6' : '#8a68a6',
    brightCyan: dark ? '#c6efe6' : '#1a8f84',
    brightWhite: dark ? '#ffffff' : '#111813',
  };
}

function monoFont(): string {
  const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return stack || 'Consolas, monospace';
}

function SessionTerminal({ sessionId, active, running, writers, pending, onWriteError }: {
  sessionId: string;
  active: boolean;
  running: boolean;
  writers: MutableRefObject<Map<string, (data: string) => void>>;
  pending: MutableRefObject<Map<string, string[]>>;
  onWriteError: MutableRefObject<(error: unknown) => void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const runningRef = useRef(running);
  activeRef.current = active;
  runningRef.current = running;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      screenReaderMode: true,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let acceptLive = false;
    const queued: string[] = [];
    const writeEncoded = (encoded: string) => {
      if (!encoded || disposed) return;
      try { term.write(decodeBase64(encoded)); }
      catch { /* Malformed bytes stay out of the terminal. */ }
    };
    const publish = (encoded: string) => {
      if (acceptLive) writeEncoded(encoded);
      else queued.push(encoded);
    };
    writers.current.set(sessionId, publish);
    const subscription = term.onData((data) => {
      if (!activeRef.current || !runningRef.current) return;
      void native.writeWorkbenchSession(sessionId, encodeBase64(new TextEncoder().encode(data))).catch((error) => onWriteError.current(error));
    });
    const fitNow = () => {
      if (disposed || !activeRef.current || node.clientWidth < 8 || node.clientHeight < 8) return;
      try { fit.fit(); } catch { return; }
      if (!runningRef.current || term.cols < 2 || term.rows < 1) return;
      void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
    };
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(node);
    const themeObserver = new MutationObserver(() => { term.options.theme = readTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void native.replayWorkbenchSession(sessionId).then((encoded) => {
      if (disposed) return;
      let snapshot = new Uint8Array(0);
      try { snapshot = Uint8Array.from(decodeBase64(typeof encoded === 'string' ? encoded : '')); }
      catch { snapshot = new Uint8Array(0); }
      const earlier = (pending.current.get(sessionId) ?? []).splice(0);
      pending.current.delete(sessionId);
      const arrived = queued.splice(0);
      const queuedBytes = concatBytes([...earlier, ...arrived].flatMap((part) => {
        try { return [decodeBase64(part)]; }
        catch { return []; }
      }));
      const suffix = queuedAfterSnapshot(snapshot, queuedBytes);
      acceptLive = true;
      try {
        if (snapshot.length) term.write(snapshot);
        if (suffix.length) term.write(suffix);
      } catch { /* Malformed bytes stay out of the terminal. */ }
      requestAnimationFrame(fitNow);
    }).catch(() => {
      acceptLive = true;
      queued.splice(0).forEach(writeEncoded);
      (pending.current.get(sessionId) ?? []).splice(0).forEach(writeEncoded);
      pending.current.delete(sessionId);
    });
    return () => {
      disposed = true;
      if (writers.current.get(sessionId) === publish) writers.current.delete(sessionId);
      subscription.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, writers, pending, onWriteError]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !active || !running;
    term.options.cursorBlink = active && running;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const fit = fitRef.current;
      const node = host.current;
      if (!fit || !node || node.clientWidth < 8) return;
      try { fit.fit(); } catch { return; }
      if (running && term.cols >= 2 && term.rows >= 1) void native.resizeWorkbenchSession(sessionId, term.cols, term.rows).catch(() => {});
      if (running) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, running, sessionId]);

  return <div ref={host} className={styles.terminalHost} hidden={!active} />;
}

export function SessionWorkbench({ active, tools, focusSessionId, focusToken, failure, onFailure, onOpenHome }: {
  active: boolean;
  tools: AdapterDescriptor[];
  focusSessionId: string | null;
  focusToken: number;
  failure: WorkbenchFailure | null;
  onFailure: (failure: WorkbenchFailure | null) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(focusSessionId);
  const [loading, setLoading] = useState(nativeAvailable);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [reload, setReload] = useState(0);
  const writers = useRef(new Map<string, (data: string) => void>());
  const pending = useRef(new Map<string, string[]>());
  const writeError = useRef<(error: unknown) => void>(() => {});
  writeError.current = (error) => setActionError(formatFailure(error, t('sessions.writeFailed'), t('sessions.retry')));

  useEffect(() => {
    if (focusSessionId) setSelectedId(focusSessionId);
  }, [focusSessionId, focusToken]);

  useEffect(() => {
    if (!nativeAvailable) { setLoading(false); return; }
    let alive = true;
    const stops: Array<() => void> = [];
    const push = (sessionId: string, data: string) => {
      const write = writers.current.get(sessionId);
      if (write) write(data);
      else {
        const queued = pending.current.get(sessionId) ?? [];
        queued.push(data);
        pending.current.set(sessionId, queued);
      }
    };
    void listen<{ sessionId: string; dataBase64: string }>('cliora:session-output', (event) => {
      if (alive) push(event.payload.sessionId, event.payload.dataBase64);
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void listen<{ sessionId: string; exitCode: number | null }>('cliora:session-exit', (event) => {
      if (!alive) return;
      setSessions((current) => current.map((item) => item.id === event.payload.sessionId ? { ...item, running: false, exitCode: event.payload.exitCode ?? null } : item));
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    return () => { alive = false; stops.forEach((stop) => { void Promise.resolve(stop()).catch(() => {}); }); };
  }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    setLoading(true);
    void Promise.all([native.listWorkbenchSessions(), native.listProjects().catch(() => [] as Project[])]).then(([listed, listedProjects]) => {
      if (!alive) return;
      const next = Array.isArray(listed) ? listed : [];
      setSessions(next);
      setProjects(Array.isArray(listedProjects) ? listedProjects : []);
      setListError('');
      setSelectedId((current) => {
        if (focusSessionId && next.some((item) => item.id === focusSessionId)) return focusSessionId;
        if (current && next.some((item) => item.id === current)) return current;
        return next.find((item) => item.running)?.id ?? next[0]?.id ?? null;
      });
      for (const session of next) {
        const queued = pending.current.get(session.id);
        const write = writers.current.get(session.id);
        if (queued?.length && write) {
          queued.splice(0).forEach(write);
          pending.current.delete(session.id);
        }
      }
    }).catch((value) => {
      if (alive) setListError(formatFailure(value, t('sessions.listFailed'), t('sessions.listNext')));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, focusToken, focusSessionId, reload, t]);

  function placeOf(session: WorkbenchSession): string {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    if (project?.name) return project.name;
    if (session.directory) return shortPath(displayPath(session.directory));
    return t('sessions.placeUnknown');
  }

  function toolName(session: WorkbenchSession): string {
    return tools.find((item) => item.id === session.toolId)?.name ?? session.toolId;
  }

  function modeLabel(mode: LaunchMode): string {
    return mode === 'yolo' ? t('sessions.modeYolo') : t('sessions.modeNormal');
  }

  async function endSession(session: WorkbenchSession) {
    if (busy) return;
    setBusy(session.id);
    setActionError('');
    try {
      await native.closeWorkbenchSession(session.id);
      const rest = sessions.filter((item) => item.id !== session.id);
      setSessions(rest);
      setSelectedId((current) => current === session.id ? (rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null) : current);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally { setBusy(''); }
  }

  async function retry() {
    if (!failure || retrying) return;
    setRetrying(true);
    setNotice('');
    setActionError('');
    try {
      const result = failure.retry.kind === 'launch'
        ? await native.launchCli(failure.retry.request)
        : await native.resumeHistorySession(failure.retry.id, failure.retry.mode);
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      onFailure(null);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      onFailure({ ...failure, detail: formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')) });
    } finally { setRetrying(false); }
  }

  const selected = sessions.find((item) => item.id === selectedId) ?? null;
  const showEmpty = !loading && !sessions.length;

  return <div className={styles.root}>
    {listError && <div className={styles.banner} role="alert"><strong>{t('sessions.listFailed')}</strong><p>{listError}</p><button type="button" onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</button></div>}
    <div className={styles.layout}>
      <aside className={styles.rail} aria-label={t('sessions.listLabel')}>
        <div className={styles.railHead}>{t('sessions.listLabel')}</div>
        <div className={styles.list} role="tablist" aria-label={t('sessions.listLabel')}>
          {sessions.map((session) => {
            const name = toolName(session);
            const place = placeOf(session);
            const mode = modeLabel(session.mode);
            return <button type="button" role="tab" key={session.id} data-session-id={session.id} className={styles.session} aria-selected={session.id === selectedId} onClick={() => setSelectedId(session.id)}>
              <strong>{name}</strong>
              <small title={session.directory ? displayPath(session.directory) : place}>{place}</small>
              <span className={styles.meta}><span className={styles.pill}>{mode}</span>{!session.running && <span className={styles.pill} data-tone="ended">{t('sessions.ended')}</span>}</span>
            </button>;
          })}
        </div>
      </aside>
      <section className={styles.stage} aria-label={t('sessions.stageLabel')}>
        {failure && <div className={styles.banner} role="alert"><strong>{t('sessions.launchFailed')}</strong><p>{failure.detail}</p><p>{t('sessions.failureHint')}</p><button type="button" onClick={() => void retry()} disabled={retrying}>{retrying ? t('sessions.loading') : t('sessions.retry')}</button></div>}
        {actionError && <div className={styles.banner} role="alert"><p>{actionError}</p></div>}
        {notice && <div className={styles.banner} data-tone="status" role="status"><p>{notice}</p></div>}
        {selected && <div className={styles.identity}>
          <ToolIcon toolId={selected.toolId} size={28} />
          <div className={styles.identityText}>
            <strong>{toolName(selected)}</strong>
            <span title={selected.directory ? displayPath(selected.directory) : ''}>{placeOf(selected)} · {modeLabel(selected.mode)}{!selected.running ? ` · ${t('sessions.ended')}` : ''}</span>
          </div>
          <button type="button" onClick={() => void endSession(selected)} disabled={!!busy}>{busy === selected.id ? t('sessions.ending') : t('sessions.end')}</button>
        </div>}
        {sessions.map((session) => <SessionTerminal key={session.id} sessionId={session.id} active={session.id === selectedId} running={session.running} writers={writers} pending={pending} onWriteError={writeError} />)}
        {loading && !sessions.length && <p className={styles.loading}>{t('sessions.loading')}</p>}
        {showEmpty && !listError && <div className={styles.empty}>
          <h2>{t('sessions.emptyTitle')}</h2>
          <p>{t('sessions.emptyDetail')}</p>
          <button type="button" className="button primary" onClick={onOpenHome}>{t('sessions.openHome')}</button>
        </div>}
      </section>
    </div>
  </div>;
}
