import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HighlightRun } from './acpHighlight';
import { AcpCopyButton } from './AcpCopyButton';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

/**
 * One fenced block of an agent reply: its language, a wrap toggle, a copy
 * button that copies the source exactly, and static highlighting for a fixed
 * set of languages, loaded only when a block needs it. Other languages and long
 * blocks stay plain text.
 */
export function AcpCodeBlock({ code, language }: { code: string; language: string | null }) {
  const { t } = useTranslation();
  const [wrap, setWrap] = useState(false);
  const [runs, setRuns] = useState<{ code: string; language: string | null; runs: HighlightRun[] } | null>(null);
  useEffect(() => {
    if (!language) return;
    let live = true;
    void import('./acpHighlight')
      .then((module) => module.highlight(code, language))
      .then((found) => { if (live && found) setRuns({ code, language, runs: found }); })
      .catch(() => {});
    return () => { live = false; };
  }, [code, language]);
  const current = runs && runs.code === code && runs.language === language ? runs.runs : null;
  const wrapLabel = wrap ? t('sessions.acpCodeNoWrap') : t('sessions.acpCodeWrap');
  return <div className={styles.codeBlock} data-acp-code="" data-language={language ?? undefined} data-wrap={wrap || undefined}>
    <div className={styles.codeHead}>
      <span className={styles.codeLanguage}>{language || t('sessions.acpCodePlain')}</span>
      <span className={styles.codeActions}>
        <button
          type="button"
          className={styles.codeToggle}
          aria-pressed={wrap}
          data-code-wrap={wrap ? 'true' : 'false'}
          title={wrapLabel}
          onClick={() => setWrap((value) => !value)}
        >
          {wrapLabel}
        </button>
        <AcpCopyButton text={code} label={t('sessions.acpCopyCode')} />
      </span>
    </div>
    <pre className={styles.codeBody} data-wrap={wrap || undefined}><code>{current
      ? current.map((run, index) => run.className ? <span key={index} className={run.className}>{visibleControls(run.text)}</span> : visibleControls(run.text))
      : visibleControls(code)}</code></pre>
  </div>;
}
