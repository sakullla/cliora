import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import { writeClipboard } from '../../../lib/clipboard';
import styles from './acp.module.css';

/** Copies exactly `text`, the source the agent sent, and says whether it worked. */
export function AcpCopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<'' | 'copied' | 'failed'>('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const shown = result === 'copied' ? t('sessions.acpCopied') : result === 'failed' ? t('sessions.acpCopyFailed') : label;
  return <button
    type="button"
    className={`${styles.iconAction}${className ? ` ${className}` : ''}`}
    aria-label={shown}
    title={shown}
    data-copy-result={result || undefined}
    onClick={() => {
      // The clipboard call runs first, inside the click (see writeClipboard).
      void writeClipboard(text).then((ok) => {
        setResult(ok ? 'copied' : 'failed');
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setResult(''), 1600);
      });
    }}>
    <Icon name={result === 'copied' ? 'check' : 'copy'} size={12} />
  </button>;
}
