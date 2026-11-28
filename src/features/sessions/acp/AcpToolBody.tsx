import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot, AcpToolCall, AcpToolContent } from '../../../types/acp';
import { acpIsLive, acpTerminal } from '../acpSession';
import { AcpDiff } from './AcpDiff';
import { AcpTerminalOutput } from './AcpTerminalOutput';
import { splitMatchRuns } from './acpSearch';
import { insideDirectory, locationTarget, visibleControls } from './acpView';
import styles from './acp.module.css';

/** Text longer than this starts folded to a few lines, with "show all". */
const LONG_TEXT = 600;
const LONG_LINES = 8;

function isLong(text: string) {
  return text.length > LONG_TEXT || text.split('\n').length > LONG_LINES;
}

export function renderRuns(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe;
  return splitMatchRuns(safe, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

/** Plain tool text: shown whole when short, folded with a toggle when long. */
function FoldedText({ text, truncated, label, searchQuery = '', searchCase = false, forceExpand = false }: {
  text: string;
  truncated: boolean;
  label?: string;
  searchQuery?: string;
  searchCase?: boolean;
  forceExpand?: boolean;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const long = isLong(text);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!forceExpand || !long || !trimmed) return;
    const hay = visibleControls(text);
    const matched = searchCase ? hay.includes(trimmed) : hay.toLowerCase().includes(trimmed.toLowerCase());
    if (matched) setAll(true);
  }, [forceExpand, long, searchQuery, searchCase, text]);

  return <div className={styles.toolText}>
    {label && <span className={styles.fieldLabel}>{label}</span>}
    <pre className={styles.toolPre} data-folded={(long && !all) || undefined}>{renderRuns(text, searchQuery, searchCase)}</pre>
    {(long || truncated) && <div className={styles.inlineActions}>
      {long && <button type="button" className={styles.linkAction} aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? t('sessions.acpShowLess') : t('sessions.acpShowAll')}</button>}
      {truncated && <span className={styles.truncated}>{t('sessions.acpTruncated')}</span>}
    </div>}
  </div>;
}

/** What a folded call still shows on its one line: the first place it touched. */
export function toolSummaryOf(call: AcpToolCall): string {
  const location = call.locations[0];
  if (location) return locationTarget(location.path, location.line);
  const diff = call.content.find((content) => content.type === 'diff');
  return diff && diff.type === 'diff' ? diff.path : '';
}

/**
 * The details of one tool call: its input, the content it reported (text, diff,
 * terminal, image or session notes) and the places it touched. The standalone tool
 * card and a work-process step both open to this same body.
 */
export function AcpToolBody({
  id,
  call,
  snapshot,
  onKillTerminal,
  onOpenPath,
  forceOpen = false,
  searchQuery = '',
  searchCase = false,
}: {
  id?: string;
  call: AcpToolCall;
  snapshot: AcpSessionSnapshot;
  onKillTerminal: (terminalId: string) => Promise<void>;
  onOpenPath?: (target: string) => Promise<void>;
  /** Find or locate opened the call: long text and diffs open to the match too. */
  forceOpen?: boolean;
  searchQuery?: string;
  searchCase?: boolean;
}) {
  const { t } = useTranslation();
  const [openError, setOpenError] = useState('');
  const live = acpIsLive(snapshot);

  function contentView(content: AcpToolContent, index: number) {
    switch (content.type) {
      case 'text':
        return <FoldedText key={index} text={content.text} truncated={content.truncated} searchQuery={searchQuery} searchCase={searchCase} forceExpand={forceOpen} />;
      case 'diff':
        return <AcpDiff
          key={index}
          path={content.path}
          oldText={content.oldText}
          newText={content.newText}
          truncated={content.truncated}
          forceOpen={forceOpen}
          directory={snapshot.directory}
          onOpenPath={onOpenPath}
          searchQuery={searchQuery}
          searchCase={searchCase}
        />;
      case 'terminal':
        return <AcpTerminalOutput
          key={index}
          terminalId={content.terminalId}
          terminal={acpTerminal(snapshot, content.terminalId)}
          live={live}
          active={call.status === 'pending' || call.status === 'in_progress'}
          omitted={(snapshot.omittedTerminalIds ?? []).includes(content.terminalId)}
          onKill={onKillTerminal}
          searchQuery={searchQuery}
          searchCase={searchCase}
        />;
      case 'image':
        return <div key={index} className={styles.contentNote} data-content="image"><Icon name="eye" size={12} />{t('sessions.acpImageContent', { type: content.mimeType })}</div>;
      case 'session':
        return <div key={index} className={styles.contentNote} data-content="session"><Icon name="branch" size={12} />{t('sessions.acpSessionContent', { id: content.sessionId })}</div>;
      default:
        return null;
    }
  }

  return <div id={id} className={styles.toolBody}>
    {call.rawInput && <FoldedText text={call.rawInput} truncated={false} label={t('sessions.acpToolInput')} searchQuery={searchQuery} searchCase={searchCase} forceExpand={forceOpen} />}
    {call.content.map(contentView)}
    {call.locations.length > 0 && <ul className={styles.locations} aria-label={t('sessions.acpLocations')}>
      {call.locations.map((location, index) => {
        const target = locationTarget(location.path, location.line);
        const inside = !!onOpenPath && insideDirectory(snapshot.directory, location.path);
        return <li key={index}>
          {inside
            ? <button type="button" className={styles.locationLink} title={t('sessions.acpLocationOpen', { path: target })} onClick={() => {
              setOpenError('');
              void onOpenPath?.(target).catch((value) => setOpenError(String((value as { message?: string })?.message ?? value)));
            }}><Icon name="file" size={12} /><span className={styles.locationPath}>{renderRuns(target, searchQuery, searchCase)}</span></button>
            : <span className={styles.locationText} title={t('sessions.acpLocationOutside')} data-outside="">{renderRuns(target, searchQuery, searchCase)}</span>}
        </li>;
      })}
    </ul>}
    {openError && <p className={styles.error} role="alert">{openError}</p>}
  </div>;
}
