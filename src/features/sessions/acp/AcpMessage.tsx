import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpMessage as Message } from '../../../types/acp';
import { AcpCodeBlock } from './AcpCodeBlock';
import { AcpCopyButton } from './AcpCopyButton';
import { splitMatchRuns } from './acpSearch';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

const MarkdownView = lazy(() => import('../../../components/MarkdownView'));

function renderCode(code: string, language: string | null) {
  return <AcpCodeBlock code={code} language={language} />;
}

function renderRuns(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe;
  return splitMatchRuns(safe, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

function containsQuery(text: string, query: string, caseSensitive: boolean): boolean {
  const trimmed = query.trim();
  if (!trimmed || !text) return false;
  const hay = visibleControls(text);
  return caseSensitive ? hay.includes(trimmed) : hay.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * One message of the timeline. An agent reply reads as Markdown in the pane's
 * terminal tone (HTML and escape sequences stay literal text); the person's own
 * message is plain text with attachment labels and an optional refill-to-input
 * action; a thought folds by default with a single-line preview and expands to
 * calm secondary text. Every message can be copied whole, exactly as it arrived.
 */
export function AcpMessage({
  message,
  toolName,
  streaming,
  canReuse = false,
  onReuse,
  forceOpen = false,
  searchQuery = '',
  searchCase = false,
  findActive = false,
  located = false,
}: {
  message: Message;
  toolName: string;
  streaming: boolean;
  /** Whether the conversation is live and accepts refilling user messages into the composer. */
  canReuse?: boolean;
  onReuse?: (text: string) => void;
  /** Automatically opens folded thought messages when targeted by find or locate. */
  forceOpen?: boolean;
  searchQuery?: string;
  searchCase?: boolean;
  findActive?: boolean;
  located?: boolean;
}) {
  const { t } = useTranslation();
  const [thoughtOpen, setThoughtOpen] = useState(forceOpen);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setThoughtOpen(true);
  }

  const role = message.role;
  const roleLabel = role === 'user' ? t('sessions.acpRoleUser')
    : role === 'thought' ? t('sessions.acpRoleThought')
      : role === 'session' ? t('sessions.acpRoleSession')
        : t('sessions.acpRoleAgent', { tool: toolName });
  const truncated = message.truncated && <span className={styles.truncated}>{t('sessions.acpTruncated')}</span>;
  const cursor = streaming && <span className={styles.cursor} role="img" aria-label={t('sessions.acpStreaming')} />;
  const copy = message.text ? <AcpCopyButton text={message.text} label={t('sessions.acpCopyMessage')} className={styles.messageCopy} /> : null;
  const hasMatch = findActive || containsQuery(message.text, searchQuery, searchCase);
  const findState = findActive ? 'active' : hasMatch ? 'match' : undefined;

  if (role === 'thought') {
    const preview = visibleControls(message.text).replace(/\s+/g, ' ').trim();
    return <details
      className={styles.thought}
      open={thoughtOpen}
      data-item-id={message.id}
      data-role={role}
      data-subagent={message.subagent ?? undefined}
      data-streaming={streaming || undefined}
      data-find-hit={findState}
      data-located={located || undefined}
      onToggle={(event) => setThoughtOpen(event.currentTarget.open)}
    >
      <summary className={styles.thoughtSummary}>
        <Icon name="chevronRight" size={12} className={styles.disclosure} />
        <Icon name="sparkle" size={12} />
        <span className={styles.thoughtLabel}>{roleLabel}</span>
        {streaming && <span className={styles.thinking} role="status">
          <span className={styles.thoughtPulse} aria-hidden="true" />
          {t('sessions.acpThinking')}
        </span>}
        {!thoughtOpen && preview && <span className={styles.thoughtPreview} data-acp-thought-preview="">
          {renderRuns(preview, searchQuery, searchCase)}
        </span>}
      </summary>
      <p className={styles.thoughtBody}>{renderRuns(message.text, searchQuery, searchCase)}{truncated}</p>
    </details>;
  }

  if (role === 'user') {
    const showReuse = canReuse && !!onReuse && message.text.trim().length > 0;
    return <div
      className={styles.message}
      data-item-id={message.id}
      data-role={role}
      data-subagent={message.subagent ?? undefined}
      data-find-hit={findState}
      data-located={located || undefined}
    >
      <div className={styles.userBubble}>
        <span className={styles.srOnly}>{roleLabel}</span>
        <p className={styles.plainText}>{message.text ? renderRuns(message.text, searchQuery, searchCase) : ' '}{truncated}</p>
        {!!message.attachments?.length && <ul className={styles.attachments} aria-label={t('sessions.acpAttachments')}>
          {message.attachments.map((attachment, index) => <li key={index} className={styles.attachment} data-type={attachment.type}>
            <Icon name={attachment.type === 'image' ? 'eye' : 'file'} size={12} />
            <span className={styles.attachmentName}>{renderRuns(attachment.name, searchQuery, searchCase)}</span>
            {attachment.delivery && <span className={styles.attachmentNote}>{t(attachment.delivery === 'embedded' ? 'sessions.acpAttachmentEmbedded' : 'sessions.acpAttachmentLink')}</span>}
          </li>)}
        </ul>}
      </div>
      {(copy || showReuse) && <div className={styles.messageTools}>
        {showReuse && <button
          type="button"
          className={`${styles.iconAction} ${styles.messageAction}`}
          data-acp-reuse=""
          aria-label={t('sessions.acpRefillMessage')}
          title={t('sessions.acpRefillMessage')}
          onClick={() => onReuse(message.text)}
        >
          <Icon name="pencil" size={12} />
        </button>}
        {copy}
      </div>}
    </div>;
  }

  const plain = <p className={styles.plainText}>{renderRuns(message.text, searchQuery, searchCase)}</p>;
  return <div
    className={styles.message}
    data-item-id={message.id}
    data-role={role}
    data-subagent={message.subagent ?? undefined}
    data-streaming={streaming || undefined}
    data-find-hit={findState}
    data-located={located || undefined}
  >
    <div className={styles.messageHead}>
      <span className={styles.roleLabel}>{roleLabel}</span>
      {copy}
    </div>
    <div className={styles.agentBody}>
      {message.text ? <Suspense fallback={plain}><MarkdownView text={message.text} tone="terminal" codeBlock={renderCode} /></Suspense> : null}
      {truncated}
      {cursor}
    </div>
  </div>;
}
