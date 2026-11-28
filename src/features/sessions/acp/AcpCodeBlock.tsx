import { memo, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HighlightRun } from './acpHighlight';
import { AcpCopyButton } from './AcpCopyButton';
import { AcpSessionContext } from './acpImageCache';
import { readHighlight, writeHighlight } from './acpRenderCache';
import { splitMatchRuns } from './acpSearch';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

function renderCodeText(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe;
  return splitMatchRuns(safe, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

/**
 * One fenced block of an agent reply: its language, a wrap toggle, a copy
 * button that copies the source exactly, and static highlighting for a fixed
 * set of languages, loaded only when a block needs it. Other languages and long
 * blocks stay plain text. A highlighted block is remembered for its session, so a
 * reply that scrolls back into the rendered range shows its colors at once, without
 * highlighting again.
 */
export const AcpCodeBlock = memo(function AcpCodeBlock({
  code,
  language,
  searchQuery = '',
  searchCase = false,
}: {
  code: string;
  language: string | null;
  searchQuery?: string;
  searchCase?: boolean;
}) {
  const { t } = useTranslation();
  const sessionId = useContext(AcpSessionContext);
  const [wrap, setWrap] = useState(false);
  const [runs, setRuns] = useState<{ code: string; language: string | null; runs: HighlightRun[] } | null>(null);
  const cached = language ? readHighlight(sessionId, code, language) : null;
  useEffect(() => {
    if (!language || readHighlight(sessionId, code, language)) return;
    let live = true;
    void import('./acpHighlight')
      .then((module) => module.highlight(code, language))
      .then((found) => {
        // Unmounted (scrolled away or the session closed): nothing is kept for it.
        if (!found || !live) return;
        writeHighlight(sessionId, code, language, found);
        setRuns({ code, language, runs: found });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [sessionId, code, language]);
  const current = cached ?? (runs && runs.code === code && runs.language === language ? runs.runs : null);
  const wrapLabel = t('sessions.acpCodeWrap');
  const wrapTitle = wrap ? t('sessions.acpCodeNoWrap') : wrapLabel;
  return <div className={styles.codeBlock} data-acp-code="" data-language={language ?? undefined} data-wrap={wrap || undefined}>
    <div className={styles.codeHead}>
      <span className={styles.codeLanguage}>{language || t('sessions.acpCodePlain')}</span>
      <span className={styles.codeActions}>
        <button
          type="button"
          className={styles.codeToggle}
          aria-pressed={wrap}
          aria-label={wrapLabel}
          data-code-wrap={wrap ? 'true' : 'false'}
          title={wrapTitle}
          onClick={() => setWrap((value) => !value)}
        >
          {wrapLabel}
        </button>
        <AcpCopyButton text={code} label={t('sessions.acpCopyCode')} />
      </span>
    </div>
    <pre className={styles.codeBody} data-wrap={wrap || undefined}><code>{current
      ? current.map((run, index) => run.className
        ? <span key={index} className={run.className}>{renderCodeText(run.text, searchQuery, searchCase)}</span>
        : renderCodeText(run.text, searchQuery, searchCase))
      : renderCodeText(code, searchQuery, searchCase)}</code></pre>
  </div>;
});
