import { useCallback, useContext, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../../components/GuideDialog';
import { AcpSessionContext, readAcpImages, subscribeAcpImages, type CachedImage } from './acpImageCache';
import styles from './acp.module.css';

/** A picture glyph for an image whose data this run no longer holds. */
function PictureGlyph() {
  return <svg className={styles.imageGlyph} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-5-5-9 9" />
  </svg>;
}

/** The pictures this run cached for one user message (empty when none). */
export function useAcpImages(messageId: string): readonly CachedImage[] {
  const sessionId = useContext(AcpSessionContext);
  const read = useCallback(() => readAcpImages(sessionId, messageId), [sessionId, messageId]);
  return useSyncExternalStore(subscribeAcpImages, read);
}

/**
 * The images of the person's own message: thumbnails in a grid while this run still
 * holds their data, a named placeholder otherwise (after a restart, a restore or a
 * replay). A thumbnail opens the full picture; Escape closes it and focus returns to
 * the thumbnail. The media type is never shown.
 */
export function AcpUserImages({ messageId, count }: { messageId: string; count: number }) {
  const { t } = useTranslation();
  const images = useAcpImages(messageId);
  const [open, setOpen] = useState<number | null>(null);
  if (count <= 0) return null;
  const label = (image: CachedImage | undefined) => image?.name || t('sessions.acpImageUnnamed');
  const shown = open != null ? images[open] : undefined;
  return <>
    <ul className={styles.imageGrid} aria-label={t('sessions.acpImages')} data-acp-images="">
      {Array.from({ length: count }, (_, index) => {
        const image = images[index];
        return <li key={index} className={styles.imageCell}>
          {image
            ? <button type="button" className={styles.imageThumb} data-acp-image-thumb="" title={label(image)} aria-label={t('sessions.acpImageOpen', { name: label(image) })} onClick={() => setOpen(index)}>
                <img src={image.url} alt={label(image)} />
              </button>
            : <span className={styles.imagePlaceholder} data-acp-image-placeholder="" role="img" aria-label={t('sessions.acpImageMissing', { name: label(image) })} title={t('sessions.acpImageMissingHint')}>
                <PictureGlyph />
                <span className={styles.imagePlaceholderName}>{label(image)}</span>
              </span>}
        </li>;
      })}
    </ul>
    {shown && createPortal(<AcpImagePreview image={shown} name={label(shown)} onClose={() => setOpen(null)} />, document.body)}
  </>;
}

/** The full picture over the app; Escape or the close button returns to the message. */
export function AcpImagePreview({ image, name, onClose }: { image: CachedImage; name: string; onClose: () => void }) {
  return <GuideDialog open wide title={name} onClose={onClose}>
    <div className={styles.imagePreview} data-acp-image-preview="">
      <img src={image.url} alt={name} />
    </div>
  </GuideDialog>;
}
