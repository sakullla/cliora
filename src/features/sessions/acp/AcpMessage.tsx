import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpMessage as Message } from '../../../types/acp';
import { AcpCodeBlock } from './AcpCodeBlock';
import { AcpCopyButton } from './AcpCopyButton';
import { AcpUserImages } from './AcpImagePreview';
import { useViewMemory } from './acpRenderCache';
import { splitMatchRuns } from './acpSearch';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

// Memoized: a reply re-renders its Markdown only when its text, the find query or the
// code renderer changes, never because another item of the conversation did.
const MarkdownView = lazy(() => import('../../../components/MarkdownView').then((module) => ({ default: memo(module.default) })));

function renderRuns(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe;
  return splitMatchRuns(safe, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

/** While a reply streams, its Markdown is parsed again at most this often (R13): a
 *  chunk arrives every frame, and parsing and laying out the whole growing reply on each
 *  one is the largest cost of a streaming frame. The last text always shows once the
 *  interval has passed, and at once when the reply ends. */
export const STREAMING_MARKDOWN_MS = 100;

function useStreamingText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const lastRef = useRef(0);
  // Outside streaming the text shows as it is; keeping `shown` with it means a reply
  // that starts streaming again continues from what is on screen.
  if (!streaming && shown !== text) setShown(text);
  useEffect(() => {
    if (!streaming || text === shown) return;
    const wait = Math.max(0, STREAMING_MARKDOWN_MS - (performance.now() - lastRef.current));
    const timer = window.setTimeout(() => {
      lastRef.current = performance.now();
      setShown(text);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [text, streaming, shown]);
  return streaming ? shown : text;
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
 * message is plain text with its pictures (thumbnails, or named placeholders once
 * their data is gone), file labels and an optional refill-to-input action; a thought folds by default with a single-line preview and expands to
 * calm secondary text. Every message can be copied whole, exactly as it arrived.
 * An agent reply carries the agent's name only when it opens its round (`head`);
 * otherwise its copy action floats over its corner on hover or focus. It re-renders
 * only when its own message or props change, and a thought keeps the reader's open or
 * folded choice in the view memory, so scrolling it out of the rendered range and back
 * changes nothing.
 */
export const AcpMessage = memo(function AcpMessage({
  message,
  toolName,
  head = true,
  streaming,
  renderMarkdown,
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
  /** Show the agent's name above a reply: the first agent content of its round. */
  head?: boolean;
  streaming: boolean;
  renderMarkdown: boolean;
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
  const [thoughtOpen, setThoughtOpen] = useViewMemory(`thought:${message.id}`, false);
  // Starts unforced, so a message that mounts already targeted opens too.
  const [prevForceOpen, setPrevForceOpen] = useState(false);
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
    const imageCount = message.attachments?.filter((attachment) => attachment.type === 'image').length ?? 0;
    const files = message.attachments?.filter((attachment) => attachment.type !== 'image') ?? [];
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
        <AcpUserImages messageId={message.id} count={imageCount} />
        {files.length > 0 && <ul className={styles.attachments} aria-label={t('sessions.acpAttachments')}>
          {files.map((attachment, index) => <li key={index} className={styles.attachment} data-type={attachment.type}>
            <Icon name="file" size={12} />
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

  const markdownText = useStreamingText(message.text, streaming);
  const markdownHighlight = useMemo(
    () => (searchQuery.trim() ? { query: searchQuery, caseSensitive: searchCase } : undefined),
    [searchQuery, searchCase],
  );
  const renderCode = useMemo(
    () => (code: string, language: string | null) => (
      <AcpCodeBlock code={code} language={language} searchQuery={searchQuery} searchCase={searchCase} />
    ),
    [searchQuery, searchCase],
  );

  const plain = <p className={styles.plainText}>{renderRuns(message.text, searchQuery, searchCase)}</p>;
  return <div
    className={styles.message}
    data-item-id={message.id}
    data-role={role}
    data-subagent={message.subagent ?? undefined}
    data-streaming={streaming || undefined}
    data-find-hit={findState}
    data-located={located || undefined}
    data-head={head || undefined}
  >
    {head
      ? <div className={styles.messageHead}>
          <span className={styles.roleLabel} data-acp-agent-head={role === 'agent' ? '' : undefined}>{roleLabel}</span>
          {copy}
        </div>
      : copy && <div className={styles.messageFloat}>{copy}</div>}
    <div className={styles.agentBody}>
      {renderMarkdown && message.text ? <Suspense fallback={plain}><MarkdownView text={markdownText} tone="terminal" codeBlock={renderCode} highlight={markdownHighlight} /></Suspense> : null}
      {truncated}
      {cursor}
    </div>
  </div>;
});
