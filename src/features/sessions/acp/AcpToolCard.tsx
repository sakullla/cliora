import { memo, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot, AcpToolCall } from '../../../types/acp';
import { acpCardAnswerable } from '../acpSession';
import { AcpPermissionCard } from './AcpPermissionCard';
import { AcpToolBody, renderRuns, toolSummaryOf } from './AcpToolBody';
import { toolBodyPropsEqual, useViewMemory } from './acpRenderCache';
import { toolKindOf, toolKindView, toolStatusIcon, toolStatusKey } from './acpView';
import styles from './acp.module.css';

/** The open body redraws only when what it shows changes, not on every snapshot. */
const ToolBody = memo(AcpToolBody, toolBodyPropsEqual);

/**
 * One tool call, merged in place by its call id. Kind glyph and status are told
 * by icon, color and word together. A completed call folds to one line; a pending,
 * running or failed one stays open, and the reader may fold or open any of them.
 * An authorization request is drawn on the call that asked, outside the fold.
 * Inside a turn's work process the same call reads as a compact step instead
 * (AcpStep); both open to the same AcpToolBody. The reader's choice is kept in the
 * view memory, so it survives the card leaving the rendered range.
 */
export const AcpToolCard = memo(function AcpToolCard({
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
  const [override, setOverride] = useViewMemory<boolean | null>(`card:${call.id}`, null);
  // Starts unforced, so a card that mounts already targeted opens too.
  const [prevForceOpen, setPrevForceOpen] = useState(false);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOverride(true);
  }

  const kind = toolKindOf(call);
  const view = toolKindView(kind);
  const request = call.permission;
  const answerable = !!request && acpCardAnswerable(snapshot, request.requestId);
  const open = override ?? (call.status !== 'completed' || answerable);
  const title = call.title || call.callId;
  const summary = toolSummaryOf(call);

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
    {open && <ToolBody
      id={bodyId}
      call={call}
      snapshot={snapshot}
      onKillTerminal={onKillTerminal}
      onOpenPath={onOpenPath}
      forceOpen={forceOpen}
      searchQuery={searchQuery}
      searchCase={searchCase}
    />}
    {request && answerable && <AcpPermissionCard title={title} request={request} busy={busy} onAnswer={onAnswer} />}
  </div>;
});
