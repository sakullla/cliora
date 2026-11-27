import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpMessage as Message } from '../../../types/acp';
import { AcpCodeBlock } from './AcpCodeBlock';
import { AcpCopyButton } from './AcpCopyButton';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

const MarkdownView = lazy(() => import('../../../components/MarkdownView'));

function renderCode(code: string, language: string | null) {
  return <AcpCodeBlock code={code} language={language} />;
}

/**
 * One message of the timeline. An agent reply reads as Markdown in the pane's
 * terminal tone (HTML and escape sequences stay literal text); the person's own
 * message is plain text with its attachment labels; a thought is folded by
 * default and says when it is still being written. Every message can be copied
 * whole, exactly as it arrived.
 */
export function AcpMessage({ message, toolName, streaming }: { message: Message; toolName: string; streaming: boolean }) {
  const { t } = useTranslation();
  const role = message.role;
  const roleLabel = role === 'user' ? t('sessions.acpRoleUser')
    : role === 'thought' ? t('sessions.acpRoleThought')
      : role === 'session' ? t('sessions.acpRoleSession')
        : t('sessions.acpRoleAgent', { tool: toolName });
  const truncated = message.truncated && <span className={styles.truncated}>{t('sessions.acpTruncated')}</span>;
  const cursor = streaming && <span className={styles.cursor} role="img" aria-label={t('sessions.acpStreaming')} />;
  const copy = message.text ? <AcpCopyButton text={message.text} label={t('sessions.acpCopyMessage')} className={styles.messageCopy} /> : null;

  if (role === 'thought') {
    return <details className={styles.thought} data-item-id={message.id} data-role={role} data-subagent={message.subagent ?? undefined} data-streaming={streaming || undefined}>
      <summary className={styles.thoughtSummary}>
        <Icon name="chevronRight" size={12} className={styles.disclosure} />
        <Icon name="sparkle" size={12} />
        <span>{roleLabel}</span>
        {streaming && <span className={styles.thinking} role="status">{t('sessions.acpThinking')}</span>}
      </summary>
      <p className={styles.plainText}>{visibleControls(message.text)}{truncated}</p>
    </details>;
  }

  if (role === 'user') {
    return <div className={styles.message} data-item-id={message.id} data-role={role} data-subagent={message.subagent ?? undefined}>
      <div className={styles.userBubble}>
        <span className={styles.srOnly}>{roleLabel}</span>
        <p className={styles.plainText}>{visibleControls(message.text) || ' '}{truncated}</p>
        {!!message.attachments?.length && <ul className={styles.attachments} aria-label={t('sessions.acpAttachments')}>
          {message.attachments.map((attachment, index) => <li key={index} className={styles.attachment} data-type={attachment.type}>
            <Icon name={attachment.type === 'image' ? 'eye' : 'file'} size={12} />
            <span className={styles.attachmentName}>{attachment.name}</span>
            {attachment.delivery && <span className={styles.attachmentNote}>{t(attachment.delivery === 'embedded' ? 'sessions.acpAttachmentEmbedded' : 'sessions.acpAttachmentLink')}</span>}
          </li>)}
        </ul>}
      </div>
      {copy && <div className={styles.messageTools}>{copy}</div>}
    </div>;
  }

  const plain = <p className={styles.plainText}>{visibleControls(message.text)}</p>;
  return <div className={styles.message} data-item-id={message.id} data-role={role} data-subagent={message.subagent ?? undefined} data-streaming={streaming || undefined}>
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
