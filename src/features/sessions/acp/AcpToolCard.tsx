import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot, AcpToolCall, AcpToolContent } from '../../../types/acp';
import { acpCardAnswerable, acpIsLive, acpTerminal } from '../acpSession';
import { AcpDiff } from './AcpDiff';
import { AcpPermissionCard } from './AcpPermissionCard';
import { AcpTerminalOutput } from './AcpTerminalOutput';
import { splitMatchRuns } from './acpSearch';
import { insideDirectory, locationTarget, toolKindOf, toolKindView, toolStatusIcon, toolStatusKey, visibleControls } from './acpView';
import styles from './acp.module.css';

/** Text longer than this starts folded to a few lines, with "show all". */
const LONG_TEXT = 600;
const LONG_LINES = 8;

function isLong(text: string) {
  return text.length > LONG_TEXT || text.split('\n').length > LONG_LINES;
}

function renderRuns(text: string, query: string, caseSensitive: boolean) {
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

/** What a folded card still shows on its one line: the first place it touched. */
function summaryOf(call: AcpToolCall): string {
  const location = call.locations[0];
  if (location) return locationTarget(location.path, location.line);
  const diff = call.content.find((content) => content.type === 'diff');
  return diff && diff.type === 'diff' ? diff.path : '';
}

/**
 * One tool call, merged in place by its call id. Kind glyph and status are told
 * by icon, color and word together. A completed call folds to one line; a pending,
 * running or failed one stays open, and the reader may fold or open any of them.
 * An authorization request is drawn on the call that asked, outside the fold.
 */
export function AcpToolCard({
  call,
  snapshot,
  busy,
  onAnswer,
  onKillTerminal,
  onOpenPath,
  forceOpen = false,
  searchQuery = '',
  searchCase = false,
  findActive = false,
  located = false,
}: {
  call: AcpToolCall;
  snapshot: AcpSessionSnapshot;
  busy: boolean;
  onAnswer: (requestId: string, optionId: string | null) => void;
  onKillTerminal: (terminalId: string) => Promise<void>;
  onOpenPath?: (target: string) => Promise<void>;
  /** Automatically opens a folded card when targeted by find or locate. */
  forceOpen?: boolean;
  searchQuery?: string;
  searchCase?: boolean;
  findActive?: boolean;
  located?: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [override, setOverride] = useState<boolean | null>(forceOpen ? true : null);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOverride(true);
  }
  const [openError, setOpenError] = useState('');

  const kind = toolKindOf(call);
  const view = toolKindView(kind);
  const request = call.permission;
  const answerable = !!request && acpCardAnswerable(snapshot, request.requestId);
  const open = override ?? (call.status !== 'completed' || answerable);
  const title = call.title || call.callId;
  const summary = summaryOf(call);
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

  return <div
    className={styles.tool}
    data-item-id={call.id}
    data-status={call.status}
    data-tool-kind={kind}
    data-subagent={call.subagent ?? undefined}
    data-open={open || undefined}
    data-find-hit={findActive ? 'active' : undefined}
    data-located={located || undefined}
  >
    <div className={styles.toolHead}>
      <button type="button" className={styles.toolToggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOverride(!open)}>
        <Icon name="chevronRight" size={12} className={styles.disclosure} />
        <span className={styles.toolKind} title={t(view.key)}><Icon name={view.icon} size={13} /><span className={styles.srOnly}>{t(view.key)}</span></span>
        <strong className={styles.toolTitle}>{renderRuns(title, searchQuery, searchCase)}</strong>
        {!open && summary && <span className={styles.toolSummary}>{renderRuns(summary, searchQuery, searchCase)}</span>}
      </button>
      <span className={styles.toolStatus}><Icon name={toolStatusIcon(call.status)} size={12} />{t(request?.userQuestion && answerable ? 'sessions.taskNeedsAnswer' : toolStatusKey(call.status))}</span>
    </div>
    {open && <div id={bodyId} className={styles.toolBody}>
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
    </div>}
    {request && answerable && <AcpPermissionCard title={title} request={request} busy={busy} onAnswer={onAnswer} />}
  </div>;
}
