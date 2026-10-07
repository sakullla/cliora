import { useTranslation } from 'react-i18next';
import { CodeEditor, type CodeFormat } from '../CodeEditor';
import styles from './ConflictCompare.module.css';

/** Unified conflict comparison (ADR-5): one warning banner, a dual-pane read-only
 *  diff and a single 使用本次/保留当前 action pair. Multi-file views render one
 *  ConflictCompare per file and pass `banner` only on the first so a conflict
 *  view keeps exactly one banner. */
export function ConflictCompare({ title, banner, status, currentContent, nextContent, format = 'text', busy, actions = true, onUseNext, onKeepCurrent }: {
  title?: string;
  banner?: string;
  status?: string;
  currentContent: string;
  nextContent: string;
  format?: CodeFormat;
  busy?: boolean;
  actions?: boolean;
  onUseNext: () => void;
  onKeepCurrent: () => void;
}) {
  const { t } = useTranslation();
  return <section className={styles.compare} aria-label={title ?? t('common.conflict.label')}>
    {banner && <p className={styles.banner} data-banner="conflict">{banner}</p>}
    {title && <strong className={styles.title}>{title}{status ? ` · ${status}` : ''}</strong>}
    <div className={styles.columns}>
      <div><strong>{t('common.conflict.current')}</strong><CodeEditor label={title ? t('common.conflict.currentContent', { title }) : t('common.conflict.currentFileContent')} value={currentContent} format={format} readOnly compact /></div>
      <div><strong>{t('common.conflict.next')}</strong><CodeEditor label={title ? t('common.conflict.nextContent', { title }) : t('common.conflict.nextContentFallback')} value={nextContent} format={format} readOnly compact /></div>
    </div>
    {actions && <div className={styles.actions}><button type="button" disabled={busy} onClick={onKeepCurrent}>{t('common.conflict.keepCurrent')}</button><button type="button" disabled={busy} onClick={onUseNext}>{t('common.conflict.useNext')}</button></div>}
  </section>;
}
