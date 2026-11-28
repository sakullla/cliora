import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import { AcpMessage } from './AcpMessage';
import type { AcpMessageItem } from './timelineModel';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

/** The first line worth reading: Markdown heading marks and list bullets dropped. */
function previewOf(items: readonly AcpMessageItem[]): string {
  for (const item of items) {
    for (const line of item.text.split('\n')) {
      const text = line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim();
      if (text) return visibleControls(text);
    }
  }
  return '';
}

/**
 * What the agent said before the first prompt (R4): folded into one line with a
 * preview of its first line, opened to read every message whole. Find and locate
 * open it when they target a message inside.
 */
export function AcpStartupGroup({
  id,
  items,
  toolName,
  renderMarkdown,
  forceOpen = false,
  activeFindItemId = null,
  locatedId = null,
  searchQuery = '',
  searchCase = false,
}: {
  id: string;
  items: readonly AcpMessageItem[];
  toolName: string;
  renderMarkdown: boolean;
  forceOpen?: boolean;
  activeFindItemId?: string | null;
  locatedId?: string | null;
  searchQuery?: string;
  searchCase?: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [open, setOpen] = useState(forceOpen);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOpen(true);
  }
  const preview = previewOf(items);

  return <section className={styles.startup} data-acp-startup={id} data-open={open || undefined} aria-label={t('sessions.acpStartupTitle')}>
    <button type="button" className={styles.startupToggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <Icon name="info" size={12} />
      <span className={styles.startupTitle}>{t('sessions.acpStartupTitle')}</span>
      {!open && preview && <span className={styles.startupPreview}>{preview}</span>}
    </button>
    {open && <div id={bodyId} className={styles.startupBody}>
      {items.map((item) => {
        const isFindActive = item.id === activeFindItemId;
        const isLocated = item.id === locatedId;
        return <AcpMessage
          key={item.id}
          message={item}
          toolName={toolName}
          head={false}
          streaming={false}
          renderMarkdown={renderMarkdown}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      })}
    </div>}
  </section>;
}
