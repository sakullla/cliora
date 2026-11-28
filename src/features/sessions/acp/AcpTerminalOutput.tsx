import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpTerminal } from '../../../types/acp';
import { AcpCopyButton } from './AcpCopyButton';
import { splitMatchRuns } from './acpSearch';
import { terminalText, visibleControls } from './acpView';
import styles from './acp.module.css';

/** How often streamed output repaints. */
const REPAINT_MS = 100;

/** `value`, updated at most once per `interval`; the last value always lands. */
function useThrottled<T>(value: T, interval: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + interval - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const timer = window.setTimeout(() => { last.current = Date.now(); setShown(value); }, wait);
    return () => window.clearTimeout(timer);
  }, [value, interval]);
  return shown;
}

function renderRuns(text: string, query: string, caseSensitive: boolean) {
  if (!query.trim()) return text;
  return splitMatchRuns(text, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

/**
 * A terminal a tool call embeds: the command, its live output as plain text, and
 * how it ended. While it runs, "Stop" ends its whole process tree through the
 * host; the output stays readable after it ends or is released. A terminal the
 * agent ran itself (`agentOwned`) is read-only: the host shows it but cannot
 * stop it, and it stops counting as running once the tool call that embeds it
 * has ended. Without a record the card says whether output is still expected
 * (`active`: the tool call is pending or in progress), or that the host dropped
 * the record past its retention bound (`omitted`) — never "no output" then.
 */
export function AcpTerminalOutput({ terminalId, terminal, live, active = false, omitted = false, onKill, searchQuery = '', searchCase = false }: {
  terminalId: string;
  terminal: AcpTerminal | null;
  live: boolean;
  /** The tool call that embeds the terminal is still pending or in progress. */
  active?: boolean;
  /** The host dropped this terminal's record; its output was omitted, not empty. */
  omitted?: boolean;
  onKill: (terminalId: string) => Promise<void>;
  searchQuery?: string;
  searchCase?: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const output = useThrottled(terminal?.output ?? '', REPAINT_MS);
  const text = terminalText(output);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const node = outputRef.current;
    if (node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [text]);

  if (!terminal) {
    const state = omitted ? 'omitted' : live && active ? 'waiting' : 'empty';
    return <div className={styles.terminal} data-content="terminal" data-terminal-id={terminalId}>
      <p className={styles.note} data-terminal-state={state}>{t(state === 'omitted' ? 'sessions.acpTerminalOmitted' : state === 'waiting' ? 'sessions.acpTerminalWaiting' : 'sessions.acpTerminalNoOutput')}</p>
    </div>;
  }
  const exit = terminal.exitStatus;
  // Nothing more arrives for an agent's own command once its tool call ended.
  const ended = !!exit || terminal.released || (terminal.agentOwned && !active);
  const running = !ended;
  const status = exit
    ? exit.signal ? t('sessions.acpTerminalSignal', { signal: exit.signal }) : t('sessions.acpTerminalExit', { code: exit.exitCode ?? '?' })
    : terminal.agentOwned && ended ? t('sessions.acpTerminalEnded')
    : terminal.released ? t('sessions.acpTerminalReleased') : t('sessions.acpTerminalRunning');
  const failed = !!exit && (exit.signal != null || (exit.exitCode != null && exit.exitCode !== 0));
  return <div className={styles.terminal} data-content="terminal" data-terminal-id={terminalId} data-running={running || undefined} data-agent-owned={terminal.agentOwned || undefined}>
    <div className={styles.terminalHead}>
      <Icon name="terminal" size={12} />
      <code className={styles.terminalCommand} title={terminal.cwd}>{renderRuns(visibleControls(terminal.command), searchQuery, searchCase)}</code>
      <span className={styles.terminalStatus} data-failed={failed || undefined} role="status">{status}</span>
      <AcpCopyButton text={terminalText(terminal.output)} label={t('sessions.acpCopyOutput')} />
      {running && live && !terminal.agentOwned && <button type="button" className={styles.action} data-variant="danger" disabled={busy} onClick={() => {
        setBusy(true);
        setError('');
        void onKill(terminalId)
          .catch((value) => setError(String((value as { message?: string })?.message ?? value)))
          .finally(() => setBusy(false));
      }}><Icon name="square" size={11} />{t('sessions.acpTerminalKill')}</button>}
    </div>
    {terminal.truncated && <p className={styles.truncatedNote}>{t('sessions.acpTerminalTruncated')}</p>}
    <pre ref={outputRef} className={styles.terminalOutput} tabIndex={0} aria-label={t('sessions.acpTerminalOutput', { command: terminal.command })} onScroll={(event) => {
      const node = event.currentTarget;
      followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
    }}>{text ? renderRuns(text, searchQuery, searchCase) : <span className={styles.muted} data-terminal-state={running ? 'waiting' : 'empty'}>{running ? t('sessions.acpTerminalWaiting') : t('sessions.acpTerminalNoOutput')}</span>}</pre>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
