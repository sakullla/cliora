import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../../components/GuideDialog';
import { Icon } from '../../../components/Icon';
import { Button } from '../../../components/ui';
import { writeClipboard } from '../../../lib/clipboard';
import type { AcpSessionSnapshot } from '../../../types/acp';
import styles from './acpComposer.module.css';

/** The agent's own name and version as it reported them, if it did. */
export function agentIdentity(snapshot: AcpSessionSnapshot): string {
  const info = snapshot.agent?.agentInfo;
  const name = (info?.title || info?.name || '').trim();
  const version = (info?.version || '').trim();
  return [name, version].filter(Boolean).join(' ');
}

/**
 * The conversation's diagnostics (the agent's error output and protocol warnings, as
 * the host redacted them) with the agent's name and version, opened from the pane
 * menu while the conversation runs. They stay out of the conversation itself; the
 * copy is exactly the text shown. Closing returns focus where it came from.
 */
export function AcpDiagnosticsDialog({ open, snapshot, toolName, onClose }: {
  open: boolean;
  snapshot: AcpSessionSnapshot;
  toolName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<'' | 'copied' | 'failed'>('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (!open) setResult(''); }, [open]);
  const text = snapshot.diagnostics.join('\n');
  const agent = agentIdentity(snapshot);
  const copyLabel = result === 'copied' ? t('sessions.acpCopied') : result === 'failed' ? t('sessions.acpCopyFailed') : t('sessions.acpCopyDiagnostics');

  return <GuideDialog open={open} wide title={t('sessions.acpDiagnosticsTitle', { tool: toolName })} hint={t('sessions.acpDiagnosticsHint')} onClose={onClose}>
    <div className={styles.diagnostics} data-acp-diagnostics-dialog="">
      <div className={styles.diagnosticsHead}>
        <span className={styles.diagnosticsAgent} data-acp-agent="">
          <Icon name="terminal" size={13} />
          {agent ? t('sessions.acpDiagnosticsAgent', { agent }) : t('sessions.acpDiagnosticsAgentUnknown')}
        </span>
        <Button size="sm" variant="secondary" data-copy-result={result || undefined} disabled={!text} onClick={() => {
          // The clipboard call runs first, inside the click (see writeClipboard).
          void writeClipboard(text).then((ok) => {
            setResult(ok ? 'copied' : 'failed');
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setResult(''), 1600);
          });
        }} icon={<Icon name={result === 'copied' ? 'check' : 'copy'} size={13} />}>{copyLabel}</Button>
      </div>
      <pre className={styles.diagnosticsText} tabIndex={0} aria-label={t('sessions.acpDiagnostics', { count: snapshot.diagnostics.length })}>{text}</pre>
    </div>
  </GuideDialog>;
}
